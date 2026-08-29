import { NextResponse } from "next/server";
import { isDatabaseConfigured, query } from "@/lib/db";
import { validateTwilioWebhook } from "@/lib/twilio";
export async function POST(request: Request) {
  const form = await request.formData();
  const data = Object.fromEntries(form);
  if (!validateTwilioWebhook(request, data)) return NextResponse.json({ error: "Invalid Twilio signature" }, { status: 403 });
  console.info("Twilio call status", {
    callSid: String(data.CallSid || ""),
    parentCallSid: String(data.ParentCallSid || ""),
    callStatus: String(data.CallStatus || ""),
    sipResponseCode: String(data.SipResponseCode || ""),
  });
  if (isDatabaseConfigured && data.CallSid) {
    const result = await query<{ id: string }>(
      "update calls set status=$1,duration_seconds=coalesce($2::integer,duration_seconds),ended_at=case when $1 in ('completed','failed','busy','no-answer','canceled') then now() else ended_at end where provider_call_id=$3 returning id",
      [String(data.CallStatus || "unknown"), data.CallDuration ? String(data.CallDuration) : null, String(data.CallSid)],
    );
    if (result.rows[0]) await query("insert into call_events(call_id,event_type,payload) values($1,$2,$3::jsonb)", [result.rows[0].id, `twilio.${String(data.CallStatus || "unknown")}`, JSON.stringify(Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)])))]);
  }
  return NextResponse.json({ ok: true });
}
