/**
 * WI-10003597 — the pass-proof writer against a REAL Postgres.
 *
 * `writeExecutedSourceRows` is the only thing that feeds per-file pass reuse
 * (plan gate-file-level-test-reuse-2026-09-27). Its unit tests inject the
 * `writeRows` seam, so the SQL itself was never executed by any test — and it
 * was broken: the `inputs_captured` flag was sent as a JS boolean[] with a
 * `::boolean[]` cast, which postgres.js serializes as a scalar boolean, so EVERY
 * write failed with "cannot cast type boolean to boolean[]". The reporter
 * catches the error and logs it to stderr only, so the gate silently recorded
 * zero proofs and reuse never applied.
 *
 * The schema is built from the REAL migrations that define the table (1132 +
 * 1236), never a hand-rolled CREATE TABLE, so this fixture cannot fall behind a
 * later column addition.
 *
 * Requires Docker (shared testcontainers PG).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from './pg-migrate.ts';
import { writeExecutedSourceRows, type ExecutedSourceRow } from './executed-source-map-reporter.ts';
import type { PgHandle } from './admin-test-runs-reporter.ts';

const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../papercusp/libs/db/sql');

/** Every armed migration that touches the table, in filename (= apply) order. */
function tableMigrations(): string[] {
  return readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readFileSync(join(SQL_DIR, f), 'utf8').includes('test_executed_sources'))
    .sort();
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function row(testFile: string, over: Partial<ExecutedSourceRow> = {}): ExecutedSourceRow {
  return { workspaceName: '@probe/ws', testFile, executedModules: ['src/a.ts', testFile], ...over };
}

describe('writeExecutedSourceRows against real Postgres (WI-10003597)', () => {
  let db: MigratedTestDb;
  let sql: ReturnType<typeof postgres>;
  let handle: PgHandle;

  beforeAll(async () => {
    const migrations = tableMigrations();
    // Positive control: if the migration dir moved, fail loudly instead of testing nothing.
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    db = await createFreshTestDb({
      prefix: 'itesm',
      provision: async (url) => {
        const p = postgres(url, { max: 1, onnotice: () => {} });
        try {
          await p.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
          for (const f of migrations) await p.unsafe(readFileSync(join(SQL_DIR, f), 'utf8'));
        } finally {
          await p.end();
        }
      },
    });
    sql = postgres(db.url, { max: 2, onnotice: () => {} });
    handle = { sql } as unknown as PgHandle;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await db?.drop();
  });

  it('persists a gate-shaped proof with inputs_captured=true, its read paths and run context', async () => {
    await writeExecutedSourceRows(
      {
        rows: [row('src/gate.test.ts', { inputsCaptured: true, readPaths: ['fixtures/x.json'], opaqueReasons: [] })],
        recordedSha: SHA_A,
        runGroupId: 'rg-1',
        workspaceName: '@probe/ws',
        runContext: 'green-checkpoint',
        runnerIdentity: 'v22.12.0 linux x64',
      },
      handle,
    );
    const [got] = await sql`
      SELECT recorded_sha, inputs_captured, read_paths, opaque_reasons, run_context, runner_identity, module_count
        FROM harness_shared.test_executed_sources WHERE test_file = 'src/gate.test.ts'`;
    expect(got).toMatchObject({
      recorded_sha: SHA_A,
      inputs_captured: true,
      read_paths: ['fixtures/x.json'],
      opaque_reasons: [],
      run_context: 'green-checkpoint',
      runner_identity: 'v22.12.0 linux x64',
      module_count: 2,
    });
  });

  it('keeps the per-row flag aligned in a mixed chunk (true, false, absent)', async () => {
    await writeExecutedSourceRows(
      {
        rows: [
          row('src/m1.test.ts', { inputsCaptured: true }),
          row('src/m2.test.ts', { inputsCaptured: false }),
          row('src/m3.test.ts'),
        ],
        recordedSha: SHA_A,
        runGroupId: null,
        runContext: null,
      },
      handle,
    );
    const got = await sql<{ test_file: string; inputs_captured: boolean; run_context: string | null }[]>`
      SELECT test_file, inputs_captured, run_context FROM harness_shared.test_executed_sources
       WHERE test_file LIKE 'src/m%' ORDER BY test_file`;
    expect(got.map((r) => [r.test_file, r.inputs_captured, r.run_context])).toEqual([
      ['src/m1.test.ts', true, null],
      ['src/m2.test.ts', false, null],
      ['src/m3.test.ts', false, null],
    ]);
  });

  it('a newer sha supersedes the same-context proof, and a retired file loses every proof', async () => {
    await writeExecutedSourceRows(
      {
        rows: [row('src/gate.test.ts', { inputsCaptured: true })],
        recordedSha: SHA_B,
        runGroupId: null,
        workspaceName: '@probe/ws',
        runContext: 'green-checkpoint',
        retiredFiles: ['src/m1.test.ts'],
      },
      handle,
    );
    const shas = await sql<{ recorded_sha: string }[]>`
      SELECT recorded_sha FROM harness_shared.test_executed_sources WHERE test_file = 'src/gate.test.ts'`;
    expect(shas.map((r) => r.recorded_sha)).toEqual([SHA_B]);
    const retired = await sql`SELECT 1 FROM harness_shared.test_executed_sources WHERE test_file = 'src/m1.test.ts'`;
    expect(retired).toHaveLength(0);
  });
});
