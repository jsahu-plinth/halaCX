export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  enum?: JsonValue[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
};

export type ToolRiskLevel = "read" | "reversible_write" | "external_write" | "sensitive" | "destructive";

export type ConfirmationKind = "none" | "caller_explicit" | "human_approval";

export type ConfirmationState =
  | { status: "not_required" }
  | { status: "required"; kind: Exclude<ConfirmationKind, "none"> }
  | { status: "confirmed"; kind: Exclude<ConfirmationKind, "none">; confirmedAt: string; confirmedBy: string }
  | { status: "rejected"; kind: Exclude<ConfirmationKind, "none">; rejectedAt: string }
  | { status: "expired"; kind: Exclude<ConfirmationKind, "none">; expiredAt: string };

export type VerificationState =
  | { status: "not_required" }
  | { status: "pending" }
  | { status: "verified"; evidence?: JsonValue }
  | { status: "failed"; reason: string; evidence?: JsonValue }
  | { status: "inconclusive"; reason: string; evidence?: JsonValue };

export type ToolCapability = {
  id: string;
  providerKey: string;
  providerToolId: string;
  toolkit: string;
  displayName: string;
  description: string;
  risk: ToolRiskLevel;
  inputSchema: JsonSchema;
  timeoutMs: number;
  enabled: boolean;
};

export type ToolProposal = {
  requestId: string;
  idempotencyKey: string;
  callId: string;
  workspaceId: string;
  agentId: string;
  capabilityId: string;
  arguments: Record<string, JsonValue>;
  confirmation: ConfirmationState;
  proposedAt: string;
};

export type ToolExecutionContext = {
  requestId: string;
  callId: string;
  workspaceId: string;
  agentId: string;
  capability: ToolCapability;
  signal: AbortSignal;
};

export type ProviderExecution = {
  providerExecutionId?: string;
  data: JsonValue;
  metadata?: Record<string, JsonValue>;
};

export type ProviderVerification =
  | { status: "verified"; evidence?: JsonValue }
  | { status: "failed"; reason: string; evidence?: JsonValue }
  | { status: "inconclusive"; reason: string; evidence?: JsonValue };

export interface ToolProvider {
  readonly key: string;
  execute(arguments_: Record<string, JsonValue>, context: ToolExecutionContext): Promise<ProviderExecution>;
  verify?(execution: ProviderExecution, context: ToolExecutionContext): Promise<ProviderVerification>;
}

export type ToolPolicy = {
  workspaceId: string;
  enabledCapabilityIds: ReadonlySet<string>;
  allowedProviderKeys?: ReadonlySet<string>;
  allowedToolkits?: ReadonlySet<string>;
};

export type ToolPolicyDecision =
  | { outcome: "allow"; confirmationKind: "none"; verificationRequired: false }
  | { outcome: "require_confirmation"; confirmationKind: Exclude<ConfirmationKind, "none">; reason: string }
  | { outcome: "deny"; code: string; reason: string };

export type ToolResultStatus = "succeeded" | "failed" | "blocked" | "confirmation_required" | "timed_out" | "in_progress";

export type ToolResult = {
  requestId: string;
  idempotencyKey: string;
  capabilityId: string;
  status: ToolResultStatus;
  startedAt: string;
  completedAt: string;
  data?: JsonValue;
  providerExecutionId?: string;
  error?: { code: string; message: string; retryable: boolean };
  confirmation: ConfirmationState;
  verification: VerificationState;
};

export type IdempotencyReservation =
  | { status: "reserved" }
  | { status: "in_progress" }
  | { status: "completed"; result: ToolResult };

export interface IdempotencyStore {
  reserve(scope: string, key: string): Promise<IdempotencyReservation>;
  complete(scope: string, key: string, result: ToolResult): Promise<void>;
  release(scope: string, key: string): Promise<void>;
}

export class ToolTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Tool execution exceeded ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ToolCatalog {
  private readonly capabilities: ReadonlyMap<string, ToolCapability>;

