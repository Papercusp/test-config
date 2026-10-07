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
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdminTestRunsReporter, {
  buildOutputTail,
  captureWorktreeSnapshot,
  collectModuleExecution,
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
  readRunConfigRoot,
  setRunRoot,
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
  resolveWorktreeSnapshotRoot,
  shouldRecordTestRunPath,
  TEST_RUN_INSERT_BATCH_SIZE,
  TEST_RUN_RECEIPT_ENV,
  appendTestRunReceipts,
  reporterWriteBudget,
  type PgSql,
  type TestRunRow,
} from './admin-test-runs-reporter';

const TEST_CONFIG_ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('durable module execution measurement', () => {
  const module = (states: string[], state = 'passed') => ({
    state: () => state,
    children: { allTests: () => states.map(s => ({ result: () => ({ state: s }) })) },
  }) as unknown as Parameters<typeof collectModuleExecution>[0];

  it('counts all cases, including mixed skips and failures', () => {
    expect(collectModuleExecution(module(['passed', 'passed', 'skipped', 'failed'], 'failed')))
      .toEqual({ passed: 2, failed: 1, skipped: 1, collectionFailed: false });
  });
  it('records requested late passing identities within the cap without crediting skipped or failed cases', () => {
    const cases = Array.from({ length: 80 }, (_, i) => ({
      fullName: `suite > proof-${i}`,
      result: () => ({ state: i === 78 ? 'skipped' : i === 79 ? 'failed' : 'passed' }),
    }));
    const measured = collectModuleExecution({
      state: () => 'failed', children: { allTests: () => cases },
    } as never, /proof-(70|78|79)$/g);
    expect(measured).toMatchObject({ passed: 78, failed: 1, skipped: 1, collectionFailed: false });
    expect(measured?.passedCaseTitles).toHaveLength(64);
    expect(measured?.passedCaseTitles?.[0]).toBe('suite > proof-70');
    expect(measured?.passedCaseTitles).not.toContain('suite > proof-78');
    expect(measured?.passedCaseTitles).not.toContain('suite > proof-79');
    expect(measured?.failedCaseTitles).toEqual(['suite > proof-79']);
    expect(collectModuleExecution({ state: () => 'failed', children: { allTests: () => cases } } as never)
      ?.passedCaseTitles).not.toContain('suite > proof-70');
  });
  it('persists a preferred late identity while running the whole module', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUN_CASE_TITLE_PATTERN', 'late-proof$');
    const rows: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }),
      async row => { rows.push(row); });
    try {
      reporter.onInit({ config: { root: TEST_CONFIG_ROOT }, vite: { config: { root: TEST_CONFIG_ROOT } } } as never);
      const cases = Array.from({ length: 80 }, (_, i) => ({
        fullName: i === 79 ? 'suite > late-proof' : `suite > case-${i}`,
        result: () => ({ state: 'passed' }),
      }));
      reporter.onTestModuleEnd({ state: () => 'passed', children: { allTests: () => cases },
        moduleId: join(TEST_CONFIG_ROOT, 'src/admin-test-runs-reporter.test.ts'),
        diagnostic: () => ({ duration: 1 }), errors: () => [],
      } as never);
      await reporter.onTestRunEnd();
      expect(rows[0].executionDetails).toMatchObject({ passed: 80, failed: 0, skipped: 0, testNamePattern: null });
      expect(rows[0].executionDetails?.passedCaseTitles).toHaveLength(64);
      expect(rows[0].executionDetails?.passedCaseTitles?.[0]).toBe('suite > late-proof');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('retains a failed collection even without a failed assertion', () => {
    expect(collectModuleExecution(module(['skipped'], 'failed')))
      .toEqual({ passed: 0, failed: 0, skipped: 1, collectionFailed: true });
  });
  it('does not invent measurements for pending or unreadable cases', () => {
    expect(collectModuleExecution(module(['passed', 'pending']))).toBeNull();
    expect(collectModuleExecution({ state: () => 'passed' } as never)).toBeNull();
    expect(collectModuleExecution(module(['passed'], 'pending'))).toBeNull();
  });
  it('writes the captured run scope and counts on the same terminal row', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUN_GROUP', 'ca5fce52-7c67-4d38-8c26-96a952f6a2a2');
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'ws-count-proof');
    vi.stubEnv('PAPERCUSP_TEST_RUN_HARNESS', 'count-proof');
    const rows: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }),
      async row => { rows.push(row); });
    try {
      reporter.onInit({ config: { root: TEST_CONFIG_ROOT, testNamePattern: /selected case/ },
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
    reporter.onInit({ config: { root: TEST_CONFIG_ROOT }, vite: { config: { root: TEST_CONFIG_ROOT } } } as never);
    reporter.onTestModuleEnd(fakeModule as never);
    await reporter.onTestRunEnd();
    expect(rows).toHaveLength(1);
    expect(rows[0].outputTail).toHaveLength(4_000);
    for (const name of names) expect(rows[0].outputTail).not.toContain(name);
    expect(rows[0].executionDetails).toMatchObject({
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
    process.env = { ...saved };
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
    reporter.onInit({ config: { provide: { papercuspTestLayer: 'browser' } },
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

  it('onInit is a no-op even with a bogus ctx', () => {
    const r = new AdminTestRunsReporter();
    expect(() => r.onInit(null as never)).not.toThrow();
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
    r.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
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

    it('pairs RETURNING ids to rows by file path, not by position', async () => {
      const sql = fakeSql(async () => [
        { id: '902', file_path: 'b.test.ts' },
        { id: '901', file_path: 'a.test.ts' },
      ]);
      const receipts = await insertTestRunRowsWithSql(sql, [row('a.test.ts'), row('b.test.ts', 'pass')], context);
      expect(receipts).toEqual([
        { filePath: 'a.test.ts', status: 'fail', outcome: 'inserted', id: '901' },
        { filePath: 'b.test.ts', status: 'pass', outcome: 'inserted', id: '902' },
      ]);
    });

    it('reports a batch that outlives its budget as timeout instead of silently dropping it', async () => {
      const sql = fakeSql(() => new Promise(() => {}));
      const receipts = await insertTestRunRowsWithSql(sql, [row('a.test.ts')], context, {
        insertTimeoutMs: 20, totalInsertMs: 1_000,
      });
      expect(receipts).toEqual([
        { filePath: 'a.test.ts', status: 'fail', outcome: 'timeout', reason: 'pg_insert_timeout_20ms' },
      ]);
    });

    it('reports a rejected insert as failed with the reason', async () => {
      const sql = fakeSql(async () => { throw new Error('remaining connection slots are reserved'); });
      const receipts = await insertTestRunRowsWithSql(sql, [row('a.test.ts')], context, {
        insertTimeoutMs: 1_000, totalInsertMs: 1_000,
      });
      expect(receipts).toEqual([
        { filePath: 'a.test.ts', status: 'fail', outcome: 'failed', reason: 'remaining connection slots are reserved' },
      ]);
    });

    it('marks a returned row set that omits a file as failed, never as inserted', async () => {
      const sql = fakeSql(async () => []);
      const receipts = await insertTestRunRowsWithSql(sql, [row('a.test.ts')], context);
      expect(receipts).toEqual([
        { filePath: 'a.test.ts', status: 'fail', outcome: 'failed', reason: 'insert_returned_no_id' },
      ]);
    });

    it('appends receipts as JSON lines only when the receipt file is named', () => {
      const dir = mkdtempSync(join(tmpdir(), 'test-run-receipts-'));
      try {
        const file = join(dir, 'receipts.jsonl');
        const receipt = { filePath: 'a.test.ts', status: 'fail', outcome: 'inserted' as const, id: '7' };
        appendTestRunReceipts({}, [receipt]);
        expect(() => readFileSync(file, 'utf8')).toThrow();
        appendTestRunReceipts({ [TEST_RUN_RECEIPT_ENV]: file }, [receipt, { ...receipt, id: '8' }]);
        expect(readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
          receipt,
          { ...receipt, id: '8' },
        ]);
        // Fail-soft: an unwritable receipt path never throws out of the reporter.
        expect(() => appendTestRunReceipts({ [TEST_RUN_RECEIPT_ENV]: join(dir, 'missing', 'x.jsonl') }, [receipt])).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('keeps the 1s fail-soft budget for ordinary runs and widens it only for evidence runs', () => {
      expect(reporterWriteBudget({})).toEqual({
        connectTimeoutSec: 1, insertTimeoutMs: 1_000, totalInsertMs: 4_500, flushBudgetMs: 5_000,
      });
      const evidence = reporterWriteBudget({ [TEST_RUN_RECEIPT_ENV]: '/tmp/r.jsonl' });
      expect(evidence.insertTimeoutMs).toBeGreaterThan(1_000);
      expect(evidence.flushBudgetMs).toBeGreaterThan(evidence.totalInsertMs);
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
      r.onInit({ config: { root: TEST_CONFIG_ROOT }, vite: { config: { root: TEST_CONFIG_ROOT } } } as never);
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

  it('writes and merges optional structured failure details across reporter groups', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-reporter-details-'));
    const detailsPath = join(dir, 'failure-details.json');
    const previous = process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH;
    process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH = detailsPath;
    const makeReporter = () =>
      new AdminTestRunsReporter(
        async () => ({ commit: 'abc', porcelain: '' }),
        async () => undefined,
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
      first.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
      first.onTestModuleEnd(makeModule('src/first.test.ts', 'first', 'actual-a', 'expected-a') as never);
      await first.onTestRunEnd();

      const second = makeReporter();
      second.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
      second.onTestModuleEnd(makeModule('src/second.test.ts', 'second', 'actual-b', 'expected-b') as never);
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
      reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
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
      reporter.onInit({ vite: { config: { configFile: join(TEST_CONFIG_ROOT, 'vitest.config.ts') } } } as never);
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

  it('onInit (EI-18767688096795873): wires computeIsScratchConfig without throwing, even on a bogus ctx', () => {
    const r = new AdminTestRunsReporter();
    const fakeCtx = { vite: { config: { configFile: '/tmp/mutant-xyz/vitest.mutant.config.ts' } } } as unknown as Parameters<typeof r.onInit>[0];
    expect(() => r.onInit(fakeCtx)).not.toThrow();
    expect(() => r.onInit(null as never)).not.toThrow();
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
    r.onInit({ vite: { config: { configFile: `${process.cwd()}/vitest.config.ts` } } } as never);
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
    r.onInit({ vite: { config: { configFile: `${process.cwd()}/vitest.config.ts` } } } as never);
    r.onTestModuleEnd({
      moduleId: join(process.cwd(), 'src/admin-test-runs-reporter.test.ts'),
      state: () => 'passed',
      diagnostic: () => ({ duration: 12 }),
      errors: () => [],
    } as unknown as Parameters<typeof r.onTestModuleEnd>[0]);

    await r.onTestRunEnd();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].worktreeDirty).toBe(false);
    expect(persisted[0].commitSha).toBe('abc');
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
      r.onInit({ vite: { config: { configFile: `${process.cwd()}/vitest.config.ts` } } } as never);
      r.onTestModuleEnd({
        moduleId: join(process.cwd(), 'src/admin-test-runs-reporter.test.ts'),
        state: () => 'passed',
        diagnostic: () => ({ duration: 12 }),
        errors: () => [],
      } as unknown as Parameters<typeof r.onTestModuleEnd>[0]);

      await r.onTestRunEnd();
      const lines = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((s) => s.startsWith('[admin-test-runs]'));
      expect(lines).toEqual(expectLine
        ? ['[admin-test-runs] 1 row(s) recorded source=local, not ci: worktree not proven stable — 1 porcelain line(s) after the run: ?? leaked-by-a-test.json\n']
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

  it('onInit pins the run root BEFORE anything else in it reads a root', () => {
    const sibling = checkout('oninit');
    const r = new AdminTestRunsReporter();
    r.onInit({
      config: { root: sibling },
      vite: { config: { configFile: join(sibling, 'vitest.config.ts') } },
    } as never);
    expect(toWorkspaceRel(join(sibling, 'tests', 'b.test.ts'))).toBe('tests/b.test.ts');
  });

  it('fail-soft: a ctx carrying no root clears the run root, restoring cwd behaviour', () => {
    const sibling = checkout('nofix');
    setRunRoot(sibling);
    const r = new AdminTestRunsReporter();
    expect(() => r.onInit({ vite: { config: { configFile: 'x' } } } as never)).not.toThrow();
    expect(toWorkspaceRel(join(sibling, 'tests', 'c.test.ts')).startsWith('../')).toBe(true);
    expect(() => r.onInit(null as never)).not.toThrow();
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
  const STATUS = 'git status --porcelain --untracked-files=all';
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
