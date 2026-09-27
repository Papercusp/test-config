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
  TEST_DB_MANAGED_MARKER,
  TEST_DB_ORPHAN_MIN_AGE_MS,
  TEST_DB_DEFERRED_SWEEP_LIMIT,
  PG_INVALID_DATABASE_CONNLIMIT,
  dropDatabaseWithLock,
  markManagedTestDatabase,
  isConnectTimeout,
  TEST_DB_DROP_LOCK_KEY,
  withConnectRetry,
} from './pg-migrate.ts';

const DROP_RE = /^DROP\s+DATABASE\b/;

/**
 * WI-10003479 class guard: PostgreSQL >= 15 marks a database invalid before the
 * slow phase of DROP DATABASE, so any server-side timeout that can cancel a
 * started drop leaks an INVALID database. Replays the session's SET sequence and
 * fails if any DROP was issued while a non-zero statement_timeout was in effect.
 */
function expectNoDropUnderStatementTimeout(queries: string[]): void {
  let timeout = '0';
  const drops: Array<{ query: string; timeout: string }> = [];
  for (const query of queries) {
    const set = /^SET statement_timeout = '([^']*)'$/.exec(query);
    if (set) timeout = set[1];
    if (DROP_RE.test(query)) drops.push({ query, timeout });
  }
  expect(drops.length).toBeGreaterThan(0);
  expect(drops.filter((drop) => drop.timeout !== '0')).toEqual([]);
}

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
      `SET statement_timeout = '0'`,
      `SET client_connection_check_interval = '0'`,
      'DROP DATABASE IF EXISTS "it_guarded" WITH (FORCE)',
      expect.stringContaining(`WHERE c.description = '${TEST_DB_DEFERRED_MARKER}'`),
      expect.stringContaining(`c.description ~ '^${TEST_DB_MANAGED_MARKER}[0-9]{13}$'`),
      `SET statement_timeout = '0'`,
      `SELECT pg_advisory_unlock(hashtext('${TEST_DB_DROP_LOCK_KEY}'))`,
    ]);
    expectNoDropUnderStatementTimeout(queries);
  });

  it('never cancels a slow drop: it DETACHES and leaves the busy connection alone (WI-10003479)', async () => {
    const queries: string[] = [];
    const result = await dropDatabaseWithLock({
      unsafe: (query) => {
        queries.push(query);
        if (query.includes('pg_try_advisory_lock')) return Promise.resolve([{ acquired: true }]);
        // The drop is still in its slow file-removal phase when the wait runs out.
        if (DROP_RE.test(query)) return new Promise(() => {});
        return Promise.resolve([]);
      },
    }, 'it_slow', { waitMs: 5 });

    expect(result).toBe('detached');
    expectNoDropUnderStatementTimeout(queries);
    // Nothing may be queued behind the in-flight drop — no deferred marker, no
    // sweep, no unlock (its backend releases the session lock on exit).
    expect(queries.at(-1)).toBe('DROP DATABASE IF EXISTS "it_slow" WITH (FORCE)');
    expect(queries.some((query) => query.includes('pg_cancel_backend'))).toBe(false);
  });

  it('a detached drop that later fails does not surface as an unhandled rejection', async () => {
    let rejectDrop!: (e: Error) => void;
    const result = await dropDatabaseWithLock({
      unsafe: (query) => {
        if (query.includes('pg_try_advisory_lock')) return Promise.resolve([{ acquired: true }]);
        if (DROP_RE.test(query)) return new Promise((_, reject) => { rejectDrop = reject; });
        return Promise.resolve([]);
      },
    }, 'it_slow', { waitMs: 1 });
    expect(result).toBe('detached');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      rejectDrop(new Error('write CONNECTION_DESTROYED'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
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

  it('marks an externally-cancelled drop deferred (it may be invalid) without stranding the lock lane', async () => {
    const queries: string[] = [];
    const statementTimeout = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const result = await dropDatabaseWithLock({
      unsafe: async (query) => {
        queries.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ acquired: true }];
        if (/^DROP\s+DATABASE\b/.test(query)) throw statementTimeout;
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
        if (query.includes(`c.description = '${TEST_DB_DEFERRED_MARKER}'`)) {
          return deferred.slice(0, TEST_DB_DEFERRED_SWEEP_LIMIT);
        }
        return [];
      },
    }, 'it_guarded');

    expect(result).toBe('dropped');
    const sweptDrops = queries.filter((query) => query.includes('it_deferred_'));
    expect(sweptDrops).toHaveLength(TEST_DB_DEFERRED_SWEEP_LIMIT);
    // The old 5s sweep timeout cancelled drops mid-flight — the leak itself.
    expectNoDropUnderStatementTimeout(queries);
  });

  it('sweeps INVALID marker-bearing databases first and never selects unmarked ones (WI-10003482)', async () => {
    const queries: string[] = [];
    await dropDatabaseWithLock({
      unsafe: async (query) => {
        queries.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ acquired: true }];
        return [];
      },
    }, 'it_guarded');
    const sweep = queries.find((query) => query.includes(`c.description = '${TEST_DB_DEFERRED_MARKER}'`));
    expect(sweep).toContain(`d.datconnlimit = ${PG_INVALID_DATABASE_CONNLIMIT}`);
    expect(sweep).toContain(`c.description ~ '^${TEST_DB_MANAGED_MARKER}[0-9]{13}$'`);
    expect(sweep).toMatch(/ORDER BY \(d\.datconnlimit = -2\) DESC/);
    // The shdescription JOIN is what restricts the sweep to marker-bearing databases.
    expect(sweep).toContain('JOIN pg_shdescription c');
  });

  it('a slow sweep drop detaches instead of being cancelled, and skips the unlock', async () => {
    const queries: string[] = [];
    const result = await dropDatabaseWithLock({
      unsafe: (query) => {
        queries.push(query);
        if (query.includes('pg_try_advisory_lock')) return Promise.resolve([{ acquired: true }]);
        if (query.includes(`c.description = '${TEST_DB_DEFERRED_MARKER}'`)) {
          return Promise.resolve([{ datname: 'papercusp_it_baseline_invalid' }]);
        }
        if (DROP_RE.test(query) && query.includes('papercusp_it_baseline_invalid')) return new Promise(() => {});
        return Promise.resolve([]);
      },
    }, 'it_guarded', { sweepBudgetMs: 5 });

    expect(result).toBe('dropped');
    expectNoDropUnderStatementTimeout(queries);
    expect(queries.at(-1)).toBe('DROP DATABASE IF EXISTS "papercusp_it_baseline_invalid" WITH (FORCE)');
  });
});

