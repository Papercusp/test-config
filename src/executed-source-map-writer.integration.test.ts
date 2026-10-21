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
const GIT_DIR = '/probe/install-a/.git';

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
        recordedGitDir: GIT_DIR,
        runGroupId: 'rg-1',
        workspaceName: '@probe/ws',
        runContext: 'green-checkpoint',
        runnerIdentity: 'v22.12.0 linux x64',
      },
      handle,
    );
    const [got] = await sql`
      SELECT recorded_sha, inputs_captured, read_paths, opaque_reasons, run_context, runner_identity, module_count,
             recorded_git_dir
        FROM harness_shared.test_executed_sources WHERE test_file = 'src/gate.test.ts'`;
    expect(got).toMatchObject({
      recorded_sha: SHA_A,
      recorded_git_dir: GIT_DIR,
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
        recordedGitDir: GIT_DIR,
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

  it('persists, replaces and retires proofs with production type discovery disabled (EI-26208403092404320)', async () => {
    // tryGetPg uses fetch_types:false. A default postgres client discovers array
    // OIDs, hiding the scalar serialization used by the real reporter client.
    const reporterSql = postgres(db.url, { max: 1, fetch_types: false, onnotice: () => {} });
    const reporterHandle = { sql: reporterSql } as unknown as PgHandle;
    const workspaceName = '@probe/no-type-discovery';
    const testFile = 'src/quoted,"proof.test.ts';
    const modules = ['src/quoted,"module.ts', 'src/back\\slash.ts', testFile];
    const write = (rows: ExecutedSourceRow[], recordedSha: string, retiredFiles?: string[]) =>
      writeExecutedSourceRows({ rows, recordedSha, recordedGitDir: GIT_DIR, runGroupId: 'no-types', workspaceName,
        runContext: 'clean-local', retiredFiles }, reporterHandle);
    try {
      await write([
        row(testFile, { workspaceName, executedModules: modules, inputsCaptured: true,
          readPaths: ['fixtures/quoted,"input.json'], opaqueReasons: [] }),
        row('src/retired.test.ts', { workspaceName, inputsCaptured: false }),
      ], SHA_A);
      const initial = await sql`
        SELECT test_file, inputs_captured FROM harness_shared.test_executed_sources
         WHERE workspace_name = ${workspaceName} ORDER BY test_file`;
      expect(initial).toEqual([
        { test_file: testFile, inputs_captured: true },
        { test_file: 'src/retired.test.ts', inputs_captured: false },
      ]);
      await write([row(testFile, { workspaceName, executedModules: modules, inputsCaptured: true,
        readPaths: ['fixtures/quoted,"input.json'], opaqueReasons: ['reason,with"quotes'] })],
      SHA_B, ['src/retired.test.ts']);
      const remaining = await sql`
        SELECT test_file, recorded_sha, executed_modules, module_count, read_paths,
               inputs_captured, opaque_reasons
          FROM harness_shared.test_executed_sources WHERE workspace_name = ${workspaceName}`;
      expect(remaining).toEqual([{ test_file: testFile, recorded_sha: SHA_B,
        executed_modules: modules, module_count: 3, read_paths: ['fixtures/quoted,"input.json'],
        inputs_captured: true, opaque_reasons: ['reason,with"quotes'] }]);
    } finally {
      await reporterSql.end();
    }
  });

  it('a newer sha supersedes the same-context proof, and a retired file loses every proof', async () => {
    await writeExecutedSourceRows(
      {
        rows: [row('src/gate.test.ts', { inputsCaptured: true })],
        recordedSha: SHA_B,
        recordedGitDir: GIT_DIR,
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

  /**
   * WI-10004880 — the upsert used to conflict on (workspace, file, sha) and SET run_context, so a
   * clean-local run at a gate candidate sha flipped the gate's pass proof to clean-local and
   * loadReuseProofs (WHERE run_context = 'green-checkpoint') stopped seeing it.
   */
  it('a clean-local write at a gate sha never flips the gate proof, and a same-context rewrite still replaces', async () => {
    const SHA_C = 'c'.repeat(40);
    const write = (runContext: string, readPaths: string[]) =>
      writeExecutedSourceRows(
        {
          rows: [row('src/ctx.test.ts', { inputsCaptured: true, readPaths })],
          recordedSha: SHA_C,
          recordedGitDir: GIT_DIR,
          runGroupId: null,
          workspaceName: '@probe/ws',
          runContext,
        },
        handle,
      );
    const gateRows = () => sql<{ read_paths: string[] }[]>`
      SELECT read_paths FROM harness_shared.test_executed_sources
       WHERE workspace_name = '@probe/ws' AND test_file = 'src/ctx.test.ts'
         AND recorded_sha = ${SHA_C} AND run_context = 'green-checkpoint'`;

    await write('green-checkpoint', ['fixtures/first.json']);
    await write('clean-local', ['fixtures/local.json']);
    expect(await gateRows()).toEqual([{ read_paths: ['fixtures/first.json'] }]);

    await write('green-checkpoint', ['fixtures/second.json']);
    expect(await gateRows()).toEqual([{ read_paths: ['fixtures/second.json'] }]);
  });

  /**
   * WI-6554700010019324 — two installs that clone one repository share workspace names and run
   * contexts. Before 1552, install B's retention DELETE (same file and context, another sha)
   * removed install A's proof, and B's rule-5 retirement removed A's proofs too.
   */
  it("one install's newer sha, same sha and failure never delete another install's proofs", async () => {
    const GIT_DIR_B = '/probe/install-b/.git';
    const ws = '@probe/cross-install';
    const write = (gitDir: string, recordedSha: string, files: string[], retiredFiles?: string[]) =>
      writeExecutedSourceRows(
        { rows: files.map((f) => row(f, { workspaceName: ws, inputsCaptured: true })), recordedSha,
          recordedGitDir: gitDir, runGroupId: null, workspaceName: ws, runContext: 'green-checkpoint', retiredFiles },
        handle,
      );
    const proofs = () => sql<{ test_file: string; recorded_sha: string; recorded_git_dir: string | null }[]>`
      SELECT test_file, recorded_sha, recorded_git_dir FROM harness_shared.test_executed_sources
       WHERE workspace_name = ${ws} ORDER BY test_file, recorded_git_dir NULLS FIRST, recorded_sha`;

    // A pre-1552 row: the reporter never deletes what it cannot attribute, except on a failure.
    await sql`
      INSERT INTO harness_shared.test_executed_sources
        (workspace_name, test_file, recorded_sha, executed_modules, module_count, run_context)
      VALUES (${ws}, 'src/x.test.ts', ${'d'.repeat(40)}, ARRAY['src/x.test.ts'], 1, 'green-checkpoint')`;
    await write(GIT_DIR, SHA_A, ['src/x.test.ts', 'src/y.test.ts']);
    await write(GIT_DIR_B, SHA_B, ['src/x.test.ts', 'src/y.test.ts']);
    await write(GIT_DIR_B, SHA_A, ['src/x.test.ts']);
    expect(await proofs()).toEqual([
      { test_file: 'src/x.test.ts', recorded_sha: 'd'.repeat(40), recorded_git_dir: null },
      { test_file: 'src/x.test.ts', recorded_sha: SHA_A, recorded_git_dir: GIT_DIR },
      { test_file: 'src/x.test.ts', recorded_sha: SHA_A, recorded_git_dir: GIT_DIR_B },
      { test_file: 'src/y.test.ts', recorded_sha: SHA_A, recorded_git_dir: GIT_DIR },
      { test_file: 'src/y.test.ts', recorded_sha: SHA_B, recorded_git_dir: GIT_DIR_B },
    ]);

    // B fails src/x: B's proofs and the unattributable pre-1552 row go, A's stays.
    await write(GIT_DIR_B, SHA_B, [], ['src/x.test.ts']);
    expect((await proofs()).filter((p) => p.test_file === 'src/x.test.ts')).toEqual([
      { test_file: 'src/x.test.ts', recorded_sha: SHA_A, recorded_git_dir: GIT_DIR },
    ]);
  });
});
