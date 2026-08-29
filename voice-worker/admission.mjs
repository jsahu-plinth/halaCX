const ADMIT_SCRIPT = `
local now = tonumber(ARGV[1])
local leaseExpiry = tonumber(ARGV[2])
local globalMaximum = tonumber(ARGV[3])
local workspaceMaximum = tonumber(ARGV[4])
local replayTtl = tonumber(ARGV[5])
local leaseId = ARGV[6]
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
if redis.call('EXISTS', KEYS[1]) == 1 then return {'replayed'} end
if redis.call('ZCARD', KEYS[2]) >= globalMaximum then return {'global_capacity'} end
if redis.call('ZCARD', KEYS[3]) >= workspaceMaximum then return {'workspace_capacity'} end
redis.call('SET', KEYS[1], '1', 'EX', replayTtl, 'NX')
redis.call('ZADD', KEYS[2], leaseExpiry, leaseId)
redis.call('ZADD', KEYS[3], leaseExpiry, leaseId)
return {'admitted'}
`;

const RENEW_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) == false then return 0 end
if redis.call('ZSCORE', KEYS[2], ARGV[1]) == false then return 0 end
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[1])
redis.call('ZADD', KEYS[2], tonumber(ARGV[2]), ARGV[1])
return 1
`;

export class RedisAdmissionStore {
  constructor({ url, token, namespace = 'halacx' }) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.namespace = namespace;
  }

  async command(command) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`redis_admission_failed_${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error('redis_admission_command_failed');
    return body.result;
  }

  workspaceKey(workspaceId) {
    return `${this.namespace}:workspace:${encodeURIComponent(workspaceId)}:active-calls`;
  }

  async admit({ jti, tokenExpiresAt, leaseId, workspaceId, maximum, workspaceMaximum, leaseMs }) {
    const now = Date.now();
    const replayTtl = Math.max(1, Math.ceil((tokenExpiresAt * 1_000 - now) / 1_000));
    const result = await this.command(['EVAL', ADMIT_SCRIPT, '3', `${this.namespace}:media-token:${jti}`, `${this.namespace}:active-calls`, this.workspaceKey(workspaceId), String(now), String(now + leaseMs), String(maximum), String(workspaceMaximum), String(replayTtl), leaseId]);
    return { status: Array.isArray(result) ? String(result[0]) : String(result) };
  }

  async renew(leaseId, leaseMs, workspaceId) {
    const result = await this.command(['EVAL', RENEW_SCRIPT, '2', `${this.namespace}:active-calls`, this.workspaceKey(workspaceId), leaseId, String(Date.now() + leaseMs)]);
    return Number(result) === 1;
  }

  async release(leaseId, workspaceId) {
    await this.command(['ZREM', `${this.namespace}:active-calls`, leaseId]);
    await this.command(['ZREM', this.workspaceKey(workspaceId), leaseId]);
  }

  async healthCheck() {
    return await this.command(['PING']) === 'PONG';
  }
}

export class PostgresAdmissionStore {
  constructor(pool) {
    this.pool = pool;
  }

  async admit({ jti, tokenExpiresAt, leaseId, workspaceId, maximum, workspaceMaximum, leaseMs }) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtext('halacx:media-admission'))");
      await client.query('delete from media_call_leases where expires_at<=now()');
      await client.query('delete from media_token_replays where expires_at<=now()');
      const replay = await client.query('select 1 from media_token_replays where token_id=$1', [jti]);
      if (replay.rows[0]) { await client.query('rollback'); return { status: 'replayed' }; }
      const count = await client.query('select count(*)::int as count from media_call_leases');
      if (Number(count.rows[0]?.count || 0) >= maximum) { await client.query('rollback'); return { status: 'global_capacity' }; }
      const workspaceCount = await client.query('select count(*)::int as count from media_call_leases where workspace_id=$1', [workspaceId]);
      if (Number(workspaceCount.rows[0]?.count || 0) >= workspaceMaximum) { await client.query('rollback'); return { status: 'workspace_capacity' }; }
      await client.query('insert into media_token_replays(token_id,expires_at) values($1,to_timestamp($2))', [jti, tokenExpiresAt]);
      await client.query("insert into media_call_leases(lease_id,workspace_id,expires_at) values($1,$2,now()+($3::text || ' milliseconds')::interval)", [leaseId, workspaceId, leaseMs]);
      await client.query('commit');
      return { status: 'admitted' };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async renew(leaseId, leaseMs, workspaceId) {
    const result = await this.pool.query("update media_call_leases set expires_at=now()+($3::text || ' milliseconds')::interval where lease_id=$1 and workspace_id=$2 returning lease_id", [leaseId, workspaceId, leaseMs]);
    return Boolean(result.rows[0]);
  }

  async release(leaseId, workspaceId) {
    await this.pool.query('delete from media_call_leases where lease_id=$1 and workspace_id=$2', [leaseId, workspaceId]);
  }

  async healthCheck() {
    const result = await this.pool.query("select to_regclass('public.media_token_replays') is not null and to_regclass('public.media_call_leases') is not null as ready");
    return Boolean(result.rows[0]?.ready);
  }
}

export function createAdmissionStore({ pool, redisUrl, redisToken, namespace }) {
  if (redisUrl && redisToken) return new RedisAdmissionStore({ url: redisUrl, token: redisToken, namespace: namespace || 'halacx' });
  if (pool) return new PostgresAdmissionStore(pool);
  throw new Error('Distributed admission requires Upstash Redis or DATABASE_URL');
}
