/** EI-27982872070632258: a pending PG operation must not outlive reporter shutdown.
 * Both controls execute the same query against an owned PG cluster. A late success
 * is preserved; an indefinitely blocked query is destroyed after the bounded drain.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { resolveNativePgBinDir, startDedicatedNativePg } from './dedicated-native-pg.ts';
import { startDedicatedTestPg } from './pg-container.ts';

let pg: { getConnectionUri(): string; stop(): Promise<unknown> };
beforeAll(async () => {
  let native = false;
  try { resolveNativePgBinDir(); native = true; } catch { /* use maintained container fallback */ }
  pg = native ? await startDedicatedNativePg() : await startDedicatedTestPg();
}, 120_000);
afterAll(async () => { await pg?.stop(); }, 30_000);

it('recovers an exact timed-out receipt through real PG array and bigint decoding', async () => {
  const require = createRequire(import.meta.url);
  const script = `
    const rep = await import(${JSON.stringify(new URL('./admin-test-runs-reporter.ts', import.meta.url).href)});
    const handle = await rep.tryGetPg();
    if (!handle) throw new Error('real reporter client unavailable');
    try {
      await handle.sql.unsafe('CREATE SCHEMA harness_shared; CREATE TABLE harness_shared.test_runs (' +
        'id bigserial PRIMARY KEY, run_group_id text, file_path text, framework text, status text, ' +
        'duration_ms bigint, started_at timestamptz, finished_at timestamptz, commit_sha text, ' +
        'harness_slug text, workspace_id text, is_scratch_config boolean, worktree_dirty boolean, execution_details jsonb)');
      const at = new Date('2026-11-06T00:00:00.000Z');
      const details = { root: '/workspace/receipt-readback', filePath: 'guard.test.ts',
        runGroupId: 'receipt-group', commitSha: 'a'.repeat(40), harnessSlug: 'test', workspaceId: 'test' };
      const base = rep.testRunReceiptBaseFor({ filePath: details.filePath, status: 'pass', durationMs: 17,
        startedAt: at, finishedAt: at, outputTail: null, isScratchConfig: false, worktreeDirty: false,
        commitSha: details.commitSha, executionDetails: details });
      const receipt = { ...base, outcome: 'timeout', reason: 'pg_insert_timeout_25000ms', replayable: false };
      const insert = () => handle.sql\`INSERT INTO harness_shared.test_runs
        (run_group_id, file_path, framework, status, duration_ms, started_at, finished_at, commit_sha,
          harness_slug, workspace_id, is_scratch_config, worktree_dirty, execution_details)
        VALUES (\${details.runGroupId}, \${details.filePath}, 'vitest', 'pass', 17, \${at}, \${at},
          \${details.commitSha}, 'test', 'test', false, false, \${handle.sql.json(details)}) RETURNING id::text\`;
      const [inserted] = await insert();
      // Keep this test's client alive across the reader's normal unheld-client cleanup.
      const release = rep.retainSharedPg();
      try {
        const options = { expectedPaths: [details.filePath], expectedRoot: details.root,
          runGroupId: details.runGroupId, env: {} };
        const read = value => rep.reconcileTimedOutTestRunReceipts(JSON.stringify(value), options);
        const recovered = await read(receipt);
        const wrongCommit = await read({ ...receipt, row: { ...receipt.row, commitSha: 'b'.repeat(40),
          executionDetails: { ...details, commitSha: 'b'.repeat(40) } } });
        await insert();
        const ambiguous = await read(receipt);
        console.log(JSON.stringify({ inserted: inserted.id, recovered: recovered.map(row => row.id),
          wrongCommit: wrongCommit.map(row => row.id), ambiguous: ambiguous.map(row => row.id) }));
      } finally { await release(); }
    } finally { await rep.closeSharedPg(); }
  `;
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ['--import', require.resolve('tsx'), '--input-type=module', '-e', script],
      { timeout: 45_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, PAPERCUSP_TEST_RUNS_DB_URL: pg.getConnectionUri() } },
      (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
  });
  const measured = JSON.parse(result.stdout.trim());
  expect(measured).toEqual({ inserted: expect.any(String), recovered: [measured.inserted],
    wrongCommit: [], ambiguous: [] });
}, 60_000);