  constructor(entries: readonly ToolCapability[]) {
    const capabilities = new Map<string, ToolCapability>();
    for (const entry of entries) {
      if (!entry.id || !entry.providerKey || !entry.providerToolId || !entry.toolkit) {
        throw new Error("Tool capabilities require stable IDs, providers, toolkits, and provider tool IDs");
      }
      if (capabilities.has(entry.id)) throw new Error(`Duplicate tool capability: ${entry.id}`);
      if (!Number.isFinite(entry.timeoutMs) || entry.timeoutMs < 100 || entry.timeoutMs > 30_000) {
        throw new Error(`Invalid timeout for tool capability: ${entry.id}`);
      }
      capabilities.set(entry.id, Object.freeze({ ...entry }));
    }
    this.capabilities = capabilities;
  }

  get(capabilityId: string) {
    return this.capabilities.get(capabilityId);
  }

  list() {
    return [...this.capabilities.values()];
  }
}

function valueType(value: JsonValue) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function validateJsonSchema(value: JsonValue, schema: JsonSchema, path = "arguments"): string[] {
  const errors: string[] = [];
  const actualType = valueType(value);
  if (schema.type) {
    const validInteger = schema.type === "integer" && actualType === "number" && Number.isInteger(value);
    if (!validInteger && actualType !== schema.type) return [`${path} must be ${schema.type}`];
  }
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    errors.push(`${path} must be one of the allowlisted values`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is too long`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} is below the minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} is above the maximum`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateJsonSchema(item, schema.items!, `${path}[${index}]`)));
  }
  if (actualType === "object" && value !== null && !Array.isArray(value)) {
    const objectValue = value as Record<string, JsonValue>;
    for (const key of schema.required || []) {
      if (!(key in objectValue)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, item] of Object.entries(objectValue)) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema) errors.push(...validateJsonSchema(item, propertySchema, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }
  return errors;
}

export function confirmationKindForRisk(risk: ToolRiskLevel): ConfirmationKind {
  if (risk === "read") return "none";
  if (risk === "sensitive" || risk === "destructive") return "human_approval";
  return "caller_explicit";
}

export function evaluateToolPolicy(capability: ToolCapability, proposal: ToolProposal, policy: ToolPolicy): ToolPolicyDecision {
  if (proposal.workspaceId !== policy.workspaceId) {
    return { outcome: "deny", code: "WORKSPACE_MISMATCH", reason: "The proposal is outside the policy workspace" };
  }
  if (!capability.enabled || !policy.enabledCapabilityIds.has(capability.id)) {
    return { outcome: "deny", code: "CAPABILITY_NOT_ALLOWED", reason: "The capability is not enabled for this workspace" };
  }
  if (policy.allowedProviderKeys && !policy.allowedProviderKeys.has(capability.providerKey)) {
    return { outcome: "deny", code: "PROVIDER_NOT_ALLOWED", reason: "The provider is not enabled for this workspace" };
  }
  if (policy.allowedToolkits && !policy.allowedToolkits.has(capability.toolkit)) {
    return { outcome: "deny", code: "TOOLKIT_NOT_ALLOWED", reason: "The toolkit is not enabled for this workspace" };
  }
  const confirmationKind = confirmationKindForRisk(capability.risk);
  if (confirmationKind !== "none" && (proposal.confirmation.status !== "confirmed" || proposal.confirmation.kind !== confirmationKind)) {
    return { outcome: "require_confirmation", confirmationKind, reason: "This action requires an explicit, matching confirmation" };
  }
  if (capability.risk !== "read") {
    return { outcome: "deny", code: "WRITE_EXECUTION_NOT_ENABLED", reason: "The current Tool Gateway foundation permits read-only execution" };
  }
  return { outcome: "allow", confirmationKind: "none", verificationRequired: false };
}

function finishedResult(
  proposal: ToolProposal,
  status: ToolResultStatus,
  startedAt: string,
  completedAt: string,
  overrides: Partial<ToolResult> = {},
): ToolResult {
  return {
    requestId: proposal.requestId,
    idempotencyKey: proposal.idempotencyKey,
    capabilityId: proposal.capabilityId,
    status,
    startedAt,
    completedAt,
    confirmation: proposal.confirmation,
    verification: { status: "not_required" },
    ...overrides,
  };
}

