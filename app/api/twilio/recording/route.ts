import { NextResponse } from "next/server";
import { isDatabaseConfigured, query } from "@/lib/db";
import { validateTwilioWebhook } from "@/lib/twilio";
import { processCallRecording } from "@/lib/post-call";

export const maxDuration = 60;

export async function POST(request: Request) {
  const form = await request.formData();
  const data = Object.fromEntries(form);
  if (!validateTwilioWebhook(request, data)) return NextResponse.json({ error: "Invalid Twilio signature" }, { status: 403 });
  const providerCallId = String(data.ParentCallSid || data.CallSid || "");
  if (isDatabaseConfigured && providerCallId && data.RecordingUrl) {
    const result = await query<{ id: string }>("update calls set recording_url=$1 where provider_call_id=$2 returning id", [String(data.RecordingUrl), providerCallId]);
    if (result.rows[0]) {
      await query("insert into call_events(call_id,event_type,payload) values($1,'twilio.recording',$2::jsonb)", [result.rows[0].id, JSON.stringify(Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)])))]);
      try {
        await processCallRecording(result.rows[0].id, String(data.RecordingUrl));
      } catch (error) {
        console.error("Post-call processing failed", error);
        await query("insert into call_events(call_id,event_type,payload) values($1,'postcall.failed',$2::jsonb)", [result.rows[0].id, JSON.stringify({ message: error instanceof Error ? error.message : "Unknown error" })]);
      }
    }
  }
  return NextResponse.json({ ok: true });
}
