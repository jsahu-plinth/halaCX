import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryIdempotencyStore,
  ToolCatalog,
  ToolGateway,
} from "../lib/tools/foundation.ts";

const readCapability = {
  id: "composio.calendar.find_events",
  providerKey: "composio",
  providerToolId: "GOOGLECALENDAR_FIND_EVENT",
  toolkit: "googlecalendar",
  displayName: "Find events",
  description: "Find matching calendar events",
  risk: "read",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: { query: { type: "string", minLength: 1, maxLength: 200 } },
    additionalProperties: false,
  },
  timeoutMs: 200,
  enabled: true,
};

const writeCapability = {
  ...readCapability,
  id: "composio.calendar.create_event",
  providerToolId: "GOOGLECALENDAR_CREATE_EVENT",
  displayName: "Create event",
  risk: "external_write",
};

function proposal(overrides = {}) {
  return {
    requestId: "request-1",
    idempotencyKey: "idem-1",
    callId: "call-1",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    capabilityId: readCapability.id,
    arguments: { query: "tomorrow" },
    confirmation: { status: "not_required" },
    proposedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function policy(...capabilities) {
  return {
    workspaceId: "workspace-1",
    enabledCapabilityIds: new Set(capabilities),
    allowedProviderKeys: new Set(["composio"]),
    allowedToolkits: new Set(["googlecalendar"]),
  };
}

test("executes only an allowlisted read capability", async () => {
  let calls = 0;
  const provider = {
    key: "composio",
    async execute(arguments_, context) {
      calls += 1;
      assert.equal(context.workspaceId, "workspace-1");
      return { providerExecutionId: "external-1", data: { events: [arguments_.query] } };
    },
  };
  const gateway = new ToolGateway(new ToolCatalog([readCapability]), [provider], new InMemoryIdempotencyStore());
  const result = await gateway.execute(proposal(), policy(readCapability.id));
  assert.equal(result.status, "succeeded");
  assert.equal(result.providerExecutionId, "external-1");
  assert.equal(result.verification.status, "not_required");
  assert.equal(calls, 1);
});

test("blocks unknown capabilities before a provider is called", async () => {
  let called = false;
  const provider = { key: "composio", async execute() { called = true; return { data: null }; } };
  const gateway = new ToolGateway(new ToolCatalog([readCapability]), [provider], new InMemoryIdempotencyStore());
  const result = await gateway.execute(proposal({ capabilityId: "composio.unknown" }), policy("composio.unknown"));
  assert.equal(result.status, "blocked");
  assert.equal(result.error.code, "UNKNOWN_CAPABILITY");
  assert.equal(called, false);
});

test("validates arguments against the catalog schema", async () => {
  const provider = { key: "composio", async execute() { throw new Error("must not execute"); } };
  const gateway = new ToolGateway(new ToolCatalog([readCapability]), [provider], new InMemoryIdempotencyStore());
  const result = await gateway.execute(proposal({ arguments: { query: "", injected: true } }), policy(readCapability.id));
  assert.equal(result.status, "blocked");
  assert.equal(result.error.code, "INVALID_ARGUMENTS");
});

test("requires confirmation and still refuses writes after confirmation", async () => {
  const provider = { key: "composio", async execute() { throw new Error("writes must stay disabled"); } };
  const gateway = new ToolGateway(new ToolCatalog([writeCapability]), [provider], new InMemoryIdempotencyStore());
  const first = await gateway.execute(proposal({ capabilityId: writeCapability.id }), policy(writeCapability.id));
  assert.equal(first.status, "confirmation_required");
  assert.equal(first.confirmation.kind, "caller_explicit");

  const confirmed = await gateway.execute(proposal({
    capabilityId: writeCapability.id,
    confirmation: { status: "confirmed", kind: "caller_explicit", confirmedAt: new Date().toISOString(), confirmedBy: "caller" },
  }), policy(writeCapability.id));
  assert.equal(confirmed.status, "blocked");
  assert.equal(confirmed.error.code, "WRITE_EXECUTION_NOT_ENABLED");
});

test("deduplicates completed executions", async () => {
  let calls = 0;
  const provider = { key: "composio", async execute() { calls += 1; return { data: { calls } }; } };
  const gateway = new ToolGateway(new ToolCatalog([readCapability]), [provider], new InMemoryIdempotencyStore());
  const first = await gateway.execute(proposal(), policy(readCapability.id));
  const second = await gateway.execute(proposal({ requestId: "request-2" }), policy(readCapability.id));
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("aborts and classifies provider timeouts", async () => {
  const slowCapability = { ...readCapability, timeoutMs: 100 };
  const provider = {
    key: "composio",
    execute(_arguments, context) {
      return new Promise((resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        setTimeout(() => resolve({ data: null }), 500);
      });
    },
  };
  const gateway = new ToolGateway(new ToolCatalog([slowCapability]), [provider], new InMemoryIdempotencyStore());
  const result = await gateway.execute(proposal(), policy(readCapability.id));
  assert.equal(result.status, "timed_out");
  assert.equal(result.error.code, "TOOL_TIMEOUT");
});
