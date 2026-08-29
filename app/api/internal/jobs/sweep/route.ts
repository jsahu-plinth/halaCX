import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { authorizeInternalJobRequest } from "@/lib/internal-job-auth";
import { sweepExpiredJobs } from "@/lib/jobs";

export async function POST(request: Request) {
  if (!authorizeInternalJobRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const jobs = await sweepExpiredJobs<{ eventId?: string; callId?: string }>(500);
  for (const job of jobs.filter(item => item.status === "dead" && item.payload?.eventId)) {
    await query("update provider_webhook_events set status='failed',processing_started_at=null,last_error=$2 where id=$1", [job.payload.eventId, job.last_error || "Worker lease expired after maximum attempts"]);
    if (job.payload.callId) {
      await query(
        `insert into call_events(call_id,provider_event_id,event_type,payload)
         values($1,$2,'postcall.dead',$3::jsonb)
         on conflict(provider_event_id) where provider_event_id is not null do update set payload=excluded.payload,created_at=now()`,
        [job.payload.callId, `postcall-dead:${job.id}`, JSON.stringify({ message: job.last_error, attempts: job.attempt_count })],
      );
    }
  }
  return NextResponse.json({ ok: true, recovered: jobs.length, jobs: jobs.map(job => ({ id: job.id, status: job.status })) });
}
