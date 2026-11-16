/** EI-28885010370277457: discriminate metadata work from PostgreSQL teardown.
 * These controlled stalls do not establish the historical incident's cause. */
import { expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestModule } from 'vitest/node';

const control = vi.hoisted(() => {
  // The package setup imports the reporter too. Reload it after installing
  // these mocks so its static Worker binding belongs to this fixture.
  vi.resetModules();
  return {
    hold: false,
    startupGate: null as Int32Array | null,
    startupWorkers: [] as import('node:worker_threads').Worker[],
    workers: [] as Array<{ emit(event: string, value: unknown): boolean }>,
    constructPg: vi.fn(() => { throw new Error('PostgreSQL must not be constructed in this fixture'); }),
  };
});

vi.mock('postgres', () => ({ default: control.constructPg }));
vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  const { EventEmitter } = await import('node:events');
  return { ...actual, Worker: vi.fn(function (...args: ConstructorParameters<typeof actual.Worker>) {
    if (control.startupGate && String(args[0]).endsWith('/git-read-worker.mjs')) {
      const preload = 'import {workerData} from "node:worker_threads";'
        + 'const gate=workerData.startupGate;Atomics.store(gate,0,1);'
        + 'while(Atomics.load(gate,1)===0)Atomics.wait(gate,1,0);';
      const worker = new actual.Worker(args[0], { ...args[1],
        execArgv: [...(args[1]?.execArgv ?? []), '--import', 'data:text/javascript,' + encodeURIComponent(preload)],
        workerData: { ...args[1]?.workerData, startupGate: control.startupGate },
      });
      control.startupWorkers.push(worker);
      return worker;
    }
    if (!control.hold || !String(args[0]).endsWith('/git-read-worker.mjs'))
      return new actual.Worker(...args);
    const worker = new EventEmitter();
    control.workers.push(worker);
    return worker;
  }) };
});

import AdminTestRunsReporter, {
  closeSharedPg, insertRows, runGit, SHARED_PG_DRAIN_TIMEOUT_MS, type TestRunRow,
} from './admin-test-runs-reporter.ts';

