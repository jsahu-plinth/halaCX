import { NextResponse } from "next/server";
import { isDatabaseConfigured, query } from "@/lib/db";
import { validateTwilioWebhook } from "@/lib/twilio";

export async function POST(request: Request) {
  const form = await request.formData();
  const data = Object.fromEntries(form);
  if (!validateTwilioWebhook(request, data)) {
    return NextResponse.json({ error: "Invalid Twilio signature" }, { status: 403 });
  }

  const diagnostic = {
    callSid: String(data.CallSid || ""),
    dialCallSid: String(data.DialCallSid || ""),
    dialCallStatus: String(data.DialCallStatus || ""),
    dialSipResponseCode: String(data.DialSipResponseCode || ""),
    dialSipCallId: String(data.DialSipCallId || ""),
  };
  console.info("Twilio SIP dial result", diagnostic);

  if (isDatabaseConfigured && diagnostic.callSid) {
    const result = await query<{ id: string }>(
      "select id from calls where provider_call_id=$1 limit 1",
      [diagnostic.callSid],
    );
    if (result.rows[0]) {
      await query(
        "insert into call_events(call_id,event_type,payload) values($1,$2,$3::jsonb)",
        [result.rows[0].id, "twilio.sip_dial_result", JSON.stringify(diagnostic)],
      );
    }
  }

  return new NextResponse("<Response/>", {
    headers: { "Content-Type": "text/xml" },
  });
}