describe('abandoned test database cleanup (WI-10003219)', () => {
  it('marks a new database with a creation time', async () => {
    const queries: string[] = [];
    await markManagedTestDatabase({ unsafe: async (query) => { queries.push(query); return []; } }, 'org_abc');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^COMMENT ON DATABASE "org_abc" IS 'papercusp-test-db:[0-9]{13}'$/);
  });

  it('reaps only old, inactive, explicitly marked databases through the existing drop lock', async () => {
    const queries: string[] = [];
    const result = await dropDatabaseWithLock({
      unsafe: async (query) => {
        queries.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ acquired: true }];
        if (query.includes(`c.description ~ '^${TEST_DB_MANAGED_MARKER}`)) return [{ datname: 'org_abandoned' }];
        return [];
      },
    }, 'org_current');
    expect(result).toBe('dropped');
    expect(queries).toContain('DROP DATABASE IF EXISTS "org_abandoned" WITH (FORCE)');
    // The orphan sweep (age-gated) is distinct from the deferred/invalid sweep,
    // which also matches the managed marker but only for INVALID databases.
    const orphanSweep = queries.find((query) => query.includes('split_part(c.description'));
    expect(orphanSweep).toContain('NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)');
    expect(orphanSweep).toContain(String(TEST_DB_ORPHAN_MIN_AGE_MS));
  });
});
