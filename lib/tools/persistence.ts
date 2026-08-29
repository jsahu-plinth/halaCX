import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  IdempotencyReservation,
  IdempotencyStore,
  JsonValue,
  ToolCapability,
  ToolPolicy,
  ToolResult,
} from "./foundation";

export type ToolExecutionState =
  | "proposed"
  | "confirmation_required"
  | "confirmation_verified"
  | "reserved"
  | "executing"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "blocked"
  | "verification_pending"
  | "verified"
  | "verification_failed"
  | "inconclusive";

const executionTransitions: Readonly<Record<ToolExecutionState, ReadonlySet<ToolExecutionState>>> = {
  proposed: new Set(["confirmation_required", "reserved", "blocked"]),
  confirmation_required: new Set(["confirmation_verified", "blocked"]),
  confirmation_verified: new Set(["blocked"]),
  reserved: new Set(["executing", "blocked"]),
  executing: new Set(["succeeded", "failed", "timed_out", "verification_pending"]),
  succeeded: new Set(),
  failed: new Set(),
  timed_out: new Set(["verification_pending"]),
  blocked: new Set(),
  verification_pending: new Set(["verified", "verification_failed", "inconclusive"]),
  verified: new Set(),
  verification_failed: new Set(),
  inconclusive: new Set(),
};

export function canTransitionToolExecution(from: ToolExecutionState, to: ToolExecutionState) {
  return executionTransitions[from].has(to);
}

export function assertToolExecutionTransition(from: ToolExecutionState, to: ToolExecutionState) {
  if (!canTransitionToolExecution(from, to)) throw new Error(`INVALID_TOOL_EXECUTION_TRANSITION:${from}:${to}`);
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) as JsonValue;
  }
  return value;
}

export function buildToolProposalDigest(input: {
  workspaceId: string;
  callId: string;
  agentId: string;
  capabilityId: string;
  arguments: Record<string, JsonValue>;
}) {
  return createHash("sha256").update(JSON.stringify(canonicalize(input as unknown as JsonValue))).digest("hex");
}

function safeDigestEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export type ConfirmationVerification =
  | { valid: true }
  | { valid: false; code: "CONFIRMATION_NOT_PENDING" | "CONFIRMATION_EXPIRED" | "CONFIRMATION_KIND_MISMATCH" | "PROPOSAL_DIGEST_MISMATCH" };

export function verifyConfirmation(input: {
  recordStatus: "required" | "confirmed" | "rejected" | "expired";
  requiredKind: "caller_explicit" | "human_approval";
  providedKind: "caller_explicit" | "human_approval";
  expectedProposalDigest: string;
  providedProposalDigest: string;
  expiresAt: Date;
  now: Date;
}): ConfirmationVerification {
  if (input.recordStatus !== "required") return { valid: false, code: "CONFIRMATION_NOT_PENDING" };
  if (input.expiresAt.getTime() <= input.now.getTime()) return { valid: false, code: "CONFIRMATION_EXPIRED" };
  if (input.requiredKind !== input.providedKind) return { valid: false, code: "CONFIRMATION_KIND_MISMATCH" };
  if (!safeDigestEqual(input.expectedProposalDigest, input.providedProposalDigest)) {
    return { valid: false, code: "PROPOSAL_DIGEST_MISMATCH" };
  }
  return { valid: true };
}

export type SqlQueryResult<Row> = { rows: Row[]; rowCount: number | null };

export interface ToolSqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<SqlQueryResult<Row>>;
}

export interface ToolPersistenceDatabase extends ToolSqlClient {
  withTransaction<Value>(work: (client: ToolSqlClient) => Promise<Value>): Promise<Value>;
}

type CapabilityVersionRow = {
  id: string;
  capability_key: string;
  version: number;
  provider_key: string;
  provider_tool_id: string;
  toolkit_slug: string;
  display_name: string;
  description: string;
  risk_level: ToolCapability["risk"];
  input_schema: ToolCapability["inputSchema"];
  timeout_ms: number;
  enabled: boolean;
};

export class PostgresToolRepository {
  private readonly database: ToolPersistenceDatabase;

  constructor(database: ToolPersistenceDatabase) {
    this.database = database;
  }

