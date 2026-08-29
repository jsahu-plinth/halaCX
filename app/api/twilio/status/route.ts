import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { isDatabaseConfigured, query, withTransaction } from "@/lib/db";
import { validateTwilioWebhook } from "@/lib/twilio";

const terminalStatuses = ["completed", "failed", "busy", "no-answer", "canceled"];

function eventKey(data: Record<string, FormDataEntryValue>) {
  const canonical = Object.keys(data).sort().map(key => `${key}=${String(data[key])}`).join("&");
  const fingerprint = createHash("sha256").update(canonical).digest("hex");
  return `status:${String(data.CallSid || "unknown")}:${String(data.SequenceNumber || fingerprint)}`;
}

export async function POST(request: Request) {
  const form = await request.formData();
  const data = Object.fromEntries(form);
  if (!validateTwilioWebhook(request, data)) return NextResponse.json({ error: "Invalid Twilio signature" }, { status: 403 });

  const providerCallId = String(data.CallSid || "");
  const callStatus = String(data.CallStatus || "unknown");
  const key = eventKey(data);
  const providerEventId = `twilio:${key}`;
  const payload = JSON.stringify(Object.fromEntries(Object.entries(data).map(([name, value]) => [name, String(value)])));

  console.info("Twilio call status", {
    callSid: providerCallId,
    parentCallSid: String(data.ParentCallSid || ""),
    callStatus,
    sipResponseCode: String(data.SipResponseCode || ""),
  });

  if (!isDatabaseConfigured || !providerCallId) return NextResponse.json({ ok: true });

  await query(
    `insert into provider_webhook_events(provider,event_key,event_type,provider_call_id,payload)
     values('twilio',$1,'call.status',$2,$3::jsonb)
     on conflict(provider,event_key) do nothing`,
    [key, providerCallId, payload],
  );
  const claimed = await query<{ id: string }>(
    `update provider_webhook_events
     set status='processing',processing_started_at=now(),attempt_count=attempt_count+1,last_error=null
     where provider='twilio' and event_key=$1
       and (status in ('received','failed') or (status='processing' and processing_started_at<now()-interval '5 minutes'))
     returning id`,
    [key],
  );
  if (!claimed.rows[0]) return NextResponse.json({ ok: true, duplicate: true });

  try {
    const callId = await withTransaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `update calls
         set status=case
               when status=any($1::text[]) then status
               when $2=any($1::text[]) then $2
               when (case $2 when 'queued' then 0 when 'initiated' then 10 when 'ringing' then 20 when 'answered' then 30 when 'in-progress' then 30 else -1 end)
                  >= (case status when 'queued' then 0 when 'initiated' then 10 when 'ringing' then 20 when 'answered' then 30 when 'in-progress' then 30 else -1 end)
                 then $2
               else status
             end,
             duration_seconds=coalesce($3::integer,duration_seconds),
             ended_at=case when status=any($1::text[]) or $2=any($1::text[]) then coalesce(ended_at,now()) else ended_at end
         where provider_call_id=$4
         returning id`,
        [terminalStatuses, callStatus, data.CallDuration ? String(data.CallDuration) : null, providerCallId],
      );
      if (!result.rows[0]) throw new Error("Call is not bound to its provider SID yet");
      await client.query(
        `insert into call_events(call_id,provider_event_id,event_type,payload)
         values($1,$2,$3,$4::jsonb)
         on conflict(provider_event_id) where provider_event_id is not null do nothing`,
        [result.rows[0].id, providerEventId, `twilio.${callStatus}`, payload],
      );
      await client.query(
        "update provider_webhook_events set call_id=$1,status='processed',processed_at=now(),last_error=null where id=$2",
        [result.rows[0].id, claimed.rows[0].id],
      );
      return result.rows[0].id;
    });
    return NextResponse.json({ ok: true, callId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown status processing error";
    await query(
      "update provider_webhook_events set status='failed',last_error=$1,processing_started_at=null where id=$2",
      [message.slice(0, 2_000), claimed.rows[0].id],
    );
    console.error("Twilio status persistence failed", { providerCallId, message });
    return NextResponse.json({ error: "Status callback will be retried" }, { status: 503 });
  }
}
