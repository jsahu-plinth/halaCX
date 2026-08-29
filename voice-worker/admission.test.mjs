import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdmissionStore, PostgresAdmissionStore, RedisAdmissionStore } from './admission.mjs';

test('requires Redis or PostgreSQL instead of silently using unsafe local state', () => {
  assert.throws(() => createAdmissionStore({}), /Distributed admission/);
});

test('Redis admission normalizes an admitted result', async () => {
  const store = new RedisAdmissionStore({ url: 'https://redis.invalid', token: 'test' });
  store.command = async command => {
    assert.equal(command[0], 'EVAL');
    assert.match(command[3], /media-token:token-id$/);
    return ['admitted'];
  };
  const result = await store.admit({ jti: 'token-id', tokenExpiresAt: Math.floor(Date.now() / 1000) + 60, leaseId: 'call-id', workspaceId: 'workspace-1', maximum: 10, workspaceMaximum: 3, leaseMs: 30_000 });
  assert.deepEqual(result, { status: 'admitted' });
});

test('Redis release removes the global and workspace lease', async () => {
  const store = new RedisAdmissionStore({ url: 'https://redis.invalid', token: 'test', namespace: 'test' });
  const commands = [];
  store.command = async value => { commands.push(value); return 1; };
  await store.release('lease-1', 'workspace-1');
  assert.deepEqual(commands, [
    ['ZREM', 'test:active-calls', 'lease-1'],
    ['ZREM', 'test:workspace:workspace-1:active-calls', 'lease-1'],
  ]);
});

test('PostgreSQL fallback reserves replay token and call lease in one transaction', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith('select 1 from media_token_replays')) return { rows: [] };
      if (sql.startsWith('select count(*)')) return { rows: [{ count: 0 }] };
      return { rows: [] };
    },
    release() { statements.push('release'); },
  };
  const store = new PostgresAdmissionStore({ async connect() { return client; } });
  const result = await store.admit({ jti: 'token', tokenExpiresAt: 2_000_000_000, leaseId: 'lease', workspaceId: 'workspace-1', maximum: 10, workspaceMaximum: 3, leaseMs: 90_000 });
  assert.deepEqual(result, { status: 'admitted' });
  assert.ok(statements.some(sql => sql.startsWith('insert into media_token_replays')));
  assert.ok(statements.some(sql => sql.startsWith('insert into media_call_leases')));
  assert.ok(statements.includes('commit'));
  assert.equal(statements.at(-1), 'release');
});
