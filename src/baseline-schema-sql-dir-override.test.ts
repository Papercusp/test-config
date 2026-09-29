/**
 * PAPERCUSP_TEST_SQL_DIR lets a migration-subject guard be mutation-probed from a
 * scratch corpus. It must never reach the REUSED baseline container, whose
 * applied-migration ledger would keep the substituted schema for later runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BASELINE_SQL_DIR_OVERRIDE_ENV, resolveBaselineSqlDir } from './baseline-schema-global-setup';

const scratch = mkdtempSync(join(tmpdir(), 'baseline-sql-dir-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('resolveBaselineSqlDir', () => {
  it('uses the repo corpus when no override is set', () => {
    expect(resolveBaselineSqlDir({}, '/repo/libs/papercusp/libs/db/sql')).toBe('/repo/libs/papercusp/libs/db/sql');
  });

  it('refuses the override without the fresh-database escape hatch', () => {
    expect(() => resolveBaselineSqlDir({ [BASELINE_SQL_DIR_OVERRIDE_ENV]: scratch }, '/repo/sql')).toThrow(
      /PAPERCUSP_TEST_PG_ADMIN_URL is not/,
    );
  });

  it('uses the override on the fresh-database escape hatch', () => {
    const env = { [BASELINE_SQL_DIR_OVERRIDE_ENV]: scratch, PAPERCUSP_TEST_PG_ADMIN_URL: 'postgres://x@127.0.0.1/postgres' };
    expect(resolveBaselineSqlDir(env, '/repo/sql')).toBe(scratch);
  });

  it('refuses an override that does not exist', () => {
    const env = {
      [BASELINE_SQL_DIR_OVERRIDE_ENV]: join(scratch, 'missing'),
      PAPERCUSP_TEST_PG_ADMIN_URL: 'postgres://x@127.0.0.1/postgres',
    };
    expect(() => resolveBaselineSqlDir(env, '/repo/sql')).toThrow(/does not exist/);
  });
});