it.each(['before-spawn', 'after-spawn'] as const)(
  'identifies an actual metadata writer held %s without blaming PostgreSQL teardown', async phase => {
    const directory = mkdtempSync(join(tmpdir(), 'reporter-metadata-lifecycle-'));
    const receiptFile = join(directory, 'receipts.jsonl');
    const keys = ['PAPERCUSP_TEST_RUN_RECEIPT_FILE', 'PAPERCUSP_TEST_RUN_RECOVERY_FILE',
      'PAPERCUSP_TEST_REPORTER_STAGE_TRACE'] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE = receiptFile;
    process.env.PAPERCUSP_TEST_RUN_RECOVERY_FILE = receiptFile;
    process.env.PAPERCUSP_TEST_REPORTER_STAGE_TRACE = '1';
    const lines: string[] = [];
    const sink = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      lines.push(String(chunk));
      return true;
    });
    const events = () => lines.filter(line => line.startsWith('TEST_FILE_FINALIZATION '))
      .map(line => JSON.parse(line.slice('TEST_FILE_FINALIZATION '.length)));
    const releaseWorkers = () => {
      for (const worker of control.workers) worker.emit('message', { type: 'result', output: 'fixture-head' });
    };
    // An injected snapshot avoids unrelated source discovery; the writer still
    // calls the real insertRows -> resolveGitContext -> runGit worker path.
    // Wrapping insertRows also bypasses the evidence-consumer PG preflight.
    const writeRows = vi.fn(async (rows: readonly TestRunRow[]) => { await insertRows(rows); });
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'fixture-head', porcelain: '' }),
      undefined, writeRows);
    let final: Promise<void> | undefined;
    try {
      await closeSharedPg();
      await reporter.onInit({ config: { root: process.cwd() } } as never);
      control.workers = [];
      control.constructPg.mockClear();
      control.hold = true;
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      // Each case starts beyond the preceding case's metadata cache lifetime.
      vi.setSystemTime(new Date(phase === 'before-spawn' ? '2030-01-01T00:00:00Z' : '2030-01-02T00:00:00Z'));
      reporter.onTestModuleEnd({ moduleId: fileURLToPath(import.meta.url), state: () => 'passed',
        diagnostic: () => ({ duration: 1 }), children: { allTests: () => [] } } as unknown as TestModule);
      let finished = false;
      final = reporter.onTestRunEnd().then(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(writeRows).toHaveBeenCalledOnce();
      expect(control.workers).toHaveLength(2);
      if (phase === 'after-spawn') {
        // Synthetic workers own no real process group. Zero is deliberately
        // inert in the bridge's failure cleanup; no PID can be signalled.
        for (const worker of control.workers) {
          worker.emit('online', undefined);
          worker.emit('message', { type: 'started' });
          worker.emit('message', { type: 'spawned', pid: 0 });
        }
      }
      const readerEvents = events().filter(event => event.phase === 'reporter-git-reader');
      expect(readerEvents.filter(event => event.event === 'requested').map(event => event.commandKind).sort())
        .toEqual(['branch', 'head']);
      expect(readerEvents.filter(event => event.event === 'created')).toHaveLength(2);
      for (const event of ['online', 'worker-started', 'spawned'])
        expect(readerEvents.filter(row => row.event === event)).toHaveLength(phase === 'after-spawn' ? 2 : 0);
      await vi.advanceTimersByTimeAsync(25_000 + SHARED_PG_DRAIN_TIMEOUT_MS);
      await final;
      expect(finished).toBe(true);
      reporter.onProcessTimeout();
      expect(events()).toContainEqual(expect.objectContaining({
        phase: 'reporter-pg-timeout', holders: 0, inFlight: 1,
        closeRequested: true, clientRequested: false, closing: false,
      }));
      const metadataStart = events().find(event => event.stage === 'git-context' && event.event === 'start');
      expect(metadataStart).toBeDefined();
      expect(events().some(event => event.operationId === metadataStart.operationId && event.event === 'end')).toBe(false);
      expect(events().some(event => event.stage === 'pg-client' || event.stage === 'ledger-insert')).toBe(false);
      expect(events()).toContainEqual(expect.objectContaining({ stage: 'pg-release', event: 'end', outcome: 'returned' }));
      expect(control.constructPg).not.toHaveBeenCalled();
      const receipts = () => readFileSync(receiptFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(receipts()).toMatchObject([{ outcome: 'timeout', reason: 'flush_budget_25000ms' }]);

      releaseWorkers();
      await vi.runAllTimersAsync();
      await reporter.onExit();
      expect(events()).toContainEqual(expect.objectContaining({
        operationId: metadataStart.operationId, event: 'end', outcome: 'returned',
      }));
      for (const request of readerEvents.filter(event => event.event === 'requested'))
        expect(events()).toContainEqual(expect.objectContaining({
          phase: 'reporter-git-reader', operationId: request.operationId, event: 'result', readable: true,
        }));
      expect(receipts()).toContainEqual(expect.objectContaining({ outcome: 'failed', reason: 'pg_unavailable' }));
      expect(control.constructPg).not.toHaveBeenCalled();
      reporter.onProcessTimeout();
      expect(events().at(-1)).toMatchObject({
        phase: 'reporter-pg-timeout', holders: 0, inFlight: 0,
        closeRequested: false, clientRequested: false, closing: false,
      });
      expect(writeRows).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseWorkers();
      control.hold = false;
      if (vi.isFakeTimers()) await vi.runAllTimersAsync();
      await final;
      await reporter.onExit();
      await closeSharedPg();
      vi.useRealTimers();
      sink.mockRestore();
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')('distinguishes a real worker preload stall from its command deadline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-git-startup-'));
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const previousTrace = process.env.PAPERCUSP_TEST_REPORTER_STAGE_TRACE;
  process.env.PAPERCUSP_TEST_REPORTER_STAGE_TRACE = '1';
  const lines: string[] = [];
  const sink = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
  const events = () => lines.filter(line => line.startsWith('TEST_FILE_FINALIZATION '))
    .map(line => JSON.parse(line.slice('TEST_FILE_FINALIZATION '.length)))
    .filter(event => event.phase === 'reporter-git-reader');
  control.startupGate = gate;
  control.startupWorkers = [];
  let pending: Promise<string | null> | undefined;
  try {
    let settled = false;
    const failures: string[] = [];
    pending = runGit('printf startup-released', directory, 20, failure => failures.push(failure))
      .then(output => { settled = true; return output; });
    await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5_000 });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    expect(events().map(event => event.event)).toEqual(['requested', 'created', 'online']);
    expect(events().some(event => event.event === 'worker-started' || event.event === 'spawned')).toBe(false);

    // This is a diagnostic discriminator, not a claim that the historical
    // hang was in preload. Its command budget starts only after this gate.
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
    expect(await pending).toBe('startup-released');
    expect(failures).toEqual([]);
    await vi.waitFor(() => expect(events().at(-1)).toMatchObject({ event: 'exit', code: 0 }), { timeout: 5_000 });
    expect(events().map(event => event.event)).toEqual([
      'requested', 'created', 'online', 'worker-started', 'spawned', 'result', 'exit',
    ]);
  } finally {
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
    await pending;
    await Promise.all(control.startupWorkers.map(worker => worker.terminate()));
    control.startupGate = null;
    sink.mockRestore();
    if (previousTrace === undefined) delete process.env.PAPERCUSP_TEST_REPORTER_STAGE_TRACE;
    else process.env.PAPERCUSP_TEST_REPORTER_STAGE_TRACE = previousTrace;
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
