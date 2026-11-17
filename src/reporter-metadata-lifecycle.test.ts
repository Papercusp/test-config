/** EI-28885010370277457: discriminate metadata work from PostgreSQL teardown.
 * These controlled stalls do not establish the historical incident's cause. */
import { expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { TestModule } from 'vitest/node';

const control = vi.hoisted(() => {
  // The package setup imports the reporter too. Reload it after installing
  // these mocks so its static Worker binding belongs to this fixture.
  vi.resetModules();
  return {
    hold: false,
    startupGate: null as Int32Array | null,
    startupWorkers: [] as import('node:worker_threads').Worker[],
    workers: [] as Array<{ emit(event: string, value: unknown): boolean; terminate: ReturnType<typeof vi.fn> }>,
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
    const worker = Object.assign(new EventEmitter(), {
      terminate: vi.fn(async () => { worker.emit('exit', 1); return 1; }),
      postMessage: vi.fn(),
    });
    control.workers.push(worker);
    return worker;
  }) };
});

import AdminTestRunsReporter, {
  closeSharedPg, insertRows, runGit, type TestRunRow,
} from './admin-test-runs-reporter.ts';

it.each(['without-signal', 'with-signal'] as const)(
  'persists metadata independently of a held Worker startup (%s)', async phase => {
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
    // Hold every Git Worker before its entry module. Optional branch/commit
    // inference must still reach the real writer's pre-client failure receipt.
    const writeRows = vi.fn(async (rows: readonly TestRunRow[], signal?: AbortSignal) => {
      await insertRows(rows, phase === 'with-signal' ? signal : undefined);
    });
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'fixture-head', porcelain: '' }),
      undefined, writeRows);
    let final: Promise<void> | undefined;
    try {
      await closeSharedPg();
      await reporter.onInit({ config: { root: process.cwd() } } as never);
      control.workers = [];
      control.constructPg.mockClear();
      control.hold = true;
      vi.useFakeTimers({ toFake: ['Date'] });
      // Each case starts beyond the preceding case's metadata cache lifetime.
      vi.setSystemTime(new Date(phase === 'without-signal' ? '2030-01-01T00:00:00Z' : '2030-01-02T00:00:00Z'));
      reporter.onTestModuleEnd({ moduleId: fileURLToPath(import.meta.url), state: () => 'passed',
        diagnostic: () => ({ duration: 1 }), children: { allTests: () => [] } } as unknown as TestModule);
      let finished = false;
      final = reporter.onTestRunEnd().then(() => { finished = true; });
      await vi.waitFor(() => expect(control.constructPg).toHaveBeenCalledOnce(), { timeout: 2_000 });
      await final;
      expect(writeRows).toHaveBeenCalledOnce();
      expect(control.workers).toHaveLength(0);
      const readerEvents = events().filter(event => event.phase === 'reporter-git-reader');
      expect(readerEvents).toEqual([]);
      expect(finished).toBe(true);
      reporter.onProcessTimeout();
      expect(events()).toContainEqual(expect.objectContaining({
        phase: 'reporter-pg-timeout', holders: 0, inFlight: 0,
        closeRequested: false, clientRequested: false, closing: false,
      }));
      const metadataStart = events().find(event => event.stage === 'git-context' && event.event === 'start');
      expect(metadataStart).toBeDefined();
      expect(events()).toContainEqual(expect.objectContaining({
        operationId: metadataStart.operationId, event: 'end', outcome: 'returned',
      }));
      expect(events()).toContainEqual(expect.objectContaining({ stage: 'pg-client', event: 'end' }));
      expect(events().some(event => event.stage === 'ledger-insert')).toBe(false);
      expect(events()).toContainEqual(expect.objectContaining({ stage: 'pg-release', event: 'end', outcome: 'returned' }));
      const receipts = () => readFileSync(receiptFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(receipts()).toMatchObject([{ outcome: 'failed', reason: 'pg_unavailable', replayable: true,
        runContext: expect.objectContaining({ configurationSnapshot: expect.any(Object) }),
      }]);
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

it('retains replayable results without starting Git or PG after metadata cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-metadata-cancellation-'));
  const receiptFile = join(directory, 'receipts.jsonl');
  const previousReceipt = process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
  process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE = receiptFile;
  const controller = new AbortController();
  controller.abort();
  const writeRows = vi.fn(async (rows: readonly TestRunRow[]) => { await insertRows(rows, controller.signal); });
  const reporter = new AdminTestRunsReporter(async () => ({ commit: 'fixture-head', porcelain: '' }), undefined, writeRows);
  let final: Promise<void> | undefined;
  try {
    await closeSharedPg();
    await reporter.onInit({ config: { root: process.cwd() } } as never);
    control.workers = [];
    control.constructPg.mockClear();
    control.hold = true;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
    reporter.onTestModuleEnd({ moduleId: fileURLToPath(import.meta.url), state: () => 'passed',
      diagnostic: () => ({ duration: 1 }), children: { allTests: () => [] } } as unknown as TestModule);
    final = reporter.onTestRunEnd();
    await vi.advanceTimersByTimeAsync(0);
    expect(control.workers).toHaveLength(0);
    await final;
    expect(controller.signal.aborted).toBe(true);
    expect(control.constructPg).not.toHaveBeenCalled();
    const receipts = readFileSync(receiptFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(receipts).toContainEqual(expect.objectContaining({
      outcome: 'failed', reason: 'git_metadata_cancelled', replayable: true,
      runContext: expect.objectContaining({
        configurationSnapshot: expect.objectContaining({ schemaVersion: 1, fingerprint: expect.any(String) }),
      }),
      row: expect.objectContaining({ commitSha: 'fixture-head', receiptAttempt: 0 }),
    }));
    expect(vi.getTimerCount()).toBe(0);
    const lines: string[] = [];
    const sink = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
    try { reporter.onProcessTimeout(); } finally { sink.mockRestore(); }
    expect(JSON.parse(lines[0].slice('TEST_FILE_FINALIZATION '.length))).toMatchObject({
      holders: 0, inFlight: 0, closeRequested: false, clientRequested: false, closing: false,
    });
  } finally {
    for (const worker of control.workers) worker.emit('message', { type: 'result', output: 'fixture-head' });
    control.hold = false;
    if (vi.isFakeTimers()) await vi.runAllTimersAsync();
    await final;
    await reporter.onExit();
    await closeSharedPg();
    vi.useRealTimers();
    if (previousReceipt === undefined) delete process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
    else process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE = previousReceipt;
    rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('cancels and reaps a real worker held before its entry module', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-git-startup-cancel-'));
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const controller = new AbortController();
  control.startupGate = gate;
  control.startupWorkers = [];
  let pending: Promise<string | null> | undefined;
  try {
    let settled = false;
    pending = runGit('printf must-not-spawn', directory, 20, undefined, controller.signal)
      .then(output => { settled = true; return output; });
    await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5_000 });
    const exited = Promise.all(control.startupWorkers.map(worker => new Promise(resolve => worker.once('exit', resolve))));
    controller.abort();
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000 });
    expect(await pending).toBeNull();
    await exited;
  } finally {
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
    await pending;
    await Promise.all(control.startupWorkers.map(worker => worker.terminate()));
    control.startupGate = null;
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

it('does not create a worker for an already-aborted Git read', async () => {
  const controller = new AbortController();
  controller.abort();
  const failures = vi.fn();
  const workersBefore = vi.mocked(Worker).mock.calls.length;
  expect(await runGit('printf must-not-spawn', process.cwd(), 20, failures, controller.signal)).toBeNull();
  expect(vi.mocked(Worker).mock.calls).toHaveLength(workersBefore);
  expect(failures).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'linux')('cancels a running command and waits for its worker and process group to stop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-git-running-cancel-'));
  const marker = join(directory, 'running.pid');
  const script = join(directory, 'running.cjs');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const controller = new AbortController();
  const failures: string[] = [];
  const running = (pid: number) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  writeFileSync(script, [
    'process.on("SIGTERM", () => {});',
    'require("node:fs").writeFileSync(process.argv[2], String(process.pid));',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const pending = runGit(`${quote(process.execPath)} ${quote(script)} ${quote(marker)}`,
    directory, 10_000, detail => failures.push(detail), controller.signal);
  const worker = vi.mocked(Worker).mock.results.at(-1)!.value as Worker;
  const exited = new Promise<number>(resolve => worker.once('exit', resolve));
  let groupPid: number | undefined;
  worker.on('message', message => { if (message.type === 'spawned') groupPid = message.pid; });
  try {
    await vi.waitFor(() => {
      expect(existsSync(marker)).toBe(true);
      expect(groupPid).toBeGreaterThan(0);
    }, { timeout: 5_000 });
    const descendant = Number(readFileSync(marker, 'utf8'));
    expect(running(descendant)).toBe(true);
    controller.abort();
    expect(await pending).toBeNull();
    expect(await exited).toBe(0);
    expect(failures).toHaveLength(1);
    expect(JSON.parse(failures[0])).toMatchObject({ killed: true, message: 'git reader cancelled by caller' });
    // Resolution acknowledges worker exit and stopped commands, rather than
    // merely queueing cancellation while a descendant remains running.
    expect(running(descendant)).toBe(false);
    expect(running(groupPid!)).toBe(false);
  } finally {
    controller.abort();
    await pending;
    await worker.terminate();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

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
    const output = await pending;
    // The assertion concerns the preload interval. Once released, a real
    // command may legitimately exhaust its 20ms budget before its close event
    // is delivered; require that exact post-spawn diagnosis in that case.
    if (output === null) {
      expect(failures).toHaveLength(1);
      expect(JSON.parse(failures[0])).toMatchObject({ message: 'command timed out', killed: true, timeoutMs: 20 });
    } else {
      expect(output).toBe('startup-released');
      expect(failures).toEqual([]);
    }
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
