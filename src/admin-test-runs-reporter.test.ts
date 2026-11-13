/**
 * P-044: Fail-soft tests for admin-test-runs-reporter.
 *
 * D-007 contract: reporter MUST never throw, never affect exit code,
 * never poison stdout/stderr, even when PG / git / fs are unavailable.
 *
 * Moved here (2026-06-08) when the reporter was lifted into @papercusp/test-config
 * + auto-wired by defineVitestConfig. Vitest 4 API: onTestModuleEnd / onTestRunEnd /
 * onExit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { defaultEvidenceRoot } from '@papercusp/verification-harness';
import { MAX_RECORDED_CASE_TITLE_CHARS, MAX_RECORDED_PASSED_CASES, parseRecordedTestPopulation } from './execution-details.ts';
import { inputsFilePath } from './executed-inputs-capture.ts';
import { redactSensitiveText } from './sensitive-text.ts';
import AdminTestRunsReporter, {
  nativeTestRunAttribution,
  observeReporterStage,
  buildOutputTail,
  captureWorktreeSnapshot,
  captureSourceByteSnapshot,
  captureSourceByteSnapshotInWorker,
  type SourceByteCensusWorkerFactory,
  collectModuleExecution,
  collectIsolatedRuntimeReceipts,
  collectBoundaryObservations,
  collectSqlCoverageObservations,
  captureReporterSaturationSnapshot,
  classifyGitEntry,
  computeWorkspaceRootFrom,
  computeWorktreeDirty,
  describeWorktreeDirt,
  exemptProbeSubject,
  WORKTREE_SNAPSHOT_GIT_BUDGETS_MS,
  computeIsScratchConfig,
  inferWorkspaceRoot,
  insertTestRunRowsWithSql,
  isDefinitePreSubmitFailure,
  isMissingConfigurationSnapshotColumn,
  missingTestRunReceiptPaths,
  latestTestRunReceipts,
  recoverTimedOutTestRunReceipts,
  reconcileTimedOutTestRunReceiptsWithSql,
  pendingTestRunRecoveryPaths,
  readRunConfigRoot,
  setRunRoot,
  testRunReceiptBaseFor,
  toWorkspaceRel,
  formatTestCaseError,
  isScratchConfigFile,
  isMutationProbeRun,
  resolveMutationProbePhase,
  resolveRecordedTestRunSource,
  resolveReporterHostLoopLag,
  resolveTestRunCommit,
  resolveTestRunHarnessSlug,
  resolveTestRunWorkspaceId,
  resolveTestRunsPgUrl,
  resolveWorktreeSnapshotRoot,
  runGit,
  shouldRecordTestRunPath,
  TEST_RUN_INSERT_BATCH_SIZE,
  TEST_RUN_RECEIPT_ENV,
  TEST_RUN_RECOVERY_ENV,
  appendTestRunReceipts,
  reporterWriteBudget,
  SHARED_PG_DRAIN_TIMEOUT_MS,
  normalizeRuntimeEnvironmentCaptureTimeout,
  DEFAULT_RUNTIME_ENVIRONMENT_CAPTURE_TIMEOUT_MS,
  MAX_RUNTIME_ENVIRONMENT_CAPTURE_TIMEOUT_MS,
  type PgSql,
  type TestRunReceipt,
  type TestRunReceiptReadbackCandidate,
  type TestRunRow,
  type WorktreeGitRunner,
} from './admin-test-runs-reporter';
import { parseTestRunExecutionDetails } from './execution-details.ts';
import { captureConfigurationSnapshot } from './configuration-snapshot.ts';
import { readVerifierSourceReceiptSync, verifierGitCheckoutSync, verifierSourceFiles } from './verifier-source.ts';

const TEST_CONFIG_ROOT = fileURLToPath(new URL('../', import.meta.url));
describe('native Node TypeScript parser compatibility (EI-28690145575369014)', () => {
  it('parses the complete reporter with native type stripping', () => {
    const source = readFileSync(new URL('./admin-test-runs-reporter.ts', import.meta.url), 'utf8');

    expect(() => stripTypeScriptTypes(source, { mode: 'strip' })).not.toThrow();
  });

  it('detects a type assertion separated from its initializer by a newline', () => {
    const source = [
      'type Receipt = { outcome: "timeout" } | { outcome: "inserted" };',
      'const receipts = ([] as Receipt[]).filter(receipt => receipt.outcome === "timeout")',
      '  as Extract<Receipt, { outcome: "timeout" }>[];',
    ].join('\n');

    expect(() => stripTypeScriptTypes(source, { mode: 'strip' })).toThrow();
  });
});

describe('actual source-byte census', () => {
  it('measures Git bytes across equivalent commits, edits and unmapped files, refusing escaped inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'reporter-source-bytes-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.email=test@test',
      '-c', 'user.name=test', ...args], { stdio: 'pipe' });
    try {
      git('init', '-q'); writeFileSync(join(root, 'a.ts'), 'export const a = 1');
      git('add', '-A'); git('commit', '-qm', 'source');
      const before = captureSourceByteSnapshot(root);
      expect(before).toMatchObject({ schemaVersion: 'source-bytes-v1', fileCount: 1 });
      git('commit', '--allow-empty', '-qm', 'equivalent');
      expect(captureSourceByteSnapshot(root)).toEqual(before);
      writeFileSync(join(root, 'a.ts'), 'export const a = 2');
      expect(captureSourceByteSnapshot(root)?.sha256).not.toBe(before?.sha256);
      writeFileSync(join(root, 'unmapped.ts'), 'export const extra = 1');
      expect(captureSourceByteSnapshot(root)?.fileCount).toBe(2);
      symlinkSync('/etc/hostname', join(root, 'escaped'));
      expect(captureSourceByteSnapshot(root)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns the same complete manifest from the cancellable worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reporter-source-bytes-worker-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    try {
      git('init', '-q');
      writeFileSync(join(root, 'tracked.ts'), 'export const tracked = 1;\n');
      git('add', '-A');
      git('-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-qm', 'source');
      writeFileSync(join(root, 'untracked.ts'), 'export const untracked = 2;\n');
      await expect(captureSourceByteSnapshotInWorker(root))
        .resolves.toEqual(captureSourceByteSnapshot(root));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('waits for an abandoned census worker to terminate before settling', async () => {
    let finishTermination: ((exitCode: number) => void) | undefined;
    const worker = {
      once: vi.fn(),
      terminate: vi.fn(() => new Promise<number>(resolve => { finishTermination = resolve; })),
    };
    const workerFactory = (() => worker) as unknown as SourceByteCensusWorkerFactory;
    const controller = new AbortController();
    let settled = false;
    const pending = captureSourceByteSnapshotInWorker('/unused', controller.signal, workerFactory)
      .then(result => { settled = true; return result; });

    controller.abort();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    finishTermination?.(1);
    await expect(pending).resolves.toBeNull();
    expect(settled).toBe(true);
  });
});

const MUTATION_FINALIZATION_DESCRIPTOR = JSON.stringify({
  schemaVersion: 1, probeInvocationId: 'qualified-mutation-finalization', mode: 'copy-out',
  subjectPath: 'source.ts', mutateExpression: 's/before/after/', againstCommit: null,
  subjectBeforeSha256: 'a'.repeat(64), subjectAfterSha256: 'b'.repeat(64),
  testCommandSha256: 'c'.repeat(64), mutantDiff: '-before\n+after', mutantDiffTruncated: false,
});
describe('native test execution custody', () => {
  it('requires an explicit item, actor and stable group rather than a guessed goal', () => {
    const env = { PAPERCUSP_SID: 'agent-a', PAPERCUSP_TEST_RUN_WORK_ITEM: 'EI-123',
      PAPERCUSP_TEST_RUN_GROUP: 'native-1' };
    expect(nativeTestRunAttribution(env)).toEqual({ attribution: { ownerId: 'agent-a', workItemId: 'EI-123' } });
    for (const missing of ['PAPERCUSP_SID', 'PAPERCUSP_TEST_RUN_WORK_ITEM', 'PAPERCUSP_TEST_RUN_GROUP'])
      expect(nativeTestRunAttribution({ ...env, [missing]: '' })).toEqual({});
    expect(nativeTestRunAttribution({ ...env, PAPERCUSP_TEST_RUN_WORK_ITEM: 'unrelated-goal' })).toEqual({});
  });
  it('retains reporter attribution with no operational session identity', () => {
    const env = { PAPERCUSP_TEST_RUN_OWNER_ID: 'agent-evidence',
      PAPERCUSP_TEST_RUN_WORK_ITEM: 'EI-123', PAPERCUSP_TEST_RUN_GROUP: 'isolated-1' };
    expect(nativeTestRunAttribution(env)).toEqual({
      attribution: { ownerId: 'agent-evidence', workItemId: 'EI-123' },
    });
    expect(nativeTestRunAttribution({ ...env, PAPERCUSP_SID: 'private-product' })).toEqual({
      attribution: { ownerId: 'agent-evidence', workItemId: 'EI-123' },
    });
    for (const missing of ['PAPERCUSP_TEST_RUN_OWNER_ID', 'PAPERCUSP_TEST_RUN_WORK_ITEM', 'PAPERCUSP_TEST_RUN_GROUP'])
      expect(nativeTestRunAttribution({ ...env, [missing]: '' })).toEqual({});
  });
  it.each([
    { ownerId: undefined, expectedOwner: 'agent-native' },
    { ownerId: 'agent-evidence', expectedOwner: 'agent-evidence' },
  ])('persists custody through the real reporter hooks for $expectedOwner', async ({ ownerId, expectedOwner }) => {
    vi.stubEnv('PAPERCUSP_SID', 'agent-native');
    vi.stubEnv('PAPERCUSP_TEST_RUN_OWNER_ID', ownerId);
    vi.stubEnv('PAPERCUSP_TEST_RUN_WORK_ITEM', 'EI-123');
    vi.stubEnv('PAPERCUSP_TEST_RUN_GROUP', 'native-hooks');
    const persisted: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }),
      async row => { persisted.push(row); });
    await reporter.onInit({ vite: { config: { configFile: `${process.cwd()}/vitest.config.ts` } } } as Parameters<typeof reporter.onInit>[0]);
    reporter.onTestModuleEnd({ moduleId: join(process.cwd(), 'src/admin-test-runs-reporter.test.ts'),
      state: () => 'passed', diagnostic: () => ({ duration: 1 }), errors: () => [],
      children: { allTests: () => [{ fullName: 'native custody', result: () => ({ state: 'passed' }) }] },
    } as unknown as Parameters<typeof reporter.onTestModuleEnd>[0]);
    await reporter.onTestRunEnd();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].executionDetails).toMatchObject({ runGroupId: 'native-hooks',
      attribution: { ownerId: expectedOwner, workItemId: 'EI-123' } });
  });
});
describe('reporter finalization stage diagnostics', () => {
  it('emits reporter-stage spans only when the per-run diagnostic flag is enabled', async () => {
    vi.stubEnv('PC_ISOLATED_RUNTIME_PROOF', '');
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', '');
    vi.stubEnv('PAPERCUSP_TEST_REPORTER_STAGE_TRACE', '');
    const lines: string[] = [];
    const sink = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
    try {
      await expect(observeReporterStage('test-runs', 'onExit', async () => 'ordinary')).resolves.toBe('ordinary');
      expect(lines).toHaveLength(0);
      vi.stubEnv('PAPERCUSP_TEST_REPORTER_STAGE_TRACE', '1');
      await expect(observeReporterStage('test-runs', 'onExit', async () => 'traced')).resolves.toBe('traced');
      const events = lines.map(line => JSON.parse(line.slice('TEST_FILE_FINALIZATION '.length)));
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ phase: 'reporter-stage', reporter: 'test-runs', stage: 'onExit', event: 'start' });
      expect(events[1]).toMatchObject({ event: 'end', outcome: 'returned', operationId: events[0].operationId });
    } finally { sink.mockRestore(); vi.unstubAllEnvs(); }
  });

  it('keeps a pending operation open and preserves settlement when the diagnostic sink fails', async () => {
    vi.stubEnv('PC_ISOLATED_RUNTIME_PROOF', '1');
    const lines: string[] = [];
    const sink = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
    let release!: (value: number) => void;
    try {
      const pending = observeReporterStage('test-runs', 'source-snapshot', () => new Promise<number>(resolve => { release = resolve; }));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0].slice('TEST_FILE_FINALIZATION '.length))).toMatchObject({ event: 'start', stage: 'source-snapshot' });
      release(17);
      await expect(pending).resolves.toBe(17);
      const events = lines.map(line => JSON.parse(line.slice('TEST_FILE_FINALIZATION '.length)));
      expect(events[1]).toMatchObject({ event: 'end', outcome: 'returned', operationId: events[0].operationId });
      sink.mockImplementation(() => { throw new Error('diagnostic unavailable'); });
      const original = new Error('original operation');
      await expect(observeReporterStage('test-runs', 'write-rows', async () => { throw original; })).rejects.toBe(original);
    } finally { sink.mockRestore(); vi.unstubAllEnvs(); }
  });

  it('distinguishes a blocked final snapshot from ledger writing and PG release through real hooks', async () => {
    vi.stubEnv('PC_ISOLATED_RUNTIME_PROOF', '1');
    const lines: string[] = [];
    const sink = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
    let reads = 0, release!: (value: { commit: string; porcelain: string }) => void;
    const writing = vi.fn(async () => {});
    const reporter = new AdminTestRunsReporter(async () => ++reads === 1
      ? { commit: 'abc', porcelain: '' } : new Promise(resolve => { release = resolve; }), undefined, writing);
    const events = () => lines.filter(line => line.startsWith('TEST_FILE_FINALIZATION '))
      .map(line => JSON.parse(line.slice('TEST_FILE_FINALIZATION '.length)));
    let pending: Promise<void> | undefined;
    try {
      await reporter.onInit({ vite: { config: { configFile: `${process.cwd()}/vitest.config.ts` } } } as never);
      reporter.onTestModuleEnd({ moduleId: join(process.cwd(), 'src/admin-test-runs-reporter.test.ts'),
        state: () => 'passed', diagnostic: () => ({ duration: 1 }), errors: () => [],
      } as never);
      pending = reporter.onTestRunEnd();
      await vi.waitFor(() => expect(reads).toBe(2));
      expect(events().filter(row => row.stage === 'source-snapshot' && row.event === 'end')).toHaveLength(1);
      expect(events()).toContainEqual(expect.objectContaining({ stage: 'onTestRunEnd', event: 'start' }));
      expect(writing).not.toHaveBeenCalled();
      release({ commit: 'abc', porcelain: '' });
      await pending;
      expect(writing).toHaveBeenCalledTimes(1);
      expect(events().filter(row => row.event === 'end').map(row => row.stage))
        .toEqual(['source-snapshot', 'source-snapshot', 'write-rows', 'pg-release', 'onTestRunEnd']);
    } finally {
      release?.({ commit: 'abc', porcelain: '' }); await pending;
      sink.mockRestore(); vi.unstubAllEnvs();
    }
  });
});

/** The resolver the reporter's onInit loads in a hive that ships verification-harness. */
describe('framework boundary case identities', () => {
  const receipt = { boundary: 'graph:query:evidence', callId: 'dispatch-1', workspaceId: 'ws', harness: 'repo',
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16), traceFlags: 1,
    startedAt: 1, endedAt: 2, outcome: 'ok', sourceFingerprint: 'd'.repeat(64), buildSha: 'e'.repeat(40),
    artifactFingerprint: null, environmentFingerprint: 'f'.repeat(64), workflowId: null };
  it('counts duplicate names in framework order including skipped occurrences, and tolerates receipt-absent modules', () => {
    const cases = [{ fullName: 'same case', result: () => ({ state: 'skipped' }) },
      { fullName: 'same case', result: () => ({ state: 'passed' }), meta: () => ({ papercuspExecutionObservations: [receipt] }) }];
    expect(collectBoundaryObservations({ children: { allTests: () => cases } } as never))
      .toEqual([{ caseKey: 'same case', occurrence: 2, receipt }]);
    expect(collectBoundaryObservations({ children: { allTests: () => [{ result: () => ({ state: 'passed' }) }] } } as never))
      .toBeUndefined();
    expect(collectBoundaryObservations({ children: { allTests: () => [{ fullName: 'case', result: () => ({ state: 'passed' }),
      meta: () => ({ papercuspExecutionObservations: [{ ...receipt, spanId: receipt.parentSpanId }] }) }] } } as never))
      .toBeUndefined();
  });
});

const collectReceipts = (testModule: Parameters<typeof collectIsolatedRuntimeReceipts>[0]) =>
  collectIsolatedRuntimeReceipts(testModule, defaultEvidenceRoot);

describe('framework SQL coverage case identities', () => {
  const execution = (toolName: string, callId: string) => ({ schemaVersion: 1, callId, workspaceId: 'ws', harness: 'repo',
    scopeId: 'a'.repeat(64), toolName, contractRef: 'contract-v1', startedAt: 1, endedAt: 2, outcome: 'ok', argsToken: 'b'.repeat(64),
    resultToken: 'c'.repeat(64), sourceFingerprint: 'd'.repeat(64), buildSha: 'e'.repeat(40),
    artifactFingerprint: 'f'.repeat(64), environmentFingerprint: '1'.repeat(64) });
  const hint = () => ({ fixtureRef: 'fixture:jobs-v1', scopeId: 'a'.repeat(64), parserVersion: 'parser-v1',
    fingerprint: '2'.repeat(64), featuresToken: '3'.repeat(64), contractRef: 'contract-v1', verdict: 'exact',
    missingFeatures: [], sqlExecution: execution('dev:pg_query', 'sql'), toolExecution: execution('jobs:list', 'tool') });
  const module = (cases: unknown[]) => ({ children: { allTests: () => cases } }) as never;
  const test = (state: string, values?: unknown) => ({ fullName: 'same case', result: () => ({ state }),
    meta: () => ({ papercuspSqlCoverageObservations: values }) });
  it('uses framework identities and only passing occurrences, including earlier skipped/failed duplicates', () => {
    expect(collectSqlCoverageObservations(module([test('skipped', [hint()]), test('failed', [hint()]),
      test('passed', [{ ...hint(), caseKey: 'forged', occurrence: 99 }])])))
      .toEqual([{ ...hint(), caseKey: 'same case', occurrence: 3 }]);
    expect(collectSqlCoverageObservations(module([test('failed', [hint()])]))).toBeUndefined();
    expect(collectSqlCoverageObservations(module([test('passed')]))).toBeUndefined();
  });
  it('fails closed for private fields, invalid receipts and oversized or duplicate metadata', () => {
    for (const values of [[{ ...hint(), sql: 'private SQL' }], [{ ...hint(), toolExecution: {} }],
      [hint(), hint()], Array(33).fill(hint()), ['bad'], {}])
      expect(collectSqlCoverageObservations(module([test('passed', values)]))).toBeUndefined();
  });
});

