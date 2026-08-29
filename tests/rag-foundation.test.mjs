import assert from "node:assert/strict";
import test from "node:test";
import {
  HybridRetriever,
  RetrievalUnavailableError,
  RetrievalValidationError,
  principalKeys,
} from "../lib/rag/foundation.ts";
import { chunkKnowledgeText, prepareDocumentIngestion } from "../lib/rag/ingestion.ts";

function candidate(id, overrides = {}) {
  return {
    workspaceId: "workspace-a",
    chunkId: `chunk-${id}`,
    documentId: `document-${id}`,
    versionId: `version-${id}`,
    sourceId: "source-a",
    title: `Document ${id}`,
    sourceUri: `https://example.com/${id}`,
    content: `Evidence passage ${id}`,
    headingPath: ["Policies", `Section ${id}`],
    accessScope: "workspace",
    aclPrincipalKeys: [],
    ...overrides,
  };
}

test("hybrid retrieval fuses ranks and emits exact citations", async () => {
  const shared = candidate("shared", { denseScore: 0.91, lexicalScore: 0.8 });
  const store = {
    async searchDense() { return [shared, candidate("dense", { denseScore: 0.88 })]; },
    async searchLexical() { return [shared, candidate("lexical", { lexicalScore: 0.75 })]; },
  };
  const result = await new HybridRetriever(store).retrieve({
    requestId: "request-1",
    workspaceId: "workspace-a",
    query: "  cancellation   policy ",
    queryEmbedding: [0.1, 0.2],
  });

  assert.equal(result.query, "cancellation policy");
  assert.equal(result.evidence[0].content, shared.content);
  assert.equal(result.citations[0].id, "K1");
  assert.equal(result.citations[0].chunkId, shared.chunkId);
  assert.match(result.context, /^\[K1\] Evidence passage shared/mu);
  assert.equal(result.diagnostics.denseCandidates, 2);
  assert.equal(result.diagnostics.lexicalCandidates, 2);
});

test("defense-in-depth filters cross-tenant and unauthorized restricted candidates", async () => {
  const store = {
    async searchLexical() {
      return [
        candidate("other-tenant", { workspaceId: "workspace-b" }),
        candidate("restricted-denied", { accessScope: "restricted", aclPrincipalKeys: ["group:finance"] }),
        candidate("restricted-allowed", { accessScope: "restricted", aclPrincipalKeys: ["role:support"] }),
      ];
    },
  };
  const result = await new HybridRetriever(store).retrieve({
    requestId: "request-2",
    workspaceId: "workspace-a",
    query: "support policy",
    principal: { userId: "user-1", roles: ["support"] },
  });
  assert.deepEqual(result.citations.map(item => item.chunkId), ["chunk-restricted-allowed"]);
  assert.deepEqual(principalKeys({ userId: "user-1", roles: ["support", "support"], groupIds: ["group-1"] }), ["group:group-1", "role:support", "user:user-1"]);
});

test("source filters are enforced even when a store returns extra candidates", async () => {
  const store = {
    async searchLexical() {
      return [candidate("wrong", { sourceId: "source-b" }), candidate("right", { sourceId: "source-a" })];
    },
  };
  const result = await new HybridRetriever(store).retrieve({
    requestId: "request-3",
    workspaceId: "workspace-a",
    query: "opening hours",
    sourceIds: ["source-a"],
  });
  assert.deepEqual(result.citations.map(item => item.chunkId), ["chunk-right"]);
});

test("retrieval strictly bounds evidence count and context size", async () => {
  const store = {
    async searchLexical() {
      return Array.from({ length: 20 }, (_, index) => candidate(String(index), { content: "x".repeat(900) }));
    },
  };
  const result = await new HybridRetriever(store).retrieve({
    requestId: "request-4",
    workspaceId: "workspace-a",
    query: "large result",
    maxResults: 2,
    maxContextCharacters: 500,
  });
  assert.ok(result.evidence.length <= 2);
  assert.ok(result.context.length <= 500);
  assert.equal(result.diagnostics.truncated, true);
});

test("lexical retrieval remains available when dense retrieval fails", async () => {
  const store = {
    async searchDense() { throw new Error("vector service unavailable"); },
    async searchLexical() { return [candidate("lexical")]; },
  };
  const result = await new HybridRetriever(store).retrieve({
    requestId: "request-5",
    workspaceId: "workspace-a",
    query: "exact product code HC-100",
    queryEmbedding: [0.4],
  });
  assert.equal(result.citations[0].chunkId, "chunk-lexical");
  assert.equal(result.diagnostics.denseFailed, true);
  assert.equal(result.diagnostics.lexicalFailed, false);
});

test("retrieval fails closed when every retrieval path is unavailable", async () => {
  const store = {
    async searchDense() { throw new Error("dense failed"); },
    async searchLexical() { throw new Error("lexical failed"); },
  };
  await assert.rejects(
    () => new HybridRetriever(store).retrieve({ requestId: "request-6", workspaceId: "workspace-a", query: "policy", queryEmbedding: [0.1] }),
    RetrievalUnavailableError,
  );
});

test("retrieval validates unbounded or malformed requests before querying stores", async () => {
  let called = false;
  const store = { async searchLexical() { called = true; return []; } };
  const retriever = new HybridRetriever(store);
  await assert.rejects(() => retriever.retrieve({ requestId: "request-7", workspaceId: "workspace-a", query: "x".repeat(2_001) }), RetrievalValidationError);
  await assert.rejects(() => retriever.retrieve({ requestId: "request-8", workspaceId: "workspace-a", query: "valid", queryEmbedding: [Number.NaN] }), RetrievalValidationError);
  assert.equal(called, false);
});

test("ingestion normalizes, hashes, and chunks documents deterministically", () => {
  const content = `# Returns\r\n\r\nProducts may be returned within thirty days. ${"Details about eligibility and receipts. ".repeat(20)}\r\n\r\n## Exceptions\r\n\r\nFinal-sale products cannot be returned.`;
  const first = prepareDocumentIngestion({
    workspaceId: "workspace-a",
    sourceId: "source-a",
    externalId: "returns-policy",
    title: "Returns policy",
    content,
    access: { scope: "restricted", principals: [{ type: "role", id: "support" }] },
  }, { maxCharacters: 300, overlapCharacters: 40 });
  const second = prepareDocumentIngestion({
    workspaceId: "workspace-a",
    sourceId: "source-a",
    externalId: "returns-policy",
    title: "Returns policy",
    content,
    access: { scope: "restricted", principals: [{ type: "role", id: "support" }] },
  }, { maxCharacters: 300, overlapCharacters: 40 });

  assert.equal(first.contentHash, second.contentHash);
  assert.ok(first.chunks.length > 2);
  assert.ok(first.chunks.every((chunk, index) => chunk.ordinal === index && chunk.content.length <= 300 && chunk.tokenCount > 0));
  assert.ok(first.chunks.some(chunk => chunk.headingPath.includes("Returns")));
  assert.ok(first.chunks.some(chunk => chunk.headingPath.includes("Exceptions")));
});

test("ingestion rejects empty and unscoped restricted documents", () => {
  assert.throws(() => prepareDocumentIngestion({ workspaceId: "workspace-a", externalId: "empty", title: "Empty", content: "   " }), /empty/u);
  assert.throws(() => prepareDocumentIngestion({
    workspaceId: "workspace-a",
    externalId: "restricted",
    title: "Restricted",
    content: "Confidential policy",
    access: { scope: "restricted", principals: [] },
  }), /principal/u);
  assert.deepEqual(chunkKnowledgeText(""), []);
});
