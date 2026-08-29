import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { query, withTransaction } from "@/lib/db";
import { authorizeInternalJobRequest } from "@/lib/internal-job-auth";
import { claimJobs, failJob, renewJobLease, type DurableJob } from "@/lib/jobs";
import { processCallRecording } from "@/lib/post-call";

export const maxDuration = 300;

type PostCallPayload = { eventId: string; callId: string; recordingUrl: string };

export async function POST(request: Request) {
  if (!authorizeInternalJobRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workerId = `post-call:${process.env.VERCEL_REGION || "worker"}:${randomUUID()}`;
  const jobs = await claimJobs<PostCallPayload>("post-call", workerId, 1, 300);
  const results: Array<{ id: string; status: string }> = [];

  for (const job of jobs) {
    const heartbeat = setInterval(() => {
      void renewJobLease(job.id, workerId, 300).catch(error => console.error("Post-call lease renewal failed", { jobId: job.id, message: error instanceof Error ? error.message : "Unknown error" }));
    }, 60_000);
    try {
      const payload = job.payload;
      if (!payload?.eventId || !payload.callId || !payload.recordingUrl) throw new Error("Invalid post-call payload");
      await query(
        "update provider_webhook_events set status='processing',processing_started_at=now(),attempt_count=$2,last_error=null where id=$1",
        [payload.eventId, job.attempt_count],
      );
      const completed = await query<{ exists: boolean }>(
        "select exists(select 1 from call_events where call_id=$1 and event_type='postcall.completed') as exists",
        [payload.callId],
      );
      if (!completed.rows[0]?.exists) await processCallRecording(payload.callId, payload.recordingUrl);
      await withTransaction(async client => {
        const completedJob = await client.query<{ id: string }>(
          `update durable_jobs set status='completed',result=$3::jsonb,completed_at=now(),updated_at=now(),lease_expires_at=null,locked_by=null
           where id=$1 and status='processing' and locked_by=$2 returning id`,
          [job.id, workerId, JSON.stringify({ callId: payload.callId })],
        );
        if (!completedJob.rows[0]) throw new Error("Post-call lease was lost before completion");
        await client.query(
          "update provider_webhook_events set status='processed',processed_at=now(),processing_started_at=null,last_error=null where id=$1",
          [payload.eventId],
        );
      });
      results.push({ id: job.id, status: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown post-call processing error";
      await query(
        "update provider_webhook_events set status='failed',processing_started_at=null,last_error=$1 where id=$2",
        [message.slice(0, 2_000), job.payload.eventId],
      ).catch(() => {});
      const status = await failJob(job as DurableJob, workerId, error);
      if (status === "dead" && job.payload.callId) {
        await query(
          `insert into call_events(call_id,provider_event_id,event_type,payload)
           values($1,$2,'postcall.dead',$3::jsonb)
           on conflict(provider_event_id) where provider_event_id is not null do update set payload=excluded.payload,created_at=now()`,
          [job.payload.callId, `postcall-dead:${job.id}`, JSON.stringify({ message, attempts: job.attempt_count })],
        ).catch(() => {});
      }
      results.push({ id: job.id, status: status || "lease-lost" });
    } finally {
      clearInterval(heartbeat);
    }
  }
  return NextResponse.json({ ok: true, claimed: jobs.length, results });
}
