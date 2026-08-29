import { NextResponse } from "next/server";
import { createMediaStreamToken } from "@/lib/media-token";
import { validateTwilioWebhook } from "@/lib/twilio";
import { query } from "@/lib/db";
import { createPendingCallContext } from "@/lib/call-context";

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export async function POST(request: Request) {
  const form = await request.formData();
  const data = Object.fromEntries(form);
  if (!validateTwilioWebhook(request, data)) {
    return NextResponse.json({ error: "Invalid Twilio signature" }, { status: 403 });
  }
  const voiceUrl = process.env.VOICE_WS_URL;
  if (!voiceUrl || !process.env.MEDIA_STREAM_SECRET) return new NextResponse("<Response><Say>Voice service is unavailable.</Say></Response>", { headers: { "Content-Type": "text/xml" } });
  const callSid = String(data.CallSid || "");
  const to = String(data.To || "").replace(/[\s()-]/g, "");
  const from = String(data.From || "").replace(/[\s()-]/g, "");
  const route = await query<{ workspace_id: string; agent_id: string | null; scenario: string; voice_provider: string }>(
    `select workspace_id,agent_id,scenario,voice_provider from phone_numbers
      where phone_number=$1 and provider='twilio' and status='active' and inbound_enabled=true limit 1`,
    [to],
  );
  const matched = route.rows[0];
  if (!matched || !callSid) {
    return new NextResponse("<Response><Say>This number is not assigned to an active Hala C X workspace. Please contact the business directly.</Say></Response>", { headers: { "Content-Type": "text/xml" } });
  }
  const call = await query<{ id: string }>(
    `insert into calls(workspace_id,agent_id,provider_call_id,direction,from_number,to_number,caller_name,status,started_at,outcome)
     values($1,$2,$3,'inbound',$4,$5,$6,'in-progress',now(),$7)
     on conflict(provider_call_id) do update set status=case when calls.status in ('completed','failed','canceled','busy','no-answer') then calls.status else 'in-progress' end
     returning id`,
    [matched.workspace_id, matched.agent_id, callSid, from || null, to, String(data.CallerName || "") || null, `Scenario: ${matched.scenario}`],
  );
  const pending = await createPendingCallContext(matched.scenario, matched.workspace_id, call.rows[0].id);
  const mediaToken = createMediaStreamToken({ callSid, contextId: pending.id || undefined, internalCallId: call.rows[0].id, workspaceId: matched.workspace_id, scenario: pending.context, voiceProvider: matched.voice_provider });
  const twiml = `<Response><Connect><Stream url="${xml(voiceUrl)}"><Parameter name="contextId" value="${xml(String(pending.id || ""))}"/><Parameter name="internalCallId" value="${xml(call.rows[0].id)}"/><Parameter name="workspaceId" value="${xml(matched.workspace_id)}"/><Parameter name="scenario" value="${xml(pending.context)}"/><Parameter name="voiceProvider" value="${xml(matched.voice_provider)}"/><Parameter name="mediaToken" value="${mediaToken}"/></Stream></Connect></Response>`;
  return new NextResponse(twiml, { headers: { "Content-Type": "text/xml" } });
}
