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
  TEST_DB_DEFERRED_MARKER,
  TEST_DB_DEFERRED_SWEEP_LIMIT,
  TEST_DB_DEFERRED_SWEEP_TIMEOUT_MS,
  dropDatabaseWithLock,
  isConnectTimeout,
  TEST_DB_DROP_LOCK_KEY,
  TEST_DB_DROP_STATEMENT_TIMEOUT_MS,
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
    const result = await dropDatabaseWithLock({
      unsafe: async (query) => {
        queries.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ acquired: true }];
        return [];
      },
    }, 'it_guarded');

    expect(result).toBe('dropped');
    expect(queries).toEqual([
      `SELECT pg_try_advisory_lock(hashtext('${TEST_DB_DROP_LOCK_KEY}')) AS acquired`,
      `SET statement_timeout = '${TEST_DB_DROP_STATEMENT_TIMEOUT_MS}ms'`,
      'DROP DATABASE IF EXISTS "it_guarded" WITH (FORCE)',
      expect.stringContaining(`WHERE c.description = '${TEST_DB_DEFERRED_MARKER}'`),
      `SET statement_timeout = '0'`,
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
          if (query.includes('pg_try_advisory_lock')) return [{ acquired: true }];
          // Regex, not a string literal: check-drop-database-force.mjs scans code for the
          // contiguous statement text and would read a bare prefix probe as an unforced DROP.
          if (/^DROP\s+DATABASE\b/.test(query)) throw failure;
          return [];
        },
      }, 'it_guarded'),
    ).rejects.toBe(failure);

    expect(queries.at(-1)).toBe(`SELECT pg_advisory_unlock(hashtext('${TEST_DB_DROP_LOCK_KEY}'))`);
  });

  it('defers immediately instead of queueing behind a slow holder', async () => {
    const queries: string[] = [];
    const result = await dropDatabaseWithLock({
      unsafe: async (query) => {
        queries.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ acquired: false }];
        return [];
      },
    }, 'it_guarded');

    expect(result).toBe('deferred');
    expect(queries.some((query) => /^DROP\s+DATABASE\b/.test(query))).toBe(false);
    expect(queries.some((query) => query.includes('pg_advisory_unlock'))).toBe(false);
    expect(queries).toContain(`COMMENT ON DATABASE "it_guarded" IS '${TEST_DB_DEFERRED_MARKER}'`);
  });

  it('defers a pathologically slow drop without stranding the lock lane', async () => {
    const queries: string[] = [];
    const statementTimeout = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const result = await dropDatabaseWithLock({
      unsafe: async (query) => {
        queries.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ acquired: true }];
        if (query.startsWith('DROP DATABASE')) throw statementTimeout;
        return [];
      },
    }, 'it_guarded');

    expect(result).toBe('deferred');
    expect(queries).toContain(`COMMENT ON DATABASE "it_guarded" IS '${TEST_DB_DEFERRED_MARKER}'`);
    expect(queries.at(-1)).toBe(`SELECT pg_advisory_unlock(hashtext('${TEST_DB_DROP_LOCK_KEY}'))`);
  });

  it('drains only a bounded batch of explicitly deferred databases', async () => {
    const queries: string[] = [];
    const deferred = Array.from({ length: TEST_DB_DEFERRED_SWEEP_LIMIT + 2 }, (_, index) => ({
      datname: `it_deferred_${index}`,
    }));
    const result = await dropDatabaseWithLock({
      unsafe: async (query) => {
        queries.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ acquired: true }];
        if (query.includes('FROM pg_database d')) return deferred.slice(0, TEST_DB_DEFERRED_SWEEP_LIMIT);
        return [];
      },
    }, 'it_guarded');

    expect(result).toBe('dropped');
    const sweptDrops = queries.filter((query) => query.includes('it_deferred_'));
    expect(sweptDrops).toHaveLength(TEST_DB_DEFERRED_SWEEP_LIMIT);
    expect(queries.filter((query) => query === `SET statement_timeout = '${TEST_DB_DEFERRED_SWEEP_TIMEOUT_MS}ms'`))
      .toHaveLength(TEST_DB_DEFERRED_SWEEP_LIMIT);
  });
});