describe('Vitest before-source boundary', () => {
  it('keeps module discovery behind the completed before-run snapshot', async () => {
    let finishSnapshot!: (snapshot: { commit: string; porcelain: string }) => void;
    const snapshot = new Promise<{ commit: string; porcelain: string }>(resolve => {
      finishSnapshot = resolve;
    });
    const reporter = new AdminTestRunsReporter(() => snapshot, async () => undefined);
    let modulesMayStart = false;
    const initialized = reporter.onInit({ config: { root: TEST_CONFIG_ROOT,
      configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } as never)
      .then(() => { modulesMayStart = true; });
    try {
      // Give onInit every opportunity to finish while the source read remains
      // pending. Module imports may run synchronous Git/build work, so merely
      // starting the async read cannot establish a before-test boundary.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(modulesMayStart).toBe(false);
      finishSnapshot({ commit: 'abc', porcelain: '' });
      await initialized;
      expect(modulesMayStart).toBe(true);
    } finally {
      finishSnapshot({ commit: 'abc', porcelain: '' });
      await initialized;
      await reporter.onTestRunEnd();
    }
  });
});

describe('Vitest run-level ledger verdict', () => {
  async function recordRun(
    outcomes: Array<{ name: string; passed: number; failed: number; skipped: number }>,
    errors: Array<{ message: string; code?: string; stack?: string }>,
    reason: 'passed' | 'failed',
  ) {
    const rows: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(
      async () => ({ commit: 'abc', porcelain: '' }),
      async row => { rows.push(row); },
    );
    await reporter.onInit({ config: { root: TEST_CONFIG_ROOT,
      configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } as never);
    const modules = outcomes.map(outcome => ({
      moduleId: join(TEST_CONFIG_ROOT, `src/${outcome.name}.test.ts`),
      state: () => outcome.failed ? 'failed' : outcome.passed ? 'passed' : 'skipped',
      // This fixture executes no test body; subtracting a fictitious millisecond
      // could backdate its module before onInit when both happen in one tick.
      diagnostic: () => ({ duration: 0 }),
      errors: () => [],
      children: { allTests: () => ['passed', 'failed', 'skipped'].flatMap(state =>
        Array.from({ length: outcome[state as 'passed' | 'failed' | 'skipped'] }, (_, index) => ({
          fullName: `${outcome.name} ${state} ${index}`,
          result: () => ({ state, ...(state === 'failed'
            ? { errors: [{ message: 'assertion mismatch' }] } : {}) }),
        }))) },
    }));
    for (const module of modules) reporter.onTestModuleEnd(module as never);
    await reporter.onTestRunEnd(modules as never, errors as never, reason);
    await reporter.onExit(); // Vitest's fallback must neither duplicate nor erase the error row.
    return rows;
  }

  it('records an unhandled run error despite eight passing assertions and preserves their counts', async () => {
    const rows = await recordRun([{ name: 'stop', passed: 8, failed: 0, skipped: 76 }],
      [{ message: 'write after end', code: 'ERR_STREAM_WRITE_AFTER_END', stack: 'Error: write after end\n    at reporter.test.ts:12' }], 'failed');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('error');
    expect(rows[0].executionDetails).toMatchObject({ passed: 8, failed: 0, skipped: 76, collectionFailed: false });
    expect(rows[0].outputTail).toContain('run-level');
    expect(rows[0].outputTail).toContain('ERR_STREAM_WRITE_AFTER_END');
    expect(rows[0].outputTail).toContain('write after end');
    expect(rows[0].outputTail).toContain('stack: Error: write after end');
    expect(rows[0].outputTail).toContain('reporter.test.ts:12');
    expect(parseTestRunExecutionDetails(rows[0].executionDetails)?.passed).toBe(8);
  });

  it('marks every passing module unproven while retaining an actual assertion failure and its diagnostic', async () => {
    const rows = await recordRun([
      { name: 'first', passed: 1, failed: 0, skipped: 0 },
      { name: 'second', passed: 1, failed: 0, skipped: 0 },
      { name: 'assertion', passed: 0, failed: 1, skipped: 0 },
      { name: 'skipped', passed: 0, failed: 0, skipped: 1 },
    ], [{ message: 'uncaught rejection' }], 'failed');
    const byName = (name: string) => rows.find(row => row.filePath.endsWith(`src/${name}.test.ts`))!;
    expect(rows).toHaveLength(4);
    expect(['first', 'second', 'assertion', 'skipped'].map(name => byName(name).status))
      .toEqual(['error', 'error', 'fail', 'error']);
    // EI-26701962157024953: the failing row is written mid-run (it survives a SIGKILL), before
    // any run-level error exists, so only the demoted rows carry the run-level diagnostic.
    expect(['first', 'second', 'skipped'].every(name => byName(name).outputTail?.includes('uncaught rejection'))).toBe(true);
    expect(byName('assertion').outputTail).toContain('assertion mismatch');
    expect(byName('assertion').executionDetails).toMatchObject({ passed: 0, failed: 1, collectionFailed: false });
    expect(byName('skipped').executionDetails).toMatchObject({ passed: 0, failed: 0, skipped: 1, collectionFailed: false });
  });

  it('preserves a clean successful invocation', async () => {
    const rows = await recordRun([{ name: 'clean', passed: 1, failed: 0, skipped: 0 }], [], 'passed');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pass');
    expect(rows[0].outputTail).toBeNull();
    const runStartedAt = rows[0].executionDetails?.runStartedAt;
    expect(typeof runStartedAt).toBe('string');
    expect(Date.parse(runStartedAt!)).toBeLessThanOrEqual(rows[0].startedAt.getTime());
  });

  it('preserves successful modules when another module only fails assertions', async () => {
    const rows = await recordRun([
      { name: 'clean', passed: 1, failed: 0, skipped: 0 },
      { name: 'assertion', passed: 0, failed: 1, skipped: 0 },
    ], [], 'failed');
    // The failing row is written first (mid-run, EI-26701962157024953); the pass at the end.
    expect(rows.map(row => [row.filePath.split('/').pop(), row.status]))
      .toEqual([['assertion.test.ts', 'fail'], ['clean.test.ts', 'pass']]);
    expect(rows[1].outputTail).toBeNull();
    expect(rows[0].outputTail).toContain('assertion mismatch');
  });

  it('keeps run-level diagnostics bounded while recording the full error count', async () => {
    const rows = await recordRun([{ name: 'many-errors', passed: 1, failed: 0, skipped: 0 }],
      Array.from({ length: 30 }, () => ({ message: 'x'.repeat(8_000), code: 'EPIPE' })), 'failed');
    expect(rows[0].status).toBe('error');
    expect(rows[0].outputTail).toContain('30 unhandled error');
    expect(rows[0].outputTail).toContain('EPIPE');
    expect(rows[0].outputTail!.length).toBeLessThanOrEqual(4_000);
  });
});

describe('reporter ledger endpoint selection', () => {
  it.each(['', '  '])('ignores a blank explicit sink instead of selecting the operating-system user database (%j)', sink => {
    expect(resolveTestRunsPgUrl({ PAPERCUSP_TEST_RUNS_DB_URL: sink, HARNESS_ADMIN_DATABASE_URL: 'postgresql://product.example/product' }))
      .toBe('postgresql://product.example/product');
    expect(new URL(resolveTestRunsPgUrl({ PAPERCUSP_TEST_RUNS_DB_URL: sink, HARNESS_ADMIN_DATABASE_URL: ' ' })).pathname)
      .toBe('/papercusp');
  });

  it('preserves the explicit evidence sink ahead of the isolated product database', () => {
    expect(resolveTestRunsPgUrl({ PAPERCUSP_TEST_RUNS_DB_URL: ' postgresql://ledger.example/evidence ',
      HARNESS_ADMIN_DATABASE_URL: 'postgresql://private.example/disposable' })).toBe('postgresql://ledger.example/evidence');
  });

  it('follows the private test-PG port when product DSN pins are intentionally scrubbed', () => {
    expect(resolveTestRunsPgUrl({ PAPERCUSP_PG_PORT: '33299' }))
      .toBe('postgresql://harness_admin:harness_admin_pwd@localhost:33299/papercusp');
  });

  it.each(['', '0', '-1', '65536', 'not-a-port'])('falls back to native PG for an invalid private port (%j)', port => {
    expect(resolveTestRunsPgUrl({ PAPERCUSP_PG_PORT: port }))
      .toBe('postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp');
  });
});

describe('receipt-backed native archive reporter', () => {
  it('distinguishes real Vitest fork-stop callback starvation from worker handles, including ordinary Git interim provenance', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'native-archive-stop-ipc-'));
    const root = join(parent, 'source');
    mkdirSync(root);
    writeFileSync(join(root, 'probe.test.ts'), 'test("tiny fork", () => expect(true).toBe(true));\n');
    const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    const identity = ['-c', 'user.name=Archive Test', '-c', 'user.email=archive@example.invalid'];
    git(['init', '--quiet']);
    git([...identity, 'commit', '--allow-empty', '--quiet', '-m', 'parent']);
    git(['add', 'probe.test.ts']);
    git([...identity, 'commit', '--quiet', '-m', 'source']);
    const sourceCommit = git(['rev-parse', 'HEAD']);
    const files = verifierSourceFiles(root, { gitMetadataPaths: ['.git'] });
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit,
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })), files,
      gitCheckout: verifierGitCheckoutSync(root, sourceCommit) };
    const receiptPath = join(parent, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    const require = createRequire(import.meta.url);
    const probePath = join(parent, 'stop-ipc.mjs');
    // Run the real Vitest pool in an owned child. Only reporter-side Git is
    // slowed, identically in both modes; the passing test worker has no handles.
    writeFileSync(probePath, `
      import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
      import { Writable } from 'node:stream';
      import { join } from 'node:path';
      const { createVitest, ForksPoolWorker } = await import(${JSON.stringify(pathToFileURL(require.resolve('vitest/node')).href)});
      const { readVerifierSourceReceiptSync } = await import(${JSON.stringify(new URL('./verifier-source.ts', import.meta.url).href)});
      const { default: AdminTestRunsReporter, captureWorktreeSnapshot, setRunRoot,
        reporterWriteBudget, appendTestRunReceipts, testRunReceiptBaseFor, TEST_RUN_RECEIPT_ENV
      } = await import(${JSON.stringify(new URL('./admin-test-runs-reporter.ts', import.meta.url).href)});
      const [root, receiptPath, mode, parent] = process.argv.slice(2);
      const events = [];
      const logs = [];
      const ordinary = mode === 'ordinary';
      const ordinaryReceipt = join(parent, 'ordinary-receipts.jsonl');
      let afterStarted;
      const afterSnapshotStarted = new Promise(resolve => { afterStarted = resolve; });
      const writes = [];
      let activeWrites = 0, maxActiveWrites = 0;
      let aborted = false, afterSnapshot, stopAt, exitAt, forkExitAt, flushAt, flushedAt;
      if (ordinary) {
        // This leg exercises ordinary Git and an expected assertion failure,
        // independently of the archive verifier and mutation provenance path.
        unlinkSync(join(root, '.verifier-source.json'));
        writeFileSync(join(root, 'probe.test.ts'), 'test("expected failure", () => expect(false).toBe(true));\\n');
        for (const key of Object.keys(process.env)) {
          if (key.startsWith('PAPERCUSP_MUTATION_') || key.startsWith('VERIFY_TAURI_')) delete process.env[key];
        }
        process.env[TEST_RUN_RECEIPT_ENV] = ordinaryReceipt;
        process.env.PAPERCUSP_TEST_RUN_GROUP = 'ordinary-git-stop-' + process.pid;
        setRunRoot(root);
      }
      const ordinaryReporter = ordinary ? new AdminTestRunsReporter(async (phase, signal) => {
        if (phase === 'after') {
          events.push('interim-after-started');
          afterStarted();
        }
        const snapshot = await captureWorktreeSnapshot(undefined, phase, signal);
        if (phase !== 'after') return snapshot;
        afterSnapshot = snapshot;
        // Keep real asynchronous provenance outstanding across the real pool
        // stop. The production close-safe budget must cancel this reader.
        await new Promise(resolve => {
          const abort = () => { aborted = true; events.push('snapshot-aborted'); resolve(); };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
        return snapshot;
      }, undefined, async rows => {
        maxActiveWrites = Math.max(maxActiveWrites, ++activeWrites);
        writes.push(...rows);
        await new Promise(resolve => setImmediate(resolve));
        appendTestRunReceipts(process.env, rows.map(row => ({ ...testRunReceiptBaseFor(row),
          outcome: 'inserted', id: 'ordinary-git-stop-row' })));
        activeWrites--;
      }) : null;
      let notifyStop;
      const stopRequested = new Promise(resolve => { notifyStop = resolve; });
      const originalPath = process.env.PATH;
      const shim = join(parent, 'slow-git-' + mode);
      const exitedPath = join(parent, 'kernel-exited-' + mode);
      mkdirSync(shim);
      writeFileSync(join(shim, 'git'), '#!' + process.execPath + '\\n' +
        'const { spawnSync } = require("node:child_process");\\n' +
        'const { readFileSync, writeFileSync } = require("node:fs");\\n' +
        'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);\\n' +
        'if (process.platform === "linux") { try {\\n' +
        '  const stat = readFileSync("/proc/" + process.env.STOP_IPC_PROBE_FORK_PID + "/stat", "utf8");\\n' +
        '  if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) writeFileSync(' + JSON.stringify(exitedPath) + ', "exited");\\n' +
        '} catch (error) { if (error.code === "ENOENT") writeFileSync(' + JSON.stringify(exitedPath) + ', "exited"); else throw error; } }\\n' +
        'const result = spawnSync("git", process.argv.slice(2), { stdio: "inherit", env: { ...process.env, PATH: ' + JSON.stringify(originalPath) + ' } });\\n' +
        'process.exit(result.status ?? 1);\\n', { mode: 0o755 });
      let snapshot;
      const stream = new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } });
      const runner = await createVitest('test', { root, config: false, watch: false,
        globals: true, include: ['probe.test.ts'], maxWorkers: 1, teardownTimeout: 300,
        pool: { name: 'receipt-forks', createPoolWorker(options) {
          events.push('pool-created');
          const worker = new ForksPoolWorker(options);
          const send = worker.send.bind(worker);
          worker.send = message => {
            if (message.type === 'stop') {
              events.push('stop-request'); send(message); notifyStop();
            } else send(message);
          };
          const start = worker.start.bind(worker);
          worker.start = async () => { await start();
            process.env.STOP_IPC_PROBE_FORK_PID = String(worker._fork.pid);
            if (ordinary) worker._fork.once('exit', () => {
              forkExitAt = Date.now(); events.push('fork-exit-callback');
            });
            worker.on('message', message => {
            if (message?.type === 'stopped') events.push('stopped-ipc');
          }); };
          const stop = worker.stop.bind(worker);
          worker.stop = async () => {
            if (ordinary) await afterSnapshotStarted;
            stopAt = Date.now();
            events.push('worker-stop'); await stop();
            exitAt = Date.now(); events.push('worker-exited');
          };
          return worker;
        } },
        reporters: ordinary ? [{
          onInit: ctx => ordinaryReporter.onInit(ctx),
          onTestModuleEnd: module => {
            flushAt = Date.now();
            ordinaryReporter.onTestModuleEnd(module);
          },
          async onTestRunEnd(modules, errors, reason) {
            if (reason !== 'failed' || errors.length || modules.length !== 1) throw new Error('expected failure missing');
            await afterSnapshotStarted;
            await ordinaryReporter.onTestRunEnd(modules, errors);
            flushedAt = Date.now(); events.push('reporter-flushed');
          },
          onExit: () => ordinaryReporter.onExit(),
        }] : [{ async onTestRunEnd(modules, errors, reason) {
          if (reason !== 'passed' || errors.length || modules.length !== 1) throw new Error('tiny test did not pass');
          if (!events.includes('pool-created')) throw new Error('instrumented pool was not selected');
          // Vitest may enter its reporter before schedule() resumes. Synchronize
          // this probe to the real stop request, not an assumed microtask order.
          await stopRequested;
          events.push('reporter-start');
          process.env.PATH = shim + ':' + originalPath;
          process.env.VERIFY_TAURI_SOURCE_RECEIPT = receiptPath;
          process.env.VERIFY_TAURI_SOURCE_REF = ${JSON.stringify(sourceCommit)};
          setRunRoot(root);
          try {
            snapshot = mode === 'sync' ? { commit: readVerifierSourceReceiptSync(root).sourceCommit, porcelain: '' }
              : await captureWorktreeSnapshot();
            events.push('snapshot-end');
          } finally { process.env.PATH = originalPath; setRunRoot(null); }
        } }],
      }, undefined, { stdout: stream, stderr: stream });
      try { await runner.start(); } finally { await runner.close(); }
      if (ordinary) process.exitCode = 0; // The nested assertion failure is this leg's required input.
      console.log(JSON.stringify({ mode, events, snapshot, osExitObserved: existsSync(exitedPath),
        ordinary: ordinary ? { afterSnapshot, aborted, writes, maxActiveWrites,
          stopMs: exitAt - stopAt, forkExitMs: forkExitAt - stopAt, flushMs: flushedAt - flushAt,
          budget: reporterWriteBudget(process.env), receipts: readFileSync(ordinaryReceipt, 'utf8') } : null,
        warning: logs.join('').includes('Timeout terminating receipt-forks worker'), logs: logs.join('') }));
    `);
    let verified = false;
    try {
      const results = [];
      for (const mode of ['sync', 'async', 'ordinary']) {
        const { stdout, stderr } = await promisify(execFile)(process.execPath,
          ['--import', require.resolve('tsx'), probePath, root, receiptPath, mode, parent],
          { timeout: 20_000, maxBuffer: 1024 * 1024 }).catch(error => {
            writeFileSync(join(parent, mode + '.stdout.log'), error.stdout ?? '');
            writeFileSync(join(parent, mode + '.stderr.log'), error.stderr ?? '');
            throw new Error(`fork-stop probe ${mode} failed: code=${error.code} signal=${error.signal}` +
              ` killed=${error.killed}\nstdout:\n${error.stdout}\nstderr:\n${error.stderr}`, { cause: error });
          });
        writeFileSync(join(parent, mode + '.stdout.log'), stdout);
        writeFileSync(join(parent, mode + '.stderr.log'), stderr);
        results.push(JSON.parse(stdout.trim().split('\n').at(-1)!));
      }
      const [sync, async, ordinary] = results;
      for (const result of [sync, async]) {
        expect(result.snapshot, JSON.stringify(result)).toEqual({ commit: sourceCommit, porcelain: '' });
        expect(result.events, JSON.stringify(result)).toContain('pool-created');
        expect(result.events, JSON.stringify(result)).toContain('worker-exited');
        if (process.platform === 'linux') expect(result.osExitObserved, JSON.stringify(result)).toBe(true);
        expect(result.events.indexOf('stop-request'), JSON.stringify(result)).toBeLessThan(result.events.indexOf('reporter-start'));
      }
      expect(sync.warning, JSON.stringify(sync)).toBe(true);
      expect(sync.events.indexOf('snapshot-end'), JSON.stringify(sync)).toBeLessThan(sync.events.indexOf('worker-exited'));
      expect(async.warning, JSON.stringify(async)).toBe(false);
      expect(async.events.indexOf('stopped-ipc'), JSON.stringify(async)).toBeLessThan(async.events.indexOf('snapshot-end'));
      expect(async.events.indexOf('worker-exited'), JSON.stringify(async)).toBeLessThan(async.events.indexOf('snapshot-end'));
      expect(ordinary.warning, JSON.stringify(ordinary)).toBe(false);
      expect(ordinary.ordinary.afterSnapshot, JSON.stringify(ordinary)).toMatchObject({ commit: sourceCommit,
        porcelain: expect.stringContaining('probe.test.ts') });
      expect(ordinary.ordinary.aborted, JSON.stringify(ordinary)).toBe(true);
      expect(ordinary.ordinary.maxActiveWrites, JSON.stringify(ordinary)).toBe(1);
      expect(ordinary.ordinary.writes, JSON.stringify(ordinary)).toEqual([expect.objectContaining({ status: 'fail',
        commitSha: null, worktreeDirty: true, executionDetails: expect.objectContaining({
          worktreeDirtyReason: 'provenance preparation exceeded its close-safe budget' }) })]);
      expect(latestTestRunReceipts(ordinary.ordinary.receipts), JSON.stringify(ordinary)).toEqual([
        expect.objectContaining({ status: 'fail', outcome: 'inserted', id: 'ordinary-git-stop-row' }),
      ]);
      expect(ordinary.ordinary.stopMs, JSON.stringify(ordinary)).toBeLessThan(300);
      expect(ordinary.ordinary.forkExitMs, JSON.stringify(ordinary)).toBeLessThan(300);
      expect(ordinary.ordinary.flushMs, JSON.stringify(ordinary)).toBeLessThan(ordinary.ordinary.budget.flushBudgetMs);
      expect(ordinary.events.indexOf('interim-after-started')).toBeLessThan(ordinary.events.indexOf('stop-request'));
      expect(ordinary.events.indexOf('worker-exited')).toBeLessThan(ordinary.events.indexOf('snapshot-aborted'));
      expect(ordinary.events, JSON.stringify(ordinary)).toContain('fork-exit-callback');
      expect(ordinary.events.indexOf('fork-exit-callback')).toBeLessThan(ordinary.events.indexOf('snapshot-aborted'));
      expect(ordinary.events.indexOf('snapshot-aborted')).toBeLessThan(ordinary.events.indexOf('reporter-flushed'));
      verified = true;
    } finally {
      if (verified) rmSync(parent, { recursive: true, force: true });
      else process.stderr.write(`fork-stop probe diagnostics retained at ${parent}\n`);
    }
  }, 45_000);

  it('keeps worker-stop IPC responsive while validating an archive snapshot', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'native-archive-responsive-'));
    const root = join(parent, 'source');
    mkdirSync(root);
    writeFileSync(join(root, 'source.ts'), 'export const source = true;\n');
    const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    const identity = ['-c', 'user.name=Archive Test', '-c', 'user.email=archive@example.invalid'];
    git(['init', '--quiet']);
    git([...identity, 'commit', '--allow-empty', '--quiet', '-m', 'parent']);
    git(['add', 'source.ts']);
    git([...identity, 'commit', '--quiet', '-m', 'source']);
    const sourceCommit = git(['rev-parse', 'HEAD']);
    const files = verifierSourceFiles(root, { gitMetadataPaths: ['.git'] });
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit,
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })), files,
      gitCheckout: verifierGitCheckoutSync(root, sourceCommit) };
    const receiptPath = join(parent, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receiptPath);
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', receipt.sourceCommit);
    setRunRoot(root);
    let heartbeat = false;
    const tick = new Promise<void>(resolve => setImmediate(() => { heartbeat = true; resolve(); }));
    try {
      const snapshot = await captureWorktreeSnapshot();
      expect(snapshot).toEqual({ commit: receipt.sourceCommit, porcelain: '' });
      // Vitest fork termination can overlap reporter finalization. Its IPC
      // callbacks must run while census/Git work is pending, even on a tiny tree.
      expect(heartbeat).toBe(true);
      git(['checkout', '--detach', '--quiet', 'HEAD^']);
      expect(await captureWorktreeSnapshot()).toMatchObject({ commit: null, porcelain: null,
        provenanceError: expect.stringContaining('verification Git checkout differs') });
    } finally {
      await tick;
      setRunRoot(null);
      vi.unstubAllEnvs();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each([false, true])('records the archive identity and detects source mutation=%s', async mutate => {
    const parent = mkdtempSync(join(tmpdir(), 'native-archive-reporter-'));
    const root = join(parent, 'source');
    const project = join(root, 'packages/operator-core');
    mkdirSync(join(parent, '.git'));
    mkdirSync(project, { recursive: true });
    const file = join(project, 'journey.e2e.test.ts');
    writeFileSync(file, 'export const journey = true;\n');
    const files = verifierSourceFiles(root);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40),
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })), files };
    const receiptPath = join(parent, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receiptPath);
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', receipt.sourceCommit);
    vi.stubEnv('OPERATOR_SOURCE_ROOT', root);
    const persisted: TestRunRow[] = [];
    const snapshotPhases: string[] = [];
    const reporter = new AdminTestRunsReporter(async phase => {
      snapshotPhases.push(phase ?? 'unspecified');
      return captureWorktreeSnapshot(undefined, phase);
    }, async row => { persisted.push(row); });
    try {
      await reporter.onInit({ config: { root: project, configFile: join(project, 'vitest.config.ts') } } as never);
      expect(computeWorkspaceRootFrom(project)).toBe(root);
      expect(toWorkspaceRel(file)).toBe('packages/operator-core/journey.e2e.test.ts');
      reporter.onTestModuleEnd({ moduleId: file, state: () => 'passed', diagnostic: () => ({ duration: 1 }),
        errors: () => [], children: { allTests: () => [{ fullName: 'native journey', result: () => ({ state: 'passed' }) }] } } as never);
      if (mutate) writeFileSync(file, 'export const journey = false;\n');
      await reporter.onTestRunEnd();
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ filePath: 'packages/operator-core/journey.e2e.test.ts',
        commitSha: mutate ? null : receipt.sourceCommit, worktreeDirty: mutate });
      expect(snapshotPhases).toEqual(['before', 'after']);
      if (mutate) expect(persisted[0].executionDetails?.worktreeDirtyReason).toContain('changed packages/operator-core/journey.e2e.test.ts');
    } finally { setRunRoot(null); vi.unstubAllEnvs(); rmSync(parent, { recursive: true, force: true }); }
  });

  it('allows exactly the recorded mutation subject in a verifier archive', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'native-archive-mutation-subject-'));
    const root = join(parent, 'source');
    const file = join(root, 'journey.e2e.test.ts');
    mkdirSync(root);
    writeFileSync(file, 'export const journey = true;\n');
    const files = verifierSourceFiles(root);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'e'.repeat(40),
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })), files };
    const receiptPath = join(parent, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receiptPath);
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', receipt.sourceCommit);
    vi.stubEnv('OPERATOR_SOURCE_ROOT', root);
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '1');
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE_SUBJECT', file);
    setRunRoot(root);
    try {
      writeFileSync(file, 'export const journey = false;\n');
      // The ordinary source verifier remains immutable even in a probe process.
      expect(() => readVerifierSourceReceiptSync(root)).toThrow('changed journey.e2e.test.ts');
      expect(await captureWorktreeSnapshot()).toEqual({ commit: receipt.sourceCommit, porcelain: '' });
      writeFileSync(join(root, 'unrelated.ts'), 'export const unrelated = true;\n');
      expect(await captureWorktreeSnapshot()).toMatchObject({
        commit: null,
        porcelain: null,
        provenanceError: expect.stringContaining('added unrelated.ts'),
      });
    } finally { setRunRoot(null); vi.unstubAllEnvs(); rmSync(parent, { recursive: true, force: true }); }
  });

  it.each(['not-a-probe', 'relative-subject', 'outside-subject', 'wrong-subject',
    'deleted-subject', 'mode-change', 'symlink-subject'] as const)(
    'refuses a verifier archive mutation with %s', async kind => {
      const parent = mkdtempSync(join(tmpdir(), 'native-archive-mutation-negative-'));
      const root = join(parent, 'source');
      const file = join(root, 'subject.ts');
      mkdirSync(root);
      writeFileSync(file, 'export const source = true;\n');
      writeFileSync(join(root, 'other.ts'), 'export const other = true;\n');
      const files = verifierSourceFiles(root);
      const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'd'.repeat(40),
        testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })), files };
      const receiptPath = join(parent, 'receipt.json');
      writeFileSync(receiptPath, JSON.stringify(receipt));
      writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
      vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receiptPath);
      vi.stubEnv('VERIFY_TAURI_SOURCE_REF', receipt.sourceCommit);
      vi.stubEnv('PAPERCUSP_MUTATION_PROBE', kind === 'not-a-probe' ? '' : '1');
      vi.stubEnv('PAPERCUSP_MUTATION_PROBE_SUBJECT',
        kind === 'relative-subject' ? 'subject.ts' : kind === 'outside-subject' ? join(parent, 'outside.ts')
          : kind === 'wrong-subject' ? join(root, 'other.ts') : file);
      setRunRoot(root);
      try {
        writeFileSync(file, 'export const source = false;\n');
        if (kind === 'deleted-subject') rmSync(file);
        if (kind === 'mode-change') chmodSync(file, 0o755);
        if (kind === 'symlink-subject') { rmSync(file); symlinkSync('other.ts', file); }
        expect(await captureWorktreeSnapshot()).toMatchObject({
          commit: null, porcelain: null, provenanceError: expect.stringContaining('verifier source:'),
        });
      } finally { setRunRoot(null); vi.unstubAllEnvs(); rmSync(parent, { recursive: true, force: true }); }
    });

  it('keeps an explicitly unknown source null instead of substituting the parent or caller commit', async () => {
    const captured: Record<string, unknown>[] = [];
    const sql = ((first: unknown) => {
      if (Array.isArray(first) && !('raw' in first)) { captured.push(...first); return {}; }
      return Promise.resolve([]);
    }) as PgSql;
    sql.end = async () => undefined;
    vi.stubEnv('PAPERCUSP_TEST_RUN_COMMIT', 'caller-commit');
    try {
      await insertTestRunRowsWithSql(sql, [{ filePath: 'journey.e2e.test.ts', status: 'fail', durationMs: 1,
        startedAt: new Date(), finishedAt: new Date(), outputTail: null, isScratchConfig: false,
        worktreeDirty: true, commitSha: null }], { branch: 'staging', inferredCommit: 'parent-head',
        declaredSource: 'local', runGroupId: null, harnessSlug: null, workspaceId: null, loopLagP95Ms: null, rssMb: null });
      expect(captured[0].commit_sha).toBeNull();
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('original isolated runtime receipt recording', () => {
  it.each(['integration', 'e2e', 'unit', 'browser', undefined] as const)(
    'persists original worker receipts only for an isolated-capable project layer (%s)', async layer => {
      const dir = mkdtempSync(join(tmpdir(), 'isolated-reporter-layer-'));
      vi.stubEnv('VH_EVIDENCE_ROOT_BASE', dir);
      const runId = '20261008T000000Z-100';
      const base = join(dir, 'isolated-integration', runId);
      const rows: TestRunRow[] = [];
      try {
        for (const file of ['result.json', 'phases/prepare/source.json', 'phases/execute/lifecycle.json']) {
          mkdirSync(join(base, file, '..'), { recursive: true });
          writeFileSync(join(base, file), '{}');
        }
        const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }),
          async row => { rows.push(row); }, undefined, async () => null);
        // A root layer cannot upgrade a project's unit or unknown layer.
        await reporter.onInit({ config: { root: TEST_CONFIG_ROOT,
          provide: { papercuspTestLayer: 'e2e' } } } as never);
        reporter.onTestModuleEnd({ state: () => 'passed',
          project: { config: { provide: layer ? { papercuspTestLayer: layer } : {} } },
          children: { allTests: () => ['threshold', 'unobservable census'].map(name => ({
            fullName: 'suite > ' + name, result: () => ({ state: 'passed' }),
            meta: () => ({ papercuspIsolatedRuntimeRunId: runId }),
          })) },
          moduleId: join(TEST_CONFIG_ROOT, 'src/admin-test-runs-reporter.test.ts'),
          diagnostic: () => ({ duration: 1 }), errors: () => [],
        } as never);
        await reporter.onTestRunEnd();
        expect(rows).toHaveLength(1);
        expect(rows[0].executionDetails?.testLayer).toBe(layer);
        const hash = createHash('sha256').update('{}').digest('hex');
        expect(rows[0].executionDetails?.isolatedRuntimeReceipts)
          .toEqual(layer === 'integration' || layer === 'e2e'
            ? [{ runId, resultSha256: hash, sourceSha256: hash, lifecycleSha256: hash }] : undefined);
      } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
    });

  it('hashes the real bytes and coalesces shared originals while refusing ordinary or partial claims', () => {
    const dir = mkdtempSync(join(tmpdir(), 'isolated-reporter-'));
    vi.stubEnv('VH_EVIDENCE_ROOT_BASE', dir);
    const runId = '20261008T000000Z-100';
    const base = join(dir, 'isolated-integration', runId);
    const files = ['result.json', 'phases/prepare/source.json', 'phases/execute/lifecycle.json'];
    const test = { result: () => ({ state: 'passed' }), meta: () => ({ papercuspIsolatedRuntimeRunId: runId }) };
    const module = (tests: unknown[]) => ({ children: { allTests: () => tests } }) as never;
    try {
      for (const file of files) { mkdirSync(join(base, file, '..'), { recursive: true }); writeFileSync(join(base, file), '{}'); }
      const expected = createHash('sha256').update('{}').digest('hex');
      expect(collectReceipts(module([test])))
        .toEqual([{ runId, resultSha256: expected, sourceSha256: expected, lifecycleSha256: expected }]);
      const skipped = { result: () => ({ state: 'skipped' }), meta: () => ({}) };
      expect(collectReceipts(module([skipped, test, skipped])))
        .toEqual([{ runId, resultSha256: expected, sourceSha256: expected, lifecycleSha256: expected }]);
      expect(collectReceipts(module([skipped]))).toBeUndefined();
      expect(collectReceipts(module([test, { result: () => undefined }])))
        .toBeUndefined();
      expect(collectReceipts(module([test, test])))
        .toEqual([{ runId, resultSha256: expected, sourceSha256: expected, lifecycleSha256: expected }]);
      expect(collectReceipts(module([{ ...test, meta: () => ({}) }]))).toBeUndefined();
      expect(collectReceipts(module([{ ...test, result: () => ({ state: 'failed' }) }]))).toBeUndefined();
      rmSync(join(base, files[2]));
      expect(collectReceipts(module([test]))).toBeUndefined();
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['result.json', 'phases/prepare/source.json', 'phases/execute/lifecycle.json'])(
    'refuses shared-original custody when %s changes between passing cases', changedFile => {
      const dir = mkdtempSync(join(tmpdir(), 'isolated-reporter-shared-conflict-'));
      const runId = '20261008T000000Z-100';
      const base = join(dir, 'isolated-integration', runId);
      vi.stubEnv('VH_EVIDENCE_ROOT_BASE', dir);
      try {
        for (const file of ['result.json', 'phases/prepare/source.json', 'phases/execute/lifecycle.json']) {
          mkdirSync(join(base, file, '..'), { recursive: true });
          writeFileSync(join(base, file), '{}');
        }
        const cases = [false, true].map(change => ({ result: () => ({ state: 'passed' }), meta: () => {
          if (change) writeFileSync(join(base, changedFile), '{"changed":true}');
          return { papercuspIsolatedRuntimeRunId: runId };
        } }));
        expect(collectReceipts({ children: { allTests: () => cases } } as never)).toBeUndefined();
      } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
    });
});

describe('retained isolated runtime receipt custody', () => {
  it('records every original receipt after completed run directories are pruned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'isolated-reporter-retained-'));
    vi.stubEnv('VH_EVIDENCE_ROOT_BASE', dir);
    const files = ['result.json', 'phases/prepare/source.json', 'phases/execute/lifecycle.json'];
    const runIds = ['20261008T000000Z-100', '20261008T000001Z-100'];
    try {
      for (const runId of runIds) {
        for (const file of files) {
          for (const location of [runId, join('retained', runId)]) {
            const target = join(dir, 'isolated-integration', location, file);
            mkdirSync(join(target, '..'), { recursive: true });
            writeFileSync(target, JSON.stringify({ runId, file }));
          }
        }
      }
      // A long multi-case file outlives its early runs' active directories.
      rmSync(join(dir, 'isolated-integration', runIds[0]), { recursive: true });
      // Retained originals remain authoritative while a live directory exists.
      writeFileSync(join(dir, 'isolated-integration', runIds[1], files[0]), 'changed live result');
      const module = { children: { allTests: () => [...runIds, runIds[0]].map(runId => ({
        result: () => ({ state: 'passed' }), meta: () => ({ papercuspIsolatedRuntimeRunId: runId }),
      })) } } as never;
      expect(collectReceipts(module)).toEqual(runIds.map(runId => {
        const hashes = files.map(file => createHash('sha256').update(JSON.stringify({ runId, file })).digest('hex'));
        return { runId, resultSha256: hashes[0], sourceSha256: hashes[1], lifecycleSha256: hashes[2] };
      }));
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses partial retained originals and receipts escaping the evidence root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'isolated-reporter-retained-invalid-'));
    const outside = mkdtempSync(join(tmpdir(), 'isolated-reporter-outside-'));
    vi.stubEnv('VH_EVIDENCE_ROOT_BASE', dir);
    const runId = '20261008T000000Z-100';
    const base = join(dir, 'isolated-integration', 'retained', runId);
    const files = ['result.json', 'phases/prepare/source.json', 'phases/execute/lifecycle.json'];
    const module = { children: { allTests: () => [{ result: () => ({ state: 'passed' }),
      meta: () => ({ papercuspIsolatedRuntimeRunId: runId }) }] } } as never;
    try {
      for (const file of files) {
        mkdirSync(join(base, file, '..'), { recursive: true });
        writeFileSync(join(base, file), '{}');
      }
      rmSync(join(base, files[2]));
      expect(collectReceipts(module)).toBeUndefined();
      writeFileSync(join(outside, 'lifecycle.json'), '{}');
      symlinkSync(join(outside, 'lifecycle.json'), join(base, files[2]));
      expect(collectReceipts(module)).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('runtime environment recorded around execution', () => {
  async function record(
    fingerprints: Array<string | null>,
    fault?: { call: number; kind: 'error' | 'timeout' },
    runtimeEnvironmentCaptureTimeoutMs?: number,
  ) {
    const rows: TestRunRow[] = [];
    let calls = 0;
    const reader = vi.fn(async () => {
      calls += 1;
      if (fault?.call === calls && fault.kind === 'error') throw new Error('runtime unavailable');
      if (fault?.call === calls && fault.kind === 'timeout')
        await new Promise(resolve => setTimeout(resolve, 1_100));
      const fingerprint = fingerprints.shift();
      return fingerprint ? { schemaVersion: 1 as const, units: ['bg-host'], fingerprint,
        observedAt: '2000-01-01T00:00:00Z' } : null;
    });
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }),
      async row => { rows.push(row); }, undefined, reader, runtimeEnvironmentCaptureTimeoutMs);
    await reporter.onInit({ config: { root: TEST_CONFIG_ROOT }, vite: { config: { root: TEST_CONFIG_ROOT } } } as never);
    reporter.onTestModuleEnd({ state: () => 'passed',
      children: { allTests: () => [{ fullName: 'suite > observed', result: () => ({ state: 'passed' }) }] },
      moduleId: join(TEST_CONFIG_ROOT, 'src/admin-test-runs-reporter.test.ts'),
      diagnostic: () => ({ duration: 1 }), errors: () => [],
    } as never);
    await reporter.onTestRunEnd();
    return { details: rows[0].executionDetails!, reader };
  }
  it('measures before collection and after execution without accepting a backdated observation', async () => {
    const { details, reader } = await record(['a'.repeat(64), 'a'.repeat(64)]);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(details.runtimeEnvironmentBefore?.fingerprint).toBe('a'.repeat(64));
    expect(details.runtimeEnvironmentAfter?.fingerprint).toBe('a'.repeat(64));
    expect(details.runtimeEnvironmentBeforeCaptureStatus).toBe('captured');
    expect(details.runtimeEnvironmentAfterCaptureStatus).toBe('captured');
    expect(Date.parse(details.runtimeEnvironmentBefore!.observedAt)).toBeGreaterThan(Date.parse('2026-01-01'));
  });
  it('preserves restart drift instead of replacing the execution-time witness with the later runtime', async () => {
    const { details } = await record(['a'.repeat(64), 'b'.repeat(64)]);
    expect(details.runtimeEnvironmentBefore?.fingerprint).toBe('a'.repeat(64));
    expect(details.runtimeEnvironmentAfter?.fingerprint).toBe('b'.repeat(64));
  });
  it('keeps an unavailable measurement absent and does not change a passing test outcome', async () => {
    const { details } = await record([], { call: 1, kind: 'error' });
    expect(details).toMatchObject({ passed: 1, failed: 0 });
    expect(details).not.toHaveProperty('runtimeEnvironmentBefore');
    expect(details).not.toHaveProperty('runtimeEnvironmentAfter');
    expect(details.runtimeEnvironmentBeforeCaptureStatus).toBe('error');
    expect(details.runtimeEnvironmentAfterCaptureStatus).toBe('unavailable');
  });
  it('records a timed-out after-runtime read without changing the passing test outcome', async () => {
    const { details } = await record(['a'.repeat(64)], { call: 2, kind: 'timeout' });
    expect(details).toMatchObject({ passed: 1, failed: 0 });
    expect(details.runtimeEnvironmentBeforeCaptureStatus).toBe('captured');
    expect(details.runtimeEnvironmentAfterCaptureStatus).toBe('timed-out');
    expect(details.runtimeEnvironmentBefore?.fingerprint).toBe('a'.repeat(64));
    expect(details).not.toHaveProperty('runtimeEnvironmentAfter');
  });
  it('honors a producer-declared budget for a bounded remote reader', async () => {
    const { details, reader } = await record(
      ['a'.repeat(64), 'b'.repeat(64)], { call: 1, kind: 'timeout' }, 1_200,
    );
    expect(reader).toHaveBeenCalledTimes(2);
    expect(details.runtimeEnvironmentBeforeCaptureStatus).toBe('captured');
    expect(details.runtimeEnvironmentBefore?.fingerprint).toBe('a'.repeat(64));
    expect(details.runtimeEnvironmentAfterCaptureStatus).toBe('captured');
    expect(details.runtimeEnvironmentAfter?.fingerprint).toBe('b'.repeat(64));
  });
  it('keeps malformed capture budgets at the default and caps oversized producer budgets', () => {
    expect(normalizeRuntimeEnvironmentCaptureTimeout(undefined)).toBe(DEFAULT_RUNTIME_ENVIRONMENT_CAPTURE_TIMEOUT_MS);
    expect(normalizeRuntimeEnvironmentCaptureTimeout(Number.NaN)).toBe(DEFAULT_RUNTIME_ENVIRONMENT_CAPTURE_TIMEOUT_MS);
    expect(normalizeRuntimeEnvironmentCaptureTimeout(MAX_RUNTIME_ENVIRONMENT_CAPTURE_TIMEOUT_MS + 1))
      .toBe(MAX_RUNTIME_ENVIRONMENT_CAPTURE_TIMEOUT_MS);
  });
});

describe('actual reporter population capture', () => {
  async function record(count: number, defect?: 'missing-ready' | 'missing-collection' | 'changed-collection' | 'unknown-ready' | 'terminal-at-collection' | 'long-title') {
    const rows: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }),
      async row => { rows.push(row); });
    await reporter.onInit({ config: { root: TEST_CONFIG_ROOT,
      configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } as never);
    let collected = true;
    const tests = Array.from({ length: count + 1 }, (_, index) => ({
      id: `case-${index}`, fullName: index < 2 ? 'suite > duplicate' : `suite > \u03bb-${index}`,
      options: { mode: index === count ? 'skip' : 'run' },
      get module() { return module; },
      result: () => ({ state: index === count ? 'skipped' : collected && defect !== 'terminal-at-collection' ? 'pending' : 'passed' }),
    }));
    if (defect === 'long-title') tests[0].fullName = 'suite > ' + 'parameter'.repeat(1_000);
    const module = {
      project: { name: 'unit', config: { provide: { papercuspTestLayer: 'unit' } } },
      moduleId: join(TEST_CONFIG_ROOT, 'src/admin-test-runs-reporter.test.ts'),
      state: () => 'passed', diagnostic: () => ({ duration: 0 }), errors: () => [],
      children: { allTests: () => tests },
    };
    if (defect !== 'missing-collection') reporter.onTestModuleCollected(module as never);
    // These events deliberately differ from collection order.
    for (const test of tests.slice(0, defect === 'missing-ready' ? count - 1 : count).reverse())
      reporter.onTestCaseReady(test as never);
    reporter.onTestCaseReady(tests[count] as never); // synthetic skipped-suite event
    if (defect === 'unknown-ready') reporter.onTestCaseReady({ ...tests[0], id: 'outside' } as never);
    collected = false;
    if (defect === 'changed-collection') tests.pop();
    reporter.onTestModuleEnd(module as never);
    await reporter.onTestRunEnd();
    return rows[0].executionDetails!;
  }

  it('persists every original collected outcome before diagnostic sampling, including duplicate occurrences', async () => {
    const count = MAX_RECORDED_PASSED_CASES + 17;
    const execution = await record(count);
    expect(execution.passedCaseTitlesTruncated).toBe(true);
    expect(execution.passedCaseTitles).toHaveLength(MAX_RECORDED_PASSED_CASES);
    const population = parseRecordedTestPopulation(execution.population)!;
    expect(population).toBeDefined();
    expect(population.cases).toHaveLength(count + 1);
    expect(population.cases.filter(row => row.identity[2] === 'suite > duplicate').map(row => row.identity[3]))
      .toEqual([1, 2]);
    expect(population.cases.filter(row => row.selected)).toHaveLength(count);
    expect(population.executionOrder[0][2]).toBe(`suite > \u03bb-${count - 1}`);
    expect(population.cases.find(row => !row.selected)?.outcome).toBe('skipped');
  });

  it('uses original runner selection when a fast case is already terminal at collection delivery', async () => {
    const execution = await record(3, 'terminal-at-collection');
    expect(execution.population?.cases.filter(row => row.selected)).toHaveLength(3);
    expect(execution.population?.executionOrder).toHaveLength(3);
  });

  it('retains long original titles which the legacy diagnostic and case tables cannot represent completely', async () => {
    const execution = await record(3, 'long-title');
    expect(execution.passedCaseTitlesTruncated).toBe(true);
    expect(execution.populationCaptureStatus).toBe('captured');
    expect(execution.population?.cases.some(row => row.identity[2] === 'suite > ' + 'parameter'.repeat(1_000)))
      .toBe(true);
  });

  it.each(['missing-ready', 'missing-collection', 'changed-collection', 'unknown-ready'] as const)
    ('leaves incomplete %s evidence unproven without losing ordinary diagnostics', async defect => {
      const execution = await record(3, defect);
      expect(execution.passed).toBe(3);
      expect(execution.population).toBeUndefined();
    });
});

