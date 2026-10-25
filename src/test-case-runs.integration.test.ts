/**
 * test-rubric-unification-2026-10-12 P-001 (R-1) — per-case results in the test-run ledger.
 *
 * A real Vitest child run of a fixture file, recorded by the real AdminTestRunsReporter into
 * a fresh Postgres, must leave one harness_shared.test_runs row for the file and one
 * harness_shared.test_case_runs row per case: its describe/it title path, status, duration
 * and (for a failure) error tail. Unit tests inject the SQL seam, so only this test proves
 * the case INSERT, the RETURNING-id pairing and the migration agree with each other.
 *
 * The schema comes from the REAL migrations: the archived CREATE TABLE for test_runs, every
 * armed migration that ALTERs it, and the migration that creates test_case_runs. A later
 * test_runs column addition is therefore picked up here without editing this file.
 *
 * Requires Docker (shared testcontainers PG).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from './pg-migrate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(here, '../../papercusp/libs/db/sql');
const FIXTURE = resolve(here, '__fixtures__/case-ledger');
const FIXTURE_CONFIG = join(FIXTURE, 'vitest.config.ts');
const VITEST_BIN = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const CHILD_TIMEOUT_MS = 120_000;

/** Inherited variables a runner or gate may set; none may leak into the child. */
const STRIPPED_PREFIXES = ['PC_', 'VITEST', 'PAPERCUSP_TEST_', 'PAPERCUSP_MUTATION_', 'AFFECTED_'];

const ALTERS_TEST_RUNS = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?harness_shared\.test_runs\b/i;
const CREATES_TEST_CASE_RUNS = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?harness_shared\.test_case_runs\b/i;

/** The ledger's migrations in apply order: base table, its ALTERs, then the case table. */
function ledgerMigrations(): { base: string; alters: string[]; caseTable: string[] } {
  const armed = readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql') && f !== '000-baseline.sql');
  const text = (f: string) => readFileSync(join(SQL_DIR, f), 'utf8');
  const byNumber = (a: string, b: string) => Number.parseInt(a, 10) - Number.parseInt(b, 10);
  return {
    base: join('archive', '083-test-runs.sql'),
    alters: armed.filter((f) => ALTERS_TEST_RUNS.test(text(f))).sort(byNumber),
    caseTable: armed.filter((f) => CREATES_TEST_CASE_RUNS.test(text(f))).sort(byNumber),
  };
}

type CaseRow = {
  case_index: number;
  case_key: string;
  occurrence: number;
  status: string;
  duration_ms: number | null;
  error_tail: string | null;
};

