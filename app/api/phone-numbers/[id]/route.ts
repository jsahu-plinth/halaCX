import { NextResponse } from "next/server";
import { z } from "zod";
import { readSession } from "@/lib/auth";
import { withTransaction } from "@/lib/db";
import { hasWorkspaceRole } from "@/lib/authorization";

const schema = z.object({
  agentId: z.string().uuid().optional(),
  scenario: z.enum(["receptionist", "appointment", "lead", "support"]).optional(),
  voiceProvider: z.enum(["openai", "sarvam", "cartesia"]).optional(),
  inboundEnabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0);

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!await hasWorkspaceRole(session.userId, session.workspaceId, ["owner", "admin"])) return NextResponse.json({ error: "Workspace administrator access is required." }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid routing configuration." }, { status: 400 });
  const { id } = await params;
  const updated = await withTransaction(async (client) => {
    if (parsed.data.agentId) {
      const agent = await client.query("select id from agents where id=$1 and workspace_id=$2", [parsed.data.agentId, session.workspaceId]);
      if (!agent.rows[0]) return null;
    }
    const result = await client.query(
      `update phone_numbers set
         agent_id=coalesce($1,agent_id),scenario=coalesce($2,scenario),voice_provider=coalesce($3,voice_provider),
         inbound_enabled=coalesce($4,inbound_enabled),updated_at=now()
       where id=$5 and workspace_id=$6
       returning id,phone_number,status,inbound_enabled,scenario,voice_provider,agent_id,updated_at`,
      [parsed.data.agentId || null, parsed.data.scenario || null, parsed.data.voiceProvider || null, parsed.data.inboundEnabled ?? null, id, session.workspaceId],
    );
    return result.rows[0] || null;
  });
  if (!updated) return NextResponse.json({ error: "Phone number or agent not found." }, { status: 404 });
  return NextResponse.json({ phoneNumber: updated });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!await hasWorkspaceRole(session.userId, session.workspaceId, ["owner", "admin"])) return NextResponse.json({ error: "Workspace administrator access is required." }, { status: 403 });
  const { id } = await params;
  const deleted = await withTransaction(async (client) => {
    const result = await client.query("delete from phone_numbers where id=$1 and workspace_id=$2 returning id", [id, session.workspaceId]);
    return result.rows[0] || null;
  });
  if (!deleted) return NextResponse.json({ error: "Phone number not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
