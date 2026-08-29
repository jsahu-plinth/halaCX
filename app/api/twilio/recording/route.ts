import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { isDatabaseConfigured, query } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { validateTwilioWebhook } from "@/lib/twilio";

function eventKey(data: Record<string, FormDataEntryValue>) {
  const canonical = Object.keys(data).sort().map(key => `${key}=${String(data[key])}`).join("&");
  const fingerprint = createHash("sha256").update(canonical).digest("hex");
  return `recording:${String(data.RecordingSid || fingerprint)}:${String(data.RecordingStatus || "completed")}`;
}

export async function POST(request: Request) {
  const form = await request.formData();
  const data = Object.fromEntries(form);
  if (!validateTwilioWebhook(request, data)) return NextResponse.json({ error: "Invalid Twilio signature" }, { status: 403 });
  const providerCallId = String(data.ParentCallSid || data.CallSid || "");
  const recordingUrl = String(data.RecordingUrl || "");
  if (!isDatabaseConfigured || !providerCallId || !recordingUrl) return NextResponse.json({ ok: true });

  const key = eventKey(data);
  const payload = JSON.stringify(Object.fromEntries(Object.entries(data).map(([name, value]) => [name, String(value)])));
  await query(
    `insert into provider_webhook_events(provider,event_key,event_type,provider_call_id,payload)
     values('twilio',$1,'recording.available',$2,$3::jsonb)
     on conflict(provider,event_key) do nothing`,
    [key, providerCallId, payload],
  );
  const event = await query<{ id: string; status: string }>(
    "select id,status from provider_webhook_events where provider='twilio' and event_key=$1",
    [key],
  );
  if (!event.rows[0]) return NextResponse.json({ error: "Recording event could not be persisted" }, { status: 503 });

  const result = await query<{ id: string }>(
    "update calls set recording_url=$1 where provider_call_id=$2 returning id",
    [recordingUrl, providerCallId],
  );
  if (!result.rows[0]) {
    await query(
      "update provider_webhook_events set status='failed',last_error='Call is not bound to its provider SID yet' where id=$1",
      [event.rows[0].id],
    );
    return NextResponse.json({ error: "Recording callback will be retried" }, { status: 503 });
  }

  await query("update provider_webhook_events set call_id=$1 where id=$2", [result.rows[0].id, event.rows[0].id]);
  await query(
    `insert into call_events(call_id,provider_event_id,event_type,payload)
     values($1,$2,'twilio.recording',$3::jsonb)
     on conflict(provider_event_id) where provider_event_id is not null do nothing`,
    [result.rows[0].id, `twilio:${key}`, payload],
  );
  if (event.rows[0].status !== "processed") await enqueueJob("post-call", event.rows[0].id, { eventId: event.rows[0].id, callId: result.rows[0].id, recordingUrl });
  return NextResponse.json({ ok: true, duplicate: event.rows[0].status === "processed" });
}