describe('per-case results recorded by the real reporter (test_case_runs)', () => {
  let db: MigratedTestDb;
  let sql: ReturnType<typeof postgres>;
  let workDir: string;
  let child: { status: number | null; output: string };
  let receiptLines: string[];

  beforeAll(async () => {
    const migrations = ledgerMigrations();
    // Positive controls: a moved migration directory or a renamed table must fail loudly
    // rather than provision an empty schema and test nothing.
    expect(migrations.alters.length).toBeGreaterThanOrEqual(5);
    expect(migrations.caseTable).toHaveLength(1);
    db = await createFreshTestDb({
      prefix: 'itcase',
      provision: async (url) => {
        const p = postgres(url, { max: 1, onnotice: () => {} });
        try {
          await p.unsafe(`DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
          await p.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
          for (const f of [migrations.base, ...migrations.alters, ...migrations.caseTable]) {
            // The archived base carries psql meta-commands (`\set ON_ERROR_STOP on`); drop
            // them as operator-core's applyMigrationForTest does, since postgres-js is not psql.
            const text = readFileSync(join(SQL_DIR, f), 'utf8')
              .split('\n')
              .filter((line) => !line.trimStart().startsWith('\\'))
              .join('\n');
            await p.unsafe(text);
          }
        } finally {
          await p.end();
        }
      },
    });
    sql = postgres(db.url, { max: 2, onnotice: () => {} });

    workDir = mkdtempSync(join(tmpdir(), 'case-ledger-'));
    const receiptFile = join(workDir, 'receipts.jsonl');
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value;
    }
    Object.assign(env, {
      PAPERCUSP_TEST_RUNS_DB_URL: db.url,
      HARNESS_ADMIN_DATABASE_URL: db.url,
      // An evidence run: the reporter gets its long write budget and reports every row.
      PAPERCUSP_TEST_RUN_RECEIPT_FILE: receiptFile,
    });
    const run = spawnSync(process.execPath, [VITEST_BIN, 'run', '--root', FIXTURE, '--config', FIXTURE_CONFIG], {
      cwd: FIXTURE,
      env,
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
    });
    child = { status: run.status, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}` };
    try {
      receiptLines = readFileSync(receiptFile, 'utf8').split('\n').filter(Boolean);
    } catch {
      receiptLines = [];
    }
  }, CHILD_TIMEOUT_MS + 120_000);

  afterAll(async () => {
    await sql?.end();
    await db?.drop();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  async function fixtureRun(): Promise<{ id: string; status: string; output_tail: string }> {
    const rows = await sql<{ id: string; status: string; output_tail: string }[]>`
      SELECT id::text AS id, status, output_tail FROM harness_shared.test_runs
       WHERE file_path LIKE ${'%cases.case-fixture.ts'}`;
    expect(rows, child.output.slice(-3000)).toHaveLength(1);
    return rows[0]!;
  }

  it('the child run executed the fixture and failed only on its deliberate case', () => {
    // Exit 1 = a failing test; null would be a timeout and 2+ a config or startup error.
    expect(child.status, child.output.slice(-3000)).toBe(1);
    expect(child.output).toContain('case-ledger-expected');
    expect(receiptLines.map((line) => JSON.parse(line).outcome)).toContain('inserted');
  });

  it('records one case row per case, in module order, keyed by the describe/it title path', async () => {
    const run = await fixtureRun();
    expect(run.status).toBe('fail');
    const cases = await sql<CaseRow[]>`
      SELECT case_index, case_key, occurrence, status, duration_ms, error_tail
        FROM harness_shared.test_case_runs WHERE test_run_id = ${run.id} ORDER BY case_index`;
    expect(cases.map(({ case_index, case_key, occurrence, status }) => ({ case_index, case_key, occurrence, status })))
      .toEqual([
        { case_index: 0, case_key: 'case ledger fixture > passes', occurrence: 1, status: 'pass' },
        { case_index: 1, case_key: 'case ledger fixture > fails with a readable message', occurrence: 1, status: 'fail' },
        { case_index: 2, case_key: 'case ledger fixture > is skipped', occurrence: 1, status: 'skip' },
        { case_index: 3, case_key: 'case ledger fixture > nested > repeats under one name', occurrence: 1, status: 'pass' },
        { case_index: 4, case_key: 'case ledger fixture > nested > repeats under one name', occurrence: 2, status: 'pass' },
      ]);
    // Executed cases carry a measured duration; only the failure carries an error tail.
    for (const c of cases.filter((row) => row.status !== 'skip')) {
      expect(c.duration_ms, c.case_key).not.toBeNull();
      expect(c.duration_ms!, c.case_key).toBeGreaterThanOrEqual(0);
    }
    expect(cases[1]!.error_tail).toContain('case-ledger-expected');
    expect(cases[1]!.error_tail).toContain('\\0binary-bytes');
    expect(run.output_tail).toContain('\\0binary-bytes');
    expect(cases.filter((row) => row.status !== 'fail').every((row) => row.error_tail === null)).toBe(true);
  });

  it('prunes case rows with their file row (ON DELETE CASCADE)', async () => {
    const run = await fixtureRun();
    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.test_case_runs WHERE test_run_id = ${run.id}`;
    expect(before[0]!.n).toBe(5);
    await sql`DELETE FROM harness_shared.test_runs WHERE id = ${run.id}`;
    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.test_case_runs WHERE test_run_id = ${run.id}`;
    expect(after[0]!.n).toBe(0);
  });
});