  async saveCapabilityVersion(capability: ToolCapability, version: number) {
    const inserted = await this.database.query<{ id: string }>(
      `insert into tool_capability_versions(
        capability_key,version,provider_key,provider_tool_id,toolkit_slug,display_name,description,risk_level,input_schema,timeout_ms,enabled
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
      on conflict(capability_key,version) do nothing returning id`,
      [capability.id, version, capability.providerKey, capability.providerToolId, capability.toolkit, capability.displayName,
        capability.description, capability.risk, JSON.stringify(capability.inputSchema), capability.timeoutMs, capability.enabled],
    );
    if (inserted.rows[0]) return inserted.rows[0].id;
    const existing = await this.database.query<CapabilityVersionRow>(
      "select * from tool_capability_versions where capability_key=$1 and version=$2",
      [capability.id, version],
    );
    const row = existing.rows[0];
    if (!row || !sameCapability(row, capability)) throw new Error("CAPABILITY_VERSION_CONFLICT");
    return row.id;
  }

  async publishReadOnlyPolicy(input: {
    workspaceId: string;
    capabilityVersionIds: readonly string[];
    allowedProviderKeys: readonly string[];
    allowedToolkits: readonly string[];
    createdBy?: string;
  }) {
    return this.database.withTransaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`tool-policy:${input.workspaceId}`]);
      const nextVersion = await client.query<{ version: number }>(
        "select coalesce(max(version),0)+1 as version from tool_policy_versions where workspace_id=$1",
        [input.workspaceId],
      );
      const version = Number(nextVersion.rows[0]?.version || 1);
      const uniqueCapabilityIds = [...new Set(input.capabilityVersionIds)];
      if (uniqueCapabilityIds.length) {
        const allowedCapabilities = await client.query<{ id: string }>(
          `select id from tool_capability_versions
           where id=any($1::uuid[]) and enabled=true and risk_level='read'`,
          [uniqueCapabilityIds],
        );
        if (allowedCapabilities.rows.length !== uniqueCapabilityIds.length) {
          throw new Error("READ_ONLY_POLICY_CAPABILITY_REJECTED");
        }
      }
      await client.query("update tool_policy_versions set status='archived' where workspace_id=$1 and status='published'", [input.workspaceId]);
      const policy = await client.query<{ id: string }>(
        `insert into tool_policy_versions(
          workspace_id,version,status,execution_mode,allowed_provider_keys,allowed_toolkits,created_by,published_at
        ) values($1,$2,'published','read_only',$3,$4,$5,now()) returning id`,
        [input.workspaceId, version, [...input.allowedProviderKeys], [...input.allowedToolkits], input.createdBy || null],
      );
      const policyId = policy.rows[0].id;
      for (const capabilityVersionId of uniqueCapabilityIds) {
        await client.query(
          "insert into tool_policy_capabilities(policy_version_id,capability_version_id,enabled) values($1,$2,true)",
          [policyId, capabilityVersionId],
        );
      }
      return { policyId, version, executionMode: "read_only" as const };
    });
  }

  async loadPublishedPolicy(workspaceId: string): Promise<{ policyId: string; version: number; policy: ToolPolicy } | null> {
    const policyResult = await this.database.query<{
      id: string;
      version: number;
      allowed_provider_keys: string[];
      allowed_toolkits: string[];
    }>(
      `select id,version,allowed_provider_keys,allowed_toolkits
       from tool_policy_versions where workspace_id=$1 and status='published' and execution_mode='read_only'
       order by version desc limit 1`,
      [workspaceId],
    );
    const row = policyResult.rows[0];
    if (!row) return null;
    const capabilities = await this.database.query<{ capability_key: string }>(
      `select c.capability_key from tool_policy_capabilities pc
       join tool_capability_versions c on c.id=pc.capability_version_id
       where pc.policy_version_id=$1 and pc.enabled=true and c.enabled=true`,
      [row.id],
    );
    return {
      policyId: row.id,
      version: row.version,
      policy: {
        workspaceId,
        enabledCapabilityIds: new Set(capabilities.rows.map((item) => item.capability_key)),
        allowedProviderKeys: new Set(row.allowed_provider_keys),
        allowedToolkits: new Set(row.allowed_toolkits),
      },
    };
  }

  async beginExecution(input: {
    workspaceId: string;
    callId?: string;
    agentId?: string;
    capabilityVersionId: string;
    policyVersionId: string;
    requestId: string;
    idempotencyKey: string;
    proposalDigest: string;
    arguments: Record<string, JsonValue>;
    riskLevel: ToolCapability["risk"];
    leaseMs?: number;
  }): Promise<{ status: "created"; executionId: string } | { status: "in_progress"; executionId?: string } | { status: "completed"; result: ToolResult }> {
    return this.database.withTransaction(async (client) => {
      const scope = `capability-version:${input.capabilityVersionId}`;
      const lockKey = `tool-execution:${input.workspaceId}:${scope}:${input.idempotencyKey}`;
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey]);
      const authorization = await client.query<{ risk_level: ToolCapability["risk"] }>(
        `select c.risk_level from tool_policy_versions p
         join tool_policy_capabilities pc on pc.policy_version_id=p.id and pc.enabled=true
         join tool_capability_versions c on c.id=pc.capability_version_id and c.enabled=true
         where p.id=$1 and p.workspace_id=$2 and p.status='published' and p.execution_mode='read_only'
           and c.id=$3 and c.risk_level='read'`,
        [input.policyVersionId, input.workspaceId, input.capabilityVersionId],
      );
      if (!authorization.rows[0] || authorization.rows[0].risk_level !== input.riskLevel || input.riskLevel !== "read") {
        throw new Error("TOOL_EXECUTION_NOT_AUTHORIZED");
      }
      const existing = await client.query<{ state: "in_progress" | "completed"; execution_id: string | null; result: ToolResult | null }>(
        "select state,execution_id,result from tool_idempotency_keys where workspace_id=$1 and scope=$2 and idempotency_key=$3",
        [input.workspaceId, scope, input.idempotencyKey],
      );
      if (existing.rows[0]?.state === "completed" && existing.rows[0].result) return { status: "completed", result: existing.rows[0].result };
      if (existing.rows[0]) return { status: "in_progress", executionId: existing.rows[0].execution_id || undefined };

      const execution = await client.query<{ id: string }>(
        `insert into tool_executions(
          workspace_id,call_id,agent_id,capability_version_id,policy_version_id,request_id,idempotency_key,proposal_digest,arguments,risk_level,status
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'proposed') returning id`,
        [input.workspaceId, input.callId || null, input.agentId || null, input.capabilityVersionId, input.policyVersionId,
          input.requestId, input.idempotencyKey, input.proposalDigest, JSON.stringify(input.arguments), input.riskLevel],
      );
      const executionId = execution.rows[0].id;
      const leaseOwner = randomUUID();
      await client.query(
        `insert into tool_idempotency_keys(
          workspace_id,scope,idempotency_key,state,execution_id,lease_owner,lease_expires_at
        ) values($1,$2,$3,'in_progress',$4,$5,now()+($6*interval '1 millisecond'))`,
        [input.workspaceId, scope, input.idempotencyKey, executionId, leaseOwner, input.leaseMs || 30_000],
      );
      await appendAudit(client, input.workspaceId, executionId, "execution.proposed", "system", null, { requestId: input.requestId });
      return { status: "created", executionId };
    });
  }

  async transitionExecution(input: {
    workspaceId: string;
    executionId: string;
    from: readonly ToolExecutionState[];
    to: ToolExecutionState;
    eventType: string;
    actorType: "system" | "model" | "caller" | "user" | "provider";
    actorId?: string;
    details?: Record<string, JsonValue>;
    result?: JsonValue;
    error?: JsonValue;
  }) {
    for (const from of input.from) assertToolExecutionTransition(from, input.to);
    return this.database.withTransaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`tool-execution:${input.executionId}`]);
      const update = await client.query<{ id: string }>(
        `update tool_executions set status=$1,result=coalesce($2::jsonb,result),error=coalesce($3::jsonb,error),
         started_at=case when $1='executing' then coalesce(started_at,now()) else started_at end,
         completed_at=case when $1 in ('succeeded','failed','timed_out','blocked','verified','verification_failed','inconclusive') then now() else completed_at end,
         updated_at=now() where id=$4 and workspace_id=$5 and status=any($6::text[]) returning id`,
        [input.to, input.result === undefined ? null : JSON.stringify(input.result), input.error === undefined ? null : JSON.stringify(input.error),
          input.executionId, input.workspaceId, [...input.from]],
      );
      if (!update.rows[0]) throw new Error("TOOL_EXECUTION_STATE_CONFLICT");
      await appendAudit(client, input.workspaceId, input.executionId, input.eventType, input.actorType, input.actorId || null, input.details || {});
    });
  }

  async requestConfirmation(input: {
    workspaceId: string;
    executionId: string;
    kind: "caller_explicit" | "human_approval";
    proposalDigest: string;
    expiresAt: Date;
  }) {
    return this.database.withTransaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`tool-execution:${input.executionId}`]);
      const execution = await client.query<{ status: ToolExecutionState; proposal_digest: string }>(
        "select status,proposal_digest from tool_executions where id=$1 and workspace_id=$2 for update",
        [input.executionId, input.workspaceId],
      );
      const row = execution.rows[0];
      if (!row || row.status !== "proposed" || !safeDigestEqual(row.proposal_digest, input.proposalDigest)) {
        throw new Error("CONFIRMATION_PROPOSAL_MISMATCH");
      }
      if (input.expiresAt.getTime() <= Date.now()) throw new Error("CONFIRMATION_EXPIRY_INVALID");
      await client.query(
        `insert into tool_confirmation_records(execution_id,confirmation_kind,status,proposal_digest,expires_at)
         values($1,$2,'required',$3,$4)`,
        [input.executionId, input.kind, input.proposalDigest, input.expiresAt],
      );
      await client.query("update tool_executions set status='confirmation_required',updated_at=now() where id=$1", [input.executionId]);
      await appendAudit(client, input.workspaceId, input.executionId, "confirmation.required", "system", null, { kind: input.kind });
    });
  }

  async decideConfirmation(input: {
    workspaceId: string;
    executionId: string;
    decision: "confirmed" | "rejected";
    kind: "caller_explicit" | "human_approval";
    proposalDigest: string;
    decidedBy: string;
    proofType: string;
    proofReference: string;
    now?: Date;
  }): Promise<ConfirmationVerification> {
    return this.database.withTransaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`tool-execution:${input.executionId}`]);
      const record = await client.query<{
        status: "required" | "confirmed" | "rejected" | "expired";
        confirmation_kind: "caller_explicit" | "human_approval";
        proposal_digest: string;
        expires_at: Date;
      }>(
        `select c.status,c.confirmation_kind,c.proposal_digest,c.expires_at
         from tool_confirmation_records c join tool_executions e on e.id=c.execution_id
         where c.execution_id=$1 and e.workspace_id=$2 for update of c,e`,
        [input.executionId, input.workspaceId],
      );
      const row = record.rows[0];
      if (!row) return { valid: false, code: "CONFIRMATION_NOT_PENDING" };
      const verification = verifyConfirmation({
        recordStatus: row.status,
        requiredKind: row.confirmation_kind,
        providedKind: input.kind,
        expectedProposalDigest: row.proposal_digest,
        providedProposalDigest: input.proposalDigest,
        expiresAt: new Date(row.expires_at),
        now: input.now || new Date(),
      });
      if (!verification.valid) {
        if (verification.code === "CONFIRMATION_EXPIRED") {
          await client.query("update tool_confirmation_records set status='expired',updated_at=now() where execution_id=$1", [input.executionId]);
          await client.query("update tool_executions set status='blocked',updated_at=now(),completed_at=now() where id=$1 and status='confirmation_required'", [input.executionId]);
          await appendAudit(client, input.workspaceId, input.executionId, "confirmation.expired", "system", null, {});
        }
        return verification;
      }
      await client.query(
        `update tool_confirmation_records set status=$1,decided_at=now(),decided_by=$2,proof_type=$3,proof_reference=$4,updated_at=now()
         where execution_id=$5 and status='required'`,
        [input.decision, input.decidedBy, input.proofType, input.proofReference, input.executionId],
      );
      const nextState: ToolExecutionState = input.decision === "confirmed" ? "confirmation_verified" : "blocked";
      await client.query(
        "update tool_executions set status=$1,updated_at=now(),completed_at=case when $1='blocked' then now() else completed_at end where id=$2 and status='confirmation_required'",
        [nextState, input.executionId],
      );
      await appendAudit(client, input.workspaceId, input.executionId, `confirmation.${input.decision}`, input.kind === "caller_explicit" ? "caller" : "user", input.decidedBy, {
        proofType: input.proofType,
      });
      return { valid: true };
    });
  }
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly owners = new Map<string, string>();
  private readonly database: ToolSqlClient;
  private readonly workspaceId: string;
  private readonly leaseMs: number;

  constructor(
    database: ToolSqlClient,
    workspaceId: string,
    leaseMs = 30_000,
  ) {
    if (!workspaceId) throw new Error("WORKSPACE_ID_REQUIRED");
    if (leaseMs < 1_000 || leaseMs > 300_000) throw new Error("IDEMPOTENCY_LEASE_INVALID");
    this.database = database;
    this.workspaceId = workspaceId;
    this.leaseMs = leaseMs;
  }

  async reserve(scope: string, key: string): Promise<IdempotencyReservation> {
    const owner = randomUUID();
    const reserved = await this.database.query<{ state: "in_progress"; result: ToolResult | null }>(
      `insert into tool_idempotency_keys(workspace_id,scope,idempotency_key,state,lease_owner,lease_expires_at)
       values($1,$2,$3,'in_progress',$4,now()+($5*interval '1 millisecond'))
       on conflict(workspace_id,scope,idempotency_key) do update set
         lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at,updated_at=now()
       where tool_idempotency_keys.state='in_progress' and tool_idempotency_keys.lease_expires_at<=now()
       returning state,result`,
      [this.workspaceId, scope, key, owner, this.leaseMs],
    );
    const localKey = `${scope}:${key}`;
    if (reserved.rows[0]) {
      this.owners.set(localKey, owner);
      return { status: "reserved" };
    }
    const existing = await this.database.query<{ state: "in_progress" | "completed"; result: ToolResult | null }>(
      "select state,result from tool_idempotency_keys where workspace_id=$1 and scope=$2 and idempotency_key=$3",
      [this.workspaceId, scope, key],
    );
    const row = existing.rows[0];
    if (row?.state === "completed" && row.result) return { status: "completed", result: row.result };
    return { status: "in_progress" };
  }

  async complete(scope: string, key: string, result: ToolResult) {
    const localKey = `${scope}:${key}`;
    const owner = this.owners.get(localKey);
    if (!owner) throw new Error("IDEMPOTENCY_RESERVATION_NOT_OWNED");
    const completed = await this.database.query(
      `update tool_idempotency_keys set state='completed',result=$1::jsonb,updated_at=now()
       where workspace_id=$2 and scope=$3 and idempotency_key=$4 and state='in_progress' and lease_owner=$5`,
      [JSON.stringify(result), this.workspaceId, scope, key, owner],
    );
    this.owners.delete(localKey);
    if (!completed.rowCount) throw new Error("IDEMPOTENCY_LEASE_LOST");
  }

  async release(scope: string, key: string) {
    const localKey = `${scope}:${key}`;
    const owner = this.owners.get(localKey);
    if (!owner) return;
    await this.database.query(
      "delete from tool_idempotency_keys where workspace_id=$1 and scope=$2 and idempotency_key=$3 and state='in_progress' and lease_owner=$4",
      [this.workspaceId, scope, key, owner],
    );
    this.owners.delete(localKey);
  }
}

async function appendAudit(
  client: ToolSqlClient,
  workspaceId: string,
  executionId: string,
  eventType: string,
  actorType: "system" | "model" | "caller" | "user" | "provider",
  actorId: string | null,
  details: Record<string, JsonValue>,
) {
  await client.query(
    `insert into tool_audit_events(workspace_id,execution_id,sequence,event_type,actor_type,actor_id,details)
     select $1,$2,coalesce(max(sequence),0)+1,$3,$4,$5,$6::jsonb from tool_audit_events where execution_id=$2`,
    [workspaceId, executionId, eventType, actorType, actorId, JSON.stringify(details)],
  );
}

function sameCapability(row: CapabilityVersionRow, capability: ToolCapability) {
  return row.capability_key === capability.id
    && row.provider_key === capability.providerKey
    && row.provider_tool_id === capability.providerToolId
    && row.toolkit_slug === capability.toolkit
    && row.display_name === capability.displayName
    && row.description === capability.description
    && row.risk_level === capability.risk
    && JSON.stringify(canonicalize(row.input_schema as JsonValue)) === JSON.stringify(canonicalize(capability.inputSchema as JsonValue))
    && row.timeout_ms === capability.timeoutMs
    && row.enabled === capability.enabled;
}
