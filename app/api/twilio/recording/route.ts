import { createHash } from "node:crypto";
import { after, NextResponse } from "next/server";
import { isDatabaseConfigured, query } from "@/lib/db";
import { validateTwilioWebhook } from "@/lib/twilio";
import { processCallRecording } from "@/lib/post-call";

export const maxDuration = 300;

function eventKey(data: Record<string, FormDataEntryValue>) {
  const canonical = Object.keys(data).sort().map(key => `${key}=${String(data[key])}`).join("&");
  const fingerprint = createHash("sha256").update(canonical).digest("hex");
  return `recording:${String(data.RecordingSid || fingerprint)}:${String(data.RecordingStatus || "completed")}`;
}

async function processRecordingEvent(eventId: string, callId: string, recordingUrl: string) {
  const claimed = await query<{ id: string }>(
    `update provider_webhook_events
     set status='processing',processing_started_at=now(),attempt_count=attempt_count+1,last_error=null
     where id=$1 and (status in ('received','failed') or (status='processing' and processing_started_at<now()-interval '5 minutes'))
     returning id`,
    [eventId],
  );
  if (!claimed.rows[0]) return;

  try {
    const completed = await query<{ exists: boolean }>(
      "select exists(select 1 from call_events where call_id=$1 and event_type='postcall.completed') as exists",
      [callId],
    );
    if (!completed.rows[0]?.exists) await processCallRecording(callId, recordingUrl);
    await query(
      "update provider_webhook_events set status='processed',processed_at=now(),processing_started_at=null,last_error=null where id=$1",
      [eventId],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown post-call processing error";
    console.error("Post-call processing failed", { callId, eventId, message });
    await query(
      "update provider_webhook_events set status='failed',processing_started_at=null,last_error=$1 where id=$2",
      [message.slice(0, 2_000), eventId],
    );
    await query(
      `insert into call_events(call_id,provider_event_id,event_type,payload)
       values($1,$2,'postcall.failed',$3::jsonb)
       on conflict(provider_event_id) where provider_event_id is not null
       do update set payload=excluded.payload,created_at=now()`,
      [callId, `postcall-failed:${eventId}`, JSON.stringify({ message })],
    );
  }
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
  if (event.rows[0].status !== "processed") {
    after(() => processRecordingEvent(event.rows[0].id, result.rows[0].id, recordingUrl));
  }
  return NextResponse.json({ ok: true, duplicate: event.rows[0].status === "processed" });
}