async function runWithTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new ToolTimeoutError(timeoutMs));
          reject(new ToolTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ToolGateway {
  private readonly providers: ReadonlyMap<string, ToolProvider>;
  private readonly catalog: ToolCatalog;
  private readonly idempotency: IdempotencyStore;
  private readonly now: () => Date;

  constructor(
    catalog: ToolCatalog,
    providers: readonly ToolProvider[],
    idempotency: IdempotencyStore,
    now: () => Date = () => new Date(),
  ) {
    this.catalog = catalog;
    this.idempotency = idempotency;
    this.now = now;
    const providerMap = new Map<string, ToolProvider>();
    for (const provider of providers) {
      if (providerMap.has(provider.key)) throw new Error(`Duplicate tool provider: ${provider.key}`);
      providerMap.set(provider.key, provider);
    }
    this.providers = providerMap;
  }

  async execute(proposal: ToolProposal, policy: ToolPolicy): Promise<ToolResult> {
    const startedAt = this.now().toISOString();
    const capability = this.catalog.get(proposal.capabilityId);
    if (!capability) {
      return finishedResult(proposal, "blocked", startedAt, this.now().toISOString(), {
        error: { code: "UNKNOWN_CAPABILITY", message: "The requested capability is not in the allowlisted catalog", retryable: false },
      });
    }
    const schemaErrors = validateJsonSchema(proposal.arguments, capability.inputSchema);
    if (schemaErrors.length) {
      return finishedResult(proposal, "blocked", startedAt, this.now().toISOString(), {
        error: { code: "INVALID_ARGUMENTS", message: schemaErrors.join("; "), retryable: false },
      });
    }
    const decision = evaluateToolPolicy(capability, proposal, policy);
    if (decision.outcome === "require_confirmation") {
      return finishedResult(proposal, "confirmation_required", startedAt, this.now().toISOString(), {
        confirmation: { status: "required", kind: decision.confirmationKind },
        error: { code: "CONFIRMATION_REQUIRED", message: decision.reason, retryable: false },
      });
    }
    if (decision.outcome === "deny") {
      return finishedResult(proposal, "blocked", startedAt, this.now().toISOString(), {
        error: { code: decision.code, message: decision.reason, retryable: false },
      });
    }
    const provider = this.providers.get(capability.providerKey);
    if (!provider) {
      return finishedResult(proposal, "failed", startedAt, this.now().toISOString(), {
        error: { code: "PROVIDER_UNAVAILABLE", message: "The capability provider is unavailable", retryable: true },
      });
    }

    const scope = `${proposal.workspaceId}:${proposal.capabilityId}`;
    const reservation = await this.idempotency.reserve(scope, proposal.idempotencyKey);
    if (reservation.status === "completed") return reservation.result;
    if (reservation.status === "in_progress") {
      return finishedResult(proposal, "in_progress", startedAt, this.now().toISOString(), {
        error: { code: "EXECUTION_IN_PROGRESS", message: "An execution with this idempotency key is already running", retryable: true },
      });
    }

    try {
      const execution = await runWithTimeout(capability.timeoutMs, (signal) => provider.execute(proposal.arguments, {
        requestId: proposal.requestId,
        callId: proposal.callId,
        workspaceId: proposal.workspaceId,
        agentId: proposal.agentId,
        capability,
        signal,
      }));
      const result = finishedResult(proposal, "succeeded", startedAt, this.now().toISOString(), {
        data: execution.data,
        providerExecutionId: execution.providerExecutionId,
      });
      await this.idempotency.complete(scope, proposal.idempotencyKey, result);
      return result;
    } catch (error) {
      const timedOut = error instanceof ToolTimeoutError;
      const result = finishedResult(proposal, timedOut ? "timed_out" : "failed", startedAt, this.now().toISOString(), {
        error: {
          code: timedOut ? "TOOL_TIMEOUT" : "PROVIDER_EXECUTION_FAILED",
          message: error instanceof Error ? error.message : "Tool execution failed",
          retryable: true,
        },
      });
      await this.idempotency.complete(scope, proposal.idempotencyKey, result);
      return result;
    }
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { state: "in_progress" } | { state: "completed"; result: ToolResult }>();

  async reserve(scope: string, key: string): Promise<IdempotencyReservation> {
    const compoundKey = `${scope}:${key}`;
    const existing = this.entries.get(compoundKey);
    if (existing?.state === "completed") return { status: "completed", result: existing.result };
    if (existing) return { status: "in_progress" };
    this.entries.set(compoundKey, { state: "in_progress" });
    return { status: "reserved" };
  }

  async complete(scope: string, key: string, result: ToolResult) {
    this.entries.set(`${scope}:${key}`, { state: "completed", result });
  }

  async release(scope: string, key: string) {
    this.entries.delete(`${scope}:${key}`);
  }
}
