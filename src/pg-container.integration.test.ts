/**
 * teardownTestPg is a NO-OP for the shared reused container (WI-1992
 * recurrence guard). ~12 test files' afterAll used to `stop()` the ONE
 * `withReuse()` container every concurrent vitest process on the box shares —
 * the first file to finish killed everyone else's PG mid-run (the 233-fail
 * CONNECTION_CLOSED cascade). If this guard ever fails, that class is back.
 *
 * Deliberately does NOT exercise the FORCE_TEST_PG_TEARDOWN=1 escape hatch —
 * doing so would stop the shared container for real concurrent suites.
 */
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from './pg-container.ts';

describe('teardownTestPg (WI-1992)', () => {
  it('does NOT stop the shared reused container from a test teardown', async () => {
    const uri = await getTestPg();

    // The old behavior: any afterAll calling this stopped the box-shared container.
    await teardownTestPg();

    // Still up: a fresh connection works after the call.
    const sql = postgres(uri, { max: 1, onnotice: () => {} });
    try {
      const rows = (await sql.unsafe('SELECT 1 AS ok')) as Array<{ ok: number }>;
      expect(rows[0]!.ok).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
