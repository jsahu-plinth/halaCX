import { query } from "@/lib/db";
import type { HybridRetrievalStore, RetrievalCandidate, RetrievalStoreQuery } from "@/lib/rag/foundation";

type CandidateRow = {
  workspace_id: string;
  chunk_id: string;
  document_id: string;
  version_id: string;
  source_id: string | null;
  title: string;
  source_uri: string | null;
  content: string;
  heading_path: string[];
  page_start: number | null;
  page_end: number | null;
  language: string | null;
  access_scope: "workspace" | "restricted";
  acl_principal_keys: string[];
  score: number | string;
};

const commonSelection = `
  c.workspace_id,
  c.id as chunk_id,
  c.document_id,
  c.version_id,
  c.source_id,
  d.title,
  d.source_uri,
  c.content,
  c.heading_path,
  c.page_start,
  c.page_end,
  d.language,
  d.access_scope,
  coalesce((
    select array_agg(concat(acl.principal_type, ':', acl.principal_id) order by acl.principal_type, acl.principal_id)
    from knowledge_document_acl acl
    where acl.workspace_id=c.workspace_id and acl.document_id=c.document_id and acl.permission='read'
  ), '{}'::text[]) as acl_principal_keys`;

const commonJoinsAndFilters = `
  from knowledge_chunks c
  join knowledge_documents d
    on d.id=c.document_id and d.workspace_id=c.workspace_id
  join knowledge_document_versions v
    on v.id=c.version_id and v.document_id=c.document_id and v.workspace_id=c.workspace_id
  where c.workspace_id=$1
    and d.deleted_at is null
    and d.status='ready'
    and v.status='ready'
    and v.version=d.current_version
    and (
      d.access_scope='workspace'
      or exists (
        select 1 from knowledge_document_acl allowed_acl
        where allowed_acl.workspace_id=c.workspace_id
          and allowed_acl.document_id=c.document_id
          and allowed_acl.permission='read'
          and concat(allowed_acl.principal_type, ':', allowed_acl.principal_id)=any($2::text[])
      )
    )
    and (cardinality($3::uuid[])=0 or c.source_id=any($3::uuid[]))`;

function toCandidate(row: CandidateRow, kind: "dense" | "lexical"): RetrievalCandidate {
  const score = Number(row.score);
  return {
    workspaceId: row.workspace_id,
    chunkId: row.chunk_id,
    documentId: row.document_id,
    versionId: row.version_id,
    sourceId: row.source_id || undefined,
    title: row.title,
    sourceUri: row.source_uri || undefined,
    content: row.content,
    headingPath: row.heading_path || [],
    pageStart: row.page_start ?? undefined,
    pageEnd: row.page_end ?? undefined,
    language: row.language || undefined,
    accessScope: row.access_scope,
    aclPrincipalKeys: row.acl_principal_keys || [],
    ...(kind === "dense" ? { denseScore: score } : { lexicalScore: score }),
  };
}

function ensureActive(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason || new Error("Retrieval was aborted");
}

export class PostgresHybridRetrievalStore implements HybridRetrievalStore {
  async searchLexical(request: RetrievalStoreQuery) {
    ensureActive(request.signal);
    const result = await query<CandidateRow>(
      `select ${commonSelection},
              ts_rank_cd(c.content_search, websearch_to_tsquery('simple', $4)) as score
       ${commonJoinsAndFilters}
         and c.content_search @@ websearch_to_tsquery('simple', $4)
       order by score desc, c.id
       limit $5`,
      [request.workspaceId, request.principalKeys, request.sourceIds, request.query, request.limit],
    );
    ensureActive(request.signal);
    return result.rows.map(row => toCandidate(row, "lexical"));
  }

  async searchDense(request: RetrievalStoreQuery & { embedding: readonly number[] }) {
    ensureActive(request.signal);
    if (request.embedding.length !== 1_536) throw new Error("The active RAG index requires 1,536-dimensional embeddings");
    if (request.embedding.some(value => !Number.isFinite(value))) throw new Error("Embedding contains a non-finite value");
    const vector = `[${request.embedding.join(",")}]`;
    const result = await query<CandidateRow>(
      `select ${commonSelection},
              1-(c.embedding <=> $4::vector) as score
       ${commonJoinsAndFilters}
         and c.embedding is not null
       order by c.embedding <=> $4::vector, c.id
       limit $5`,
      [request.workspaceId, request.principalKeys, request.sourceIds, vector, request.limit],
    );
    ensureActive(request.signal);
    return result.rows.map(row => toCandidate(row, "dense"));
  }
}
