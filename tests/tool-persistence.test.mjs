import assert from "node:assert/strict";
import test from "node:test";
import {
  assertToolExecutionTransition,
  buildToolProposalDigest,
  canTransitionToolExecution,
  PostgresIdempotencyStore,
  PostgresToolRepository,
  verifyConfirmation,
} from "../lib/tools/persistence.ts";

test("proposal digests are canonical and bind the exact action", () => {
  const base = {
    workspaceId: "workspace-1",
    callId: "call-1",
    agentId: "agent-1",
    capabilityId: "calendar.create",
    arguments: { title: "Review", attendees: ["a@example.com"], slot: { end: "11:00", start: "10:00" } },
  };
  const reordered = {
    ...base,
    arguments: { slot: { start: "10:00", end: "11:00" }, attendees: ["a@example.com"], title: "Review" },
  };
  assert.equal(buildToolProposalDigest(base), buildToolProposalDigest(reordered));
  assert.notEqual(buildToolProposalDigest(base), buildToolProposalDigest({ ...base, arguments: { ...base.arguments, title: "Other" } }));
});

test("execution state machine permits only explicit transitions", () => {
  assert.equal(canTransitionToolExecution("proposed", "reserved"), true);
  assert.equal(canTransitionToolExecution("executing", "succeeded"), true);
  assert.equal(canTransitionToolExecution("succeeded", "executing"), false);
  assert.throws(() => assertToolExecutionTransition("blocked", "executing"), /INVALID_TOOL_EXECUTION_TRANSITION/);
});

test("confirmation proof must match kind, digest, pending state, and expiry", () => {
  const future = new Date(Date.now() + 60_000);
  const valid = verifyConfirmation({
    recordStatus: "required",
    requiredKind: "caller_explicit",
    providedKind: "caller_explicit",
    expectedProposalDigest: "digest-1",
    providedProposalDigest: "digest-1",
    expiresAt: future,
    now: new Date(),
  });
  assert.deepEqual(valid, { valid: true });
  assert.equal(verifyConfirmation({
    recordStatus: "required",
    requiredKind: "human_approval",
    providedKind: "caller_explicit",
    expectedProposalDigest: "digest-1",
    providedProposalDigest: "digest-1",
    expiresAt: future,
    now: new Date(),
  }).code, "CONFIRMATION_KIND_MISMATCH");
  assert.equal(verifyConfirmation({
    recordStatus: "required",
    requiredKind: "caller_explicit",
    providedKind: "caller_explicit",
    expectedProposalDigest: "digest-1",
    providedProposalDigest: "digest-2",
    expiresAt: future,
    now: new Date(),
  }).code, "PROPOSAL_DIGEST_MISMATCH");
  assert.equal(verifyConfirmation({
    recordStatus: "required",
    requiredKind: "caller_explicit",
    providedKind: "caller_explicit",
    expectedProposalDigest: "digest-1",
    providedProposalDigest: "digest-1",
    expiresAt: new Date(0),
    now: new Date(),
  }).code, "CONFIRMATION_EXPIRED");
});

test("Postgres idempotency reservation uses workspace scope and lease ownership", async () => {
  const calls = [];
  const database = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.startsWith("insert into tool_idempotency_keys")) return { rows: [{ state: "in_progress", result: null }], rowCount: 1 };
      if (text.startsWith("update tool_idempotency_keys")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const store = new PostgresIdempotencyStore(database, "workspace-1", 10_000);
  assert.deepEqual(await store.reserve("workspace-1:calendar.find", "idem-1"), { status: "reserved" });
  await store.complete("workspace-1:calendar.find", "idem-1", {
    requestId: "request-1",
    idempotencyKey: "idem-1",
    capabilityId: "calendar.find",
    status: "succeeded",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    confirmation: { status: "not_required" },
    verification: { status: "not_required" },
  });
  assert.equal(calls[0].values[0], "workspace-1");
  assert.equal(calls[0].values[4], 10_000);
  assert.equal(calls[1].values[1], "workspace-1");
  assert.equal(typeof calls[1].values[4], "string");
});

test("Postgres idempotency returns an existing completed result", async () => {
  const prior = {
    requestId: "request-prior",
    idempotencyKey: "idem-1",
    capabilityId: "calendar.find",
    status: "succeeded",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    confirmation: { status: "not_required" },
    verification: { status: "not_required" },
  };
  let queryCount = 0;
  const database = {
    async query(text) {
      queryCount += 1;
      if (text.startsWith("insert into tool_idempotency_keys")) return { rows: [], rowCount: 0 };
      return { rows: [{ state: "completed", result: prior }], rowCount: 1 };
    },
  };
  const store = new PostgresIdempotencyStore(database, "workspace-1");
  assert.deepEqual(await store.reserve("workspace-1:calendar.find", "idem-1"), { status: "completed", result: prior });
  assert.equal(queryCount, 2);
});

test("read-only policy publication rejects write-risk capability versions", async () => {
  const client = {
    async query(text) {
      if (text.startsWith("select pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
      if (text.startsWith("select coalesce(max(version)")) return { rows: [{ version: 1 }], rowCount: 1 };
      if (text.includes("risk_level='read'")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const repository = new PostgresToolRepository({
    query: client.query,
    async withTransaction(work) { return work(client); },
  });
  await assert.rejects(repository.publishReadOnlyPolicy({
    workspaceId: "workspace-1",
    capabilityVersionIds: ["00000000-0000-0000-0000-000000000001"],
    allowedProviderKeys: ["composio"],
    allowedToolkits: ["googlecalendar"],
  }), /READ_ONLY_POLICY_CAPABILITY_REJECTED/);
});