describe('durable module execution measurement', () => {
  const module = (states: string[], state = 'passed') => ({
    state: () => state,
    children: { allTests: () => states.map(s => ({ result: () => ({ state: s }) })) },
  }) as unknown as Parameters<typeof collectModuleExecution>[0];

  it('counts all cases, including mixed skips and failures', () => {
    expect(collectModuleExecution(module(['passed', 'passed', 'skipped', 'failed'], 'failed')))
      .toEqual({ passed: 2, failed: 1, skipped: 1, collectionFailed: false, passedCaseTitlesTruncated: true });
  });
  it.each(['passed-first', 'failed-first'])('omits mixed-outcome duplicate names from proof while preserving counts (%s)', order => {
    const mixed = ['passed', 'failed'];
    if (order === 'failed-first') mixed.reverse();
    const cases = [
      ...mixed.map(state => ({ fullName: 'suite > duplicate', result: () => ({ state }) })),
      { fullName: 'suite > positive', result: () => ({ state: 'passed' }) },
      { fullName: 'suite > negative', result: () => ({ state: 'failed' }) },
    ];
    const measured = collectModuleExecution({ state: () => 'failed', children: { allTests: () => cases } } as never, /duplicate/g);
    expect(measured).toEqual({ passed: 2, failed: 2, skipped: 0, collectionFailed: false,
      passedCaseTitles: ['suite > positive'], passedCaseTitlesTruncated: true,
      failedCaseTitles: ['suite > negative'] });
  });
  it('does not certify a duplicate failure when its passing case falls outside the recording cap', () => {
    const cases = [
      ...Array.from({ length: MAX_RECORDED_PASSED_CASES + 10 }, (_, i) => ({
        fullName: 'suite > first-' + i, result: () => ({ state: 'passed' }),
      })),
      { fullName: 'suite > duplicate', result: () => ({ state: 'passed' }) },
      { fullName: 'suite > duplicate', result: () => ({ state: 'failed' }) },
    ];
    const measured = collectModuleExecution({ state: () => 'failed', children: { allTests: () => cases } } as never);
    expect(measured).toMatchObject({ passed: MAX_RECORDED_PASSED_CASES + 11, failed: 1, skipped: 0 });
    expect(measured?.passedCaseTitles).toHaveLength(MAX_RECORDED_PASSED_CASES);
    expect(measured?.passedCaseTitlesTruncated).toBe(true);
    expect(measured?.failedCaseTitles).toBeUndefined();
  });
  it('marks the identity proof incomplete when a passing case has an unreadable title', () => {
    const cases = [
      { fullName: 'suite > readable', result: () => ({ state: 'passed' }) },
      { fullName: 'x'.repeat(MAX_RECORDED_CASE_TITLE_CHARS + 1), result: () => ({ state: 'passed' }) },
    ];
    const measured = collectModuleExecution({ state: () => 'passed', children: { allTests: () => cases } } as never);
    expect(measured).toMatchObject({
      passed: 2,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      passedCaseTitles: ['suite > readable'],
      passedCaseTitlesTruncated: true,
    });
  });
  it('records requested late passing identities within the cap without crediting skipped or failed cases', () => {
    const lateIndex = MAX_RECORDED_PASSED_CASES + 10;
    const skippedIndex = MAX_RECORDED_PASSED_CASES + 14;
    const failedIndex = MAX_RECORDED_PASSED_CASES + 15;
    const cases = Array.from({ length: MAX_RECORDED_PASSED_CASES + 16 }, (_, i) => ({
      fullName: 'suite > proof-' + i,
      result: () => ({ state: i === skippedIndex ? 'skipped' : i === failedIndex ? 'failed' : 'passed' }),
    }));
    const measured = collectModuleExecution({
      state: () => 'failed', children: { allTests: () => cases },
    } as never, new RegExp('proof-(' + [lateIndex, skippedIndex, failedIndex].join('|') + ')$', 'g'));
    expect(measured).toMatchObject({
      passed: MAX_RECORDED_PASSED_CASES + 14, failed: 1, skipped: 1, collectionFailed: false,
    });
    expect(measured?.passedCaseTitles).toHaveLength(MAX_RECORDED_PASSED_CASES);
    expect(measured?.passedCaseTitlesTruncated).toBe(true);
    expect(measured?.passedCaseTitles?.[0]).toBe('suite > proof-' + lateIndex);
    expect(measured?.passedCaseTitles).not.toContain('suite > proof-' + skippedIndex);
    expect(measured?.passedCaseTitles).not.toContain('suite > proof-' + failedIndex);
    expect(measured?.failedCaseTitles).toEqual(['suite > proof-' + failedIndex]);
    expect(collectModuleExecution({ state: () => 'failed', children: { allTests: () => cases } } as never)
      ?.passedCaseTitles).not.toContain('suite > proof-' + lateIndex);
  });
  it('names every failed case of a failing module: failed identities are not capped (P-017, D-005)', () => {
    const cases = Array.from({ length: 200 }, (_, i) => ({
      fullName: 'suite > failing-' + i, result: () => ({ state: 'failed' }),
    }));
    const measured = collectModuleExecution({ state: () => 'failed', children: { allTests: () => cases } } as never);
    expect(measured).toMatchObject({ passed: 0, failed: 200, skipped: 0, collectionFailed: false });
    expect(measured?.failedCaseTitles).toEqual(cases.map(c => c.fullName));
  });
  it('persists a preferred late identity while running the whole module', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUN_CASE_TITLE_PATTERN', 'late-proof$');
    const rows: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }),
      async row => { rows.push(row); });
    try {
      await reporter.onInit({ config: { root: TEST_CONFIG_ROOT }, vite: { config: { root: TEST_CONFIG_ROOT } } } as never);
      const cases = Array.from({ length: MAX_RECORDED_PASSED_CASES + 16 }, (_, i) => ({
        fullName: i === MAX_RECORDED_PASSED_CASES + 15 ? 'suite > late-proof' : 'suite > case-' + i,
        result: () => ({ state: 'passed' }),
      }));
      reporter.onTestModuleEnd({ state: () => 'passed', children: { allTests: () => cases },
        moduleId: join(TEST_CONFIG_ROOT, 'src/admin-test-runs-reporter.test.ts'),
        diagnostic: () => ({ duration: 1 }), errors: () => [],
      } as never);
      await reporter.onTestRunEnd();
      expect(rows[0].executionDetails).toMatchObject({
        passed: MAX_RECORDED_PASSED_CASES + 16, failed: 0, skipped: 0, testNamePattern: null,
      });
      expect(rows[0].executionDetails?.passedCaseTitles).toHaveLength(MAX_RECORDED_PASSED_CASES);
      expect(rows[0].executionDetails?.passedCaseTitlesTruncated).toBe(true);
      expect(rows[0].executionDetails?.passedCaseTitles?.[0]).toBe('suite > late-proof');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('retains a failed collection even without a failed assertion', () => {
    expect(collectModuleExecution(module(['skipped'], 'failed')))
      .toEqual({ passed: 0, failed: 0, skipped: 1, collectionFailed: true });
  });
  it.each([14, 47, MAX_RECORDED_PASSED_CASES + 1])(
    'preserves readable red metadata after a suite hook fails following %i passing cases', async passed => {
      const rows: TestRunRow[] = [];
      const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }),
        async row => { rows.push(row); });
      await reporter.onInit({ config: { root: TEST_CONFIG_ROOT },
        vite: { config: { root: TEST_CONFIG_ROOT } } } as never);
      reporter.onTestModuleEnd({ state: () => 'failed',
        children: { allTests: () => Array.from({ length: passed }, (_, index) => ({
          fullName: `suite > passed-${index}`, result: () => ({ state: 'passed' }),
        })) },
        moduleId: join(TEST_CONFIG_ROOT, 'src/admin-test-runs-reporter.test.ts'),
        diagnostic: () => ({ duration: 1 }), errors: () => [{ message: 'afterAll cleanup failed' }],
      } as never);
      await reporter.onTestRunEnd();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('fail');
      expect(rows[0].outputTail).toContain('afterAll cleanup failed');
      const execution = parseTestRunExecutionDetails(rows[0].executionDetails);
      expect(execution).toMatchObject({ root: computeWorkspaceRootFrom(TEST_CONFIG_ROOT), commitSha: 'abc',
        passed, failed: 0, skipped: 0, collectionFailed: true });
      expect(execution).not.toHaveProperty('passedCaseTitles');
      expect(execution).not.toHaveProperty('failedCaseTitles');
      expect(execution).not.toHaveProperty('passedCaseTitlesTruncated');
    },
  );
  it('does not invent measurements for pending or unreadable cases', () => {
    expect(collectModuleExecution(module(['passed', 'pending']))).toBeNull();
    expect(collectModuleExecution({ state: () => 'passed' } as never)).toBeNull();
    expect(collectModuleExecution(module(['passed'], 'pending'))).toBeNull();
  });
  it('writes the captured run scope and counts on the same terminal row', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUN_GROUP', 'ca5fce52-7c67-4d38-8c26-96a952f6a2a2');
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'ws-count-proof');
    vi.stubEnv('PAPERCUSP_TEST_RUN_WORKSPACE', 'ws-count-proof');
    vi.stubEnv('PAPERCUSP_TEST_RUN_HARNESS', 'count-proof');
    const rows: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }),
      async row => { rows.push(row); });
    try {
      await reporter.onInit({ config: { root: TEST_CONFIG_ROOT, testNamePattern: /selected case/ },
        vite: { config: { root: TEST_CONFIG_ROOT } } } as never);
      reporter.onTestModuleEnd({ ...module(['passed', 'skipped']),
        moduleId: join(TEST_CONFIG_ROOT, 'src/admin-test-runs-reporter.test.ts'),
        diagnostic: () => ({ duration: 1 }), errors: () => [],
      } as never);
      await reporter.onTestRunEnd();
      expect(rows).toHaveLength(1);
      expect(rows[0].executionDetails).toMatchObject({ schemaVersion: 1,
        workspaceId: 'ws-count-proof', harnessSlug: 'count-proof',
        runGroupId: 'ca5fce52-7c67-4d38-8c26-96a952f6a2a2',
        filePath: rows[0].filePath, testNamePattern: 'selected case',
        passed: 1, failed: 0, skipped: 1, collectionFailed: false });
      expect(rows[0].executionDetails?.root).toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('retains exact failed-case identities when DOM errors erase them from the tail (EI-25248905256718690)', async () => {
    const names = ['suite — first > fails: at a colon', 'suite > second fails', 'suite > third fails'];
    const fakeModule = {
      state: () => 'failed',
      children: { allTests: () => [
        { fullName: 'suite > passes', result: () => ({ state: 'passed' }) },
        ...names.map(fullName => ({ fullName, result: () => ({
          state: 'failed', errors: [{
            message: `<aside>${'DOM '.repeat(3_000)}</aside>`,
            actual: 'actual DOM '.repeat(1_000), expected: 'expected DOM '.repeat(1_000),
          }],
        }) })),
      ] },
      moduleId: join(TEST_CONFIG_ROOT, 'src/admin-test-runs-reporter.test.ts'),
      diagnostic: () => ({ duration: 1 }), errors: () => [],
    };
    const rows: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }),
      async row => { rows.push(row); });
    await reporter.onInit({ config: { root: TEST_CONFIG_ROOT }, vite: { config: { root: TEST_CONFIG_ROOT } } } as never);
    reporter.onTestModuleEnd(fakeModule as never);
    await reporter.onTestRunEnd();
    expect(rows).toHaveLength(1);
    expect(rows[0].outputTail).toHaveLength(4_000);
    for (const name of names) expect(rows[0].outputTail).not.toContain(name);
    expect(rows[0].executionDetails).toMatchObject({
      passed: 1, failed: 3, failedCaseTitles: names, passedCaseTitles: ['suite > passes'],
    });
    // Recovery readers enforce this exact schema. Keep the writer and reader in
    // lockstep so a reporter field cannot turn an otherwise measured pass into unknown.
    expect(parseTestRunExecutionDetails(rows[0].executionDetails)).toMatchObject({
      passed: 1, failed: 3, failedCaseTitles: names, passedCaseTitles: ['suite > passes'],
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WI-1702898 — a test_runs row must be joinable to the sha it judged', () => {
  const saved = { ...process.env };
  afterEach(() => {
    // Keep Node's native environment object. Replacing it with an ordinary
    // object detaches later stubEnv writes from new Worker environments.
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(saved, key)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });

  it('refuses to record a DIRTY-TREE run as source=ci', () => {
    // A tree ~100 agents are mutating proves nothing about any sha. Recorded as `ci`,
    // 3,126 such rows sat indistinguishable from real gate evidence on 2026-08-31.
    expect(resolveRecordedTestRunSource('ci', true)).toBe('local');
  });

  it('leaves a CLEAN ci run alone — this narrows the claim, it does not delete it', () => {
    expect(resolveRecordedTestRunSource('ci', false)).toBe('ci');
  });

  it('never PROMOTES a non-ci source, in either dirty state', () => {
    for (const dirty of [true, false]) {
      expect(resolveRecordedTestRunSource('local', dirty)).toBe('local');
      expect(resolveRecordedTestRunSource('admin-ui', dirty)).toBe('admin-ui');
    }
  });

  it('prefers the runner STAMP over the locally inferred sha', () => {
    // The stamp is an observation by the process that chose the sha; the inferred value
    // is a guess about which checkout we are sitting in, behind a 200ms timeout.
    process.env.PAPERCUSP_TEST_RUN_COMMIT = 'adbf27530285830455f8d8df32a45752cfaff332';
    expect(resolveTestRunCommit('someotherhead')).toBe('adbf27530285830455f8d8df32a45752cfaff332');
  });

  it('falls back to the inferred sha when nothing stamped one', () => {
    delete process.env.PAPERCUSP_TEST_RUN_COMMIT;
    expect(resolveTestRunCommit('localhead')).toBe('localhead');
  });

  it('an EMPTY or whitespace stamp is not a stamp — it must not blank a real inferred sha', () => {
    // A stamp that resolved to '' is exactly the NULL this fix exists to remove; letting
    // it win would reintroduce the defect through the fix for it.
    for (const blank of ['', '   ']) {
      process.env.PAPERCUSP_TEST_RUN_COMMIT = blank;
      expect(resolveTestRunCommit('localhead')).toBe('localhead');
    }
  });

  it('still reports null when neither source has a sha — an honest NULL, not a fake one', () => {
    delete process.env.PAPERCUSP_TEST_RUN_COMMIT;
    expect(resolveTestRunCommit(null)).toBeNull();
  });
});

