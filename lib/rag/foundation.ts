export type RetrievalPrincipal = {
  userId?: string;
  roles?: readonly string[];
  groupIds?: readonly string[];
};

export type RetrievalRequest = {
  requestId: string;
  workspaceId: string;
  query: string;
  principal?: RetrievalPrincipal;
  queryEmbedding?: readonly number[];
  sourceIds?: readonly string[];
  locale?: string;
  maxResults?: number;
  maxContextCharacters?: number;
  candidateLimit?: number;
  timeoutMs?: number;
};

export type RetrievalCandidate = {
  workspaceId: string;
  chunkId: string;
  documentId: string;
  versionId: string;
  sourceId?: string;
  title: string;
  sourceUri?: string;
  content: string;
  headingPath: readonly string[];
  pageStart?: number;
  pageEnd?: number;
  language?: string;
  accessScope: "workspace" | "restricted";
  aclPrincipalKeys: readonly string[];
  lexicalScore?: number;
  denseScore?: number;
};

export type RetrievalStoreQuery = {
  workspaceId: string;
  query: string;
  principalKeys: readonly string[];
  sourceIds: readonly string[];
  limit: number;
  signal: AbortSignal;
};

export interface HybridRetrievalStore {
  searchLexical(request: RetrievalStoreQuery): Promise<readonly RetrievalCandidate[]>;
  searchDense?(request: RetrievalStoreQuery & { embedding: readonly number[] }): Promise<readonly RetrievalCandidate[]>;
}

export type RetrievalCitation = {
  id: string;
  chunkId: string;
  documentId: string;
  versionId: string;
  sourceId?: string;
  title: string;
  sourceUri?: string;
  headingPath: readonly string[];
  pageStart?: number;
  pageEnd?: number;
};

export type RetrievalEvidence = {
  citationId: string;
  content: string;
  fusedScore: number;
  lexicalScore?: number;
  denseScore?: number;
};

export type RetrievalResult = {
  requestId: string;
  workspaceId: string;
  query: string;
  context: string;
  citations: readonly RetrievalCitation[];
  evidence: readonly RetrievalEvidence[];
  diagnostics: {
    denseAttempted: boolean;
    denseFailed: boolean;
    lexicalFailed: boolean;
    denseCandidates: number;
    lexicalCandidates: number;
    authorizedCandidates: number;
    elapsedMs: number;
    truncated: boolean;
  };
};

export class RetrievalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalValidationError";
  }
}

export class RetrievalUnavailableError extends Error {
  constructor(message = "Knowledge retrieval is temporarily unavailable") {
    super(message);
    this.name = "RetrievalUnavailableError";
  }
}

const clampInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) throw new RetrievalValidationError("Retrieval limits must be integers");
  return Math.min(maximum, Math.max(minimum, value));
};

export function principalKeys(principal: RetrievalPrincipal | undefined) {
  const values = new Set<string>();
  if (principal?.userId) values.add(`user:${principal.userId}`);
  for (const role of principal?.roles || []) if (role.trim()) values.add(`role:${role.trim()}`);
  for (const groupId of principal?.groupIds || []) if (groupId.trim()) values.add(`group:${groupId.trim()}`);
  return [...values].sort();
}

function normalizeRequest(request: RetrievalRequest) {
  const query = request.query.replace(/\s+/gu, " ").trim();
  if (!request.requestId.trim()) throw new RetrievalValidationError("requestId is required");
  if (!request.workspaceId.trim()) throw new RetrievalValidationError("workspaceId is required");
  if (!query) throw new RetrievalValidationError("query is required");
  if (query.length > 2_000) throw new RetrievalValidationError("query exceeds 2,000 characters");
  if (request.queryEmbedding) {
    if (!request.queryEmbedding.length || request.queryEmbedding.length > 4_096) throw new RetrievalValidationError("query embedding has invalid dimensions");
    if (request.queryEmbedding.some(value => !Number.isFinite(value))) throw new RetrievalValidationError("query embedding contains a non-finite value");
  }
  return {
    ...request,
    query,
    principalKeys: principalKeys(request.principal),
    sourceIds: [...new Set(request.sourceIds || [])].slice(0, 100),
    maxResults: clampInteger(request.maxResults, 6, 1, 12),
    maxContextCharacters: clampInteger(request.maxContextCharacters, 10_000, 500, 20_000),
    candidateLimit: clampInteger(request.candidateLimit, 40, 5, 100),
    timeoutMs: clampInteger(request.timeoutMs, 700, 100, 3_000),
  };
}

function isAuthorized(candidate: RetrievalCandidate, workspaceId: string, allowedPrincipalKeys: ReadonlySet<string>) {
  if (candidate.workspaceId !== workspaceId) return false;
  if (candidate.accessScope === "workspace") return true;
  return candidate.aclPrincipalKeys.some(key => allowedPrincipalKeys.has(key));
}

