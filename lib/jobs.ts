import { query } from "@/lib/db";

export type DurableJob<T = Record<string, unknown>> = {
  id: string;
  queue: string;
  dedupe_key: string;
  payload: T;
  attempt_count: number;
  max_attempts: number;
  locked_by: string;
};

export function retryDelaySeconds(attempt: number) {
  return Math.min(3_600, Math.max(5, 5 * 2 ** Math.max(0, attempt - 1)));
}

export async function enqueueJob(queue: string, dedupeKey: string, payload: Record<string, unknown>, options: { priority?: number; maxAttempts?: number } = {}) {
  const result = await query<{ id: string; status: string }>(
    `insert into durable_jobs(queue,dedupe_key,payload,priority,max_attempts)
     values($1,$2,$3::jsonb,$4,$5)
     on conflict(queue,dedupe_key) do update set updated_at=durable_jobs.updated_at
     returning id,status`,
    [queue, dedupeKey, JSON.stringify(payload), options.priority || 0, options.maxAttempts || 8],
  );
  return result.rows[0];
}

export async function claimJobs<T = Record<string, unknown>>(queue: string, workerId: string, limit = 5, leaseSeconds = 300) {
  const safeLimit = Math.min(25, Math.max(1, Math.trunc(limit)));
  const safeLease = Math.min(1_800, Math.max(30, Math.trunc(leaseSeconds)));
  const result = await query<DurableJob<T>>(
    `with candidates as (
       select id from durable_jobs
       where queue=$1 and status='available' and available_at<=now()
       order by priority desc,created_at
       limit $2 for update skip locked
     )
     update durable_jobs j
     set status='processing',attempt_count=j.attempt_count+1,locked_by=$3,
         lease_expires_at=now()+($4::text || ' seconds')::interval,updated_at=now(),last_error=null
     from candidates c where j.id=c.id
     returning j.id,j.queue,j.dedupe_key,j.payload,j.attempt_count,j.max_attempts,j.locked_by`,
    [queue, safeLimit, workerId, safeLease],
  );
  return result.rows;
}

export async function completeJob(jobId: string, workerId: string, result: Record<string, unknown> = {}) {
  const completed = await query<{ id: string }>(
    `update durable_jobs set status='completed',result=$3::jsonb,completed_at=now(),updated_at=now(),
       lease_expires_at=null,locked_by=null
     where id=$1 and status='processing' and locked_by=$2 returning id`,
    [jobId, workerId, JSON.stringify(result)],
  );
  return Boolean(completed.rows[0]);
}

export async function renewJobLease(jobId: string, workerId: string, leaseSeconds = 300) {
  const safeLease = Math.min(1_800, Math.max(30, Math.trunc(leaseSeconds)));
  const renewed = await query<{ id: string }>(
    `update durable_jobs set lease_expires_at=now()+($3::text || ' seconds')::interval,updated_at=now()
     where id=$1 and status='processing' and locked_by=$2 returning id`,
    [jobId, workerId, safeLease],
  );
  return Boolean(renewed.rows[0]);
}

export async function failJob(job: DurableJob, workerId: string, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error || "Unknown job error")).slice(0, 2_000);
  const dead = job.attempt_count >= job.max_attempts;
  const delay = retryDelaySeconds(job.attempt_count);
  const result = await query<{ status: string }>(
    `update durable_jobs
     set status=$3,last_error=$4,updated_at=now(),lease_expires_at=null,locked_by=null,
         available_at=case when $3='available' then now()+($5::text || ' seconds')::interval else available_at end
     where id=$1 and status='processing' and locked_by=$2 returning status`,
    [job.id, workerId, dead ? "dead" : "available", message, delay],
  );
  return result.rows[0]?.status;
}

export async function sweepExpiredJobs<T = Record<string, unknown>>(limit = 100) {
  const safeLimit = Math.min(1_000, Math.max(1, Math.trunc(limit)));
  const result = await query<{ id: string; status: string; payload: T; attempt_count: number; last_error: string | null }>(
    `with expired as (
       select id from durable_jobs where status='processing' and lease_expires_at<=now()
       order by lease_expires_at limit $1 for update skip locked
     )
     update durable_jobs j
     set status=case when j.attempt_count>=j.max_attempts then 'dead' else 'available' end,
         available_at=case when j.attempt_count>=j.max_attempts then j.available_at else now() end,
         last_error=coalesce(j.last_error,'Worker lease expired'),lease_expires_at=null,locked_by=null,updated_at=now()
     from expired e where j.id=e.id returning j.id,j.status,j.payload,j.attempt_count,j.last_error`,
    [safeLimit],
  );
  return result.rows;
}
