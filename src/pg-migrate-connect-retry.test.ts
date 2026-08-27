/**
 * withConnectRetry / isConnectTimeout (EI-10571) — the shared testcontainers
 * Postgres (`getTestPg()`) is `.withReuse()`d across the WHOLE fleet (~30+
 * concurrent vitest processes at once), so a brand-new client's first query
 * can transiently `CONNECT_TIMEOUT` under connect-queue/CPU pressure alone —
 * not a real outage. This mirrors operator-core's pg-transient-retry.test.ts
 * for the test-infra-side classifier/retry pair that createFreshDb /
 * createDbFromTemplate / buildTemplate / makeDrop now use.
 *
 *   npx vitest run libs/test-config/src/pg-migrate-connect-retry.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  dropDatabaseWithLock,
  isConnectTimeout,
  TEST_DB_DROP_LOCK_KEY,
  TEST_DB_DROP_LOCK_TIMEOUT_MS,
  withConnectRetry,
} from './pg-migrate.ts';

/** A postgres-js-shaped connect-timeout error (code is the reliable signal). */
function connectTimeout(): Error & { code: string } {
  const e = new Error('write CONNECT_TIMEOUT localhost:33146') as Error & { code: string };
  e.code = 'CONNECT_TIMEOUT';
  return e;
}

/** A synchronous sleep stub — records the backoff schedule, never actually waits. */
function sleepSpy() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => { delays.push(ms); } };
}

describe('isConnectTimeout', () => {
  it('matches CONNECT_TIMEOUT by code', () => {
    expect(isConnectTimeout(connectTimeout())).toBe(true);
  });

  it('matches CONNECT_TIMEOUT by message when code is absent', () => {
    expect(isConnectTimeout(new Error('write CONNECT_TIMEOUT localhost:33146'))).toBe(true);
  });

  it('does NOT match an unrelated error', () => {
    expect(isConnectTimeout(new Error('relation "x" does not exist'))).toBe(false);
  });

  it('is null/undefined-safe', () => {
    expect(isConnectTimeout(null)).toBe(false);
    expect(isConnectTimeout(undefined)).toBe(false);
  });
});

describe('withConnectRetry', () => {
  it('returns the result on first success without sleeping', async () => {
    const { delays, sleep } = sleepSpy();
    const fn = vi.fn(async () => 'ok');
    await expect(withConnectRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('retries a transient CONNECT_TIMEOUT and succeeds on a later attempt', async () => {
    const { delays, sleep } = sleepSpy();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw connectTimeout();
      return 'connected';
    });
    await expect(withConnectRetry(fn, { sleep })).resolves.toBe('connected');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([300, 600]); // linear backoff: 300*1, then 300*2
  });

  it('exhausts the attempt budget and rethrows the LAST CONNECT_TIMEOUT', async () => {
    const { sleep } = sleepSpy();
    const fn = vi.fn(async () => { throw connectTimeout(); });
    await expect(withConnectRetry(fn, { sleep, attempts: 3 })).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows a NON-connect-timeout error immediately without retrying', async () => {
    const { delays, sleep } = sleepSpy();
    const boom = new Error('CREATE DATABASE "x" failed: already exists');
    const fn = vi.fn(async () => { throw boom; });
    await expect(withConnectRetry(fn, { sleep })).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});

describe('dropDatabaseWithLock (WI-42514 recurrence guard)', () => {
  it('serializes the forced drop and always releases the advisory lock', async () => {
    const queries: string[] = [];
    await dropDatabaseWithLock({
      unsafe: async (query) => {
        queries.push(query);
      },
    }, 'it_guarded');

    expect(queries).toEqual([
      `SET lock_timeout = '${TEST_DB_DROP_LOCK_TIMEOUT_MS}ms'`,
      `SELECT pg_advisory_lock(hashtext('${TEST_DB_DROP_LOCK_KEY}'))`,
      `SET lock_timeout = '0'`,
      'DROP DATABASE IF EXISTS "it_guarded" WITH (FORCE)',
      `SELECT pg_advisory_unlock(hashtext('${TEST_DB_DROP_LOCK_KEY}'))`,
    ]);
  });

  it('unlocks when the forced drop itself fails without masking the error', async () => {
    const queries: string[] = [];
    const failure = new Error('drop failed');
    await expect(
      dropDatabaseWithLock({
        unsafe: async (query) => {
          queries.push(query);
          if (query.startsWith('DROP DATABASE')) throw failure;
        },
      }, 'it_guarded'),
    ).rejects.toBe(failure);

    expect(queries.at(-1)).toBe(`SELECT pg_advisory_unlock(hashtext('${TEST_DB_DROP_LOCK_KEY}'))`);
  });

  it('surfaces a bounded, stage-labelled error when the drop lane is contended', async () => {
    const queries: string[] = [];
    const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    await expect(
      dropDatabaseWithLock({
        unsafe: async (query) => {
          queries.push(query);
          if (query.includes('pg_advisory_lock')) throw lockTimeout;
        },
      }, 'it_guarded'),
    ).rejects.toThrow(
      `makeDrop: stage=drop-lock-acquire timed out after ${TEST_DB_DROP_LOCK_TIMEOUT_MS}ms ` +
        `(lock=${TEST_DB_DROP_LOCK_KEY}, database=it_guarded)`,
    );

    expect(queries.some((query) => query.startsWith('DROP DATABASE'))).toBe(false);
    expect(queries.some((query) => query.includes('pg_advisory_unlock'))).toBe(false);
  });
});