async function settleWithin<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("Retrieval deadline exceeded"));
          reject(controller.signal.reason);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type RankedCandidate = RetrievalCandidate & { fusedScore: number };

function reciprocalRankFusion(dense: readonly RetrievalCandidate[], lexical: readonly RetrievalCandidate[]) {
  const fused = new Map<string, RankedCandidate>();
  const add = (candidate: RetrievalCandidate, rank: number, weight: number) => {
    const existing = fused.get(candidate.chunkId);
    const fusedScore = (existing?.fusedScore || 0) + weight / (60 + rank);
    fused.set(candidate.chunkId, { ...(existing || candidate), ...candidate, fusedScore });
  };
  dense.forEach((candidate, index) => add(candidate, index + 1, 1));
  lexical.forEach((candidate, index) => add(candidate, index + 1, 1.15));
  return [...fused.values()].sort((left, right) => right.fusedScore - left.fusedScore || left.chunkId.localeCompare(right.chunkId));
}

export class HybridRetriever {
  private readonly store: HybridRetrievalStore;
  private readonly now: () => number;

  constructor(store: HybridRetrievalStore, now: () => number = () => Date.now()) {
    this.store = store;
    this.now = now;
  }

  async retrieve(input: RetrievalRequest): Promise<RetrievalResult> {
    const request = normalizeRequest(input);
    const startedAt = this.now();
    const baseQuery: Omit<RetrievalStoreQuery, "signal"> = {
      workspaceId: request.workspaceId,
      query: request.query,
      principalKeys: request.principalKeys,
      sourceIds: request.sourceIds,
      limit: request.candidateLimit,
    };
    let dense: readonly RetrievalCandidate[] = [];
    let lexical: readonly RetrievalCandidate[] = [];
    let denseFailed = false;
    let lexicalFailed = false;

    const tasks: Promise<void>[] = [
      settleWithin(signal => this.store.searchLexical({ ...baseQuery, signal }), request.timeoutMs)
        .then(result => { lexical = result.slice(0, request.candidateLimit); })
        .catch(() => { lexicalFailed = true; }),
    ];
    if (request.queryEmbedding && this.store.searchDense) {
      tasks.push(
        settleWithin(signal => this.store.searchDense!({ ...baseQuery, embedding: request.queryEmbedding!, signal }), request.timeoutMs)
          .then(result => { dense = result.slice(0, request.candidateLimit); })
          .catch(() => { denseFailed = true; }),
      );
    }
    await Promise.all(tasks);
    if (lexicalFailed && (!request.queryEmbedding || !this.store.searchDense || denseFailed)) throw new RetrievalUnavailableError();

    const allowedPrincipals = new Set(request.principalKeys);
    const sourceFilter = new Set(request.sourceIds);
    const ranked = reciprocalRankFusion(dense, lexical).filter(candidate =>
      isAuthorized(candidate, request.workspaceId, allowedPrincipals)
      && (!sourceFilter.size || (candidate.sourceId !== undefined && sourceFilter.has(candidate.sourceId))),
    );

    const citations: RetrievalCitation[] = [];
    const evidence: RetrievalEvidence[] = [];
    const context: string[] = [];
    let remaining = request.maxContextCharacters;
    let truncated = ranked.length > request.maxResults;
    for (const candidate of ranked) {
      if (evidence.length >= request.maxResults || remaining < 80) {
        truncated = true;
        break;
      }
      const citationId = `K${evidence.length + 1}`;
      const prefix = `[${citationId}] `;
      const available = Math.max(0, remaining - prefix.length - 1);
      if (available < 64) {
        truncated = true;
        break;
      }
      const boundedContent = candidate.content.length > available ? candidate.content.slice(0, available).trimEnd() : candidate.content;
      if (!boundedContent) continue;
      if (boundedContent.length < candidate.content.length) truncated = true;
      context.push(`${prefix}${boundedContent}`);
      remaining -= prefix.length + boundedContent.length + 1;
      citations.push({
        id: citationId,
        chunkId: candidate.chunkId,
        documentId: candidate.documentId,
        versionId: candidate.versionId,
        sourceId: candidate.sourceId,
        title: candidate.title,
        sourceUri: candidate.sourceUri,
        headingPath: candidate.headingPath,
        pageStart: candidate.pageStart,
        pageEnd: candidate.pageEnd,
      });
      evidence.push({
        citationId,
        content: boundedContent,
        fusedScore: candidate.fusedScore,
        lexicalScore: candidate.lexicalScore,
        denseScore: candidate.denseScore,
      });
    }

    return {
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      query: request.query,
      context: context.join("\n"),
      citations,
      evidence,
      diagnostics: {
        denseAttempted: Boolean(request.queryEmbedding && this.store.searchDense),
        denseFailed,
        lexicalFailed,
        denseCandidates: dense.length,
        lexicalCandidates: lexical.length,
        authorizedCandidates: ranked.length,
        elapsedMs: Math.max(0, this.now() - startedAt),
        truncated,
      },
    };
  }
}
