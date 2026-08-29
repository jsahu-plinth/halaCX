import { NextResponse } from "next/server";
import { z } from "zod";
import { readSession } from "@/lib/auth";
import { isDatabaseConfigured, query } from "@/lib/db";
import { allowDemoCall, attachProviderCall, createPendingCallContext, discardPendingCall } from "@/lib/call-context";

const schema = z.object({
  phone: z.string()
    .transform((value) => value.replace(/[\s()-]/g, ""))
    .refine((value) => /^(?:\+971\d{8,9}|\+91\d{10})$/.test(value)),
  context: z.enum(["receptionist", "appointment", "lead", "support"]).default("receptionist"),
  voiceProvider: z.enum(["openai", "sarvam", "cartesia"]).default("sarvam"),
});

export async function POST(request: Request) {
  const session = await readSession();
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid UAE (+971) or India (+91) mobile number." }, { status: 400 });
  }
  const clientKey = request.headers.get("x-forwarded-for")?.split(",")[0] || "local";
  if (!session && !(await allowDemoCall(clientKey))) return NextResponse.json({ error: "Demo limit reached. Try again in ten minutes." }, { status: 429 });

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  const appUrl = process.env.APP_URL;
  const voiceUrl = process.env.VOICE_WS_URL;

  const username = apiKeySid || sid;
  const password = apiKeySecret || authToken;

  if (!sid || !username || !password || !from || !appUrl || !voiceUrl) {
    return NextResponse.json({ error: "Voice providers are not fully configured." }, { status: 503 });
  }

  const pending = await createPendingCallContext(parsed.data.context, session && !session.preview ? session.workspaceId : undefined);
  const contextParameter = pending.id ? `<Parameter name="contextId" value="${pending.id}"/>` : "";
  const twiml = `<Response><Connect><Stream url="${voiceUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">${contextParameter}<Parameter name="scenario" value="${pending.context}"/><Parameter name="voiceProvider" value="${parsed.data.voiceProvider}"/></Stream></Connect></Response>`;
  const body = new URLSearchParams({
    To: parsed.data.phone,
    From: from,
    Twiml: twiml,
    StatusCallback: `${appUrl}/api/twilio/status`,
    Record: "true",
    RecordingChannels: "dual",
    RecordingStatusCallback: `${appUrl}/api/twilio/recording`,
  });
  for (const event of ["initiated", "ringing", "answered", "completed"]) {
    body.append("StatusCallbackEvent", event);
  }
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json();
  if (!response.ok) {
    await discardPendingCall(pending.id);
    return NextResponse.json({ error: data.message ?? "Twilio could not start the call." }, { status: 502 });
  }
  await attachProviderCall(pending.id, data.sid);
  if (isDatabaseConfigured && session && !session.preview) {
    await query(
      "insert into calls(workspace_id,agent_id,provider_call_id,direction,from_number,to_number,status,started_at,outcome) values($1,(select id from agents where workspace_id=$1 order by created_at limit 1),$2,'outbound',$3,$4,'queued',now(),$5) on conflict(provider_call_id) do nothing",
      [session.workspaceId, data.sid, from, parsed.data.phone, `Scenario: ${pending.context}`],
    );
  }
  return NextResponse.json({ callId: data.sid, demo: false, persisted: Boolean(session && !session.preview) });
}
