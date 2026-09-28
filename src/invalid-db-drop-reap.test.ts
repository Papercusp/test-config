/**
 * WI-10003479 / WI-10003482 — cancelled DROP DATABASE leaves INVALID databases.
 *
 * PostgreSQL >= 15 commits a database's invalid mark (datconnlimit = -2) BEFORE
 * the slow checkpoint/barrier/file-removal phase of DROP DATABASE. The test
 * infra used to run teardown drops under statement_timeout = 20s (sweep drops
 * under 5s), so a slow drop was cancelled mid-flight and left an INVALID
 * database behind — unconnectable, skipped by pg_dump, and never reaped
 * (18 papercusp_it_baseline_* / org_* on 2026-09-27). These guards pin:
 *
 *   1. no DROP DATABASE is ever issued while a non-zero statement_timeout is in
 *      effect on that session (the CLASS guard — any future cancelling timeout
 *      re-opens the leak);
 *   2. a drop that outlives the caller's wait is DETACHED, never cancelled, and
 *      nothing is queued behind it on the busy connection;
 *   3. the janitor sweep reaps INVALID marker-bearing databases first and never
 *      selects an unmarked database.
 *
 *   npm run test:file -- libs/test-config/src/invalid-db-drop-reap.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PG_INVALID_DATABASE_CONNLIMIT,
  TEST_DB_DEFERRED_MARKER,
  TEST_DB_MANAGED_MARKER,
  dropDatabaseWithLock,
} from './pg-migrate.ts';

const DROP_RE = /^DROP\s+DATABASE\b/;

/**
 * Replays the session's SET sequence and fails if any DROP was issued while a
 * non-zero statement_timeout was in effect.
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

describe('a cancelled database drop never leaks an INVALID database (WI-10003479)', () => {
  it('class guard: the detector itself catches a drop issued under a cancelling timeout', () => {
    // Calibration: without this, a detector that never matched would pass vacuously.
    expect(() => expectNoDropUnderStatementTimeout([
      `SET statement_timeout = '20000ms'`,
      'DROP DATABASE IF EXISTS "it_x" WITH (FORCE)',
    ])).toThrow();
    expect(() => expectNoDropUnderStatementTimeout([
      `SET statement_timeout = '20000ms'`,
      `SET statement_timeout = '0'`,
      'DROP DATABASE IF EXISTS "it_x" WITH (FORCE)',
    ])).not.toThrow();
  });

  it('issues the primary drop with statement_timeout = 0', async () => {
    const queries: string[] = [];
    const result = await dropDatabaseWithLock({
      unsafe: async (query) => {
        queries.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ acquired: true }];
        return [];
      },
    }, 'it_guarded');
    expect(result).toBe('dropped');
    expect(queries).toContain(`SET client_connection_check_interval = '0'`);
    expectNoDropUnderStatementTimeout(queries);
  });

  it('never cancels a slow drop: it DETACHES and leaves the busy connection alone', async () => {
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

  it('reaps a swept INVALID database without a cancelling timeout', async () => {
    const queries: string[] = [];
    const result = await dropDatabaseWithLock({
      unsafe: async (query) => {
        queries.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ acquired: true }];
        if (query.includes(`c.description = '${TEST_DB_DEFERRED_MARKER}'`)) {
          return [{ datname: 'papercusp_it_baseline_invalid' }];
        }
        return [];
      },
    }, 'it_guarded');
    expect(result).toBe('dropped');
    expect(queries).toContain('DROP DATABASE IF EXISTS "papercusp_it_baseline_invalid" WITH (FORCE)');
    expectNoDropUnderStatementTimeout(queries);
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