describe('AdminTestRunsReporter fail-soft contract', () => {
  it.each(['unit', 'integration', undefined] as const)('records project layer %s instead of inferring it from a filename or root config', async (layer) => {
    const rows: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }),
      async (row) => { rows.push(row); });
    await reporter.onInit({ config: { provide: { papercuspTestLayer: 'browser' } },
      vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
    reporter.onTestModuleEnd({
      moduleId: join(TEST_CONFIG_ROOT, 'src/runtime-layer.test.ts'),
      project: { config: { provide: layer ? { papercuspTestLayer: layer } : {} } },
      state: () => 'passed', diagnostic: () => ({ duration: 1 }), errors: () => [],
      children: { allTests: () => [{ result: () => ({ state: 'passed' }) }] },
    } as never);
    await reporter.onTestRunEnd();
    expect(rows).toHaveLength(1);
    expect(rows[0].executionDetails?.testLayer).toBe(layer);
  });

  it('constructs without side effects', () => {
    const r = new AdminTestRunsReporter();
    expect(r).toBeDefined();
  });

  it('onInit resolves even with a bogus ctx', async () => {
    const r = new AdminTestRunsReporter();
    await expect(r.onInit(null as never)).resolves.toBeUndefined();
  });

  it.each(['throw', 'reject'])('records dirty provenance when the snapshot reader fails by %s', async failure => {
    const rows: TestRunRow[] = [];
    const error = new ReferenceError('snapshot dependency missing');
    const reporter = new AdminTestRunsReporter(
      () => {
        if (failure === 'throw') throw error;
        return Promise.reject(error);
      },
      async row => { rows.push(row); },
    );

    await expect(reporter.onInit({
      config: { root: TEST_CONFIG_ROOT }, vite: { config: { root: TEST_CONFIG_ROOT } },
    } as never)).resolves.toBeUndefined();
    reporter.onTestModuleEnd({
      moduleId: join(TEST_CONFIG_ROOT, 'src/admin-test-runs-reporter.test.ts'),
      state: () => 'passed', diagnostic: () => ({ duration: 1 }), errors: () => [],
      children: { allTests: () => [{ result: () => ({ state: 'passed' }) }] },
    } as never);
    await expect(reporter.onTestRunEnd()).resolves.toBeUndefined();

    expect(rows).toHaveLength(1);
    expect(rows[0].worktreeDirty).toBe(true);
    expect(rows[0].executionDetails?.worktreeDirtyReason).toContain('snapshot dependency missing');
  });

  it('onTestModuleEnd swallows a TestModule whose state() throws', () => {
    const r = new AdminTestRunsReporter();
    const fakeModule = {
      moduleId: '/tmp/fake.test.ts',
      state: () => {
        throw new Error('state-explodes');
      },
      diagnostic: () => ({ duration: 5 }),
      errors: () => [],
    } as unknown as Parameters<typeof r.onTestModuleEnd>[0];
    expect(() => r.onTestModuleEnd(fakeModule)).not.toThrow();
  });

  it('onTestModuleEnd swallows a TestModule with no moduleId', () => {
    const r = new AdminTestRunsReporter();
    const fakeModule = {
      // moduleId: undefined
      state: () => 'passed',
      diagnostic: () => ({ duration: 5 }),
    } as unknown as Parameters<typeof r.onTestModuleEnd>[0];
    expect(() => r.onTestModuleEnd(fakeModule)).not.toThrow();
  });

  it('onTestModuleEnd accepts a realistic passing module without throwing', () => {
    const r = new AdminTestRunsReporter();
    const fakeModule = {
      moduleId: '/tmp/fake.test.ts',
      state: () => 'passed',
      diagnostic: () => ({ duration: 12, environmentSetupDuration: 0, prepareDuration: 0, collectDuration: 0, setupDuration: 0 }),
      errors: () => [],
    } as unknown as Parameters<typeof r.onTestModuleEnd>[0];
    expect(() => r.onTestModuleEnd(fakeModule)).not.toThrow();
  });

  it('flushes a 674-file pure-lane shard through one reporter batch, never 674 writes', async () => {
    const batches: ReadonlyArray<TestRunRow>[] = [];
    const r = new AdminTestRunsReporter(
      async () => ({ commit: 'abc', porcelain: '' }),
      undefined,
      async (rows) => { batches.push(rows); },
    );
    await r.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
    for (let i = 0; i < 674; i += 1) {
      r.onTestModuleEnd({
        moduleId: join(TEST_CONFIG_ROOT, `src/shard-${i}.test.ts`),
        state: () => 'passed',
        diagnostic: () => ({ duration: 1 }),
        errors: () => [],
        children: { allTests: () => [{ result: () => ({ state: 'passed' }) }] },
      } as never);
    }

    await r.onTestRunEnd();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(674);
  });

  it('persists a 674-file shard in two bounded bulk statements with ISO timestamps', async () => {
    const helperCalls: Array<{ rows: ReadonlyArray<Record<string, unknown>>; columns: unknown[] }> = [];
    let statementCalls = 0;
    const sql = ((first: unknown, ...values: unknown[]) => {
      if (Array.isArray(first) && !('raw' in (first as object))) {
        helperCalls.push({ rows: first as ReadonlyArray<Record<string, unknown>>, columns: values });
        return { kind: 'bulk-values' };
      }
      statementCalls += 1;
      return Promise.resolve([]);
    }) as PgSql;
    sql.end = async () => undefined;
    const startedAt = new Date('2026-09-13T13:57:41.000Z');
    const finishedAt = new Date('2026-09-13T13:58:32.000Z');
    const rows = Array.from({ length: 674 }, (_, i): TestRunRow => ({
      filePath: `packages/operator-core/lib/shard-${i}.test.ts`,
      status: 'pass',
      durationMs: 1,
      startedAt,
      finishedAt,
      outputTail: null,
      isScratchConfig: false,
      worktreeDirty: false,
      commitSha: 'abc123',
      executionDetails: null,
    }));

    await insertTestRunRowsWithSql(sql, rows, {
      branch: 'staging',
      inferredCommit: 'fallback',
      declaredSource: 'local',
      runGroupId: 'pure-shard',
      harnessSlug: 'papercusp',
      workspaceId: 'papercusp-workspace',
      loopLagP95Ms: 2,
      rssMb: 100,
    });

    expect(TEST_RUN_INSERT_BATCH_SIZE).toBe(500);
    expect(statementCalls).toBe(2);
    expect(helperCalls.map((call) => call.rows.length)).toEqual([500, 174]);
    expect(helperCalls[0].rows[0]).toMatchObject({
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      execution_details: null,
    });
    expect(helperCalls[0].columns).toContain('execution_details');
  });

  it('hands postgres-js the execution_details OBJECT, never pre-stringified JSON (EI-24799048791133095)', async () => {
    // The reporter's hand-rolled client keeps postgres-js's default jsonb
    // serializer (JSON.stringify). A pre-stringified value is therefore encoded
    // twice and lands as a jsonb STRING scalar, so `execution_details->>'key'`
    // silently reads NULL. 826k ledger rows were written that way.
    const helperCalls: Array<{ rows: Record<string, unknown>[] }> = [];
    const sql = Object.assign(
      (first: TemplateStringsArray | readonly Record<string, unknown>[]) => {
        if (!Array.isArray(first) || 'raw' in first) return Promise.resolve([]);
        helperCalls.push({ rows: [...(first as readonly Record<string, unknown>[])] });
        return {};
      },
      { end: async () => undefined },
    ) as unknown as Parameters<typeof insertTestRunRowsWithSql>[0];
    const at = new Date('2026-10-01T00:00:00.000Z');
    const details = {
      schemaVersion: 1, root: '/tmp', filePath: 'a.test.ts', runGroupId: null, workspaceId: null,
      harnessSlug: null, testNamePattern: null, passed: 1, failed: 0, skipped: 0,
      collectionFailed: false, mutationPhase: 'mutant', commitSha: 'abc123', worktreeDirty: false,
    } as const;
    await insertTestRunRowsWithSql(sql, [{
      filePath: 'a.test.ts', status: 'pass', durationMs: 1, startedAt: at, finishedAt: at,
      outputTail: null, isScratchConfig: false, worktreeDirty: false, commitSha: 'abc123',
      executionDetails: details,
    }], {
      branch: 'staging', inferredCommit: null, declaredSource: 'local', runGroupId: null,
      harnessSlug: null, workspaceId: null, loopLagP95Ms: null, rssMb: null,
    });

    const stored = helperCalls[0]?.rows[0]?.execution_details;
    expect(typeof stored).toBe('object');
    expect(stored).toEqual(details);
  });

  it('retains binary failure diagnostics in file, JSON and case inserts without PostgreSQL NULs', async () => {
    const batches: Record<string, unknown>[][] = [];
    let batch: Record<string, unknown>[] = [];
    const sql = Object.assign((first: unknown) => {
      if (Array.isArray(first) && !('raw' in first)) {
        batch = first as Record<string, unknown>[];
        batches.push(batch);
        return {};
      }
      return Promise.resolve(batch[0]?.file_path ? [{ id: '901', file_path: batch[0].file_path }] : []);
    }, { end: async () => undefined }) as unknown as PgSql;
    const at = new Date('2026-10-25T00:00:00.000Z');
    const diagnostic = 'raster' + String.fromCharCode(0) + 'bytes';
    const details = { schemaVersion: 1, passedCaseTitles: [diagnostic] } as unknown as NonNullable<TestRunRow['executionDetails']>;
    const receipts = await insertTestRunRowsWithSql(sql, [{
      filePath: 'binary.test.ts', status: 'fail', durationMs: 1, startedAt: at, finishedAt: at,
      outputTail: diagnostic, isScratchConfig: false, worktreeDirty: false, commitSha: 'abc123',
      executionDetails: details, cases: [{ caseIndex: 0, caseKey: diagnostic, occurrence: 1,
        status: 'fail', durationMs: 1, errorTail: diagnostic }],
    }], { branch: 'staging', inferredCommit: null, declaredSource: 'local', runGroupId: null,
      harnessSlug: null, workspaceId: null, loopLagP95Ms: null, rssMb: null });
    expect(receipts).toMatchObject([{ outcome: 'inserted', id: '901' }]);
    expect(batches).toHaveLength(2);
    expect(batches[0][0]).toMatchObject({ output_tail: 'raster\\0bytes',
      execution_details: { passedCaseTitles: ['raster\\0bytes'] } });
    expect(batches[1][0]).toMatchObject({ case_key: 'raster\\0bytes', error_tail: 'raster\\0bytes' });
    expect(details.passedCaseTitles).toEqual([diagnostic]);
  });

  describe('per-row write receipts (WI-10006245)', () => {
    const context = {
      branch: 'staging', inferredCommit: null, declaredSource: 'mutation-probe' as const, runGroupId: null,
      harnessSlug: null, workspaceId: null, loopLagP95Ms: null, rssMb: null,
    };
    const at = new Date('2026-10-06T01:15:00.000Z');
    const row = (filePath: string, status: TestRunRow['status'] = 'fail'): TestRunRow => ({
      filePath, status, durationMs: 1, startedAt: at, finishedAt: at, outputTail: null,
      isScratchConfig: false, worktreeDirty: false, commitSha: 'abc123', executionDetails: null,
    });
    /** A fake client whose STATEMENT result is `statement()`; the bulk helper just passes through. */
    const fakeSql = (statement: () => Promise<unknown>): PgSql =>
      Object.assign(
        (first: unknown) => (Array.isArray(first) && !('raw' in (first as object)) ? {} : statement()),
        { end: async () => undefined },
      ) as unknown as PgSql;

    it('uses a row framework override and keeps Vitest as the compatibility default', async () => {
      const insertedRows: Record<string, unknown>[] = [];
      const sql = Object.assign(
        (first: unknown) => {
          if (Array.isArray(first) && !('raw' in (first as object))) {
            insertedRows.push(...(first as Record<string, unknown>[]));
            return {};
          }
          return Promise.resolve([
            { id: '901', file_path: 'node.test.js' },
            { id: '902', file_path: 'vitest.test.ts' },
          ]);
        },
        { end: async () => undefined },
      ) as unknown as PgSql;
      await insertTestRunRowsWithSql(sql, [
        { ...row('node.test.js', 'pass'), framework: 'node' },
        row('vitest.test.ts', 'pass'),
      ], context);
      expect(insertedRows.map((inserted) => inserted.framework)).toEqual(['node', 'vitest']);
    });

    it('pairs RETURNING ids to rows by file path, not by position', async () => {
      const sql = fakeSql(async () => [
        { id: '902', file_path: 'b.test.ts' },
        { id: '901', file_path: 'a.test.ts' },
      ]);
      const receipts = await insertTestRunRowsWithSql(sql, [row('a.test.ts'), row('b.test.ts', 'pass')], context);
      expect(receipts).toMatchObject([
        { filePath: 'a.test.ts', status: 'fail', outcome: 'inserted', id: '901' },
        { filePath: 'b.test.ts', status: 'pass', outcome: 'inserted', id: '902' },
      ]);
    });

    describe('exact timed-out receipt readback', () => {
      const details = {
        schemaVersion: 1,
        root: '/workspace/packages/operator-core',
        filePath: 'a.test.ts',
        runGroupId: 'group-a',
        workspaceId: 'workspace-a',
        harnessSlug: 'papercusp',
        testNamePattern: null,
        passed: 1,
        failed: 0,
        skipped: 0,
        collectionFailed: false,
        mutationPhase: null,
        commitSha: 'abc123',
        worktreeDirty: false,
      } as NonNullable<TestRunRow['executionDetails']>;
      const base = testRunReceiptBaseFor({ ...row('a.test.ts', 'pass'), executionDetails: details });
      const receipt: TestRunReceipt = {
        ...base, outcome: 'timeout', reason: 'pg_insert_timeout_2000ms', replayable: false,
      };
      const candidate: TestRunReceiptReadbackCandidate = {
        id: '901',
        runGroupId: 'group-a',
        filePath: 'a.test.ts',
        framework: 'vitest',
        status: 'pass',
        durationMs: 1,
        startedAt: at,
        finishedAt: at,
        commitSha: 'abc123',
        harnessSlug: 'papercusp',
        workspaceId: 'workspace-a',
        isScratchConfig: false,
        worktreeDirty: false,
        root: details.root,
        detailsRunGroupId: 'group-a',
        detailsFilePath: 'a.test.ts',
        detailsCommitSha: 'abc123',
        detailsHarnessSlug: 'papercusp',
        detailsWorkspaceId: 'workspace-a',
        executionDetails: details,
      };

      it('restores the original ledger id from one exact same-run row', () => {
        expect(recoverTimedOutTestRunReceipts([receipt], [candidate], 'group-a')).toEqual([{
          ...base, outcome: 'inserted', id: '901',
        }]);
      });

      it.each(['timeout', 'inserted'] as const)('recovers omitted cases after a %s file receipt without another file INSERT', async outcome => {
        const cases = [{ caseIndex: 0, caseKey: 'suite > original', occurrence: 1,
          status: 'pass' as const, durationMs: 1, errorTail: null }];
        const original = { ...receipt, outcome, ...(outcome === 'inserted' ? { id: '901' } : {}),
          row: { ...receipt.row, cases }, caseInsertOutcome: { written: 0, unwritten: 1, reason: 'file_insert_timeout' } };
        const statements: string[] = [];
        const batches: Record<string, unknown>[][] = [];
        const sql = Object.assign((first: unknown) => {
          if (Array.isArray(first) && !('raw' in first)) {
            if (typeof first[0] === 'object') batches.push(first as Record<string, unknown>[]);
            return {};
          }
          const query = (first as TemplateStringsArray).join('?');
          statements.push(query);
          return Promise.resolve(query.includes('SELECT') ? [candidate] : []);
        }, { end: async () => undefined }) as unknown as PgSql;
        const log = JSON.stringify(original);
        expect(pendingTestRunRecoveryPaths(log, ['a.test.ts'], details.root)).toEqual(['a.test.ts']);
        const options = { expectedPaths: ['a.test.ts'], expectedRoot: details.root, runGroupId: 'group-a', env: {} };
        const recovered = await reconcileTimedOutTestRunReceiptsWithSql(sql, log, options);
        expect(recovered).toMatchObject([{ outcome: 'inserted', id: '901',
          caseInsertOutcome: { written: 1, unwritten: 0, reason: null } }]);
        expect(statements).toHaveLength(2);
        expect(statements[0]).toContain('SELECT');
        expect(statements[1]).toContain('INSERT INTO harness_shared.test_case_runs');
        expect(statements[1]).toContain('ON CONFLICT (test_run_id, case_index) DO NOTHING');
        expect(statements.join('')).not.toContain('INSERT INTO harness_shared.test_runs');
        expect(batches).toEqual([[expect.objectContaining({ test_run_id: '901', case_index: 0, case_key: cases[0].caseKey })]]);
        const completeLog = log + '\n' + JSON.stringify(recovered[0]);
        expect(pendingTestRunRecoveryPaths(completeLog, ['a.test.ts'], details.root)).toEqual([]);
        expect(await reconcileTimedOutTestRunReceiptsWithSql(sql, completeLog, options)).toEqual([]);
        expect(statements).toHaveLength(2);
      });

      it.each(['foreign metadata', 'ambiguous row', 'different acknowledged id'])('never writes recovered cases for %s', async control => {
        const original = { ...base, outcome: 'inserted', id: '901', row: { ...base.row,
          cases: [{ caseIndex: 0, caseKey: 'original', occurrence: 1, status: 'pass', durationMs: 1, errorTail: null }] } };
        const candidates = control === 'foreign metadata' ? [{ ...candidate, executionDetails: { ...details, passed: 2 } }]
          : control === 'ambiguous row' ? [candidate, { ...candidate, id: '902' }] : [{ ...candidate, id: '902' }];
        const queries: string[] = [];
        const sql = Object.assign((first: unknown) => {
          if (Array.isArray(first) && !('raw' in first)) return {};
          queries.push((first as TemplateStringsArray).join('?'));
          return Promise.resolve(candidates);
        }, { end: async () => undefined }) as unknown as PgSql;
        expect(await reconcileTimedOutTestRunReceiptsWithSql(sql, JSON.stringify(original), {
          expectedPaths: ['a.test.ts'], expectedRoot: details.root, runGroupId: 'group-a', env: {},
        })).toEqual([]);
        expect(queries).toHaveLength(1);
        expect(queries[0]).toContain('SELECT');
      });

      it('never substitutes file identity or weakens case acknowledgement when merging recovery', () => {
        const original = { ...base, outcome: 'inserted', id: '901', row: { ...base.row,
          cases: [{ caseIndex: 0, caseKey: 'original', occurrence: 1, status: 'pass', durationMs: 1, errorTail: null }] },
          caseInsertOutcome: { written: 0, unwritten: 1, reason: 'file_insert_timeout' } };
        const complete = { ...original, caseInsertOutcome: { written: 1, unwritten: 0, reason: null } };
        const read = (...history: unknown[]) => latestTestRunReceipts(history.map(value => JSON.stringify(value)).join('\n'));
        expect(read(original, complete, original)).toEqual([complete]);
        for (const changed of [
          { id: '902' }, { attempt: 1 }, { status: 'fail' },
          { row: { ...complete.row, cases: [{ ...complete.row.cases[0], caseKey: 'foreign' }] } },
          { caseInsertOutcome: { written: 2, unwritten: -1, reason: null } },
        ]) expect(read(original, { ...complete, ...changed })).toEqual([original]);
      });

      it('does not queue case recovery behind a pending canonical readback', async () => {
        const queries: string[] = [];
        let release!: (value: unknown) => void;
        const pending = new Promise(resolve => { release = resolve; });
        const sql = Object.assign((first: unknown) => {
          if (Array.isArray(first) && !('raw' in first)) return {};
          queries.push((first as TemplateStringsArray).join('?'));
          return pending;
        }, { end: async () => undefined }) as unknown as PgSql;
        const original = { ...receipt, row: { ...receipt.row, cases: [{ caseIndex: 0, caseKey: 'original',
          occurrence: 1, status: 'pass', durationMs: 1, errorTail: null }] } };
        expect(await reconcileTimedOutTestRunReceiptsWithSql(sql, JSON.stringify(original), {
          expectedPaths: ['a.test.ts'], expectedRoot: details.root, runGroupId: 'group-a', env: {}, timeoutMs: 10,
        })).toEqual([]);
        release([candidate]);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(queries).toHaveLength(1);
      });

      it.each([
        undefined, null, 'json-string-scalar',
        { ...details, passed: 2 }, { ...details, failed: 1 }, { ...details, skipped: 1 },
        { ...details, collectionFailed: true }, { ...details, worktreeDirty: true },
        { ...details, testNamePattern: 'different selection' },
        { ...details, proofContext: { fingerprint: 'foreign original proof' } },
      ])('refuses an original ledger row with different complete execution metadata: %j', executionDetails => {
        expect(recoverTimedOutTestRunReceipts([receipt], [{ ...candidate, executionDetails }], 'group-a'))
          .toEqual([]);
      });

      it('binds nested proof and population bytes while allowing JSONB object-key order', () => {
        const executionDetails = { ...details, observation: { optional: undefined,
          binary: 'before\0after', members: [{ title: 'one', outcome: 'passed' }, { title: 'two', outcome: 'skipped' }] } };
        const original = { ...receipt, row: { ...receipt.row,
          executionDetails: executionDetails as unknown as typeof details } };
        const stored = { observation: { members: [{ outcome: 'passed', title: 'one' },
          { outcome: 'skipped', title: 'two' }], binary: 'before\\0after' }, ...details };
        const recovered = recoverTimedOutTestRunReceipts([original], [{ ...candidate, executionDetails: stored }], 'group-a');
        expect(recovered).toHaveLength(1);
        expect(recovered[0]!.id).toBe(candidate.id);
        for (const observation of [
          { ...stored.observation, members: [...stored.observation.members].reverse() },
          { ...stored.observation, members: [{ title: 'one', outcome: 'failed' }, stored.observation.members[1]] },
          { ...stored.observation, binary: 'changed' },
        ]) expect(recoverTimedOutTestRunReceipts([original], [{ ...candidate,
          executionDetails: { ...stored, observation } }], 'group-a')).toEqual([]);
      });

      it('recovers PostgreSQL bigint durations without weakening the run identity', () => {
        const readback = { ...candidate, durationMs: '1' };
        expect(recoverTimedOutTestRunReceipts([receipt], [readback], 'group-a')).toEqual([
          { ...base, outcome: 'inserted', id: '901' },
        ]);
        expect(recoverTimedOutTestRunReceipts([receipt], [
          { ...readback, detailsCommitSha: 'other' },
        ], 'group-a')).toEqual([]);
      });

      it.each(['2', '-1', '1.0', '1e0', '0x1', ' 1', '', '9007199254740993'])(
        'keeps the timeout for a different or invalid bigint duration %j', durationMs => {
          expect(recoverTimedOutTestRunReceipts([receipt], [
            { ...candidate, durationMs },
          ], 'group-a')).toEqual([]);
        },
      );

      it('recovers a committed row after the same timed-out connection was destroyed', () => {
        const failed: TestRunReceipt = { ...receipt, outcome: 'failed',
          reason: 'write CONNECTION_DESTROYED localhost:5432',
          errorCode: 'CONNECTION_DESTROYED', replayable: false };
        const log = [receipt, failed].map(value => JSON.stringify(value)).join('\n');
        expect(missingTestRunReceiptPaths(log, ['a.test.ts'], details.root)).toEqual(['a.test.ts']);
        const eligible = latestTestRunReceipts(log, true);
        expect(recoverTimedOutTestRunReceipts(eligible, [candidate], 'group-a')).toEqual([
          { ...base, outcome: 'inserted', id: '901' },
        ]);
        expect(recoverTimedOutTestRunReceipts(eligible, [
          { ...candidate, commitSha: 'other' },
        ], 'group-a')).toEqual([]);
        expect(recoverTimedOutTestRunReceipts(eligible, [
          candidate, { ...candidate, id: '902' },
        ], 'group-a')).toEqual([]);
      });

      it.each([
        ['a definite pre-submit failure', { errorCode: 'CONNECT_TIMEOUT', replayable: true }],
        ['a database rejection', { errorCode: '23514', replayable: false }],
        ['a newer attempt', { errorCode: 'CONNECTION_DESTROYED', replayable: false, attempt: 1 }],
      ])('does not recover the older timeout after %s', (_label, change) => {
        const failed: TestRunReceipt = { ...receipt, outcome: 'failed', reason: 'write failed',
          ...change };
        const log = [receipt, failed].map(value => JSON.stringify(value)).join('\n');
        expect(recoverTimedOutTestRunReceipts(
          latestTestRunReceipts(log, true), [candidate], 'group-a',
        )).toEqual([]);
      });

      it('never revives a failed-only or already inserted receipt for readback', () => {
        const failed: TestRunReceipt = { ...receipt, outcome: 'failed', reason: 'connection destroyed',
          errorCode: 'CONNECTION_DESTROYED', replayable: false };
        const inserted: TestRunReceipt = { ...base, outcome: 'inserted', id: '901' };
        for (const history of [[failed], [receipt, inserted, failed]]) {
          expect(recoverTimedOutTestRunReceipts(
            latestTestRunReceipts(history.map(value => JSON.stringify(value)).join('\n'), true),
            [candidate], 'group-a',
          )).toEqual([]);
        }
      });

      it.each([
        ['the group', { runGroupId: 'group-b' }],
        ['the details group', { detailsRunGroupId: 'group-b' }],
        ['the file', { filePath: 'b.test.ts' }],
        ['the details file', { detailsFilePath: 'b.test.ts' }],
        ['the status', { status: 'fail' }],
        ['the duration', { durationMs: 2 }],
        ['the start time', { startedAt: new Date('2026-10-06T01:15:01.000Z') }],
        ['the finish time', { finishedAt: new Date('2026-10-06T01:15:01.000Z') }],
        ['the commit', { commitSha: 'other' }],
        ['the details commit', { detailsCommitSha: 'other' }],
        ['the recorded root', { root: '/workspace/other' }],
        ['the harness scope', { harnessSlug: 'other' }],
        ['the details harness scope', { detailsHarnessSlug: 'other' }],
        ['the workspace scope', { workspaceId: 'other' }],
        ['the details workspace scope', { detailsWorkspaceId: 'other' }],
        ['the framework', { framework: 'node' }],
      ] as Array<[string, Partial<TestRunReceiptReadbackCandidate>]>)(
        'keeps the timeout when %s differs',
        (_field, mismatch) => {
          expect(recoverTimedOutTestRunReceipts(
            [receipt], [{ ...candidate, ...mismatch }], 'group-a',
          )).toEqual([]);
        },
      );

      it('keeps the timeout for invalid timestamps, ambiguous rows, or a truncated read', () => {
        expect(recoverTimedOutTestRunReceipts([receipt], [
          { ...candidate, startedAt: 'not-a-timestamp' },
        ], 'group-a')).toEqual([]);
        expect(recoverTimedOutTestRunReceipts([receipt], [
          candidate, { ...candidate, id: '902' },
        ], 'group-a')).toEqual([]);
        expect(recoverTimedOutTestRunReceipts([receipt], [candidate], 'group-a', true)).toEqual([]);
      });

      it('does not let one ledger row satisfy multiple receipts or a failed receipt', () => {
        const secondReceipt: TestRunReceipt = {
          ...receipt,
          receiptId: 'receipt-b',
          row: { ...receipt.row, receiptId: 'receipt-b' },
        };
        const failedReceipt: TestRunReceipt = {
          ...receipt, outcome: 'failed', reason: 'connect timeout', replayable: false,
        };
        expect(recoverTimedOutTestRunReceipts(
          [receipt, secondReceipt], [candidate], 'group-a',
        )).toEqual([]);
        expect(recoverTimedOutTestRunReceipts(
          [failedReceipt], [candidate], 'group-a',
        )).toEqual([]);
      });
    });

    it('records client timing and only the backend pid from the postgres result', async () => {
      const result = Object.assign([{ id: '901', file_path: 'a.test.ts' }], {
        state: { pid: 1198083, secret: 987654321 },
      });
      const statement = vi.fn(async () => result);
      const [receipt] = await insertTestRunRowsWithSql(fakeSql(statement), [row('a.test.ts')], context);
      const diagnostics = receipt?.insertDiagnostics;
      expect(diagnostics).toMatchObject({
        schemaVersion: 1, statementId: expect.any(String), clientPid: process.pid, backendPid: 1198083,
        startedAt: expect.any(String), observedAt: expect.any(String), settledAt: expect.any(String),
        elapsedMs: expect.any(Number), settledElapsedMs: expect.any(Number), budgetMs: expect.any(Number),
      });
      expect(diagnostics!.elapsedMs).toBeGreaterThanOrEqual(diagnostics!.settledElapsedMs!);
      expect(diagnostics!.settledElapsedMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(receipt)).not.toContain('987654321');
      expect(statement).toHaveBeenCalledTimes(1);
    });

    it.each([0, 1])('distinguishes %i received result rows from an unacknowledged insert without leaking driver data', async rowCount => {
      vi.useFakeTimers();
      const NEVER_EMIT_MARKER = 'never-emit-me';
      const pending = Object.assign(new Promise(() => {}), {
        executed: true, active: true, state: { pid: 1198083, secret: NEVER_EMIT_MARKER },
        resultDiagnostic: { rowCount, wireBytes: rowCount * 42, query: 'private-sql-sentinel',
          context: { credential: 'driver-context-sentinel' } },
      });
      const statement = vi.fn(() => pending);
      try {
        const write = insertTestRunRowsWithSql(fakeSql(statement), [row('a.test.ts')], context, {
          insertTimeoutMs: 20, totalInsertMs: 40,
        });
        await vi.advanceTimersByTimeAsync(40);
        const [receipt] = await write;
        expect(receipt).toMatchObject({ outcome: 'timeout',
          insertDiagnostics: { settledAt: null, driverState: {
            executed: true, active: true, resultRowCount: rowCount, resultWireBytes: rowCount * 42,
          } } });
        const text = JSON.stringify(receipt);
        for (const sentinel of [NEVER_EMIT_MARKER, 'private-sql-sentinel', 'driver-context-sentinel']) {
          expect(text).not.toContain(sentinel);
        }
        expect(statement).toHaveBeenCalledTimes(1);
      } finally { vi.useRealTimers(); }
    });

    it('keeps unavailable or invalid driver progress unknown without losing an inserted receipt', async () => {
      const result = [{ id: '901', file_path: 'a.test.ts' }];
      const pending = Object.assign(Promise.resolve(result), {
        executed: 'unknown', active: 1,
        resultDiagnostic: { rowCount: -1, wireBytes: Number.POSITIVE_INFINITY },
      });
      const [receipt] = await insertTestRunRowsWithSql(fakeSql(() => pending), [row('a.test.ts')], context);
      expect(receipt).toMatchObject({ outcome: 'inserted', id: '901',
        insertDiagnostics: { driverState: {
          executed: null, active: null, resultRowCount: null, resultWireBytes: null,
        } } });
      Object.defineProperty(pending, 'resultDiagnostic', { get: () => { throw new Error('diagnostic getter'); } });
      const [guarded] = await insertTestRunRowsWithSql(fakeSql(() => pending), [row('a.test.ts')], context);
      expect(guarded).toMatchObject({ outcome: 'inserted', id: '901' });
      expect(guarded?.insertDiagnostics?.driverState).toBeUndefined();
    });

    it('bounds a permanently pending insert by the total budget without replaying it', async () => {
      vi.useFakeTimers();
      const pending = Object.assign(new Promise(() => {}), { state: null as { pid: number } | null });
      const statement = vi.fn(() => pending);
      const sql = fakeSql(statement);
      let finished = false;
      const write = insertTestRunRowsWithSql(sql, [row('a.test.ts')], context, {
        insertTimeoutMs: 20, totalInsertMs: 1_000,
      }).then(receipts => {
        finished = true;
        return receipts;
      });
      try {
        await vi.advanceTimersByTimeAsync(999);
        expect(finished).toBe(false);
        pending.state = { pid: 1198083 }; // postgres-js assigns this after dispatch, not at construction.
        await vi.advanceTimersByTimeAsync(1);
        expect(await write).toMatchObject([
          { filePath: 'a.test.ts', status: 'fail', outcome: 'timeout', reason: 'pg_insert_timeout_1000ms',
            insertDiagnostics: { backendPid: 1198083, settledAt: null, budgetMs: 1_000 } },
        ]);
        expect(statement).toHaveBeenCalledTimes(1);
      } finally {
        await vi.runAllTimersAsync();
        vi.useRealTimers();
      }
    });

    it('reports a rejected insert as failed with the reason', async () => {
      const sql = fakeSql(async () => { throw new Error('remaining connection slots are reserved'); });
      const receipts = await insertTestRunRowsWithSql(sql, [row('a.test.ts')], context, {
        insertTimeoutMs: 1_000, totalInsertMs: 1_000,
      });
      expect(receipts).toMatchObject([
        { filePath: 'a.test.ts', status: 'fail', outcome: 'failed', reason: 'remaining connection slots are reserved' },
      ]);
    });

    it('replays one definite pre-submit timeout with the same receipt id and execution details', async () => {
      const details = { schemaVersion: 1, filePath: 'a.test.ts', passed: 1 };
      const rows: TestRunRow[] = [{ ...row('a.test.ts', 'pass'),
        executionDetails: details as unknown as TestRunRow['executionDetails'] }];
      const statement = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('connect timeout'), { code: 'CONNECT_TIMEOUT' }))
        .mockResolvedValueOnce([{ id: '901', file_path: 'a.test.ts' }]);
      const sql = fakeSql(statement);

      const receipts = await insertTestRunRowsWithSql(sql, rows, context, {
        insertTimeoutMs: 1_000, totalInsertMs: 2_000,
      });

      expect(isDefinitePreSubmitFailure(Object.assign(new Error('connect timeout'), { code: 'CONNECT_TIMEOUT' }))).toBe(true);
      expect(isDefinitePreSubmitFailure(Object.assign(new Error('wait timeout'), { code: 'ETIMEDOUT' }))).toBe(false);
      expect(statement).toHaveBeenCalledTimes(2);
      expect(receipts.map(receipt => ({ outcome: receipt.outcome, attempt: receipt.attempt, receiptId: receipt.receiptId }))).toEqual([
        { outcome: 'failed', attempt: 0, receiptId: receipts[0]?.receiptId },
        { outcome: 'inserted', attempt: 1, receiptId: receipts[0]?.receiptId },
      ]);
      expect(receipts[0]).toMatchObject({ outcome: 'failed', replayable: true, errorCode: 'CONNECT_TIMEOUT' });
      expect(receipts[1]).toMatchObject({ outcome: 'inserted', id: '901', row: { executionDetails: details } });
      expect(receipts[0]?.insertDiagnostics).toMatchObject({ backendPid: null, settledAt: expect.any(String) });
      expect(receipts[1]?.insertDiagnostics?.statementId).not.toBe(receipts[0]?.insertDiagnostics?.statementId);
    });

    it('does not replay a CONNECT_TIMEOUT more than once', async () => {
      const statement = vi.fn(async () => {
        throw Object.assign(new Error('connect timeout'), { code: 'CONNECT_TIMEOUT' });
      });
      const receipts = await insertTestRunRowsWithSql(fakeSql(statement), [row('a.test.ts')], context, {
        insertTimeoutMs: 1_000, totalInsertMs: 2_000,
      });

      expect(statement).toHaveBeenCalledTimes(2);
      expect(receipts.map(receipt => [receipt.outcome, receipt.attempt,
        receipt.outcome === 'inserted' ? null : receipt.replayable])).toEqual([
        ['failed', 0, true], ['failed', 1, false],
      ]);
    });

    it('requires a canonical inserted receipt for each expected file and accepts a later attempt', () => {
      const rowReceipt = {
        filePath: 'apps/operator/a.test.ts', status: 'pass',
        row: { filePath: 'apps/operator/a.test.ts', startedAt: '2026-10-06T01:15:00.000Z', finishedAt: '2026-10-06T01:15:01.000Z' },
        receiptId: 'receipt-a', attempt: 0,
      };
      const log = [
        { ...rowReceipt, outcome: 'failed', reason: 'connect timeout', replayable: true },
        { ...rowReceipt, attempt: 1, outcome: 'inserted', id: '901' },
        { ...rowReceipt, receiptId: 'receipt-b', filePath: 'apps/operator/b.test.ts', row: {
          ...rowReceipt.row, filePath: 'apps/operator/b.test.ts',
        }, outcome: 'timeout', reason: 'waiter expired', replayable: false },
        '{malformed receipt',
      ].map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n');

      expect(missingTestRunReceiptPaths(log, [
        'apps/operator/a.test.ts', 'apps/operator/b.test.ts', 'apps/operator/c.test.ts',
      ])).toEqual(['apps/operator/b.test.ts', 'apps/operator/c.test.ts']);
    });

    it('reconciles inserted receipt paths against their recorded root without suffix matching', () => {
      const filePath = 'src/shared.test.ts';
      const receipt = {
        receiptId: 'nested-root', attempt: 0, filePath, status: 'pass', outcome: 'inserted', id: '901',
        row: { filePath, startedAt: at.toISOString(), finishedAt: at.toISOString(),
          executionDetails: { root: '/repo/libs/first' } },
      };
      const expected = ['libs/first/src/shared.test.ts', 'libs/second/src/shared.test.ts'];
      expect(missingTestRunReceiptPaths(JSON.stringify(receipt), expected, '/repo'))
        .toEqual(['libs/second/src/shared.test.ts']);
      // The same receipt remains usable by a standalone submodule caller.
      expect(missingTestRunReceiptPaths(JSON.stringify(receipt), [filePath])).toEqual([]);
      for (const badRoot of [undefined, 'libs/first', '/other/libs/first']) {
        const invalid = { ...receipt, row: { ...receipt.row, executionDetails: { root: badRoot } } };
        expect(missingTestRunReceiptPaths(JSON.stringify(invalid), expected, '/repo')).toEqual(expected);
      }
      const timeout = { ...receipt, outcome: 'timeout', reason: 'pending', replayable: false };
      expect(missingTestRunReceiptPaths(JSON.stringify(timeout), expected, '/repo')).toEqual(expected);
      const escaped = { ...receipt, filePath: '../../outside.test.ts',
        row: { ...receipt.row, filePath: '../../outside.test.ts' } };
      expect(missingTestRunReceiptPaths(JSON.stringify(escaped), ['outside.test.ts'], '/repo'))
        .toEqual(['outside.test.ts']);
      const inconsistent = { ...receipt, row: { ...receipt.row, filePath: 'src/other.test.ts' } };
      expect(missingTestRunReceiptPaths(JSON.stringify(inconsistent), expected, '/repo')).toEqual(expected);
    });

    it('records late RETURNING ids on the original receipt sink without retrying the insert', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'test-run-late-receipts-'));
      const file = join(dir, 'original.jsonl');
      const otherFile = join(dir, 'other.jsonl');
      let resolveInsert!: (value: unknown) => void;
      const pending = Object.assign(new Promise(resolve => { resolveInsert = resolve; }), {
        state: { pid: 1198083, secret: 987654321 },
      });
      const statement = vi.fn(() => pending);
      vi.stubEnv(TEST_RUN_RECEIPT_ENV, file);
      try {
        const receipts = await insertTestRunRowsWithSql(fakeSql(statement), [row('a.test.ts'), row('b.test.ts', 'pass')], context, {
          insertTimeoutMs: 20, totalInsertMs: 1_000,
        });
        expect(receipts.map(receipt => receipt.outcome)).toEqual(['timeout', 'timeout']);
        const diagnostics = receipts[0]!.insertDiagnostics;
        expect(diagnostics).toMatchObject({ backendPid: 1198083, settledAt: null, settledElapsedMs: null });
        expect(receipts[1]?.insertDiagnostics).toEqual(diagnostics);
        appendTestRunReceipts(process.env, receipts);
        vi.stubEnv(TEST_RUN_RECEIPT_ENV, otherFile);
        resolveInsert([{ id: '902', file_path: 'b.test.ts' }, { id: '901', file_path: 'a.test.ts' }]);
        await vi.waitFor(() => {
          expect(readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)).slice(2)).toMatchObject([
            { filePath: 'a.test.ts', status: 'fail', outcome: 'inserted', id: '901' },
            { filePath: 'b.test.ts', status: 'pass', outcome: 'inserted', id: '902' },
          ]);
        });
        const late = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(late[2].insertDiagnostics).toMatchObject({
          statementId: diagnostics!.statementId, backendPid: 1198083, settledAt: expect.any(String),
        });
        expect(late[2].insertDiagnostics.settledElapsedMs).toBeGreaterThanOrEqual(diagnostics!.elapsedMs);
        expect(diagnostics?.settledAt).toBeNull(); // The timeout remains an immutable observation.
        expect(late[3].insertDiagnostics).toEqual(late[2].insertDiagnostics);
        expect(readFileSync(file, 'utf8')).not.toContain('987654321');
        expect(statement).toHaveBeenCalledTimes(1);
        expect(() => readFileSync(otherFile, 'utf8')).toThrow();
      } finally {
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('records a late rejection after the foreground timeout without an unhandled rejection', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'test-run-late-rejection-'));
      const file = join(dir, 'receipts.jsonl');
      let rejectInsert!: (error: Error) => void;
      const statement = vi.fn(() => new Promise((_resolve, reject) => { rejectInsert = reject; }));
      vi.stubEnv(TEST_RUN_RECEIPT_ENV, file);
      try {
        const receipts = await insertTestRunRowsWithSql(fakeSql(statement), [row('a.test.ts')], context, {
          insertTimeoutMs: 20, totalInsertMs: 1_000,
        });
        expect(receipts[0]?.outcome).toBe('timeout');
        rejectInsert(new Error('connection closed after timeout'));
        await vi.waitFor(() => {
          expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
            filePath: 'a.test.ts', status: 'fail', outcome: 'failed', reason: 'connection closed after timeout',
            insertDiagnostics: { statementId: receipts[0]?.insertDiagnostics?.statementId,
              backendPid: null, settledAt: expect.any(String), settledElapsedMs: expect.any(Number) },
          });
        });
        expect(statement).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('marks a returned row set that omits a file as failed, never as inserted', async () => {
      const sql = fakeSql(async () => []);
      const receipts = await insertTestRunRowsWithSql(sql, [row('a.test.ts')], context);
      expect(receipts).toMatchObject([
        { filePath: 'a.test.ts', status: 'fail', outcome: 'failed', reason: 'insert_returned_no_id' },
      ]);
    });

    it('appends receipts as JSON lines only when the receipt file is named', () => {
      const dir = mkdtempSync(join(tmpdir(), 'test-run-receipts-'));
      try {
        const file = join(dir, 'receipts.jsonl');
        const receiptRow = row('a.test.ts');
        const receipt: TestRunReceipt = {
          receiptId: 'receipt-a', attempt: 0, filePath: 'a.test.ts', status: 'fail',
          row: { ...receiptRow, receiptId: 'receipt-a', receiptAttempt: 0,
            startedAt: receiptRow.startedAt.toISOString(), finishedAt: receiptRow.finishedAt.toISOString() },
          outcome: 'inserted', id: '7',
        };
        appendTestRunReceipts({}, [receipt]);
        expect(() => readFileSync(file, 'utf8')).toThrow();
        appendTestRunReceipts({ [TEST_RUN_RECEIPT_ENV]: file }, [receipt, { ...receipt, id: '8' }]);
        expect(readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
          receipt,
          { ...receipt, id: '8' },
        ]);
        // Fail-soft: an unwritable receipt path never throws out of the reporter.
        expect(() => appendTestRunReceipts({ [TEST_RUN_RECEIPT_ENV]: join(dir, 'missing', 'x.jsonl') }, [receipt])).not.toThrow();
        const recovery = join(dir, 'recovery.jsonl');
        appendTestRunReceipts({ [TEST_RUN_RECOVERY_ENV]: recovery }, [receipt]);
        expect(JSON.parse(readFileSync(recovery, 'utf8').trim())).toEqual(receipt);
        expect(reporterWriteBudget({ [TEST_RUN_RECOVERY_ENV]: recovery })).toEqual(reporterWriteBudget({}));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    describe('configuration_snapshot column (P-011, migration 1448)', () => {
      const missingColumn = () => Object.assign(
        new Error('column "configuration_snapshot" of relation "test_runs" does not exist'),
        { code: '42703' },
      );
      /**
       * A fake client that records each bulk helper's column list and rows, and runs
       * `onStatement` with the columns of the helper interpolated into that statement.
       */
      const recordingSql = (onStatement: (columns: readonly unknown[]) => Promise<unknown> | null) => {
        const helpers: Array<{ columns: readonly unknown[]; rows: Record<string, unknown>[] }> = [];
        let statements = 0;
        const sql = Object.assign(
          (first: unknown, ...values: unknown[]) => {
            if (Array.isArray(first) && !('raw' in (first as object))) {
              const helper = { columns: values, rows: [...(first as Record<string, unknown>[])] };
              helpers.push(helper);
              return helper;
            }
            statements += 1;
            const helper = values[0] as { columns: readonly unknown[]; rows: Record<string, unknown>[] };
            return onStatement(helper.columns)
              ?? Promise.resolve(helper.rows.map((r, i) => ({ id: `${statements}-${i}`, file_path: r.file_path })));
          },
          { end: async () => undefined },
        ) as unknown as PgSql;
        return { sql, helpers, statements: () => statements };
      };

      it('writes the process snapshot as an OBJECT into the configuration_snapshot column', async () => {
        const snapshot = captureConfigurationSnapshot({ PAPERCUSP_FLAG_VIDEO_CHANNELS: '1', NODE_ENV: 'test' });
        const fake = recordingSql(() => null);
        const receipts = await insertTestRunRowsWithSql(fake.sql, [row('a.test.ts')], {
          ...context, configurationSnapshot: snapshot,
        });
        expect(receipts.map((r) => r.outcome)).toEqual(['inserted']);
        expect(fake.helpers[0].columns).toContain('configuration_snapshot');
        expect(typeof fake.helpers[0].rows[0].configuration_snapshot).toBe('object');
        expect(fake.helpers[0].rows[0].configuration_snapshot).toEqual(snapshot);
      });

      it('retries the same batch, and every later one, without the column on a ledger that predates 1448', async () => {
        const fake = recordingSql((columns) => (
          columns.includes('configuration_snapshot') ? Promise.reject(missingColumn()) : null
        ));
        const rows = Array.from({ length: TEST_RUN_INSERT_BATCH_SIZE + 1 }, (_, i) => row(`f-${i}.test.ts`));
        const receipts = await insertTestRunRowsWithSql(fake.sql, rows, {
          ...context, configurationSnapshot: captureConfigurationSnapshot({}),
        }, { insertTimeoutMs: 1_000, totalInsertMs: 5_000 });

        expect(receipts).toHaveLength(rows.length);
        expect(receipts.every((r) => r.outcome === 'inserted')).toBe(true);
        // One refused attempt, then the same first batch and the second batch without the column.
        expect(fake.statements()).toBe(3);
        expect(fake.helpers.map((h) => h.columns.includes('configuration_snapshot'))).toEqual([true, false, false]);
        expect(fake.helpers.map((h) => h.rows.length)).toEqual([TEST_RUN_INSERT_BATCH_SIZE, TEST_RUN_INSERT_BATCH_SIZE, 1]);
      });

      it('does not retry an undefined-column error that names a different column', async () => {
        const other = Object.assign(new Error('column "rss_mb" of relation "test_runs" does not exist'), { code: '42703' });
        const fake = recordingSql(() => Promise.reject(other));
        const receipts = await insertTestRunRowsWithSql(fake.sql, [row('a.test.ts')], context, {
          insertTimeoutMs: 1_000, totalInsertMs: 1_000,
        });
        expect(fake.statements()).toBe(1);
        expect(receipts).toMatchObject([
          { filePath: 'a.test.ts', status: 'fail', outcome: 'failed', reason: other.message },
        ]);
      });

      it('recognizes only Postgres 42703 errors that name configuration_snapshot', () => {
        expect(isMissingConfigurationSnapshotColumn(missingColumn())).toBe(true);
        expect(isMissingConfigurationSnapshotColumn({ code: '42703', message: 'column "rss_mb" does not exist' })).toBe(false);
        expect(isMissingConfigurationSnapshotColumn({ code: '42P01', message: 'configuration_snapshot' })).toBe(false);
        expect(isMissingConfigurationSnapshotColumn(null)).toBe(false);
        expect(isMissingConfigurationSnapshotColumn('configuration_snapshot')).toBe(false);
      });
    });

    it('keeps the 1s fail-soft budget for ordinary runs and widens it only for evidence runs', () => {
      expect(reporterWriteBudget({})).toEqual({
        connectTimeoutSec: 1, insertTimeoutMs: 1_000, totalInsertMs: 4_500, flushBudgetMs: 5_000,
      });
      const evidence = reporterWriteBudget({ [TEST_RUN_RECEIPT_ENV]: '/tmp/r.jsonl' });
      expect(evidence.insertTimeoutMs).toBeGreaterThan(1_000);
      expect(evidence.flushBudgetMs).toBe(5_000);
      expect(evidence.flushBudgetMs).toBeLessThan(10_000);
      expect(evidence.totalInsertMs).toBeGreaterThan(evidence.flushBudgetMs);
    });
  });

  it('records mutation-probe modules with their explicit phase metadata', async () => {
    const previousProbe = process.env.PAPERCUSP_MUTATION_PROBE;
    const previousPhase = process.env.PAPERCUSP_MUTATION_PHASE;
    process.env.PAPERCUSP_MUTATION_PROBE = '1';
    process.env.PAPERCUSP_MUTATION_PHASE = 'mutant';
    const rows: TestRunRow[] = [];
    try {
      const r = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }),
        async row => { rows.push(row); });
      const fakeModule = {
        state: () => 'failed',
        children: { allTests: () => [{ result: () => ({ state: 'failed' }) }] },
        moduleId: join(TEST_CONFIG_ROOT, 'src/admin-test-runs-reporter.test.ts'),
        diagnostic: () => ({ duration: 1 }), errors: () => [],
      } as unknown as Parameters<typeof r.onTestModuleEnd>[0];
      await r.onInit({ config: { root: TEST_CONFIG_ROOT }, vite: { config: { root: TEST_CONFIG_ROOT } } } as never);
      expect(() => r.onTestModuleEnd(fakeModule)).not.toThrow();
      await r.onTestRunEnd();
      expect(rows).toHaveLength(1);
      expect(rows[0].executionDetails).toMatchObject({ mutationPhase: 'mutant', failed: 1 });
      expect(resolveMutationProbePhase()).toBe('mutant');
    } finally {
      if (previousProbe === undefined) delete process.env.PAPERCUSP_MUTATION_PROBE;
      else process.env.PAPERCUSP_MUTATION_PROBE = previousProbe;
      if (previousPhase === undefined) delete process.env.PAPERCUSP_MUTATION_PHASE;
      else process.env.PAPERCUSP_MUTATION_PHASE = previousPhase;
    }
  });

  it('recognizes only the explicit mutation-probe marker', () => {
    const previous = process.env.PAPERCUSP_MUTATION_PROBE;
    try {
      delete process.env.PAPERCUSP_MUTATION_PROBE;
      expect(isMutationProbeRun()).toBe(false);
      process.env.PAPERCUSP_MUTATION_PROBE = '1';
      expect(isMutationProbeRun()).toBe(true);
      process.env.PAPERCUSP_MUTATION_PROBE = '0';
      expect(isMutationProbeRun()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_MUTATION_PROBE;
      else process.env.PAPERCUSP_MUTATION_PROBE = previous;
    }
  });

  it('captures the reporter saturation fields used by harness_shared.test_runs', () => {
    const previous = process.env.PAPERCUSP_RESOURCE_GOVERNOR_HEALTH_DIR;
    process.env.PAPERCUSP_RESOURCE_GOVERNOR_HEALTH_DIR = '/tmp/papercusp-no-live-health-for-test';
    const snap = captureReporterSaturationSnapshot();
    try {
      expect(snap.rssMb).toEqual(expect.any(Number));
      // No host snapshot at this path: absence remains an explicit unknown.
      expect(snap.loopLagP95Ms).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_RESOURCE_GOVERNOR_HEALTH_DIR;
      else process.env.PAPERCUSP_RESOURCE_GOVERNOR_HEALTH_DIR = previous;
    }
  });

  it('accepts only a fresh measured host snapshot for loop-lag attribution', () => {
    const measured = {
      sampledAtMs: 10_000,
      signals: {
        'latency.eventLoopP95Ms': {
          state: 'measured', value: 323.5, unit: 'milliseconds', observedAtMs: 9_500,
        },
      },
    };
    expect(resolveReporterHostLoopLag(measured, 10_000)).toBe(323.5);
    expect(resolveReporterHostLoopLag({
      ...measured,
      sampledAtMs: 1,
      signals: {
        'latency.eventLoopP95Ms': {
          ...measured.signals['latency.eventLoopP95Ms'],
          observedAtMs: 1,
        },
      },
    }, 30_000)).toBeNull();
    expect(resolveReporterHostLoopLag({ ...measured, signals: { 'latency.eventLoopP95Ms': { ...measured.signals['latency.eventLoopP95Ms'], state: 'unknown' } } }, 10_000)).toBeNull();
    expect(resolveReporterHostLoopLag({ ...measured, signals: { 'latency.eventLoopP95Ms': { ...measured.signals['latency.eventLoopP95Ms'], unit: 'percent' } } }, 10_000)).toBeNull();
  });

  it('does not record retired, scratch, or sibling-checkout test paths', () => {
    expect(shouldRecordTestRunPath('_retired/snapshot-system/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('libs/papercusp/_retired/orchestrator-run-loop/src/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('.papercusp/scratch/tdg-123/src/x.test.tsx')).toBe(false);
    expect(shouldRecordTestRunPath('apps/operator/.papercusp/scratch/tdg-123/src/x.test.tsx')).toBe(false);
    expect(shouldRecordTestRunPath('papercupai-workspace/papercup-checkpoint/apps/operator/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('papercupai-workspace/papercusp-checkpoint/apps/operator/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('papercupai-workspace/papercup-staging/apps/operator/x.test.ts')).toBe(false);
    // The parent workspace dirname is installation-specific; classify the
    // preserved checkout by its own basename instead of this box's root.
    expect(shouldRecordTestRunPath('custom-install/papercup-checkpoint/apps/operator/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('custom-install/papercusp-checkpoint/apps/operator/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('custom-install/papercup-staging/apps/operator/x.test.ts')).toBe(false);
    // `*.flakeproof.test.{ts,tsx}` — reserved flake-soak self-test scratch fixtures,
    // intended REDs, never committed (EI-10761 — a red-test EI on a non-existent file).
    expect(shouldRecordTestRunPath('apps/operator-vite/src/components/left-sidebar/MugTab.flakeproof.test.tsx')).toBe(false);
    expect(shouldRecordTestRunPath('src/x.flakeproof.test.ts')).toBe(false);
    // Cargo/Tauri BUILD-ARTIFACT copies of template checks — the sidecar build
    // copies `templates/<id>/checks/*.test.ts` (which import
    // `@papercusp/template-kit`) into a gitignored cargo target dir where
    // node_modules are NOT linked, so every copy reds with "Cannot find package
    // '@papercusp/template-kit'". Never a source regression (EI-11176).
    expect(shouldRecordTestRunPath('.wi3388-cargo-target/debug/sidecar/templates/papercusp-webapp/checks/composition-integrity.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('papercusp-desktop/src-tauri/target/debug/sidecar/templates/papercusp-webapp/checks/composition-integrity.test.ts')).toBe(false);
    // Cross-target and sidecar-specific Cargo profiles do not put `debug` or
    // `release` immediately below target/, so the narrower profile regex above
    // must not be the only guard. This is the relocated target symlink shape
    // that produced the phantom macOS bundle failures (EI-20206285706779155).
    expect(
      shouldRecordTestRunPath(
        'papercusp-desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Papercusp GUI.app/Contents/Resources/sidecar/templates/papercusp-webapp/checks/composition-integrity.test.ts',
      ),
    ).toBe(false);
    expect(
      shouldRecordTestRunPath(
        'papercusp-desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Papercusp Server.app/Contents/Resources/sidecar/templates/papercusp-desktop-app/checks/composition-integrity.test.ts',
      ),
    ).toBe(false);
    expect(
      shouldRecordTestRunPath(
        'papercusp-desktop/src-tauri/target/darwin-sidecar/templates/papercusp-agentic-desktop-app/checks/composition-integrity.test.ts',
      ),
    ).toBe(false);
    // …but the real SOURCE copies of those same checks still record.
    expect(shouldRecordTestRunPath('templates/papercusp-webapp/checks/composition-integrity.test.ts')).toBe(true);
    expect(shouldRecordTestRunPath('packages/operator-core/lib/testing-orphan-runs.test.ts')).toBe(true);
  });

  it('does not record a path that resolves outside the workspace root (WI-5183)', () => {
    // toWorkspaceRel('/tmp/fake.test.ts') → '../../../../tmp/fake.test.ts' — exactly
    // the moduleId THIS test file's own fixtures above use ('/tmp/fake.test.ts').
    // Never a real repo file; must not be recorded as a flakiness signal.
    expect(shouldRecordTestRunPath('../../../../tmp/fake.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('../outside-repo.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('..\\windows-outside.test.ts')).toBe(false);
  });

  it('buildOutputTail captures failed TEST-CASE errors when the module has no top-level errors', () => {
    const fakeModule = {
      moduleId: '/tmp/fake.test.ts',
      state: () => 'failed',
      errors: () => [],
      children: {
        allTests: () => [
          {
            fullName: 'suite > passes',
            result: () => ({ state: 'passed', errors: [] }),
          },
          {
            fullName: 'suite > fails',
            result: () => ({ state: 'failed', errors: [{ message: 'expected 1 to be 2' }] }),
          },
        ],
      },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    const tail = buildOutputTail(fakeModule, 'fail');
    expect(tail).toBe('suite > fails: expected 1 to be 2');
  });

  it('redacts inherited credential values before reporter tail and sidecar clipping', async () => {
    const secret = 'r'.repeat(48);
    const previousKey = process.env.PAPERCUSP_API_KEY;
    const previousDetailsPath = process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-reporter-secret-redaction-'));
    const detailsPath = join(dir, 'failure-details.json');
    process.env.PAPERCUSP_API_KEY = secret;
    process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH = detailsPath;
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }), async () => undefined);
    const tailMessage = `${'x'.repeat(995)}${secret}${'y'.repeat(5000 - 995 - secret.length)}`;
    const sidecarActual = `${'x'.repeat(1990)}${secret}${'y'.repeat(80)}`;
    const failure = { message: tailMessage, actual: sidecarActual, expected: 'expected value' };
    const module = {
      moduleId: join(TEST_CONFIG_ROOT, 'src/secret-redaction.test.ts'),
      state: () => 'failed',
      diagnostic: () => ({ duration: 1 }),
      errors: () => [],
      children: { allTests: () => [{ fullName: 'suite > leaks no key', result: () => ({ state: 'failed', errors: [failure] }) }] },
    };
    try {
      await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
      const outputTail = buildOutputTail(module as never, 'fail')!;
      expect(outputTail).toContain('[redacted]');
      expect(outputTail).not.toContain(secret.slice(5));
      expect(redactSensitiveText(`inherited=${secret}`)).toBe('inherited=[redacted]');

      reporter.onTestModuleEnd(module as never);
      await reporter.onTestRunEnd();
      const sidecar = JSON.parse(readFileSync(detailsPath, 'utf8')) as {
        failures: Array<{ actual?: string }>;
      };
      // Redaction precedes the 2,000-character diagnostic budget, including its
      // ellipsis. The marker itself can cross that budget; the secret cannot.
      expect(sidecar.failures[0]?.actual).toBe(`${'x'.repeat(1990)}[redacted…`);
      expect(sidecar.failures[0]?.actual).toHaveLength(2000);
      expect(readFileSync(detailsPath, 'utf8')).not.toContain(secret);
    } finally {
      if (previousKey === undefined) delete process.env.PAPERCUSP_API_KEY;
      else process.env.PAPERCUSP_API_KEY = previousKey;
      if (previousDetailsPath === undefined) delete process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH;
      else process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH = previousDetailsPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formats TestCase.result errors with bounded actual and expected values', () => {
    const error = {
      message: 'expected object to match',
      actual: '{ service_select: false }',
      expected: '{ service_select: true }',
    };
    expect(formatTestCaseError(error)).toBe(
      'expected object to match\nactual: { service_select: false }\nexpected: { service_select: true }',
    );
    const fakeModule = {
      state: () => 'failed',
      errors: () => [],
      children: { allTests: () => [{ fullName: 'suite > fails', result: () => ({ state: 'failed', errors: [error] }) }] },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    expect(buildOutputTail(fakeModule, 'fail')).toContain('actual: { service_select: false }');
    expect(buildOutputTail(fakeModule, 'fail')).toContain('expected: { service_select: true }');
  });

  it('persists completed-module diagnostics before finalization and merges reporter groups', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-reporter-details-'));
    const detailsPath = join(dir, 'failure-details.json');
    const previous = process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH;
    process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH = detailsPath;
    const writeRow = vi.fn(async () => undefined);
    const makeReporter = () =>
      new AdminTestRunsReporter(
        async () => ({ commit: 'abc', porcelain: '' }),
        writeRow,
      );
    const makeModule = (file: string, test: string, actual: string, expected: string) => ({
      moduleId: join(TEST_CONFIG_ROOT, file),
      state: () => 'failed',
      diagnostic: () => ({ duration: 1 }),
      errors: () => [],
      children: {
        allTests: () => [{ fullName: test, result: () => ({ state: 'failed', errors: [{ message: 'diff', actual, expected }] }) }],
      },
    });
    try {
      const first = makeReporter();
      await first.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
      first.onTestModuleEnd(makeModule('src/first.test.ts', 'first', 'actual-a', 'expected-a') as never);
      // A hard-killed run reaches neither final hook. Its completed failures
      // must already be readable synchronously; the interim ledger write is
      // asynchronous (it waits for its own snapshot), pinned separately below.
      expect(JSON.parse(readFileSync(detailsPath, 'utf8')).failures).toEqual([
        expect.objectContaining({ test: 'first', actual: 'actual-a', expected: 'expected-a' }),
      ]);
      expect(writeRow).not.toHaveBeenCalled();
      await first.onTestRunEnd();

      const second = makeReporter();
      await second.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
      second.onTestModuleEnd(makeModule('src/second.test.ts', 'second', 'actual-b', 'expected-b') as never);
      expect(JSON.parse(readFileSync(detailsPath, 'utf8')).failures).toHaveLength(2);
      await second.onTestRunEnd();

      const payload = JSON.parse(readFileSync(detailsPath, 'utf8')) as {
        failures: Array<{ file: string; test: string; actual?: string; expected?: string }>;
      };
      expect(payload.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ file: expect.stringMatching(/(?:^|\/)src\/first\.test\.ts$/), test: 'first', actual: 'actual-a', expected: 'expected-a' }),
        expect.objectContaining({ file: expect.stringMatching(/(?:^|\/)src\/second\.test\.ts$/), test: 'second', actual: 'actual-b', expected: 'expected-b' }),
      ]));
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH;
      else process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('EI-26701962157024953: persists failures before final hooks and drains failures arriving during a write', async () => {
    const writes: Array<Array<{ filePath: string; status: string; worktreeDirty: boolean; commitSha: string | null }>> = [];
    let release: () => void = () => undefined;
    const writeRows = vi.fn(async (rows: Array<{ filePath: string; status: string; worktreeDirty: boolean; commitSha: string | null }>) => {
      writes.push(rows.map(({ filePath, status, worktreeDirty, commitSha }) => ({ filePath, status, worktreeDirty, commitSha })));
      // Hold the first interim write open so a second failure arrives mid-write.
      if (writes.length === 1) await new Promise<void>(r => { release = r; });
    });
    const reporter = new AdminTestRunsReporter(
      async () => ({ commit: 'abc', porcelain: '' }),
      undefined,
      writeRows as never,
    );
    const makeModule = (file: string, state: 'passed' | 'failed') => ({
      moduleId: join(TEST_CONFIG_ROOT, file),
      state: () => state,
      diagnostic: () => ({ duration: 1 }),
      errors: () => [],
      children: { allTests: () => [{ fullName: file, result: () => ({ state, errors: [] }) }] },
    });
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
    await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);

    reporter.onTestModuleEnd(makeModule('src/passes.test.ts', 'passed') as never);
    reporter.onTestModuleEnd(makeModule('src/fails-a.test.ts', 'failed') as never);
    await settle();
    // The failure is persisted with no final hook at all, stamped by its own snapshot.
    expect(writes).toEqual([[expect.objectContaining({
      filePath: expect.stringMatching(/fails-a\.test\.ts$/), status: 'fail', worktreeDirty: false, commitSha: 'abc' })]]);

    reporter.onTestModuleEnd(makeModule('src/fails-b.test.ts', 'failed') as never);
    release();
    await settle();
    // The follow-up batch picks up the failure that arrived during the first write.
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual([expect.objectContaining({ filePath: expect.stringMatching(/fails-b\.test\.ts$/), status: 'fail' })]);
    // A SIGKILL here loses only the pass: it was never written, so it never claims proof.
    expect(writes.flat().some(row => row.status === 'pass')).toBe(false);

    // A run that does finish writes the remaining pass exactly once and no failure twice.
    await reporter.onTestRunEnd();
    expect(writes).toHaveLength(3);
    expect(writes[2]).toEqual([expect.objectContaining({ filePath: expect.stringMatching(/passes\.test\.ts$/), status: 'pass' })]);
  });

  it('EI-26701962157024953: failure receipts and diagnostics survive an actual SIGKILL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reporter-sigkill-'));
    const ledgerPath = join(dir, 'ledger.json');
    const detailsPath = join(dir, 'failure-details.json');
    const exitPath = join(dir, 'exit-hook');
    const require = createRequire(import.meta.url);
    const program = `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const { default: Reporter } = await import(${JSON.stringify(new URL('./admin-test-runs-reporter.ts', import.meta.url).href)});
      process.on('exit', () => writeFileSync(${JSON.stringify(exitPath)}, 'exit'));
      const reporter = new Reporter(async () => ({ commit: 'abc', porcelain: '' }), undefined, async rows => {
        writeFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify(rows));
        process.kill(process.pid, 'SIGKILL');
      });
      await reporter.onInit({ vite: { config: { root: ${JSON.stringify(TEST_CONFIG_ROOT)}, configFile: join(${JSON.stringify(TEST_CONFIG_ROOT)}, 'vitest.config.ts') } } });
      const module = (file, state) => ({ moduleId: join(${JSON.stringify(TEST_CONFIG_ROOT)}, 'src', file),
        state: () => state, diagnostic: () => ({ duration: 1 }), errors: () => [],
        children: { allTests: () => [{ fullName: file, result: () => ({ state,
          errors: state === 'failed' ? [{ message: 'expected result', actual: 'actual', expected: 'expected' }] : [] }) }] } });
      reporter.onTestModuleEnd(module('surviving-pass.test.ts', 'passed'));
      reporter.onTestModuleEnd(module('surviving-failure.test.ts', 'failed'));
      setInterval(() => {}, 1_000);
    `;
    try {
      const result = await promisify(execFile)(process.execPath,
        ['--import', require.resolve('tsx'), '--input-type=module', '-e', program], {
          // Match Vitest's worker: exercise the working source under test. The
          // router's parent-only committed-source preload would substitute HEAD.
          timeout: 15_000, env: { ...process.env, NODE_OPTIONS: '', PAPERCUSP_TEST_FAILURE_DETAILS_PATH: detailsPath },
        }).then(() => ({ signal: null, stderr: '' }), error => error as { signal: string | null; stderr: string });
      expect(result.signal, result.stderr).toBe('SIGKILL');
      expect(existsSync(exitPath)).toBe(false);
      expect(JSON.parse(readFileSync(ledgerPath, 'utf8'))).toEqual([
        expect.objectContaining({ filePath: expect.stringMatching(/surviving-failure\.test\.ts$/),
          status: 'fail', commitSha: 'abc', worktreeDirty: false }),
      ]);
      expect(JSON.parse(readFileSync(detailsPath, 'utf8')).failures).toEqual([
        expect.objectContaining({ test: 'surviving-failure.test.ts', actual: 'actual', expected: 'expected' }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([false, true])('awaits final provenance beyond the SQL budget and preserves dirty=%s with a fresh bounded write', async dirty => {
    let releaseSnapshot: (value: { commit: string; porcelain: string }) => void = () => undefined;
    let releaseWrite: () => void = () => undefined;
    const writeRows = vi.fn(async (_rows: readonly TestRunRow[]) => {
      await new Promise<void>(resolve => { releaseWrite = resolve; });
    });
    const reporter = new AdminTestRunsReporter(async phase => phase === 'before'
      ? { commit: 'abc', porcelain: '' }
      : new Promise(resolve => { releaseSnapshot = resolve; }), undefined, writeRows);
    await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
    vi.useFakeTimers();
    let final: Promise<void> | undefined;
    try {
      reporter.onTestModuleEnd({ moduleId: join(TEST_CONFIG_ROOT, 'src/final-provenance.test.ts'),
        state: () => 'passed', diagnostic: () => ({ duration: 1 }), errors: () => [],
        children: { allTests: () => [] } } as never);
      let finished = false;
      final = reporter.onTestRunEnd().then(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(reporterWriteBudget(process.env).flushBudgetMs * 3);
      expect(finished).toBe(false);
      expect(writeRows).not.toHaveBeenCalled();
      releaseSnapshot({ commit: 'abc', porcelain: dirty ? ' M source.ts' : '' });
      await vi.advanceTimersByTimeAsync(0);
      expect(writeRows).toHaveBeenCalledTimes(1);
      expect(writeRows.mock.calls[0][0][0]).toMatchObject({ status: 'pass', commitSha: 'abc', worktreeDirty: dirty });
      const budget = reporterWriteBudget(process.env);
      await vi.advanceTimersByTimeAsync(Math.max(budget.flushBudgetMs, budget.totalInsertMs) - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      // The reporter then gives the tracked writer one bounded shared-client drain
      // before releasing its lease. Advance that timer too; otherwise this test
      // waits on the fake clock it owns while deliberately holding writeRows open.
      await vi.advanceTimersByTimeAsync(SHARED_PG_DRAIN_TIMEOUT_MS);
      await final;
      expect(finished).toBe(true);
      releaseWrite();
      await reporter.onExit();
      expect(writeRows).toHaveBeenCalledTimes(1);
    } finally {
      releaseSnapshot({ commit: 'abc', porcelain: '' });
      releaseWrite();
      await vi.runAllTimersAsync();
      await final;
      vi.useRealTimers();
    }
  });

  it.each([false, true])('awaits complete mutation failure provenance beyond the SQL budget and preserves dirty=%s', async dirty => {
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '1');
    vi.stubEnv('PAPERCUSP_MUTATION_PHASE', 'mutant');
    vi.stubEnv('PAPERCUSP_MUTATION_DESCRIPTOR', MUTATION_FINALIZATION_DESCRIPTOR);
    let releaseSnapshot: (value: { commit: string; porcelain: string }) => void = () => undefined;
    const writeRows = vi.fn(async (_rows: readonly TestRunRow[]) => undefined);
    const reporter = new AdminTestRunsReporter(async phase => phase === 'before'
      ? { commit: 'abc', porcelain: '' }
      : new Promise(resolve => { releaseSnapshot = resolve; }), undefined, writeRows);
    await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
    vi.useFakeTimers();
    let final: Promise<void> | undefined;
    try {
      reporter.onTestModuleEnd({ moduleId: join(TEST_CONFIG_ROOT, 'src/mutation-provenance.test.ts'),
        state: () => 'failed', diagnostic: () => ({ duration: 1 }), errors: () => [],
        children: { allTests: () => [{ fullName: 'mutant is caught', result: () => ({ state: 'failed' }) }] } } as never);
      await vi.advanceTimersByTimeAsync(reporterWriteBudget(process.env).flushBudgetMs * 3);
      expect(writeRows).not.toHaveBeenCalled();
      let finished = false;
      final = reporter.onTestRunEnd().then(() => { finished = true; });
      let exited = false;
      const exit = reporter.onExit().then(() => { exited = true; });
      await vi.advanceTimersByTimeAsync(reporterWriteBudget(process.env).flushBudgetMs * 3);
      expect(finished).toBe(false);
      expect(exited).toBe(false);
      expect(writeRows).not.toHaveBeenCalled();
      releaseSnapshot({ commit: 'abc', porcelain: dirty ? ' M source.ts' : '' });
      await vi.advanceTimersByTimeAsync(0);
      await final;
      await exit;
      expect(finished).toBe(true);
      expect(exited).toBe(true);
      expect(writeRows).toHaveBeenCalledTimes(1);
      expect(writeRows.mock.calls[0][0]).toEqual([expect.objectContaining({
        status: 'fail', commitSha: 'abc', worktreeDirty: dirty,
        executionDetails: expect.objectContaining({ failed: 1, mutationPhase: 'mutant',
          commitSha: 'abc', worktreeDirty: dirty }),
      })]);
      await reporter.onExit();
      expect(writeRows).toHaveBeenCalledTimes(1);
    } finally {
      releaseSnapshot({ commit: 'abc', porcelain: '' });
      await vi.runAllTimersAsync();
      await final;
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { name: 'missing descriptor', descriptor: undefined, phase: 'mutant', beforePorcelain: '' },
    { name: 'malformed descriptor', descriptor: '{invalid', phase: 'mutant', beforePorcelain: '' },
    { name: 'failed calibration', descriptor: MUTATION_FINALIZATION_DESCRIPTOR, phase: 'baseline', beforePorcelain: '' },
    { name: 'dirty initial source', descriptor: MUTATION_FINALIZATION_DESCRIPTOR, phase: 'mutant', beforePorcelain: ' M source.ts' },
  ])('keeps unqualified mutation failure bounded ($name)', async ({ descriptor, phase, beforePorcelain }) => {
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '1');
    vi.stubEnv('PAPERCUSP_MUTATION_PHASE', phase);
    vi.stubEnv('PAPERCUSP_MUTATION_DESCRIPTOR', descriptor);
    let releaseSnapshot: (value: { commit: string; porcelain: string }) => void = () => undefined;
    let aborted = false;
    const writeRows = vi.fn(async (_rows: readonly TestRunRow[]) => undefined);
    const reporter = new AdminTestRunsReporter(async (phase, signal) => phase === 'before'
      ? { commit: 'abc', porcelain: beforePorcelain }
      : new Promise(resolve => {
          releaseSnapshot = resolve;
          signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
        }), undefined, writeRows);
    await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
    vi.useFakeTimers();
    let final: Promise<void> | undefined;
    try {
      reporter.onTestModuleEnd({ moduleId: join(TEST_CONFIG_ROOT, 'src/unqualified-mutation.test.ts'),
        state: () => 'failed', diagnostic: () => ({ duration: 1 }), errors: () => [],
        children: { allTests: () => [] } } as never);
      await vi.advanceTimersByTimeAsync(0);
      let finished = false;
      final = reporter.onTestRunEnd().then(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(reporterWriteBudget(process.env).flushBudgetMs + 1_000);
      expect(finished).toBe(true);
      expect(aborted).toBe(true);
      expect(writeRows).toHaveBeenCalledTimes(1);
      expect(writeRows.mock.calls[0][0]).toEqual([expect.objectContaining({
        status: 'fail', commitSha: null, worktreeDirty: true,
      })]);
    } finally {
      releaseSnapshot({ commit: 'abc', porcelain: '' });
      await vi.runAllTimersAsync();
      await final;
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('writes an inserted failure receipt before Vitest close when provenance misses the close-safe budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reporter-interim-preparation-timeout-'));
    const receiptPath = join(dir, 'receipts.jsonl');
    const previousReceiptPath = process.env[TEST_RUN_RECEIPT_ENV];
    const previousRunGroup = process.env.PAPERCUSP_TEST_RUN_GROUP;
    process.env[TEST_RUN_RECEIPT_ENV] = receiptPath;
    process.env.PAPERCUSP_TEST_RUN_GROUP = '8c1c3b18-973d-4f61-925a-411c82e08a4a';
    let reads = 0;
    let release: (value: { commit: string; porcelain: string }) => void = () => undefined;
    const writeRows = vi.fn(async (rows: readonly TestRunRow[]) => {
      appendTestRunReceipts(process.env, rows.map((row, index) => ({
        ...testRunReceiptBaseFor(row),
        outcome: 'inserted' as const,
        id: `close-safe-insert-${index + 1}`,
      })));
    });
    let aborted = false;
    const reporter = new AdminTestRunsReporter(async (_phase, signal) => ++reads === 1
      ? { commit: 'abc', porcelain: '' } : new Promise(resolve => {
        release = resolve;
        signal?.addEventListener('abort', () => { aborted = true; release({ commit: 'abc', porcelain: '' }); }, { once: true });
      }), undefined, writeRows);
    await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
    vi.useFakeTimers();
    let final: Promise<void> | undefined;
    const testFile = join(TEST_CONFIG_ROOT, 'src/interim-provenance.test.ts');
    const expectedFilePath = 'libs/test-config/src/interim-provenance.test.ts';
    try {
      reporter.onTestModuleEnd({ moduleId: testFile,
        state: () => 'failed', diagnostic: () => ({ duration: 1 }), errors: () => [],
        children: { allTests: () => [] } } as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(2);
      let finished = false;
      const closeStartedAt = Date.now();
      final = reporter.onTestRunEnd().then(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(reporterWriteBudget(process.env).flushBudgetMs + 3_000);
      expect(finished).toBe(true);
      expect(Date.now() - closeStartedAt).toBeLessThan(10_000);
      expect(aborted).toBe(true);
      expect(writeRows).toHaveBeenCalledTimes(1);
      expect(writeRows.mock.calls[0][0]).toEqual([expect.objectContaining({
        filePath: expectedFilePath,
        status: 'fail', commitSha: null, worktreeDirty: true,
        executionDetails: expect.objectContaining({ commitSha: null, worktreeDirty: true,
          worktreeDirtyReason: 'provenance preparation exceeded its close-safe budget' }),
      })]);
      const receiptLog = readFileSync(receiptPath, 'utf8');
      expect(latestTestRunReceipts(receiptLog)).toEqual(expect.arrayContaining([
        expect.objectContaining({ filePath: expectedFilePath, status: 'fail', outcome: 'inserted', id: 'close-safe-insert-1' }),
      ]));
      expect(missingTestRunReceiptPaths(receiptLog, [expectedFilePath], computeWorkspaceRootFrom(TEST_CONFIG_ROOT)))
        .toEqual([]);
      release({ commit: 'abc', porcelain: '' });
      await vi.advanceTimersByTimeAsync(0);
      await final;
      expect(writeRows).toHaveBeenCalledTimes(1);
      await reporter.onExit();
      expect(writeRows).toHaveBeenCalledTimes(1);
    } finally {
      release({ commit: 'abc', porcelain: '' });
      await vi.runAllTimersAsync();
      await final;
      vi.useRealTimers();
      if (previousReceiptPath === undefined) delete process.env[TEST_RUN_RECEIPT_ENV];
      else process.env[TEST_RUN_RECEIPT_ENV] = previousReceiptPath;
      if (previousRunGroup === undefined) delete process.env.PAPERCUSP_TEST_RUN_GROUP;
      else process.env.PAPERCUSP_TEST_RUN_GROUP = previousRunGroup;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains timed-out preparation ownership until a noncooperative reader actually settles', async () => {
    let reads = 0;
    let release: (value: { commit: string; porcelain: string }) => void = () => undefined;
    const writeRows = vi.fn(async (_rows: readonly TestRunRow[]) => {});
    const reporter = new AdminTestRunsReporter(async () => ++reads === 2
      ? new Promise(resolve => { release = resolve; }) : { commit: 'abc', porcelain: '' }, undefined, writeRows);
    await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
    const module = (file: string) => ({ moduleId: join(TEST_CONFIG_ROOT, file), state: () => 'failed',
      diagnostic: () => ({ duration: 1 }), errors: () => [], children: { allTests: () => [] } });
    vi.useFakeTimers();
    try {
      reporter.onTestModuleEnd(module('first-reader.test.ts') as never);
      await vi.advanceTimersByTimeAsync(reporterWriteBudget(process.env).flushBudgetMs);
      expect(reads).toBe(2);
      expect(writeRows).toHaveBeenCalledTimes(1);
      reporter.onTestModuleEnd(module('queued-reader.test.ts') as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(2);
      expect(writeRows).toHaveBeenCalledTimes(1);
      release({ commit: 'abc', porcelain: '' });
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(3);
      expect(writeRows).toHaveBeenCalledTimes(2);
      expect(writeRows.mock.calls[1][0][0]).toMatchObject({ filePath: expect.stringMatching(/queued-reader\.test\.ts$/),
        status: 'fail', commitSha: 'abc', worktreeDirty: false });
      await reporter.onTestRunEnd();
      await reporter.onExit();
      expect(writeRows).toHaveBeenCalledTimes(2);
    } finally {
      release({ commit: 'abc', porcelain: '' });
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await reporter.onExit();
    }
  });

  it('keeps one receipt identity across the outer flush timeout and late SQL acknowledgement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reporter-flush-receipt-identity-'));
    const receiptPath = join(dir, 'receipts.jsonl');
    const previous = process.env[TEST_RUN_RECEIPT_ENV];
    process.env[TEST_RUN_RECEIPT_ENV] = receiptPath;
    let release: () => void = () => undefined;
    let writtenFile = '';
    const statement = vi.fn(() => new Promise(resolve => {
      release = () => resolve([{ id: 'late-file-row', file_path: writtenFile }]);
    }));
    const sql = ((strings: TemplateStringsArray | unknown[]) =>
      Object.hasOwn(strings, 'raw') ? statement() : strings) as unknown as PgSql;
    const flushMs = reporterWriteBudget(process.env).flushBudgetMs;
    const writeRows = vi.fn(async (rows: readonly TestRunRow[]) => {
      writtenFile = rows[0]!.filePath;
      const receipts = await insertTestRunRowsWithSql(sql, rows, {
        branch: 'staging', inferredCommit: null, declaredSource: 'local', runGroupId: 'late-group',
        harnessSlug: 'test-config', workspaceId: null, loopLagP95Ms: null, rssMb: null,
      }, { insertTimeoutMs: flushMs * 2, totalInsertMs: flushMs * 3 });
      appendTestRunReceipts(process.env, receipts);
    });
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }), undefined, writeRows);
    await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
    vi.useFakeTimers();
    try {
      reporter.onTestModuleEnd({
        moduleId: join(TEST_CONFIG_ROOT, 'src/slow-ledger.test.ts'), state: () => 'failed',
        diagnostic: () => ({ duration: 1 }), errors: () => [], children: { allTests: () => [] },
      } as never);
      await vi.advanceTimersByTimeAsync(flushMs);
      const timedOut = latestTestRunReceipts(readFileSync(receiptPath, 'utf8'));
      expect(timedOut).toHaveLength(1);
      expect(timedOut[0]).toMatchObject({ outcome: 'timeout', reason: `flush_budget_${flushMs}ms` });
      release();
      await vi.advanceTimersByTimeAsync(0);
      const log = readFileSync(receiptPath, 'utf8');
      const history = log.trim().split('\n').map(line => JSON.parse(line) as TestRunReceipt);
      expect(history.map(receipt => receipt.receiptId)).toEqual([timedOut[0]!.receiptId, timedOut[0]!.receiptId]);
      expect(latestTestRunReceipts(log, true)).toEqual([
        expect.objectContaining({ receiptId: timedOut[0]!.receiptId, outcome: 'inserted', id: 'late-file-row' }),
      ]);
      expect(statement).toHaveBeenCalledTimes(1);
      expect(writeRows).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await reporter.onTestRunEnd();
      await reporter.onExit();
      if (previous === undefined) delete process.env[TEST_RUN_RECEIPT_ENV];
      else process.env[TEST_RUN_RECEIPT_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('EI-26701962157024953: a timed-out interim writer never overlaps final persistence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reporter-interim-timeout-'));
    const receiptPath = join(dir, 'receipts.jsonl');
    const previous = process.env[TEST_RUN_RECEIPT_ENV];
    process.env[TEST_RUN_RECEIPT_ENV] = receiptPath;
    let release: () => void = () => undefined;
    const writeRows = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }), undefined, writeRows);
    const module = (state: 'passed' | 'failed') => ({
      moduleId: join(TEST_CONFIG_ROOT, `src/${state}.test.ts`), state: () => state,
      diagnostic: () => ({ duration: 1 }), errors: () => [], children: { allTests: () => [] },
    });
    await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
    vi.useFakeTimers();
    try {
      reporter.onTestModuleEnd(module('failed') as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(writeRows).toHaveBeenCalledTimes(1);
      reporter.onTestModuleEnd(module('passed') as never);
      const final = reporter.onTestRunEnd();
      await vi.advanceTimersByTimeAsync(reporterWriteBudget(process.env).flushBudgetMs);
      expect(writeRows).toHaveBeenCalledTimes(1);
      await final;
      const receipts = readFileSync(receiptPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(receipts).toEqual(expect.arrayContaining([
        expect.objectContaining({ filePath: expect.stringMatching(/passed\.test\.ts$/), outcome: 'timeout' }),
      ]));
    } finally {
      release();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await reporter.onExit();
      if (previous === undefined) delete process.env[TEST_RUN_RECEIPT_ENV];
      else process.env[TEST_RUN_RECEIPT_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('EI-26701962157024953: queued failures resume after a timed-out writer actually settles', async () => {
    let release: () => void = () => undefined;
    const writeRows = vi.fn(async (_rows: readonly TestRunRow[]) => {
      if (writeRows.mock.calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
    });
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }), undefined, writeRows);
    const module = (file: string) => ({ moduleId: join(TEST_CONFIG_ROOT, file), state: () => 'failed',
      diagnostic: () => ({ duration: 1 }), errors: () => [], children: { allTests: () => [] } });
    await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
    vi.useFakeTimers();
    try {
      reporter.onTestModuleEnd(module('src/first.test.ts') as never);
      await vi.advanceTimersByTimeAsync(0);
      reporter.onTestModuleEnd(module('src/second.test.ts') as never);
      await vi.advanceTimersByTimeAsync(reporterWriteBudget(process.env).flushBudgetMs);
      expect(writeRows).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(writeRows).toHaveBeenCalledTimes(2);
      expect(writeRows.mock.calls[1][0]).toEqual([
        expect.objectContaining({ filePath: expect.stringMatching(/second\.test\.ts$/), status: 'fail' }),
      ]);
    } finally {
      release();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await reporter.onTestRunEnd();
    }
  });

  it('EI-26701962157024953: run-level unhandled errors still demote the passes that were held back', async () => {
    const written: Array<{ filePath: string; status: string }> = [];
    const reporter = new AdminTestRunsReporter(
      async () => ({ commit: 'abc', porcelain: '' }),
      undefined,
      (async (rows: Array<{ filePath: string; status: string }>) => { written.push(...rows); }) as never,
    );
    const makeModule = (file: string, state: 'passed' | 'failed') => ({
      moduleId: join(TEST_CONFIG_ROOT, file),
      state: () => state,
      diagnostic: () => ({ duration: 1 }),
      errors: () => [],
      children: { allTests: () => [{ fullName: file, result: () => ({ state, errors: [] }) }] },
    });
    await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
    reporter.onTestModuleEnd(makeModule('src/fails.test.ts', 'failed') as never);
    reporter.onTestModuleEnd(makeModule('src/passes.test.ts', 'passed') as never);
    await reporter.onTestRunEnd([], [new Error('stream exploded')], 'failed' as never);
    expect(written.map(row => [row.filePath.split('/').pop(), row.status])).toEqual([
      ['fails.test.ts', 'fail'],
      ['passes.test.ts', 'error'],
    ]);
  });

  it('EI-22137062583459326: a beforeAll collection crash (no test cases ever registered) surfaces its real error in the sidecar under "(file failed to collect)", not silently as nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-reporter-collection-failure-'));
    const detailsPath = join(dir, 'failure-details.json');
    const previous = process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH;
    process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH = detailsPath;
    try {
      const reporter = new AdminTestRunsReporter(
        async () => ({ commit: 'abc', porcelain: '' }),
        async () => undefined,
      );
      await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
      // A pure beforeAll throw: the module state is 'failed', testModule.errors()
      // carries the real thrown error (the same source buildOutputTail already
      // reads), and children.allTests() is EMPTY — collection never got far
      // enough to discover any test case, so the pre-existing per-test walk
      // above finds nothing.
      const collectionCrashModule = {
        moduleId: join(TEST_CONFIG_ROOT, 'src/dead-suite.integration.test.ts'),
        state: () => 'failed',
        diagnostic: () => ({ duration: 3 }),
        errors: () => [{ message: 'PostgresError: relation "plan_item_assignments" already exists' }],
        children: { allTests: () => [] },
      };
      reporter.onTestModuleEnd(collectionCrashModule as never);
      await reporter.onTestRunEnd();

      const payload = JSON.parse(readFileSync(detailsPath, 'utf8')) as {
        failures: Array<{ file: string; test: string; message?: string }>;
      };
      expect(payload.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: expect.stringMatching(/(?:^|\/)src\/dead-suite\.integration\.test\.ts$/),
          test: '(file failed to collect)',
          message: 'PostgresError: relation "plan_item_assignments" already exists',
        }),
      ]));
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH;
      else process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('EI-27740011831602428: a nested beforeAll error survives registered passed and skipped cases in output_tail and the failure sidecar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-reporter-nested-collection-failure-'));
    const detailsPath = join(dir, 'failure-details.json');
    const previous = process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH;
    process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH = detailsPath;
    const written: TestRunRow[] = [];
    const error = {
      message: 'nested beforeAll failed: auditDefinition was null',
      stack: 'Error: nested beforeAll failed: auditDefinition was null\n    at beforeAll (admin-test-runs-reporter.test.ts:2400:11)',
    };
    const registeredCases = [
      { fullName: 'parent > broken setup > already ran', result: () => ({ state: 'passed', errors: [] }) },
      { fullName: 'parent > broken setup > blocked one', result: () => ({ state: 'skipped', errors: [] }) },
      { fullName: 'parent > broken setup > blocked two', result: () => ({ state: 'skipped', errors: [] }) },
    ];
    const reporter = new AdminTestRunsReporter(
      async () => ({ commit: 'abc', porcelain: '' }),
      undefined,
      async rows => { written.push(...rows); },
    );
    try {
      await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
      reporter.onTestModuleEnd({
        moduleId: join(TEST_CONFIG_ROOT, 'src/nested-suite.integration.test.ts'),
        state: () => 'failed',
        diagnostic: () => ({ duration: 3 }),
        errors: () => [],
        children: {
          allTests: () => registeredCases,
          allSuites: () => [{ errors: () => [error] }],
        },
      } as never);
      await reporter.onTestRunEnd();

      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        status: 'fail',
        outputTail: expect.stringContaining('nested beforeAll failed: auditDefinition was null'),
      });
      const payload = JSON.parse(readFileSync(detailsPath, 'utf8')) as {
        failures: Array<{ file: string; test: string; message?: string }>;
      };
      expect(payload.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: expect.stringMatching(/(?:^|\/)src\/nested-suite\.integration\.test\.ts$/),
          test: '(file failed to collect)',
          message: expect.stringContaining('nested beforeAll failed: auditDefinition was null'),
        }),
      ]));
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH;
      else process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('EI-22137062583459326: a module with a real per-test failure does NOT also get a spurious "(file failed to collect)" entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-reporter-no-spurious-collection-'));
    const detailsPath = join(dir, 'failure-details.json');
    const previous = process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH;
    process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH = detailsPath;
    try {
      const reporter = new AdminTestRunsReporter(
        async () => ({ commit: 'abc', porcelain: '' }),
        async () => undefined,
      );
      await reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
      // A module that collected fine and ran a real assertion with a
      // structured actual/expected diff (so the pre-existing narrow filter
      // records it) — errors() is ALSO non-empty (Vitest often still reports
      // module-level noise alongside a real per-test failure) but there IS a
      // real per-test failure, so the collection-failure fallback must stay
      // silent and must not add a second, spurious entry alongside it.
      const assertionFailureModule = {
        moduleId: join(TEST_CONFIG_ROOT, 'src/normal.test.ts'),
        state: () => 'failed',
        diagnostic: () => ({ duration: 2 }),
        errors: () => [{ message: 'unrelated module-level noise' }],
        children: {
          allTests: () => [
            {
              fullName: 'suite > fails',
              result: () => ({
                state: 'failed',
                errors: [{ message: 'expected 1 to be 2', actual: '1', expected: '2' }],
              }),
            },
          ],
        },
      };
      reporter.onTestModuleEnd(assertionFailureModule as never);
      await reporter.onTestRunEnd();

      const payload = JSON.parse(readFileSync(detailsPath, 'utf8')) as {
        failures: Array<{ file: string; test: string; message?: string }>;
      };
      expect(payload.failures).toHaveLength(1);
      expect(payload.failures[0]?.test).toBe('suite > fails');
      expect(payload.failures.some((f) => f.test === '(file failed to collect)')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH;
      else process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildOutputTail prefers module-level errors and stays null for passing modules', () => {
    const withModuleErr = {
      errors: () => [{ message: 'import boom' }],
      children: { allTests: () => [] },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    expect(buildOutputTail(withModuleErr, 'fail')).toBe('import boom');

    const passing = {
      errors: () => [],
      children: {
        allTests: () => [{ fullName: 'x', result: () => ({ state: 'passed', errors: [] }) }],
      },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    expect(buildOutputTail(passing, 'pass')).toBeNull();
  });

  it('preserves the originating stack of a serialized teardown error after cases passed', () => {
    const error = {
      message: 'templateLockName is not defined',
      stack: 'ReferenceError: templateLockName is not defined\n    at sweepIdleTemplates (pg-migrate.ts:400:18)\n    at cleanup (_pg-helpers.ts:91:7)',
    };
    const module = {
      errors: () => [error],
      children: { allTests: () => [{ fullName: 'claim is released', result: () => ({ state: 'passed' }) }] },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    expect(buildOutputTail(module, 'fail')).toContain('templateLockName is not defined');
    expect(buildOutputTail(module, 'fail')).toContain('at sweepIdleTemplates (pg-migrate.ts:400:18)');
    expect(buildOutputTail(module, 'fail')).toContain('at cleanup (_pg-helpers.ts:91:7)');
    expect(formatTestCaseError(error)).toBe(error.message);
  });

  it('bounds a file-error stack while retaining its originating frame and structured values', () => {
    const error = {
      message: 'fixture failed',
      stack: 'Error: fixture failed\n    at fixtureCleanup (fixture.ts:5:1)\n' + '    at later (runner.ts:1:1)\n'.repeat(500),
      actual: 'broken', expected: 'healthy',
    };
    const module = { errors: () => [error] } as unknown as Parameters<typeof buildOutputTail>[0];
    const tail = buildOutputTail(module, 'fail')!;
    expect(tail).toContain('at fixtureCleanup (fixture.ts:5:1)');
    expect(tail).toContain('actual: broken\nexpected: healthy');
    expect(tail.length).toBeLessThan(2_000);
  });

  it('retains the file-error message when a stack getter throws', () => {
    const error = { message: 'teardown failed', get stack(): string { throw new Error('stack unavailable'); } };
    const module = { errors: () => [error] } as unknown as Parameters<typeof buildOutputTail>[0];
    expect(buildOutputTail(module, 'fail')).toBe('teardown failed');
  });

  it('buildOutputTail is fail-soft when the test walk throws', () => {
    const explosive = {
      errors: () => [],
      children: {
        allTests: () => {
          throw new Error('walk-explodes');
        },
      },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    expect(buildOutputTail(explosive, 'fail')).toBeNull();
  });

  it('isScratchConfigFile (EI-18767688096795873): flags a config resolved OUTSIDE the repo tree', () => {
    // Exactly the reported shape: a mutation-testing harness's throwaway config
    // under /tmp, unrelated to the real in-tree repo root.
    expect(isScratchConfigFile('/tmp/mutant-abc123/vitest.mutant.config.ts', '/home/dev/papercup')).toBe(true);
  });

  it('isScratchConfigFile: does NOT flag a canonical in-tree config', () => {
    expect(isScratchConfigFile('/home/dev/papercup/packages/operator-core/vitest.config.ts', '/home/dev/papercup')).toBe(false);
    expect(isScratchConfigFile('/home/dev/papercup/vitest.config.ts', '/home/dev/papercup')).toBe(false);
  });

  it('isScratchConfigFile: defaults to false (trust the run) when there is no configFile at all', () => {
    // A config-less `vitest run` (libs/generic/* shape) resolves configFile to
    // `false` — must never be treated as scratch (that would suppress a real signal).
    expect(isScratchConfigFile(false, '/home/dev/papercup')).toBe(false);
    expect(isScratchConfigFile(undefined, '/home/dev/papercup')).toBe(false);
    expect(isScratchConfigFile('', '/home/dev/papercup')).toBe(false);
  });

  it('isScratchConfigFile: a sibling directory that merely SHARES the repo-root prefix is still outside the tree', () => {
    // '/home/dev/papercup-release' starts with the string '/home/dev/papercup' but
    // is a DIFFERENT directory — relative() must be used, not a string prefix check.
    expect(isScratchConfigFile('/home/dev/papercup-release/vitest.config.ts', '/home/dev/papercup')).toBe(true);
  });

  it('computeIsScratchConfig (EI-18767688096795873): reads ctx.vite.config.configFile, not ctx.config', () => {
    // The resolved config path lives on the underlying Vite dev server's config,
    // not Vitest's own ctx.config (which deliberately omits configFile).
    const scratch = { vite: { config: { configFile: '/tmp/mutant-xyz/vitest.mutant.config.ts' } } } as unknown as Parameters<typeof computeIsScratchConfig>[0];
    expect(computeIsScratchConfig(scratch)).toBe(true);

    const canonical = { vite: { config: { configFile: `${process.cwd()}/vitest.config.ts` } } } as unknown as Parameters<typeof computeIsScratchConfig>[0];
    expect(computeIsScratchConfig(canonical)).toBe(false);
  });

  it('computeIsScratchConfig defaults to false (never throws) on a bogus/missing ctx.vite', () => {
    expect(computeIsScratchConfig({} as unknown as Parameters<typeof computeIsScratchConfig>[0])).toBe(false);
    expect(computeIsScratchConfig(null as unknown as Parameters<typeof computeIsScratchConfig>[0])).toBe(false);
  });

  it('onInit (EI-18767688096795873): wires computeIsScratchConfig without throwing, even on a bogus ctx', async () => {
    const r = new AdminTestRunsReporter();
    const fakeCtx = { vite: { config: { configFile: '/tmp/mutant-xyz/vitest.mutant.config.ts' } } } as unknown as Parameters<typeof r.onInit>[0];
    await expect(r.onInit(fakeCtx)).resolves.toBeUndefined();
    await expect(r.onInit(null as never)).resolves.toBeUndefined();
  });

  it('onTestRunEnd resolves cleanly with no pending work', async () => {
    const r = new AdminTestRunsReporter();
    await expect(r.onTestRunEnd()).resolves.toBeUndefined();
  });

  it('onExit resolves cleanly with no pending work', async () => {
    const r = new AdminTestRunsReporter();
    await expect(r.onExit()).resolves.toBeUndefined();
  });

  it('persists worktree_dirty=true when a tracked fixture changes during the run', async () => {
    const snapshots = [
      { commit: 'abc', porcelain: '' },
      { commit: 'abc', porcelain: ' M tracked-fixture.ts' },
    ];
    const persisted: TestRunRow[] = [];
    const r = new AdminTestRunsReporter(
      async () => snapshots.shift()!,
      async (row) => {
        persisted.push(row);
      },
    );
    await r.onInit({ vite: { config: { configFile: `${process.cwd()}/vitest.config.ts` } } } as never);
    r.onTestModuleEnd({
      moduleId: join(process.cwd(), 'src/admin-test-runs-reporter.test.ts'),
      state: () => 'passed',
      diagnostic: () => ({ duration: 12 }),
      errors: () => [],
    } as unknown as Parameters<typeof r.onTestModuleEnd>[0]);

    await r.onTestRunEnd();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].worktreeDirty).toBe(true);
    expect(persisted[0].commitSha).toBe('abc');
  });

  it('persists worktree_dirty=false for a clean stable run', async () => {
    const snapshots = [
      { commit: 'abc', porcelain: '' },
      { commit: 'abc', porcelain: '' },
    ];
    const persisted: TestRunRow[] = [];
    const r = new AdminTestRunsReporter(
      async () => snapshots.shift()!,
      async (row) => {
        persisted.push(row);
      },
    );
    await r.onInit({ vite: { config: { configFile: `${process.cwd()}/vitest.config.ts` } } } as never);
    r.onTestModuleEnd({
      moduleId: join(process.cwd(), 'src/admin-test-runs-reporter.test.ts'),
      state: () => 'passed',
      diagnostic: () => ({ duration: 12 }),
      errors: () => [],
      children: { allTests: () => [{ fullName: 'clean control', result: () => ({ state: 'passed' }) }] },
    } as unknown as Parameters<typeof r.onTestModuleEnd>[0]);

    await r.onTestRunEnd();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].worktreeDirty).toBe(false);
    expect(persisted[0].commitSha).toBe('abc');
    expect(persisted[0].executionDetails).toBeTruthy();
    expect(persisted[0].executionDetails).not.toHaveProperty('worktreeDirtyReason');
    expect(persisted[0].executionDetails?.proofContext).toMatchObject({ schemaVersion: 'proof-context-v1',
      components: { source: null, population: null, dependencies: null, runtimeCapabilities: null } });
  });

  it('persists original worker dependency evidence independently of the reporter runtime', async () => {
    const inputDir = mkdtempSync(join(tmpdir(), 'worker-runtime-result-'));
    const saved = process.env.PC_EXECUTED_INPUTS_DIR;
    const file = join(process.cwd(), 'src/admin-test-runs-reporter.test.ts');
    const worker = { name: 'bun', version: '1.3.5', executable: '/qualified/bun', platform: 'linux', arch: 'arm64',
      binarySha256: '1'.repeat(64), lockfileSha256: '2'.repeat(64), nativeDependencyGeneration: '3'.repeat(64),
      configurationSha256: '4'.repeat(64) };
    const runtime = { before: worker, after: worker };
    const rows: TestRunRow[] = [];
    try {
      process.env.PC_EXECUTED_INPUTS_DIR = inputDir;
      writeFileSync(inputsFilePath(inputDir, file), JSON.stringify({ testFile: file, reads: [], opaque: [], runtime }));
      const reporter = new AdminTestRunsReporter(async () => ({ commit: 'a'.repeat(40), porcelain: '' }),
        async row => { rows.push(row); });
      await reporter.onInit({} as never);
      const test = { fullName: 'worker control', result: () => ({ state: 'passed' }) };
      const module = { moduleId: file, state: () => 'passed', diagnostic: () => ({ duration: 1 }),
        errors: () => [], children: { allTests: () => [test] } } as never;
      reporter.onTestModuleEnd(module);
      await reporter.onTestRunEnd();
      expect(rows).toHaveLength(1);
      const details = parseTestRunExecutionDetails(rows[0]!.executionDetails);
      expect(details?.workerRuntime).toEqual(runtime);
      expect(details?.proofContext?.components.dependencies).toMatch(/^[a-f0-9]{64}$/);
      expect(details?.proofContext?.components.runtimeCapabilities).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.PC_EXECUTED_INPUTS_DIR;
      else process.env.PC_EXECUTED_INPUTS_DIR = saved;
      rmSync(inputDir, { recursive: true, force: true });
    }
  });

  it('does not attribute a nested unversioned verifier source archive to a clean enclosing checkout', async () => {
    mkdirSync(join(process.cwd(), '.papercusp/tmp'), { recursive: true });
    const scratchRoot = mkdtempSync(join(process.cwd(), '.papercusp/tmp/verify-tauri-headless.reporter-test.'));
    const sourceRoot = join(scratchRoot, 'operator-source');
    mkdirSync(sourceRoot, { recursive: true });
    const receipt = join(scratchRoot, 'verifier-source-receipt.json');
    writeFileSync(receipt, JSON.stringify({ schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40) }));
    vi.stubEnv('OPERATOR_SOURCE_ROOT', sourceRoot);
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receipt);
    const persisted: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(
      async () => ({ commit: 'outer-checkout-sha', porcelain: '' }),
      async row => { persisted.push(row); },
    );
    try {
      await reporter.onInit({
        config: { root: process.cwd() },
        vite: { config: { root: process.cwd(), configFile: join(process.cwd(), 'vitest.config.ts') } },
      } as never);
      reporter.onTestModuleEnd({
        moduleId: join(sourceRoot, 'packages/operator-core/lib/reports-library-native.e2e.test.ts'),
        state: () => 'passed',
        diagnostic: () => ({ duration: 12 }),
        errors: () => [],
        children: { allTests: () => [{ fullName: 'immutable source archive run', result: () => ({ state: 'passed' }) }] },
      } as never);

      await reporter.onTestRunEnd();

      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        worktreeDirty: true,
        commitSha: null,
      });
      expect(persisted[0].executionDetails?.worktreeDirtyReason)
        .toContain('verifier source archive without Git metadata');
    } finally {
      vi.unstubAllEnvs();
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it.each(['local', 'mutation-probe', 'ci'])('persists the dirty reason for %s receipts', async (source) => {
    vi.stubEnv('PAPERCUSP_TEST_RUN_SOURCE', source);
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', source === 'mutation-probe' ? '1' : '');
    const snapshots = [
      { commit: 'abc', porcelain: '' },
      { commit: 'abc', porcelain: ' M unrelated-source.ts' },
    ];
    const persisted: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(
      async () => snapshots.shift()!,
      async (row) => { persisted.push(row); },
    );
    try {
      await reporter.onInit({ vite: { config: { configFile: `${process.cwd()}/vitest.config.ts` } } } as never);
      reporter.onTestModuleEnd({
        moduleId: join(process.cwd(), 'src/admin-test-runs-reporter.test.ts'),
        state: () => 'passed', diagnostic: () => ({ duration: 12 }), errors: () => [],
        children: { allTests: () => [{ fullName: 'dirty receipt control', result: () => ({ state: 'passed' }) }] },
      } as never);
      await reporter.onTestRunEnd();
      expect(persisted).toHaveLength(1);
      expect(parseTestRunExecutionDetails(persisted[0].executionDetails)).toMatchObject({
        worktreeDirty: true,
        worktreeDirtyReason: '1 porcelain line(s) after the run:  M unrelated-source.ts',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('persists an unreadable status reason instead of losing the provenance failure', async () => {
    const snapshots = [
      { commit: 'abc', porcelain: '' },
      { commit: 'abc', porcelain: null },
    ];
    const persisted: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(
      async () => snapshots.shift()!,
      async (row) => { persisted.push(row); },
    );
    await reporter.onInit({ vite: { config: { configFile: `${process.cwd()}/vitest.config.ts` } } } as never);
    reporter.onTestModuleEnd({
      moduleId: join(process.cwd(), 'src/admin-test-runs-reporter.test.ts'),
      state: () => 'passed', diagnostic: () => ({ duration: 12 }), errors: () => [],
      children: { allTests: () => [{ fullName: 'unreadable status control', result: () => ({ state: 'passed' }) }] },
    } as never);
    await reporter.onTestRunEnd();
    expect(parseTestRunExecutionDetails(persisted[0].executionDetails)).toMatchObject({
      worktreeDirty: true,
      worktreeDirtyReason: 'git status unreadable after the run',
    });
  });

  // WI-10004076: a declared-ci run demoted to local must say why, while the tree still exists.
  it.each([
    { ci: '1', expectLine: true },
    { ci: '', expectLine: false },
  ])('names the dirt reason on stderr only for a demoted ci run (CI=$ci)', async ({ ci, expectLine }) => {
    vi.stubEnv('CI', ci);
    vi.stubEnv('PAPERCUSP_TEST_RUN_SOURCE', '');
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const snapshots = [
        { commit: 'abc', porcelain: '' },
        { commit: 'abc', porcelain: '?? leaked-by-a-test.json' },
      ];
      const r = new AdminTestRunsReporter(async () => snapshots.shift()!, async () => {});
      await r.onInit({ vite: { config: { configFile: `${process.cwd()}/vitest.config.ts` } } } as never);
      r.onTestModuleEnd({
        moduleId: join(process.cwd(), 'src/admin-test-runs-reporter.test.ts'),
        state: () => 'passed',
        diagnostic: () => ({ duration: 12 }),
        errors: () => [],
      } as unknown as Parameters<typeof r.onTestModuleEnd>[0]);

      await r.onTestRunEnd();
      const lines = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((s) => s.startsWith('[admin-test-runs]'));
      expect(lines).toEqual(expectLine
        ? ['[admin-test-runs] 1 row(s) prepared source=local, not ci: worktree not proven stable — 1 porcelain line(s) after the run: ?? leaked-by-a-test.json\n']
        : []);
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe('computeWorktreeDirty (EI-20327093837421120)', () => {
  const clean = (commit: string) => ({ commit, porcelain: '' });

  it('keeps a clean stable tree clean', () => {
    expect(computeWorktreeDirty(clean('abc'), clean('abc'))).toBe(false);
  });

  it('marks a tracked fixture mutated during the run dirty', () => {
    expect(computeWorktreeDirty(clean('abc'), { commit: 'abc', porcelain: ' M tracked-fixture.ts' })).toBe(true);
  });

  it('marks a pre-existing dirty tree dirty even when it stays stable', () => {
    const dirty = { commit: 'abc', porcelain: ' M generated-contract.ts' };
    expect(computeWorktreeDirty(dirty, dirty)).toBe(true);
  });

  it('fails safe when either snapshot cannot be read', () => {
    expect(computeWorktreeDirty({ commit: null, porcelain: '' }, clean('abc'))).toBe(true);
    expect(computeWorktreeDirty(clean('abc'), { commit: 'abc', porcelain: null })).toBe(true);
  });
});

describe('describeWorktreeDirt (WI-10004076)', () => {
  const clean = (commit: string) => ({ commit, porcelain: '' });

  it('returns null exactly when the pair proves the tree stable', () => {
    expect(describeWorktreeDirt(clean('abc'), clean('abc'))).toBeNull();
  });

  it('names each way a pair can fail to prove stability', () => {
    expect(describeWorktreeDirt({ commit: null, porcelain: '' }, clean('abc'))).toBe('HEAD unreadable (before=null after=abc)');
    expect(describeWorktreeDirt(clean('aaaaaaaaaaaaaaaa'), clean('bbbbbbbbbbbbbbbb'))).toBe('HEAD moved aaaaaaaaaaaa -> bbbbbbbbbbbb');
    expect(describeWorktreeDirt(clean('abc'), { commit: 'abc', porcelain: null })).toBe('git status unreadable after the run');
  });

  it('names the porcelain paths, the side they were seen on, and caps the sample at five', () => {
    const after = { commit: 'abc', porcelain: Array.from({ length: 7 }, (_, i) => `?? leak-${i}.txt`).join('\n') };
    expect(describeWorktreeDirt(clean('abc'), after)).toBe(
      '7 porcelain line(s) after the run: ?? leak-0.txt | ?? leak-1.txt | ?? leak-2.txt | ?? leak-3.txt | ?? leak-4.txt',
    );
    expect(describeWorktreeDirt({ commit: 'abc', porcelain: ' M pre.ts' }, clean('abc'))).toBe(
      '1 porcelain line(s) before the run:  M pre.ts',
    );
  });

  it('agrees with computeWorktreeDirty on every case', () => {
    const snaps = [clean('abc'), clean('def'), { commit: null, porcelain: '' }, { commit: 'abc', porcelain: null }, { commit: 'abc', porcelain: '?? x' }];
    for (const before of snaps) {
      for (const after of snaps) {
        expect(computeWorktreeDirty(before, after)).toBe(describeWorktreeDirt(before, after) !== null);
      }
    }
  });
});

/**
 * EI-19307211919650123 — the root walk must tell a linked WORKTREE apart from a
 * SUBMODULE. Both carry a `.git` FILE, and they need opposite answers:
 *   - worktree  → this dir IS the repo root; stop (paths are relative to it)
 *   - submodule → the superproject above is the root; keep walking
 *
 * The regression this guards is not hypothetical. Treating every `.git` file as
 * "keep walking" made the green gate's checkout (`papercusp-checkpoint`, a linked
 * worktree) resolve its root to a stray `/home/<user>/.git`, so every gate row was
 * stamped `papercupai-workspace/papercusp-checkpoint/…` and then dropped by
 * `shouldRecordTestRunPath` — the release gate recorded nothing at all.
 *
 * Uses a real temp fs rather than mocking `node:fs`, so it exercises the same
 * statSync/readFileSync path production takes.
 */
describe('classifyGitEntry (worktree vs submodule vs plain repo root)', () => {
  const made: string[] = [];
  function tree(): string {
    const d = mkdtempSync(join(tmpdir(), 'pc-gitentry-'));
    made.push(d);
    return d;
  }
  afterEach(() => {
    while (made.length) {
      try { rmSync(made.pop() as string, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('a `.git` DIRECTORY is a repo root', () => {
    const d = tree();
    mkdirSync(join(d, '.git'));
    expect(classifyGitEntry(d)).toBe('root');
  });

  it('THE REGRESSION: a linked-worktree gitlink is a repo root, not a thing to walk past', () => {
    const d = tree();
    writeFileSync(join(d, '.git'), 'gitdir: /repo/.git/worktrees/papercusp-checkpoint\n');
    expect(classifyGitEntry(d)).toBe('root');
  });

  it('a SUBMODULE gitlink is still skipped — the superproject stays the root', () => {
    const d = tree();
    writeFileSync(join(d, '.git'), 'gitdir: /repo/.git/modules/libs/generic/cache\n');
    expect(classifyGitEntry(d)).toBe('skip');
  });

  it('a submodule gitlink nested inside a linked worktree is still skipped', () => {
    const d = tree();
    writeFileSync(join(d, '.git'), 'gitdir: /repo/.git/worktrees/checkout/modules/libs/test-config\n');
    expect(classifyGitEntry(d)).toBe('skip');
  });

  it('does not treat a repository path segment named modules as a submodule', () => {
    const d = tree();
    writeFileSync(join(d, '.git'), 'gitdir: /repo/modules/project/.git/worktrees/checkout\n');
    expect(classifyGitEntry(d)).toBe('root');
  });

  it('no `.git` entry at all reports none', () => {
    expect(classifyGitEntry(tree())).toBe('none');
  });

  it('an unrecognised gitlink keeps the previous behaviour (skip), never an invented root', () => {
    const d = tree();
    writeFileSync(join(d, '.git'), 'this is not a gitlink\n');
    expect(classifyGitEntry(d)).toBe('skip');
    const d2 = tree();
    writeFileSync(join(d2, '.git'), 'gitdir: /repo/.git/something-else/x\n');
    expect(classifyGitEntry(d2)).toBe('skip');
  });

  it('tolerates windows-style separators in the gitdir target', () => {
    const d = tree();
    writeFileSync(join(d, '.git'), 'gitdir: C:\\repo\\.git\\worktrees\\wt\n');
    expect(classifyGitEntry(d)).toBe('root');
  });

  it('COMPOSED: the walk stops at a worktree, and its paths survive shouldRecordTestRunPath', () => {
    // Mirrors the real shape: a superproject with a linked worktree beside it.
    const repo = tree();
    mkdirSync(join(repo, '.git'));
    const wt = join(repo, 'checkout');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'checkout')}\n`);

    expect(classifyGitEntry(wt)).toBe('root');
    // Because the walk stops AT the worktree, a test file inside it records as
    // repo-relative (`packages/...`) — the same key a local run in the main tree
    // produces, which is what makes gate-vs-local comparison possible at all.
    expect(shouldRecordTestRunPath('packages/operator-core/lib/foo.test.ts')).toBe(true);
    // Had the walk continued past it, the path would have carried the checkout
    // prefix — the exact shape NON_SIGNAL_PREFIXES drops.
    expect(
      shouldRecordTestRunPath('papercupai-workspace/papercusp-checkpoint/packages/operator-core/lib/foo.test.ts'),
    ).toBe(false);
  });
});

// WI-6583: harness_slug/workspace_id were populated on effectively none of
// 647,266 rows because only ONE naming convention was ever checked. These pin
// the broadened precedence so a future edit can't quietly narrow it back down.
describe('resolveTestRunHarnessSlug / resolveTestRunWorkspaceId (WI-6583)', () => {
  const ATTRIBUTION_KEYS = [
    'PAPERCUSP_TEST_RUN_HARNESS',
    'HARNESS_SLUG',
    'PAPERCUSP_HARNESS_SLUG',
    'PAPERCUSP_TEST_RUN_WORKSPACE',
    'PAPERCUSP_WORKSPACE_ID',
    'PAPERCUSP_WORKSPACE',
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ATTRIBUTION_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ATTRIBUTION_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('resolveTestRunHarnessSlug: returns null when nothing is set', () => {
    expect(resolveTestRunHarnessSlug()).toBeNull();
  });

  it('resolveTestRunHarnessSlug: falls back to HARNESS_SLUG (a harness-spawned agent role)', () => {
    process.env.HARNESS_SLUG = 'my-harness';
    expect(resolveTestRunHarnessSlug()).toBe('my-harness');
  });

  it('resolveTestRunHarnessSlug: falls back to PAPERCUSP_HARNESS_SLUG (an interactive su/psu shell)', () => {
    process.env.PAPERCUSP_HARNESS_SLUG = 'papercusp';
    expect(resolveTestRunHarnessSlug()).toBe('papercusp');
  });

  it('resolveTestRunHarnessSlug: PAPERCUSP_TEST_RUN_HARNESS (explicit dogfood override) wins over the others', () => {
    process.env.PAPERCUSP_TEST_RUN_HARNESS = 'explicit';
    process.env.HARNESS_SLUG = 'from-spawn';
    process.env.PAPERCUSP_HARNESS_SLUG = 'from-shell';
    expect(resolveTestRunHarnessSlug()).toBe('explicit');
  });

  it('resolveTestRunHarnessSlug: HARNESS_SLUG wins over PAPERCUSP_HARNESS_SLUG', () => {
    process.env.HARNESS_SLUG = 'from-spawn';
    process.env.PAPERCUSP_HARNESS_SLUG = 'from-shell';
    expect(resolveTestRunHarnessSlug()).toBe('from-spawn');
  });

  it.each([
    ['PAPERCUSP_TEST_RUN_HARNESS', '*'],
    ['PAPERCUSP_TEST_RUN_HARNESS', 'all'],
    ['PAPERCUSP_TEST_RUN_HARNESS', ' ALL '],
    ['HARNESS_SLUG', '*'],
    ['HARNESS_SLUG', 'all'],
    ['PAPERCUSP_HARNESS_SLUG', '*'],
    ['PAPERCUSP_HARNESS_SLUG', 'all'],
  ] as const)('resolveTestRunHarnessSlug: rejects %s sentinel %j', (key, value) => {
    process.env[key] = value;
    expect(resolveTestRunHarnessSlug()).toBeNull();
  });

  it('resolveTestRunHarnessSlug: does not fall through a sentinel override to ambient harness attribution', () => {
    process.env.PAPERCUSP_TEST_RUN_HARNESS = 'all';
    process.env.HARNESS_SLUG = 'from-spawn';
    expect(resolveTestRunHarnessSlug()).toBeNull();
  });

  it('resolveTestRunWorkspaceId: returns null when nothing is set', () => {
    expect(resolveTestRunWorkspaceId()).toBeNull();
  });

  it('resolveTestRunWorkspaceId: falls back to PAPERCUSP_WORKSPACE (an interactive su/psu shell)', () => {
    process.env.PAPERCUSP_WORKSPACE = 'papercusp-workspace';
    expect(resolveTestRunWorkspaceId()).toBe('papercusp-workspace');
  });

  it('resolveTestRunWorkspaceId: PAPERCUSP_WORKSPACE_ID wins over PAPERCUSP_WORKSPACE', () => {
    process.env.PAPERCUSP_WORKSPACE_ID = 'ws-id';
    process.env.PAPERCUSP_WORKSPACE = 'ws-legacy';
    expect(resolveTestRunWorkspaceId()).toBe('ws-id');
  });

  // The isolated rig rebinds PAPERCUSP_WORKSPACE_ID to its throwaway workspace; the
  // ledger-only override must beat it or isolated e2e rows land unreadably scoped.
  it('resolveTestRunWorkspaceId: PAPERCUSP_TEST_RUN_WORKSPACE (ledger override) wins over a rig-rebound PAPERCUSP_WORKSPACE_ID', () => {
    process.env.PAPERCUSP_TEST_RUN_WORKSPACE = 'papercusp-workspace';
    process.env.PAPERCUSP_WORKSPACE_ID = 'verify-tauri-isolated-90';
    process.env.PAPERCUSP_WORKSPACE = 'verify-tauri-isolated-90';
    expect(resolveTestRunWorkspaceId()).toBe('papercusp-workspace');
  });
});

/**
 * WI-10000776 — every recorded path used to be relativized against the root inferred
 * from `process.cwd()`, i.e. the PAPERCUSP tree, whatever checkout the suite belonged
 * to. A sibling checkout therefore produced `../…/tests/x.test.ts`, and
 * {@link shouldRecordTestRunPath} DROPS anything starting `../` — so its rows were
 * silently discarded, no `test_run_id` was ever minted, and `plans:bind-spec-evidence`
 * (which requires a non-null one) could not carry `test`-kind evidence for any plan in
 * that checkout. The tests ran green and left no trace.
 *
 * These build REAL fixture checkouts on disk (a `.git` DIRECTORY is a repo root per
 * classifyGitEntry) rather than mocking the walk, because the defect lives precisely in
 * WHICH directory the walk was asked about.
 */
describe('WI-10000776 — the recorded root is the CHECKOUT UNDER TEST, not the process cwd', () => {
  const made: string[] = [];
  function checkout(name: string): string {
    const d = mkdtempSync(join(tmpdir(), `pc-${name}-`));
    made.push(d);
    mkdirSync(join(d, '.git'));
    mkdirSync(join(d, 'tests'));
    return d;
  }
  afterEach(() => {
    setRunRoot(null); // realm-pinned state — never leak a run root into a sibling test
    while (made.length) {
      try { rmSync(made.pop() as string, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('THE BUG: with no run root, a sibling checkout normalizes to ../ and is dropped', () => {
    const sibling = checkout('sibling');
    const rel = toWorkspaceRel(join(sibling, 'tests', 'a.test.ts'));
    expect(rel.startsWith('../')).toBe(true);
    expect(shouldRecordTestRunPath(rel)).toBe(false);
  });

  it('THE FIX: pinned to that checkout, the same file records as tests/a.test.ts', () => {
    const sibling = checkout('sibling');
    expect(setRunRoot(sibling)).toBe(sibling);
    expect(toWorkspaceRel(join(sibling, 'tests', 'a.test.ts'))).toBe('tests/a.test.ts');
    expect(shouldRecordTestRunPath('tests/a.test.ts')).toBe(true);
  });

  it('WI-5183 SURVIVES: a /tmp fixture is outside EVERY checkout and is still rejected', () => {
    // The guard never needed loosening — the root was wrong. Fixing the root makes this
    // guard mean what it says instead of weakening it.
    setRunRoot(checkout('sibling'));
    const rel = toWorkspaceRel('/tmp/fake.test.ts');
    expect(rel.startsWith('../')).toBe(true);
    expect(shouldRecordTestRunPath(rel)).toBe(false);
  });

  it('a run rooted inside a SUBMODULE resolves to that checkout’s SUPERPROJECT', () => {
    // Routing through computeWorkspaceRootFrom rather than using the config root raw is
    // what prevents reintroducing the submodule-relative-path bug inferWorkspaceRoot
    // already had to fix once.
    const superproject = checkout('super');
    const sub = join(superproject, 'libs', 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, '.git'), 'gitdir: /repo/.git/modules/libs/sub\n');
    expect(setRunRoot(sub)).toBe(superproject);
    expect(toWorkspaceRel(join(sub, 'x.test.ts'))).toBe('libs/sub/x.test.ts');
  });

  function preparedNestedClone(trackGitlink: boolean): { parent: string; sub: string } {
    const parent = mkdtempSync(join(tmpdir(), 'pc-prepared-parent-'));
    made.push(parent);
    const sub = join(parent, 'libs', 'sub with spaces');
    mkdirSync(sub, { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    for (const root of [parent, sub]) git(root, 'init', '-q');
    writeFileSync(join(sub, 'x.test.ts'), 'export const observed = true;\n');
    git(sub, 'add', 'x.test.ts');
    git(sub, '-c', 'user.name=Reporter fixture', '-c', 'user.email=reporter@example.test',
      'commit', '-qm', 'child');
    writeFileSync(join(parent, '.gitmodules'),
      '[submodule "fixture"]\n\tpath = libs/sub with spaces\n\turl = ./fixture\n');
    git(parent, 'add', '.gitmodules');
    if (trackGitlink) {
      git(parent, 'update-index', '--add', '--cacheinfo',
        `160000,${git(sub, 'rev-parse', 'HEAD')},libs/sub with spaces`);
    }
    git(parent, '-c', 'user.name=Reporter fixture', '-c', 'user.email=reporter@example.test',
      'commit', '-qm', 'parent');
    return { parent, sub };
  }

  it('records a prepared standalone submodule clone under its committed parent gitlink', () => {
    const { parent, sub } = preparedNestedClone(true);
    expect(existsSync(join(sub, '.git', 'HEAD'))).toBe(true);
    expect(setRunRoot(sub)).toBe(parent);
    expect(toWorkspaceRel(join(sub, 'x.test.ts'))).toBe('libs/sub with spaces/x.test.ts');
  });

  it('keeps an independent nested clone local when .gitmodules has no matching committed gitlink', () => {
    const { sub } = preparedNestedClone(false);
    expect(setRunRoot(sub)).toBe(sub);
    expect(toWorkspaceRel(join(sub, 'x.test.ts'))).toBe('x.test.ts');
  });

  it('computeWorkspaceRootFrom answers about the directory it was ASKED about', () => {
    // Why the walk had to be split from the cache: inferWorkspaceRoot short-circuits on
    // its cached process root and silently ignores its own `from` once warm, so calling
    // it with the config root would have returned the papercusp tree anyway.
    const sibling = checkout('uncached');
    const processRoot = inferWorkspaceRoot(); // warm the cache
    expect(computeWorkspaceRootFrom(sibling)).toBe(sibling);
    expect(inferWorkspaceRoot(sibling)).toBe(processRoot);
  });

  it('readRunConfigRoot prefers ctx.config.root, falls back to vite, never throws', () => {
    expect(readRunConfigRoot({ config: { root: '/a' }, vite: { config: { root: '/b' } } })).toBe('/a');
    expect(readRunConfigRoot({ vite: { config: { root: '/b' } } })).toBe('/b');
    expect(readRunConfigRoot({ vite: { config: { configFile: '/x/vitest.config.ts' } } })).toBeNull();
    expect(readRunConfigRoot({ config: { root: '' } })).toBeNull();
    expect(readRunConfigRoot({})).toBeNull();
    expect(readRunConfigRoot(null)).toBeNull();
    expect(readRunConfigRoot(undefined)).toBeNull();
  });

  it('onInit pins the run root BEFORE anything else in it reads a root', async () => {
    const sibling = checkout('oninit');
    const r = new AdminTestRunsReporter();
    await r.onInit({
      config: { root: sibling },
      vite: { config: { configFile: join(sibling, 'vitest.config.ts') } },
    } as never);
    expect(toWorkspaceRel(join(sibling, 'tests', 'b.test.ts'))).toBe('tests/b.test.ts');
  });

  it('fail-soft: a ctx carrying no root clears the run root, restoring cwd behaviour', async () => {
    const sibling = checkout('nofix');
    setRunRoot(sibling);
    const r = new AdminTestRunsReporter();
    await expect(r.onInit({ vite: { config: { configFile: 'x' } } } as never)).resolves.toBeUndefined();
    expect(toWorkspaceRel(join(sibling, 'tests', 'c.test.ts')).startsWith('../')).toBe(true);
    await expect(r.onInit(null as never)).resolves.toBeUndefined();
  });

  it('a sibling checkout’s OWN vitest.config.ts stops being misread as a scratch config', () => {
    // The second, quieter half of the same defect: measured against the papercusp tree, a
    // legitimate external config resolved outside it and was stamped is_scratch_config.
    const sibling = checkout('scratch');
    const ctx = {
      config: { root: sibling },
      vite: { config: { configFile: join(sibling, 'vitest.config.ts') } },
    } as never;
    expect(computeIsScratchConfig(ctx)).toBe(true);
    setRunRoot(sibling);
    expect(computeIsScratchConfig(ctx)).toBe(false);
  });

  it('a genuine scratch config is STILL flagged once the run root is correct', () => {
    setRunRoot(checkout('scratch-neg'));
    expect(
      computeIsScratchConfig({ vite: { config: { configFile: '/tmp/mutant-xyz/vitest.mutant.config.ts' } } } as never),
    ).toBe(true);
  });
});

/**
 * WI-10004898 — a copy-out mutation probe records from a .git-less mirror, so the
 * snapshot that proves a run clean must come from the probe's ORIGIN checkout.
 * These run real git against a real origin repo and a real non-git mirror: the
 * property is "which directory does git status run in", so a stubbed reader would
 * prove nothing.
 */
describe('WI-10004898 — copy-out probe rows are measured against the origin checkout', () => {
  const made: string[] = [];
  const saved = {
    probe: process.env.PAPERCUSP_MUTATION_PROBE,
    origin: process.env.PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT,
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  function originRepo(): { root: string; head: string } {
    const root = mkdtempSync(join(tmpdir(), 'pc-probe-origin-'));
    made.push(root);
    git(root, 'init', '-q');
    writeFileSync(join(root, 'subject.ts'), 'export const x = 1;\n');
    git(root, 'add', 'subject.ts');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    return { root, head: git(root, 'rev-parse', 'HEAD') };
  }
  function mirror(): string {
    const d = mkdtempSync(join(tmpdir(), 'pc-probe-mirror-'));
    made.push(d);
    return d;
  }

  afterEach(() => {
    setRunRoot(null);
    for (const [key, value] of [
      ['PAPERCUSP_MUTATION_PROBE', saved.probe],
      ['PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT', saved.origin],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (made.length) {
      try { rmSync(made.pop() as string, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('THE BUG: a mirror record root has no .git, so the snapshot can never prove a clean run', async () => {
    const { root } = originRepo();
    setRunRoot(mirror());
    delete process.env.PAPERCUSP_MUTATION_PROBE;
    process.env.PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT = root;
    const snap = await captureWorktreeSnapshot();
    expect(snap.commit).toBeNull();
    expect(computeWorktreeDirty(snap, snap)).toBe(true);
  });

  it('THE FIX: inside a probe run, a clean origin proves the run clean at its HEAD', async () => {
    const { root, head } = originRepo();
    setRunRoot(mirror());
    process.env.PAPERCUSP_MUTATION_PROBE = '1';
    process.env.PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT = root;
    expect(resolveWorktreeSnapshotRoot()).toBe(root);
    const snap = await captureWorktreeSnapshot();
    expect(snap).toEqual({ commit: head, porcelain: '' });
    expect(computeWorktreeDirty(snap, snap)).toBe(false);
  });

  it('a DIRTY origin stays dirty — the shared tree cannot launder a probe clean', async () => {
    const { root } = originRepo();
    writeFileSync(join(root, 'peer-edit.ts'), 'uncommitted\n');
    setRunRoot(mirror());
    process.env.PAPERCUSP_MUTATION_PROBE = '1';
    process.env.PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT = root;
    const snap = await captureWorktreeSnapshot();
    expect(snap.porcelain).toContain('peer-edit.ts');
    expect(computeWorktreeDirty(snap, snap)).toBe(true);
  });

  it('a relative origin is ignored and the record root stands', () => {
    const recordRoot = mirror();
    setRunRoot(recordRoot);
    process.env.PAPERCUSP_MUTATION_PROBE = '1';
    process.env.PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT = 'relative/origin';
    expect(resolveWorktreeSnapshotRoot()).toBe(recordRoot);
  });
});

describe('captureWorktreeSnapshot retries a timed-out git read (WI-10004931)', () => {
  const STATUS = 'git status --porcelain --untracked-files=all --pc-partitioned';
  /** A fake git: each command answers from its queue in order; null models a timed-out exec. */
  const fakeGit = (answers: Record<string, Array<string | null>>) => {
    const calls: Array<{ cmd: string; timeoutMs: number }> = [];
    const run = async (cmd: string, _cwd: string, timeoutMs: number) => {
      calls.push({ cmd, timeoutMs });
      const queue = answers[cmd] ?? [];
      return queue.length > 0 ? (queue.shift() as string | null) : null;
    };
    return { run, calls };
  };

  it('measures recursive materialization only for an armed clean source snapshot, retaining unreadable and changed observations as null', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reporter-fake-submodules-'));
    execFileSync('git', ['init', '-q', root]);
    setRunRoot(root);
    try {
      const sha = 'a'.repeat(40), status = 'git submodule status --recursive';
      for (const [raw, expected] of [[`${sha} libs/a (heads/main)`, [['libs/a', sha]]], ['', []],
        [`-${sha} libs/a`, null], [`+${sha} libs/a`, null], [null, null]] as const) {
        const { run, calls } = fakeGit({ 'git rev-parse HEAD': [sha],
          [`${STATUS} --ignore-submodules=none`]: [''], [status]: [raw, raw] });
        const snapshot = await captureWorktreeSnapshot(run, undefined, undefined, true);
        expect(snapshot).toMatchObject({ commit: sha, porcelain: '', submodules: expected,
          sourceBytes: null });
        expect(calls.some(call => call.cmd === status)).toBe(true);
      }
      const { run, calls } = fakeGit({ 'git rev-parse HEAD': [sha],
        [`${STATUS} --ignore-submodules=none`]: [' M source.ts'] });
      expect(await captureWorktreeSnapshot(run, undefined, undefined, true)).toMatchObject({ submodules: null });
      expect(calls.some(call => call.cmd === status)).toBe(false);
    } finally {
      setRunRoot(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('observes real Git checkouts, distinguishes an empty census and refuses an uninitialized submodule', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reporter-submodule-checkouts-'));
    const sub = join(root, 'libs', 'observed');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args,
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commit = (cwd: string) => git(cwd, '-c', 'user.name=Reporter fixture',
      '-c', 'user.email=reporter@example.test', 'commit', '--allow-empty', '-qm', 'fixture');
    try {
      git(root, 'init', '-q'); commit(root); setRunRoot(root);
      expect((await captureWorktreeSnapshot(undefined, undefined, undefined, true)).submodules).toEqual([]);
      mkdirSync(sub, { recursive: true }); git(sub, 'init', '-q');
      writeFileSync(join(sub, 'source.js'), 'original'); git(sub, 'add', 'source.js'); commit(sub);
      const childSha = git(sub, 'rev-parse', 'HEAD');
      writeFileSync(join(root, '.gitmodules'), '[submodule "observed"]\n\tpath = libs/observed\n\turl = ./fixture\n');
      git(root, 'add', '.gitmodules');
      git(root, 'update-index', '--add', '--cacheinfo', `160000,${childSha},libs/observed`); commit(root);
      // A hand-added gitlink also needs Git's local submodule registration.
      // Retain the direct Git observation in any failure diagnostic.
      git(root, 'submodule', 'init');
      const observed = await captureWorktreeSnapshot(undefined, undefined, undefined, true);
      expect(observed.submodules, JSON.stringify({ observed, git: git(root, 'submodule', 'status', '--recursive') }))
        .toEqual([['libs/observed', childSha]]);
      git(root, 'config', 'submodule.observed.ignore', 'all');
      writeFileSync(join(sub, 'source.js'), 'changed');
      // Distinguish a misleading ordinary status from the armed producer's
      // explicit census. The checkout SHA itself has not changed.
      expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      expect(git(root, 'submodule', 'status', '--recursive')).toContain(childSha);
      const hiddenDirt = await captureWorktreeSnapshot(undefined, undefined, undefined, true);
      expect(hiddenDirt.porcelain).toContain('libs/observed');
      expect(hiddenDirt.submodules).toBeNull();
      writeFileSync(join(sub, 'source.js'), 'original');
      commit(sub);
      expect((await captureWorktreeSnapshot(undefined, undefined, undefined, true)).submodules).toBeNull();
      rmSync(sub, { recursive: true, force: true }); mkdirSync(sub);
      expect((await captureWorktreeSnapshot(undefined, undefined, undefined, true)).submodules).toBeNull();
    } finally { setRunRoot(null); rmSync(root, { recursive: true, force: true }); }
  });

  function preparedRootReceiptFixture() {
    const parent = mkdtempSync(join(tmpdir(), 'prepared-root-receipt-'));
    const root = join(parent, 'source');
    mkdirSync(join(root, '.git'), { recursive: true });
    const sourceCommit = 'a'.repeat(40);
    const markerBytes = JSON.stringify({ pid: process.pid, sha: sourceCommit });
    writeFileSync(join(root, '.git', 'lint-as-committed-owner.json'), markerBytes);
    const receiptPath = join(parent, 'prepared-root.json');
    writeFileSync(receiptPath, JSON.stringify({
      schemaVersion: 'lint-as-committed-prepared-root-v1',
      root,
      sourceCommit,
      ownerMarkerSha256: createHash('sha256').update(markerBytes).digest('hex'),
    }), { mode: 0o600 });
    vi.stubEnv('PAPERCUSP_LINT_AS_COMMITTED_CLONE', '1');
    vi.stubEnv('PAPERCUSP_LINT_AS_COMMITTED_PREPARED_ROOT_RECEIPT', receiptPath);
    setRunRoot(root);
    return { parent, root, receiptPath, sourceCommit };
  }

  it.skipIf(process.platform === 'win32')('partitions full-tree status and preserves tracked, untracked, staged-delete and literal paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reporter-partitioned-status-'));
    const bin = mkdtempSync(join(tmpdir(), 'reporter-git-shim-'));
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const log = join(bin, 'status-calls.txt');
    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      'if [ "$1" = "--literal-pathspecs" ] && [ "$2" = "status" ]; then echo "$#" >> "$PC_TEST_STATUS_LOG"; fi',
      'exec "$PC_TEST_REAL_GIT" "$@"',
      '',
    ].join('\n'), { mode: 0o755 });
    chmodSync(join(bin, 'git'), 0o755);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    try {
      git('init', '-q');
      for (let index = 0; index < 520; index++)
        writeFileSync(join(root, `tracked-${String(index).padStart(4, '0')}.ts`), `export const n = ${index};`);
      writeFileSync(join(root, ':(glob)literal.ts'), 'export const literal = true;');
      git('add', '--', '.');
      git('-c', 'user.name=Reporter fixture', '-c', 'user.email=reporter@example.test', 'commit', '-qm', 'fixture');

      vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`);
      vi.stubEnv('PC_TEST_REAL_GIT', realGit);
      vi.stubEnv('PC_TEST_STATUS_LOG', log);
      setRunRoot(root);
      const clean = await captureWorktreeSnapshot(undefined, undefined, undefined, false);
      expect(clean.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(clean.porcelain).toBe('');
      const cleanCalls = readFileSync(log, 'utf8').trim().split('\n').map(Number);
      expect(cleanCalls.length).toBeGreaterThan(1);
      expect(cleanCalls.every(argumentCount => argumentCount <= 517)).toBe(true);

      writeFileSync(log, '');
      writeFileSync(join(root, 'tracked-0001.ts'), 'export const n = 9001;');
      writeFileSync(join(root, ':(glob)literal.ts'), 'export const literal = false;');
      writeFileSync(join(root, 'untracked.ts'), 'export const fresh = true;');
      git('rm', '--quiet', '--', 'tracked-0519.ts');
      const dirty = await captureWorktreeSnapshot(undefined, undefined, undefined, false);
      expect(dirty.porcelain).toContain('tracked-0001.ts');
      expect(dirty.porcelain).toContain(':(glob)literal.ts');
      expect(dirty.porcelain).toContain('untracked.ts');
      expect(dirty.porcelain).toContain('tracked-0519.ts');
      const dirtyCalls = readFileSync(log, 'utf8').trim().split('\n').map(Number);
      expect(dirtyCalls.length).toBeGreaterThan(1);
      expect(dirtyCalls.every(argumentCount => argumentCount <= 517)).toBe(true);
    } finally {
      setRunRoot(null);
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  }, 30_000);

  it('consumes the prepared receipt for the before snapshot and still checks after-run dirt', async () => {
    const fixture = preparedRootReceiptFixture();
    const { run, calls } = fakeGit({
      'git rev-parse HEAD': [fixture.sourceCommit, fixture.sourceCommit],
      [STATUS]: ['?? unrelated.txt'],
    });
    try {
      const before = await captureWorktreeSnapshot(run, 'before');
      expect(before).toEqual({ commit: fixture.sourceCommit, porcelain: '' });
      expect(calls.map(call => call.cmd)).toEqual(['git rev-parse HEAD']);
      expect(existsSync(fixture.receiptPath)).toBe(false);

      const after = await captureWorktreeSnapshot(run, 'after');
      expect(calls.map(call => call.cmd)).toEqual([
        'git rev-parse HEAD', 'git rev-parse HEAD', STATUS,
      ]);
      expect(after.porcelain).toBe('?? unrelated.txt');
      expect(describeWorktreeDirt(before, after)).toContain('after the run: ?? unrelated.txt');
    } finally {
      setRunRoot(null);
      vi.unstubAllEnvs();
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  });

  it('a prepared-root receipt cannot hide an after-run Git deadline failure (EI-27287737272256622)', async () => {
    const fixture = preparedRootReceiptFixture();
    const { run, calls } = fakeGit({
      'git rev-parse HEAD': [fixture.sourceCommit, fixture.sourceCommit],
      [STATUS]: WORKTREE_SNAPSHOT_GIT_BUDGETS_MS.map(() => null),
    });
    try {
      const before = await captureWorktreeSnapshot(run, 'before');
      expect(before).toEqual({ commit: fixture.sourceCommit, porcelain: '' });
      expect(existsSync(fixture.receiptPath)).toBe(false);

      const after = await captureWorktreeSnapshot(run, 'after');
      expect(after.commit).toBe(fixture.sourceCommit);
      expect(after.porcelain).toBeNull();
      expect(calls.filter(call => call.cmd === STATUS).map(call => call.timeoutMs))
        .toEqual([...WORKTREE_SNAPSHOT_GIT_BUDGETS_MS]);
      expect(computeWorktreeDirty(before, after)).toBe(true);
      expect(describeWorktreeDirt(before, after)).toBe('git status unreadable after the run');
    } finally {
      setRunRoot(null);
      vi.unstubAllEnvs();
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  });

  it('verified-source snapshots avoid Git deadlines and reject post-run source tampering (EI-27287737272256622)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'reporter-verified-source-'));
    const root = join(parent, 'source');
    mkdirSync(root);
    writeFileSync(join(root, 'subject.ts'), 'export const value = 1;');
    const files = verifierSourceFiles(root);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40), files,
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })) };
    const receiptPath = join(parent, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receiptPath);
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', receipt.sourceCommit);
    setRunRoot(root);
    const run = vi.fn(async () => null);
    try {
      const before = await captureWorktreeSnapshot(run, 'before');
      const unchanged = await captureWorktreeSnapshot(run, 'after');
      expect(before).toEqual({ commit: receipt.sourceCommit, porcelain: '' });
      expect(computeWorktreeDirty(before, unchanged)).toBe(false);
      expect(run).not.toHaveBeenCalled();

      writeFileSync(join(root, 'subject.ts'), 'export const value = 2;');
      const changed = await captureWorktreeSnapshot(run, 'after');
      expect(changed).toMatchObject({ commit: null, porcelain: null });
      expect(changed.provenanceError).toContain('tampered');
      expect(computeWorktreeDirty(before, changed)).toBe(true);
      expect(run).not.toHaveBeenCalled();
    } finally {
      setRunRoot(null);
      vi.unstubAllEnvs();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects a receipt with the wrong owner-marker digest and falls back to Git status', async () => {
    const fixture = preparedRootReceiptFixture();
    const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8'));
    receipt.ownerMarkerSha256 = '0'.repeat(64);
    writeFileSync(fixture.receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const { run, calls } = fakeGit({
      'git rev-parse HEAD': [fixture.sourceCommit],
      [STATUS]: ['?? unrelated.txt'],
    });
    try {
      const snapshot = await captureWorktreeSnapshot(run, 'before');
      expect(snapshot.porcelain).toBe('?? unrelated.txt');
      expect(calls.some(call => call.cmd === STATUS)).toBe(true);
      expect(existsSync(fixture.receiptPath)).toBe(false);
    } finally {
      setRunRoot(null);
      vi.unstubAllEnvs();
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  });

  it('a status read that times out once and then answers empty proves the tree CLEAN', async () => {
    const { run, calls } = fakeGit({ 'git rev-parse HEAD': ['abc123'], [STATUS]: [null, ''] });
    const snap = await captureWorktreeSnapshot(run);
    expect(snap).toEqual({ commit: 'abc123', porcelain: '' });
    expect(computeWorktreeDirty(snap, snap)).toBe(false);
    expect(calls.filter((c) => c.cmd === STATUS).map((c) => c.timeoutMs)).toEqual([...WORKTREE_SNAPSHOT_GIT_BUDGETS_MS]);
  });

  it('the retry gets a LARGER budget than the first attempt', () => {
    expect(WORKTREE_SNAPSHOT_GIT_BUDGETS_MS.length).toBeGreaterThanOrEqual(2);
    expect(WORKTREE_SNAPSHOT_GIT_BUDGETS_MS[1]).toBeGreaterThan(WORKTREE_SNAPSHOT_GIT_BUDGETS_MS[0]);
  });

  it('a status read that fails on EVERY attempt stays unreadable, so the run is still DIRTY (D-007)', async () => {
    const { run } = fakeGit({ 'git rev-parse HEAD': ['abc123'], [STATUS]: [null, null, null] });
    const snap = await captureWorktreeSnapshot(run);
    expect(snap.porcelain).toBeNull();
    expect(describeWorktreeDirt(snap, snap)).toBe('git status unreadable before the run');
  });

  it('a real dirty answer on the first attempt is NOT retried away', async () => {
    const { run, calls } = fakeGit({ 'git rev-parse HEAD': ['abc123'], [STATUS]: [' M peer-edit.ts', ''] });
    const snap = await captureWorktreeSnapshot(run);
    expect(snap.porcelain).toBe(' M peer-edit.ts');
    expect(computeWorktreeDirty(snap, snap)).toBe(true);
    expect(calls.filter((c) => c.cmd === STATUS)).toHaveLength(1);
  });

  it('a HEAD read that times out once is retried too', async () => {
    const { run } = fakeGit({ 'git rev-parse HEAD': [null, 'abc123'], [STATUS]: [''] });
    expect(await captureWorktreeSnapshot(run)).toEqual({ commit: 'abc123', porcelain: '' });
  });

  it('retains both failed status attempts when HEAD is readable (EI-25879692352233544)', async () => {
    const run: WorktreeGitRunner = async (cmd, _cwd, budget, failed) => {
      if (cmd !== STATUS) return 'abc123';
      failed?.(`status budget=${budget} code=128 stderr=permission denied`);
      return null;
    };
    const snap = await captureWorktreeSnapshot(run);
    const reason = describeWorktreeDirt(snap, snap);
    expect(snap).toMatchObject({ commit: 'abc123', porcelain: null });
    expect(reason).toContain('git status unreadable before the run');
    for (const budget of WORKTREE_SNAPSHOT_GIT_BUDGETS_MS) expect(reason).toContain(`budget=${budget}`);
    expect(reason).toContain('code=128 stderr=permission denied');
    expect(computeWorktreeDirty(snap, snap)).toBe(true);
  });

  it('discards failed-attempt diagnostics when the retry proves clean', async () => {
    let attempts = 0;
    const run: WorktreeGitRunner = async (cmd, _cwd, _budget, failed) => {
      if (cmd !== STATUS) return 'abc123';
      if (++attempts === 1) { failed?.('first attempt timed out'); return null; }
      return '';
    };
    const snap = await captureWorktreeSnapshot(run);
    expect(snap).toEqual({ commit: 'abc123', porcelain: '' });
    expect(describeWorktreeDirt(snap, snap)).toBeNull();
  });

  it('persists the failure diagnostic in the ledger row', async () => {
    const rows: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(
      async () => ({ commit: 'abc', porcelain: null, provenanceError: 'status code=128 stderr=denied' }),
      async row => { rows.push(row); },
    );
    await reporter.onInit({ config: { root: TEST_CONFIG_ROOT,
      configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } as never);
    reporter.onTestModuleEnd({ moduleId: join(TEST_CONFIG_ROOT, 'src/admin-test-runs-reporter.test.ts'),
      state: () => 'passed', diagnostic: () => ({ duration: 1 }), errors: () => [],
      children: { allTests: () => [{ fullName: 'Git diagnostic persistence', result: () => ({ state: 'passed' }) }] },
    } as never);
    await reporter.onTestRunEnd();
    expect(rows).toHaveLength(1);
    expect(rows[0].executionDetails).toMatchObject({ worktreeDirty: true,
      worktreeDirtyReason: 'git status unreadable before the run: status code=128 stderr=denied' });
  });
});

describe('completed Git reads across a delayed parent timer (EI-26830659784013914)', () => {
  it.skipIf(process.platform !== 'linux').each(['', '?? untracked-positive-control.ts'])
  ('retains the complete %j reading when the producer exited before timeout delivery', async output => {
    const root = mkdtempSync(join(tmpdir(), 'completed-git-read-'));
    const marker = join(root, 'exited.pid');
    const script = join(root, 'producer.cjs');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const failures: string[] = [];
    writeFileSync(script, [
      'const fs = require("node:fs");',
      'fs.writeSync(1, process.argv[3]);',
      'process.on("exit", () => fs.writeFileSync(process.argv[2], String(process.pid)));',
    ].join('\n'));
    // Observe real kernel exit while the reporter loop is blocked, then keep
    // that loop blocked beyond its deadline. The reader must own its own clock.
    const pending = runGit(
      `${quote(process.execPath)} ${quote(script)} ${quote(marker)} ${quote(output)}`,
      root, 2_000, detail => failures.push(detail),
    );
    try {
      const deadline = Date.now() + 5_000;
      let exited = false;
      while (Date.now() < deadline) {
        if (existsSync(marker)) {
          const pid = Number(readFileSync(marker, 'utf8'));
          try {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            exited = stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') exited = true;
            else throw error;
          }
          if (exited) break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      expect(exited, 'the independent producer must exit before timer delivery').toBe(true);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_100);
      expect(await pending).toBe(output);
      expect(failures).toEqual([]);
    } finally {
      await pending;
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('oversized Git status provenance (EI-26835807023614872)', () => {
  it.skipIf(process.platform === 'win32')('summarizes the complete status without losing dirty evidence or its digest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reporter-large-status-'));
    const failures: string[] = [];
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'generated'));
      for (let index = 0; index < 6_000; index++) {
        writeFileSync(join(root, 'generated', `${String(index).padStart(5, '0')}-${'x'.repeat(175)}`), '');
      }
      const raw = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'],
        { cwd: root, maxBuffer: 2 * 1024 * 1024 });
      expect(raw.byteLength).toBeGreaterThan(1024 * 1024);

      const output = await runGit('git status --porcelain --untracked-files=all', root, 10_000,
        detail => failures.push(detail));
      expect(output).not.toBeNull();
      expect(failures).toEqual([]);
      expect(output!.length).toBeLessThan(9_000);
      expect(output).toContain(`bytes=${raw.byteLength} lines=6000 sha256=${createHash('sha256').update(raw).digest('hex')}`);
      expect(output).toContain('?? generated/00000-');
      const before = { commit: 'same-commit', porcelain: '' };
      const after = { commit: 'same-commit', porcelain: output };
      expect(computeWorktreeDirty(before, after)).toBe(true);
      expect(describeWorktreeDirt(before, after)).toContain('6000 porcelain line(s) after the run');
      expect(describeWorktreeDirt(before, after)).toContain('bounded sample');

      // Exempting an intentional mutation must not erase omitted dirty paths.
      const subjectRel = `generated/00000-${'x'.repeat(175)}`;
      const exempted = exemptProbeSubject(output!, { subjectRel, nested: null });
      expect(computeWorktreeDirty(before, { ...after, porcelain: exempted })).toBe(true);
      expect(exempted).toContain('# reporter git-status summary:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('runGit failure diagnostics (EI-25879692352233544)', () => {
  it.skipIf(process.platform === 'win32')('observes Git dirt without refreshing the index even when the caller enables optional locks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reporter-read-only-git-'));
    const source = join(root, 'source.ts');
    vi.stubEnv('GIT_OPTIONAL_LOCKS', '1');
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(source, 'export const value = 1;\n');
      execFileSync('git', ['add', 'source.ts'], { cwd: root });
      execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
        'commit', '-qm', 'initial source'], { cwd: root });
      const index = join(root, '.git/index');
      const originalIndex = readFileSync(index);
      // Change only the cached stat data. Ordinary status refreshes the index;
      // a provenance observer must leave it untouched while checking the bytes.
      const changedTime = new Date(Date.now() + 2_000);
      utimesSync(source, changedTime, changedTime);
      expect(await runGit('git status --porcelain --untracked-files=all', root, 5_000)).toBe('');
      expect(readFileSync(index)).toEqual(originalIndex);

      writeFileSync(source, 'export const value = 2;\n');
      writeFileSync(join(root, 'untracked.ts'), 'new source\n');
      const output = await runGit('git status --porcelain --untracked-files=all', root, 5_000);
      expect(output).toContain('M source.ts');
      expect(output).toContain('?? untracked.ts');
      expect(readFileSync(index)).toEqual(originalIndex);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32').each(['stdout', 'stderr'] as const)(
    'bounds %s while terminating the command without throwing (EI-26096532443968552)', async stream => {
      const failures: string[] = [];
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const program = `process.${stream}.write('x'.repeat(1024 * 1024 + 1));`;
      expect(await runGit(`${quote(process.execPath)} -e ${quote(program)}`, process.cwd(), 5_000,
        detail => failures.push(detail))).toBeNull();
      expect(failures).toHaveLength(1);
      const failure = JSON.parse(failures[0]);
      expect(failure).toMatchObject({ killed: true, message: `${stream} maxBuffer length exceeded` });
      expect(failure.stderr.length).toBeLessThanOrEqual(512);
    },
  );

  it.skipIf(process.platform === 'win32')('stops Git descendants that ignore SIGTERM when the read times out (EI-26096532443968552)', async () => {
    vi.stubEnv('GIT_TRACE2_EVENT', '');
    const root = mkdtempSync(join(tmpdir(), 'git-descendant-timeout-'));
    const pidPath = join(root, 'descendant.pid');
    const script = join(root, 'blocked.cjs');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    let descendant: number | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const running = (pid: number) => {
      try {
        process.kill(pid, 0);
        // An orphan may await reaping by PID 1 after it has already stopped.
        if (process.platform === 'linux') {
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
          return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
        }
        return true;
      } catch { return false; }
    };
    writeFileSync(script, [
      'process.on("SIGTERM", () => {});',
      // A real Git alias inherits Trace2's fd. Malformed/oversized events must
      // not hide the following phase or turn a timed-out read into clean proof.
      'const fs = require("node:fs");',
      'fs.writeSync(3, "invalid-json\\n" + "x".repeat(20_000) + "\\n");',
      'const parent = "private-diagnostic-parent", child = parent + "/blocked-helper";',
      'for (const [event, sid, label] of [["region_enter", parent, "completed-parent"], ["region_enter", child, "blocked-descendant"], ["region_leave", parent, "completed-parent"]]) {',
      '  fs.writeSync(3, JSON.stringify({event,sid,thread:"main",nesting:1,category:"reporter-test",label}) + "\\n");',
      '}',
      'require("node:fs").writeFileSync(process.argv[2], String(process.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const alias = `!${quote(process.execPath)} ${quote(script)} ${quote(pidPath)}`;
    try {
      const failures: string[] = [];
      const pending = runGit(`git -c ${quote(`alias.reporter-block=${alias}`)} reporter-block`, root, 5_000,
        detail => failures.push(detail));
      const result = await Promise.race([pending, new Promise<string>(resolve => {
        deadline = setTimeout(() => resolve('reporter timeout did not settle'), 8_000);
      })]);
      descendant = Number(readFileSync(pidPath, 'utf8'));
      expect(descendant).toBeGreaterThan(0);
      expect(result).toBeNull();
      expect(failures).toHaveLength(1);
      expect(JSON.parse(failures[0])).toMatchObject({ timeoutMs: 5_000, killed: true });
      const failure = JSON.parse(failures[0]);
      expect(failure.identity).toMatchObject({ uid: process.getuid!(), gid: process.getgid!() });
      expect(failure.gitTrace.events).toBeGreaterThan(0);
      expect(failure.gitTrace.droppedLines).toBeGreaterThanOrEqual(2);
      expect(failure.gitTrace.openRegions).toContainEqual(expect.objectContaining({
        category: 'reporter-test', label: 'blocked-descendant',
      }));
      const blocked = failure.gitTrace.openRegions.find((phase: { label: string }) => phase.label === 'blocked-descendant');
      const parent = failure.gitTrace.lastEvents.find((phase: { event: string; label: string }) =>
        phase.event === 'region_leave' && phase.label === 'completed-parent');
      expect(blocked.processId).toMatch(/^[a-f0-9]{12}$/);
      expect(parent.processId).toMatch(/^[a-f0-9]{12}$/);
      expect(blocked.parentProcessId).toBe(parent.processId);
      expect(blocked.processId).not.toBe(parent.processId);
      expect(failure.gitTrace.openRegions).not.toContainEqual(expect.objectContaining({ label: 'completed-parent' }));
      expect(failure.gitTrace.rootProcessId).toMatch(/^[a-f0-9]{12}$/);
      expect(failures[0]).not.toContain('private-diagnostic-parent');
      expect(failure.gitTrace.lastEvents.length).toBeLessThanOrEqual(12);
      expect(failure.gitTrace.openRegions.length).toBeLessThanOrEqual(12);
      expect(failures[0].length).toBeLessThan(8_000);
      await vi.waitFor(() => expect(running(descendant!)).toBe(false), { timeout: 1_000, interval: 20 });
    } finally {
      if (deadline) clearTimeout(deadline);
      if (descendant === undefined) {
        try { descendant = Number(readFileSync(pidPath, 'utf8')); } catch { /* Spawn may have failed. */ }
      }
      if (descendant && running(descendant)) {
        try { process.kill(descendant, 'SIGKILL'); } catch { /* Already exited. */ }
      }
      rmSync(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }, 15_000);

  it.skipIf(process.platform === 'win32')('preserves an explicit Git trace destination and keeps it out of the reading', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-explicit-trace-'));
    const tracePath = join(root, 'trace.jsonl');
    vi.stubEnv('GIT_TRACE2_EVENT', tracePath);
    try {
      const failures: string[] = [];
      expect(await runGit('git status --porcelain', root, 5_000,
        detail => failures.push(detail))).toBeNull();
      expect(readFileSync(tracePath, 'utf8')).toContain('"event":"start"');
      expect(failures).toHaveLength(1);
      expect(JSON.parse(failures[0])).toMatchObject({ code: 128, killed: false });
      expect(JSON.parse(failures[0])).not.toHaveProperty('gitTrace');
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains a real Git exit code and bounded stderr without changing null semantics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-diagnostic-'));
    try {
      const failures: string[] = [];
      expect(await runGit('git status --porcelain', root, 5_000, detail => failures.push(detail))).toBeNull();
      expect(failures).toHaveLength(1);
      expect(JSON.parse(failures[0])).toMatchObject({ command: 'git status --porcelain',
        timeoutMs: 5_000, code: 128, killed: false, stderr: expect.stringContaining('not a git repository') });
      expect(JSON.parse(failures[0]).stderr.length).toBeLessThanOrEqual(512);
      expect(await runGit('git status --porcelain', root, 5_000, () => { throw new Error('sink unavailable'); })).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('retains a missing working-directory spawn error once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-missing-cwd-'));
    rmSync(root, { recursive: true, force: true });
    const failures: string[] = [];
    expect(await runGit('git --version', root, 5_000, detail => failures.push(detail))).toBeNull();
    expect(failures).toHaveLength(1);
    expect(JSON.parse(failures[0])).toMatchObject({ code: 'ENOENT', killed: false });
  });
});

/**
 * WI-10004952: an IN-TREE mutation probe mutates its subject inside the checkout, so
 * the snapshot used to see that subject and every in-tree row landed dirty, even from
 * a pristine as-committed clone. mutation-probe.sh now names the subject and the
 * snapshot exempts exactly that path. Real git, real files: the property is which
 * porcelain lines survive, and a stubbed reader would prove nothing.
 */
describe('WI-10004952 — an in-tree probe’s own subject is not dirt, and nothing else is exempt', () => {
  const made: string[] = [];
  const keys = ['PAPERCUSP_MUTATION_PROBE', 'PAPERCUSP_MUTATION_PROBE_SUBJECT', 'PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  function repo(prefix: string, files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    made.push(root);
    git(root, 'init', '-q');
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), body);
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    return root;
  }
  /** A superproject whose `lib` submodule holds the subject. */
  function superWithSubmodule(): { root: string; sub: string } {
    const inner = repo('pc-probe-inner-', { 'src/subject.ts': 'export const x = 1;\n' });
    const root = repo('pc-probe-super-', { 'README.md': 'x\n' });
    git(root, 'submodule', 'add', '-q', inner, 'lib');
    git(root, 'commit', '-q', '-m', 'add lib');
    return { root, sub: join(root, 'lib') };
  }
  async function snapshotAt(root: string, subject: string | null, probe = true) {
    setRunRoot(root);
    delete process.env.PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT;
    if (probe) process.env.PAPERCUSP_MUTATION_PROBE = '1';
    else delete process.env.PAPERCUSP_MUTATION_PROBE;
    if (subject) process.env.PAPERCUSP_MUTATION_PROBE_SUBJECT = subject;
    else delete process.env.PAPERCUSP_MUTATION_PROBE_SUBJECT;
    const snap = await captureWorktreeSnapshot();
    return { snap, dirty: computeWorktreeDirty(snap, snap) };
  }

  afterEach(() => {
    setRunRoot(null);
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    while (made.length) {
      try { rmSync(made.pop() as string, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('THE BUG: without the subject named, an in-tree mutant in a clean clone records dirty', async () => {
    const root = repo('pc-probe-intree-', { 'subject.ts': 'export const x = 1;\n', 'other.ts': 'y\n' });
    writeFileSync(join(root, 'subject.ts'), 'export const x = 2;\n');
    expect((await snapshotAt(root, null)).dirty).toBe(true);
  });

  it('THE FIX: the named subject is the only change, so the row proves clean at HEAD', async () => {
    const root = repo('pc-probe-intree-', { 'subject.ts': 'export const x = 1;\n', 'other.ts': 'y\n' });
    writeFileSync(join(root, 'subject.ts'), 'export const x = 2;\n');
    const { snap, dirty } = await snapshotAt(root, join(root, 'subject.ts'));
    expect(snap).toEqual({ commit: git(root, 'rev-parse', 'HEAD'), porcelain: '' });
    expect(dirty).toBe(false);
  });

  it('any OTHER modified or untracked path keeps the row dirty', async () => {
    const root = repo('pc-probe-intree-', { 'subject.ts': 'export const x = 1;\n', 'other.ts': 'y\n' });
    writeFileSync(join(root, 'subject.ts'), 'export const x = 2;\n');
    writeFileSync(join(root, 'other.ts'), 'z\n');
    writeFileSync(join(root, 'stray.ts'), 'w\n');
    const { snap, dirty } = await snapshotAt(root, join(root, 'subject.ts'));
    expect(dirty).toBe(true);
    expect(snap.porcelain).toContain('other.ts');
    expect(snap.porcelain).toContain('stray.ts');
    expect(snap.porcelain).not.toContain('subject.ts');
  });

  it('outside a probe run the subject variable is ignored', async () => {
    const root = repo('pc-probe-intree-', { 'subject.ts': 'export const x = 1;\n' });
    writeFileSync(join(root, 'subject.ts'), 'export const x = 2;\n');
    expect((await snapshotAt(root, join(root, 'subject.ts'), false)).dirty).toBe(true);
  });

  it('a DELETED subject is not the in-place edit a probe makes, so it stays dirty', async () => {
    const root = repo('pc-probe-intree-', { 'subject.ts': 'export const x = 1;\n' });
    rmSync(join(root, 'subject.ts'));
    expect((await snapshotAt(root, join(root, 'subject.ts'))).dirty).toBe(true);
  });

  it('a subject inside a submodule: exempt when the submodule sits at its pinned commit and only the subject changed', async () => {
    const { root, sub } = superWithSubmodule();
    writeFileSync(join(sub, 'src/subject.ts'), 'export const x = 2;\n');
    expect((await snapshotAt(root, null)).dirty).toBe(true);
    const { snap, dirty } = await snapshotAt(root, join(sub, 'src/subject.ts'));
    expect(snap.porcelain).toBe('');
    expect(dirty).toBe(false);
  });

  it('a subject inside a submodule with ANY other dirt in that submodule stays dirty', async () => {
    const { root, sub } = superWithSubmodule();
    writeFileSync(join(sub, 'src/subject.ts'), 'export const x = 2;\n');
    writeFileSync(join(sub, 'src/stray.ts'), 'w\n');
    expect((await snapshotAt(root, join(sub, 'src/subject.ts'))).dirty).toBe(true);
  });

  it('a submodule whose HEAD moved off the pinned gitlink stays dirty even if only the subject is modified', async () => {
    const { root, sub } = superWithSubmodule();
    writeFileSync(join(sub, 'src/later.ts'), 'v\n');
    git(sub, 'add', '-A');
    git(sub, 'commit', '-q', '-m', 'moves HEAD off the gitlink');
    writeFileSync(join(sub, 'src/subject.ts'), 'export const x = 2;\n');
    expect((await snapshotAt(root, join(sub, 'src/subject.ts'))).dirty).toBe(true);
  });

  it('parses the trimmed FIRST porcelain line the same as the rest (runGit trims stdout)', () => {
    const ex = { subjectRel: 'a/subject.ts', nested: null };
    expect(exemptProbeSubject('M a/subject.ts\n M b/other.ts', ex)).toBe(' M b/other.ts');
    expect(exemptProbeSubject('M b/other.ts\n M a/subject.ts', ex)).toBe('M b/other.ts');
    expect(exemptProbeSubject('?? a/subject.ts', ex)).toBe('?? a/subject.ts');
  });
});