it.each(['pending', 'drained', 'pre-client'] as const)('closes the parent cleanly with a %s leased real PG query', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'shared-pg-parent-close-'));
  const require = createRequire(import.meta.url);
  const probe = join(root, 'probe.mjs');
  // Share the installed-driver regression's isolated candidate seam. The default
  // still exercises the installed package; candidate runs identify their source.
  const driverEntry = process.env.PAPERCUSP_POSTGRES_SHUTDOWN_TEST_ENTRY
    ?? pathToFileURL(require.resolve('postgres')).href;
  writeFileSync(join(root, 'probe.test.ts'), 'test("clean worker", () => expect(true).toBe(true));\n');
  writeFileSync(probe, `
    import { Writable } from 'node:stream';
    import { registerHooks } from 'node:module';
    const driverEntry = ${JSON.stringify(driverEntry)};
    registerHooks({ resolve(specifier, context, next) {
      return specifier === 'postgres' ? { url: driverEntry, shortCircuit: true } : next(specifier, context);
    } });
    const { createVitest } = await import(${JSON.stringify(pathToFileURL(require.resolve('vitest/node')).href)});
    const { default: AdminTestRunsReporter, retainSharedPg, tryGetPg, trackSharedPgOperation, SHARED_PG_DRAIN_TIMEOUT_MS } = await import(${JSON.stringify(new URL('./admin-test-runs-reporter.ts', import.meta.url).href)});
    if (SHARED_PG_DRAIN_TIMEOUT_MS !== 2000) throw new Error('reporter bounded-drain contract not loaded');
    process.stderr.write('PG_SHUTDOWN_SOURCE ' + JSON.stringify({ driverEntry, drainTimeoutMs: SHARED_PG_DRAIN_TIMEOUT_MS }) + '\\n');
    const [root, mode] = process.argv.slice(2);
    let operationPending = false;
    const event = (kind, detail = {}) => console.log(JSON.stringify({ kind, mode, ...detail }));
    const stream = new Writable({ write(chunk, _encoding, done) { process.stderr.write(chunk); done(); } });
    const runner = await createVitest('test', { root, config: false, watch: false,
      globals: true, include: ['probe.test.ts'], pool: 'forks', maxWorkers: 1,
      teardownTimeout: 500,
      reporters: [{ onProcessTimeout() {
        new AdminTestRunsReporter().onProcessTimeout();
        const port = Number(new URL(process.env.PAPERCUSP_TEST_RUNS_DB_URL).port || 5432);
        const sockets = process._getActiveHandles().filter(handle => handle.remotePort === port)
          .map(handle => ({ destroyed: handle.destroyed, referenced: handle._handle?.hasRef() }));
        event('process-timeout', { operationPending, poolClosed: !runner.pool, sockets });
      }, async onTestRunEnd(modules, errors, reason) {
        if (reason !== 'passed' || errors.length || modules.length !== 1) throw new Error('probe did not pass');
        event('test-passed');
        const release = retainSharedPg();
        if (mode === 'pre-client') {
          let begin;
          const ready = new Promise(resolve => { begin = resolve; });
          operationPending = true;
          const operation = trackSharedPgOperation(ready.then(async () => {
            const handle = await tryGetPg();
            if (!handle?.sql) throw new Error('delayed real PG client unavailable');
            const rows = await handle.sql.unsafe('SELECT 73 AS proof');
            if (rows[0].proof !== 73) throw new Error('delayed query did not complete');
            operationPending = false;
            event('query-settled');
          }));
          const closing = release().then(() => event('lease-released', { operationPending }));
          // Give the old early-return path a full loop turn to settle before
          // allowing metadata preparation to create the real client.
          await new Promise(resolve => setTimeout(resolve, 50));
          begin();
          await operation;
          await closing;
          return;
        }
        const handle = await tryGetPg();
        if (!handle?.sql) throw new Error('real PG client unavailable');
        const query = trackSharedPgOperation(handle.sql.unsafe(
          'SELECT pg_advisory_xact_lock(277023), 73 AS proof /* lease-parent-control */'));
        operationPending = true;
        void query.then(() => { operationPending = false; }, () => { operationPending = false; });
        // Observe the backend actually waiting, rather than guessing from a timer.
        const deadline = Date.now() + 10000;
        for (;;) {
          const rows = await handle.sql.unsafe("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory' AND query LIKE '%lease-parent-control%'");
          if (rows.length) break;
          if (Date.now() >= deadline) throw new Error('query never reached advisory wait');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        event('query-pending');
        if (mode === 'drained') {
          const rows = await query;
          if (rows[0].proof !== 73) throw new Error('query did not complete');
          event('query-settled');
        }
        await release();
        if (mode === 'pending') await query.then(
          () => { throw new Error('blocked query unexpectedly completed'); },
          error => event('query-cancelled', { code: error.code }),
        );
        event('lease-released', { operationPending });
      } }],
    }, undefined, { stdout: stream, stderr: stream });
    await runner.start();
    await runner.exit();
    event('runner-closed');
  `);
  try {
      const blocker = postgres(pg.getConnectionUri(), { max: 1, fetch_types: false, onnotice: () => {} });
      try {
        await blocker.unsafe('SELECT pg_advisory_lock(277023)');
        let unlock: Promise<unknown> | undefined;
        const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          let output = '';
          const child = execFile(process.execPath,
            ['--import', require.resolve('tsx'), probe, root, mode],
            { timeout: 45_000, maxBuffer: 1024 * 1024,
              env: { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '1',
                PAPERCUSP_TEST_RUNS_DB_URL: pg.getConnectionUri() } },
            (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
          child.stdout!.on('data', chunk => {
            output += String(chunk);
            if (mode === 'drained' && !unlock && output.includes('"kind":"query-pending"')) {
              unlock = Promise.resolve(blocker.unsafe('SELECT pg_advisory_unlock(277023)'));
              void unlock.catch(reject);
            }
          });
        });
        await unlock;
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        const events = records.map(record => record.kind);
        expect(events, JSON.stringify(result)).toEqual(mode === 'pre-client'
          ? ['test-passed', 'query-settled', 'lease-released', 'runner-closed'] : mode === 'pending'
          ? ['test-passed', 'query-pending', 'query-cancelled', 'lease-released', 'runner-closed']
          : ['test-passed', 'query-pending', 'query-settled', 'lease-released', 'runner-closed']);
        expect(result.stderr, JSON.stringify(result)).not.toContain('close timed out');
        const source = result.stderr.split('\n').find(line => line.startsWith('PG_SHUTDOWN_SOURCE '));
        expect(source).toBeDefined();
        expect(JSON.parse(source!.slice('PG_SHUTDOWN_SOURCE '.length)))
          .toEqual({ driverEntry, drainTimeoutMs: 2000 });
        expect(result.stderr, JSON.stringify({ mode, ...result }))
          .not.toMatch(/Timeout terminating .*worker|Failed to terminate .*worker/);
        if (mode === 'pending') {
          expect(records.find(record => record.kind === 'query-cancelled'))
            .toMatchObject({ code: 'CONNECTION_DESTROYED' });
        }
        expect(records.find(record => record.kind === 'lease-released')).toMatchObject({ operationPending: false });
        const lifecycle = result.stderr.split('\n').filter(line => line.startsWith('TEST_FILE_FINALIZATION '))
          .map(line => JSON.parse(line.slice('TEST_FILE_FINALIZATION '.length)));
        expect(lifecycle).toEqual([]);
      } finally {
        await blocker.unsafe('SELECT pg_advisory_unlock_all()');
        await blocker.end({ timeout: 2 });
      }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
