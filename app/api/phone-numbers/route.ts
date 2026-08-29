import { NextResponse } from "next/server";
import { z } from "zod";
import { readSession } from "@/lib/auth";
import { query, withTransaction } from "@/lib/db";
import { configureTwilioNumber, findOwnedTwilioNumber } from "@/lib/twilio-rest";
import { hasWorkspaceRole } from "@/lib/authorization";

const schema = z.object({
  phoneNumber: z.string().transform((value) => value.replace(/[\s()-]/g, "")).refine((value) => /^\+[1-9]\d{7,14}$/.test(value)),
  agentId: z.string().uuid().optional(),
  scenario: z.enum(["receptionist", "appointment", "lead", "support"]).default("receptionist"),
  voiceProvider: z.enum(["openai", "sarvam", "cartesia"]).default("openai"),
});

export async function GET() {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await query(
    `select pn.id,pn.phone_number,pn.friendly_name,pn.country_code,pn.status,pn.inbound_enabled,
            pn.scenario,pn.voice_provider,pn.agent_id,pn.last_error,pn.updated_at,a.name as agent_name
       from phone_numbers pn left join agents a on a.id=pn.agent_id
      where pn.workspace_id=$1 order by pn.created_at`,
    [session.workspaceId],
  );
  return NextResponse.json({ phoneNumbers: result.rows });
}

export async function POST(request: Request) {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!await hasWorkspaceRole(session.userId, session.workspaceId, ["owner", "admin"])) return NextResponse.json({ error: "Workspace administrator access is required." }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid E.164 phone number and routing configuration." }, { status: 400 });
  const appUrl = process.env.APP_URL;
  if (!appUrl) return NextResponse.json({ error: "APP_URL is not configured." }, { status: 503 });

  const owned = await findOwnedTwilioNumber(parsed.data.phoneNumber).catch((error) => ({ error: error instanceof Error ? error.message : "Twilio lookup failed" }));
  if (!owned || "error" in owned) return NextResponse.json({ error: owned && "error" in owned ? owned.error : "This number is not owned by the configured Twilio account." }, { status: 400 });
  if (owned.voice_application_sid || owned.trunk_sid) {
    return NextResponse.json({ error: "Detach this number from its TwiML Application or SIP Trunk before assigning it directly to HalaCX." }, { status: 409 });
  }

  const provisioned = await withTransaction(async (client) => {
    const agent = parsed.data.agentId
      ? await client.query<{ id: string }>("select id from agents where id=$1 and workspace_id=$2", [parsed.data.agentId, session.workspaceId])
      : await client.query<{ id: string }>("select id from agents where workspace_id=$1 order by created_at limit 1", [session.workspaceId]);
    if (!agent.rows[0]) throw new Error("No agent is available in this workspace.");
    const result = await client.query<{ id: string }>(
      `insert into phone_numbers(workspace_id,agent_id,provider,provider_number_id,phone_number,friendly_name,country_code,status,scenario,voice_provider)
       values($1,$2,'twilio',$3,$4,$5,$6,'provisioning',$7,$8)
       on conflict(phone_number) do update set agent_id=excluded.agent_id,friendly_name=excluded.friendly_name,
         scenario=excluded.scenario,voice_provider=excluded.voice_provider,status='provisioning',last_error=null,updated_at=now()
       where phone_numbers.workspace_id=excluded.workspace_id
       returning id`,
      [session.workspaceId, agent.rows[0].id, owned.sid, owned.phone_number, owned.friendly_name || owned.phone_number, owned.phone_number.startsWith("+971") ? "AE" : owned.phone_number.startsWith("+91") ? "IN" : null, parsed.data.scenario, parsed.data.voiceProvider],
    );
    if (!result.rows[0]) throw new Error("This phone number is already assigned to another workspace.");
    return result.rows[0].id;
  }).catch((error) => ({ error: error instanceof Error ? error.message : "Unable to assign number" }));
  if (typeof provisioned !== "string") return NextResponse.json({ error: provisioned.error }, { status: 409 });

  try {
    await configureTwilioNumber(owned.sid, appUrl);
    await query("update phone_numbers set status='active',last_error=null,updated_at=now() where id=$1 and workspace_id=$2", [provisioned, session.workspaceId]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Twilio configuration failed";
    await query("update phone_numbers set status='failed',last_error=$1,updated_at=now() where id=$2 and workspace_id=$3", [message, provisioned, session.workspaceId]);
    return NextResponse.json({ error: message }, { status: 502 });
  }
  return NextResponse.json({ id: provisioned, status: "active" }, { status: 201 });
}
