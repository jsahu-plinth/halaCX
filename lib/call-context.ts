import { createHash } from "node:crypto";
import { isDatabaseConfigured, query, withTransaction } from "@/lib/db";

export type ContextKey = "receptionist" | "appointment" | "lead" | "support";

const contexts: Record<ContextKey, string> = {
  receptionist: "Act as a front-desk receptionist. Answer questions about hours and services, capture the caller's name and message, and offer a human follow-up when needed.",
  appointment: "Act as an appointment coordinator. Ask what service the caller needs, check the available information, confirm their preferred time, and summarize the booking.",
  lead: "Act as a lead qualification agent. Ask about the caller's company, need, urgency, and preferred next step. Keep the conversation helpful rather than sales-heavy.",
  support: "Act as a customer-support agent. Ask for the issue and an order or reference number, explain the next action, and escalate anything that needs human judgment.",
};

export function normalizeContext(value: string): ContextKey {
  return value in contexts ? value as ContextKey : "receptionist";
}

export function contextInstructions(context: string) {
  return contexts[normalizeContext(context)];
}

export async function createPendingCallContext(value: string, workspaceId?: string) {
  const context = normalizeContext(value);
  if (!isDatabaseConfigured) return { id: null, context };
  const result = await query<{ id: string }>("insert into pending_call_contexts(workspace_id,context) values($1,$2) returning id", [workspaceId || null, context]);
  return { id: result.rows[0].id, context };
}

export async function attachProviderCall(contextId: string | null, providerCallId: string) {
  if (contextId && isDatabaseConfigured) await query("update pending_call_contexts set provider_call_id=$1 where id=$2", [providerCallId, contextId]);
}

export async function discardPendingCall(contextId: string | null) {
  if (contextId && isDatabaseConfigured) await query("delete from pending_call_contexts where id=$1", [contextId]);
}

export async function consumePendingCallContext(contextId?: string | null) {
  if (!isDatabaseConfigured) return { context: "receptionist" as ContextKey, workspaceId: null, providerCallId: null };
  if (!contextId) return { context: "receptionist" as ContextKey, workspaceId: null, providerCallId: null };
  return withTransaction(async (client) => {
    await client.query("delete from pending_call_contexts where expires_at <= now()");
    const result = await client.query<{ context: ContextKey; workspace_id: string | null; provider_call_id: string | null }>(
      "delete from pending_call_contexts where id=(select id from pending_call_contexts where id=$1 and expires_at>now() for update skip locked) returning context,workspace_id,provider_call_id",
      [contextId],
    );
    const row = result.rows[0];
    return { context: normalizeContext(row?.context || "receptionist"), workspaceId: row?.workspace_id || null, providerCallId: row?.provider_call_id || null };
  });
}

export async function allowDemoCall(key: string) {
  if (!isDatabaseConfigured) return true;
  const clientHash = createHash("sha256").update(key).digest("hex");
  return withTransaction(async (client) => {
    await client.query("delete from demo_requests where created_at < now() - interval '24 hours'");
    const recent = await client.query<{ count: string }>("select count(*)::text as count from demo_requests where client_hash=$1 and created_at>now()-interval '10 minutes'", [clientHash]);
    if (Number(recent.rows[0].count) >= 3) return false;
    await client.query("insert into demo_requests(client_hash) values($1)", [clientHash]);
    return true;
  });
}
