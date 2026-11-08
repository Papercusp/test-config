/**
 * test-rubric-unification-2026-10-12 P-001 (R-1): per-case records from the Vitest reporter.
 *
 * Unit layer for the two pieces the real-Postgres test (test-case-runs.integration.test.ts)
 * exercises end to end: reading every case out of a TestModule, and writing case rows behind
 * their file rows without ever costing the file rows (D-007).
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendTestRunReceipts,
  collectTestCases,
  TEST_RUN_INSERT_BATCH_SIZE,
  insertTestCaseRowsWithSql,
  insertTestRunRowsWithSql,
  latestTestRunReceipts,
  TEST_RUN_RECEIPT_ENV,
  TEST_CASE_ERROR_TAIL_MAX_CHARS,
  TEST_CASE_INSERT_BATCH_SIZE,
  type PgSql,
  type TestCaseInsertOutcome,
  type TestCaseRecord,
  type TestRunRow,
} from './admin-test-runs-reporter.ts';

type FakeCase = {
  fullName?: string;
  result: () => { state: string; errors?: unknown[]; note?: string };
  diagnostic?: () => { duration?: number } | undefined;
};

const moduleOf = (cases: FakeCase[], state = 'passed') =>
  ({ state: () => state, children: { allTests: () => cases } }) as unknown as Parameters<typeof collectTestCases>[0];

describe('collectTestCases', () => {
  it('records every case in module order with its title path, status, duration and diagnostic tail', () => {
    const cases = collectTestCases(moduleOf([
      { fullName: 'suite > passes', result: () => ({ state: 'passed' }), diagnostic: () => ({ duration: 3.6 }) },
      {
        fullName: 'suite > fails',
        result: () => ({ state: 'failed', errors: [{ message: 'expected 1 to be 2' }, { message: 'second error' }] }),
        diagnostic: () => ({ duration: 1 }),
      },
      {
        fullName: 'suite > skipped',
        result: () => ({ state: 'skipped', note: 'provider refused TEST_FILE_NAME_FILTER_NO_MATCH testsExecuted=0' }),
        diagnostic: () => undefined,
      },
    ], 'failed'));
    expect(cases).toEqual<TestCaseRecord[]>([
      { caseIndex: 0, caseKey: 'suite > passes', occurrence: 1, status: 'pass', durationMs: 4, errorTail: null },
      { caseIndex: 1, caseKey: 'suite > fails', occurrence: 1, status: 'fail', durationMs: 1, errorTail: 'expected 1 to be 2' },
      {
        caseIndex: 2, caseKey: 'suite > skipped', occurrence: 1, status: 'skip', durationMs: null,
        errorTail: 'provider refused TEST_FILE_NAME_FILTER_NO_MATCH testsExecuted=0',
      },
    ]);
  });

  it('numbers parameterized cases that share a title path instead of collapsing them', () => {
    const cases = collectTestCases(moduleOf([
      { fullName: 'suite > each', result: () => ({ state: 'passed' }) },
      { fullName: 'suite > each', result: () => ({ state: 'failed', errors: [{ message: 'boom' }] }) },
      { fullName: 'suite > other', result: () => ({ state: 'passed' }) },
      { fullName: 'suite > each', result: () => ({ state: 'passed' }) },
    ], 'failed'));
    expect(cases?.map(({ caseKey, occurrence, status }) => [caseKey, occurrence, status])).toEqual([
      ['suite > each', 1, 'pass'],
      ['suite > each', 2, 'fail'],
      ['suite > other', 1, 'pass'],
      ['suite > each', 3, 'pass'],
    ]);
  });

  it('bounds a failure tail to the column limit', () => {
    const [failed] = collectTestCases(moduleOf([
      { fullName: 'suite > long', result: () => ({ state: 'failed', errors: [{ message: 'x'.repeat(5_000) }] }) },
    ], 'failed')) ?? [];
    expect(failed?.errorTail?.length).toBeLessThanOrEqual(TEST_CASE_ERROR_TAIL_MAX_CHARS);
    expect(failed?.errorTail?.length).toBeGreaterThan(0);
  });

  it('returns null rather than a partial list when a case is still pending', () => {
    expect(collectTestCases(moduleOf([
      { fullName: 'suite > done', result: () => ({ state: 'passed' }) },
      { fullName: 'suite > pending', result: () => ({ state: 'pending' }) },
    ]))).toBeNull();
  });

  it('never throws: an unreadable module yields null', () => {
    const throwing = { state: () => 'passed', children: { allTests: () => { throw new Error('torn'); } } };
    expect(collectTestCases(throwing as never)).toBeNull();
    expect(collectTestCases({ state: () => { throw new Error('gone'); } } as never)).toBeNull();
  });
});

describe('case rows ride behind their file rows', () => {
  const at = new Date('2026-10-12T21:00:00.000Z');
  const context = {
    branch: 'staging', inferredCommit: null, declaredSource: 'local' as const, runGroupId: null,
    harnessSlug: null, workspaceId: null, loopLagP95Ms: null, rssMb: null,
  };
  const testCase = (caseIndex: number, status: TestCaseRecord['status'] = 'pass'): TestCaseRecord => ({
    caseIndex, caseKey: `suite > case ${caseIndex}`, occurrence: 1, status, durationMs: 2, errorTail: null,
  });
  const row = (filePath: string, cases: TestCaseRecord[] | null): TestRunRow => ({
    filePath, status: 'pass', durationMs: 5, startedAt: at, finishedAt: at, outputTail: null,
    isScratchConfig: false, worktreeDirty: false, commitSha: 'abc123', executionDetails: null, cases,
  });

  /**
   * A fake postgres-js client. The bulk helper call (`sql(rows, ...columns)`) records its rows;
   * each tagged-template statement resolves through `respond(table)`.
   */
  function fakeSql(respond: (table: 'test_runs' | 'test_case_runs', rows: Record<string, unknown>[]) => Promise<unknown>) {
    const statements: Array<{ table: 'test_runs' | 'test_case_runs'; rows: Record<string, unknown>[]; columns: string[] }> = [];
    let pendingRows: Record<string, unknown>[] = [];
    let pendingColumns: string[] = [];
    const sql = Object.assign(
      (first: unknown, ...rest: unknown[]) => {
        if (Array.isArray(first) && !('raw' in (first as object))) {
          pendingRows = first as Record<string, unknown>[];
          pendingColumns = rest as string[];
          return {};
        }
        const text = (first as TemplateStringsArray).join(' ');
        const table = text.includes('test_case_runs') ? 'test_case_runs' as const : 'test_runs' as const;
        statements.push({ table, rows: pendingRows, columns: pendingColumns });
        return respond(table, pendingRows);
      },
      { end: async () => undefined },
    ) as unknown as PgSql;
    return { sql, statements };
  }

  const returningIds = (rows: Record<string, unknown>[]) =>
    Promise.resolve(rows.map((r, i) => ({ id: String(100 + i), file_path: r.file_path })));

  it('writes each file row first, then its cases keyed to the returned id', async () => {
    const fake = fakeSql((table, rows) => (table === 'test_runs' ? returningIds(rows) : Promise.resolve([])));
    const outcomes: TestCaseInsertOutcome[] = [];
    const receipts = await insertTestRunRowsWithSql(fake.sql,
      [row('a.test.ts', [testCase(0), testCase(1, 'fail')]), row('b.test.ts', null), row('c.test.ts', [testCase(0)])],
      context, { insertTimeoutMs: 1_000, totalInsertMs: 4_000 }, (outcome) => outcomes.push(outcome));
    expect(receipts.map((r) => r.outcome)).toEqual(['inserted', 'inserted', 'inserted']);
    expect(fake.statements.map((s) => s.table)).toEqual(['test_runs', 'test_case_runs']);
    const caseStatement = fake.statements[1]!;
    expect(caseStatement.columns).toEqual(
      ['test_run_id', 'case_index', 'case_key', 'occurrence', 'status', 'duration_ms', 'error_tail']);
    expect(caseStatement.rows.map((r) => [r.test_run_id, r.case_index, r.status])).toEqual([
      ['100', 0, 'pass'], ['100', 1, 'fail'], ['102', 0, 'pass'],
    ]);
    expect(outcomes).toEqual([{ written: 3, unwritten: 0, reason: null }]);
  });

  it('keeps the file receipts when the ledger predates the case table', async () => {
    const missing = Object.assign(new Error('relation "harness_shared.test_case_runs" does not exist'), { code: '42P01' });
    const fake = fakeSql((table, rows) => (table === 'test_runs' ? returningIds(rows) : Promise.reject(missing)));
    const outcomes: TestCaseInsertOutcome[] = [];
    const receipts = await insertTestRunRowsWithSql(fake.sql, [row('a.test.ts', [testCase(0)])], context,
      { insertTimeoutMs: 1_000, totalInsertMs: 4_000 }, (outcome) => outcomes.push(outcome));
    // Receipts carry their identity (receiptId + attempt) and the serialized row since the
    // reporter's receipt-identity change; the file receipt itself must still be `inserted`.
    // insertDiagnostics is pinned by admin-test-runs-reporter.test.ts. Matching it here coupled
    // this missing-case-table test to the reporter's diagnostics revision, so the frozen repair
    // lineage (whose reporter predates insertDiagnostics) failed it for an unrelated reason.
    expect(receipts).toEqual([expect.objectContaining({
      filePath: 'a.test.ts', status: 'pass', outcome: 'inserted', id: '100',
      receiptId: expect.any(String), attempt: 0,
      row: expect.objectContaining({ filePath: 'a.test.ts', status: 'pass' }),
    })]);
    expect(outcomes).toEqual([{ written: 0, unwritten: 1, reason: 'test_case_runs_missing' }]);
  });

  it('reports omitted cases at the file deadline without queueing writes after late RETURNING', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'case-receipt-late-'));
    const file = join(dir, 'receipts.jsonl');
    vi.stubEnv(TEST_RUN_RECEIPT_ENV, file);
    let resolveInsert!: (value: unknown) => void;
    const fake = fakeSql(() => new Promise(resolve => { resolveInsert = resolve; }));
    const outcomes: TestCaseInsertOutcome[] = [];
    try {
      const pending = insertTestRunRowsWithSql(fake.sql, [row('a.test.ts', [testCase(0)])], context,
        { insertTimeoutMs: 20, totalInsertMs: 1_000 }, (outcome) => outcomes.push(outcome));
      await vi.advanceTimersByTimeAsync(999);
      expect(outcomes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const receipts = await pending;
      appendTestRunReceipts(process.env, receipts);
      expect(receipts[0]).toMatchObject({ outcome: 'timeout',
        caseInsertOutcome: { written: 0, unwritten: 1, reason: 'file_insert_timeout' } });
      expect(outcomes).toEqual([{ written: 0, unwritten: 1, reason: 'file_insert_timeout' }]);
      resolveInsert([{ id: '100', file_path: 'a.test.ts' }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(latestTestRunReceipts(readFileSync(file, 'utf8'))[0]).toMatchObject({
        outcome: 'inserted', id: '100',
        caseInsertOutcome: { written: 0, unwritten: 1, reason: 'file_insert_timeout' },
      });
      expect(fake.statements.map(s => s.table)).toEqual(['test_runs']);
      expect(outcomes).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('includes earlier acknowledged files and later unattempted files when a file batch times out', async () => {
    vi.useFakeTimers();
    let batches = 0;
    const fake = fakeSql((_table, rows) => ++batches === 1 ? returningIds(rows) : new Promise(() => {}));
    const outcomes: TestCaseInsertOutcome[] = [];
    const rows = Array.from({ length: TEST_RUN_INSERT_BATCH_SIZE * 2 + 1 }, (_, i) => row(`${i}.test.ts`, [testCase(0)]));
    try {
      const pending = insertTestRunRowsWithSql(fake.sql, rows, context,
        { insertTimeoutMs: 20, totalInsertMs: 1_000 }, outcome => outcomes.push(outcome));
      await vi.advanceTimersByTimeAsync(1_000);
      const receipts = await pending;
      expect(receipts.filter(receipt => receipt.outcome === 'inserted')).toHaveLength(TEST_RUN_INSERT_BATCH_SIZE);
      expect(fake.statements.map(s => s.table)).toEqual(['test_runs', 'test_runs']);
      expect(outcomes).toEqual([{ written: 0, unwritten: rows.length, reason: 'file_insert_timeout' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports cases whose file INSERT failed or returned no id', async () => {
    const failed = fakeSql(() => Promise.reject(new Error('file insert failed')));
    const missing = fakeSql(() => Promise.resolve([]));
    for (const [fake, reason] of [[failed, 'file_insert_failed'], [missing, 'file_insert_unacknowledged']] as const) {
      const outcomes: TestCaseInsertOutcome[] = [];
      const receipts = await insertTestRunRowsWithSql(fake.sql, [row('a.test.ts', [testCase(0)])], context,
        { insertTimeoutMs: 20, totalInsertMs: 1_000 }, outcome => outcomes.push(outcome));
      expect(receipts[0]?.outcome).toBe('failed');
      expect(receipts[0]).toHaveProperty('caseInsertOutcome', { written: 0, unwritten: 1, reason });
      expect(fake.statements.map(s => s.table)).toEqual(['test_runs']);
      expect(outcomes).toEqual([{ written: 0, unwritten: 1, reason }]);
    }
  });

  it('counts missing file ids alongside acknowledged case rows', async () => {
    const fake = fakeSql((table) => Promise.resolve(table === 'test_runs' ? [{ id: '100', file_path: 'a.test.ts' }] : []));
    const outcomes: TestCaseInsertOutcome[] = [];
    const receipts = await insertTestRunRowsWithSql(fake.sql,
      [row('a.test.ts', [testCase(0)]), row('b.test.ts', [testCase(0), testCase(1)])], context,
      { insertTimeoutMs: 20, totalInsertMs: 1_000 }, outcome => outcomes.push(outcome));
    expect(receipts.map(receipt => receipt.outcome)).toEqual(['inserted', 'failed']);
    expect(fake.statements.map(s => s.table)).toEqual(['test_runs', 'test_case_runs']);
    expect(outcomes).toEqual([{ written: 1, unwritten: 2, reason: 'file_insert_unacknowledged' }]);
  });

  it('preserves per-file case acknowledgement through receipt readback without inferring it from file PASS', async () => {
    const fake = fakeSql(table => Promise.resolve(table === 'test_runs'
      ? [{ id: '100', file_path: 'a.test.ts' }, { id: '102', file_path: 'c.test.ts' }] : []));
    const receipts = await insertTestRunRowsWithSql(fake.sql,
      [row('a.test.ts', [testCase(0)]), row('b.test.ts', [testCase(0), testCase(1)]), row('c.test.ts', null)],
      context, { insertTimeoutMs: 20, totalInsertMs: 1_000 }, () => {});
    const readback = latestTestRunReceipts(receipts.map(receipt => JSON.stringify(receipt)).join('\n'));
    expect(readback[0]).toMatchObject({ outcome: 'inserted',
      caseInsertOutcome: { written: 1, unwritten: 0, reason: null } });
    expect(readback[1]).toMatchObject({ outcome: 'failed',
      caseInsertOutcome: { written: 0, unwritten: 2, reason: 'file_insert_unacknowledged' } });
    expect(readback[2]).not.toHaveProperty('caseInsertOutcome');
    expect(fake.statements.map(statement => statement.table)).toEqual(['test_runs', 'test_case_runs']);
  });

  it('attributes an acknowledged case prefix to the correct file receipts when a later batch times out', async () => {
    vi.useFakeTimers();
    let caseBatches = 0;
    const fake = fakeSql((table, rows) => table === 'test_runs' ? returningIds(rows)
      : ++caseBatches === 1 ? Promise.resolve([]) : new Promise(() => {}));
    try {
      const pending = insertTestRunRowsWithSql(fake.sql,
        [row('a.test.ts', [testCase(0)]),
          row('b.test.ts', Array.from({ length: TEST_CASE_INSERT_BATCH_SIZE + 1 }, (_, index) => testCase(index)))],
        context, { insertTimeoutMs: 20, totalInsertMs: 1_000 }, () => {});
      await vi.advanceTimersByTimeAsync(20);
      const receipts = await pending;
      expect(receipts.map(receipt => receipt.outcome)).toEqual(['inserted', 'inserted']);
      expect(receipts.map(receipt => receipt.caseInsertOutcome)).toEqual([
        { written: 1, unwritten: 0, reason: null },
        { written: TEST_CASE_INSERT_BATCH_SIZE - 1, unwritten: 2, reason: 'pg_insert_timeout_20ms' },
      ]);
      expect(fake.statements.map(statement => statement.table)).toEqual(['test_runs', 'test_case_runs', 'test_case_runs']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('splits large case sets into bounded statements and stops at the deadline', async () => {
    const many = Array.from({ length: TEST_CASE_INSERT_BATCH_SIZE + 1 }, (_, i) => testCase(i));
    const ok = fakeSql(() => Promise.resolve([]));
    expect(await insertTestCaseRowsWithSql(ok.sql, [{ testRunId: '7', cases: many }],
      { deadline: Date.now() + 5_000, insertTimeoutMs: 1_000 }))
      .toEqual({ written: TEST_CASE_INSERT_BATCH_SIZE + 1, unwritten: 0, reason: null });
    expect(ok.statements.map((s) => s.rows.length)).toEqual([TEST_CASE_INSERT_BATCH_SIZE, 1]);

    const late = fakeSql(() => Promise.resolve([]));
    expect(await insertTestCaseRowsWithSql(late.sql, [{ testRunId: '7', cases: many }],
      { deadline: Date.now() - 1, insertTimeoutMs: 1_000 }))
      .toEqual({ written: 0, unwritten: TEST_CASE_INSERT_BATCH_SIZE + 1, reason: 'flush_deadline' });
    expect(late.statements).toEqual([]);
  });

  it('retains safe driver progress at the file deadline without a receipt sink or another write', async () => {
    vi.useFakeTimers();
    vi.stubEnv(TEST_RUN_RECEIPT_ENV, '');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let resolveInsert!: (value: unknown) => void;
    const query = Object.assign(new Promise(resolve => { resolveInsert = resolve; }), {
      state: { pid: 321, cancelKey: 654 },
      executed: true,
      active: true,
      resultDiagnostic: { rowCount: 0, wireBytes: 12 },
    });
    const fake = fakeSql(() => query);
    try {
      const pending = insertTestRunRowsWithSql(fake.sql, [row('a.test.ts', [testCase(0)])],
        { ...context, runGroupId: 'file-write-run' }, { insertTimeoutMs: 20, totalInsertMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      const receipts = await pending;
      expect(receipts[0]).toMatchObject({ outcome: 'timeout', replayable: false,
        caseInsertOutcome: { written: 0, unwritten: 1, reason: 'file_insert_timeout' } });
      const fileLine = stderr.mock.calls.map(call => String(call[0]))
        .find(line => line.startsWith('[admin-test-runs] file-write '));
      expect(fileLine).toBeDefined();
      const diagnostic = JSON.parse(fileLine!.slice('[admin-test-runs] file-write '.length));
      expect(diagnostic).toMatchObject({ schemaVersion: 1, runGroupId: 'file-write-run',
        outcome: 'timeout', affectedFiles: 1, reason: 'pg_insert_timeout_1000ms', replayable: false,
        insertDiagnostics: { backendPid: 321, settledAt: null, budgetMs: 1_000,
          driverState: { executed: true, active: true, resultRowCount: 0, resultWireBytes: 12 } } });
      expect(diagnostic.insertDiagnostics).toEqual(receipts[0]?.insertDiagnostics);
      expect(fileLine).not.toContain('cancelKey');
      expect(fileLine).not.toContain('a.test.ts');
      expect(fileLine).not.toContain('suite >');
      expect(fake.statements.map(statement => statement.table)).toEqual(['test_runs']);
    } finally {
      resolveInsert([{ id: '100', file_path: 'a.test.ts' }]);
      await vi.advanceTimersByTimeAsync(0);
      stderr.mockRestore();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it('keeps a timed-out file unacknowledged when its diagnostic sink throws', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('closed stderr'); });
    let resolveInsert!: (value: unknown) => void;
    const fake = fakeSql(() => new Promise(resolve => { resolveInsert = resolve; }));
    try {
      const pending = insertTestRunRowsWithSql(fake.sql, [row('a.test.ts', null)], context,
        { insertTimeoutMs: 20, totalInsertMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual([expect.objectContaining({ outcome: 'timeout', replayable: false })]);
      expect(fake.statements.map(statement => statement.table)).toEqual(['test_runs']);
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      resolveInsert([{ id: '100', file_path: 'a.test.ts' }]);
      await vi.advanceTimersByTimeAsync(0);
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reports a committed case prefix when the shared deadline expires before the next batch', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const started = Date.now();
      const many = Array.from({ length: TEST_CASE_INSERT_BATCH_SIZE + 1 }, (_, i) => testCase(i));
      const fake = fakeSql((table, rows) => {
        if (table === 'test_runs') return returningIds(rows);
        vi.setSystemTime(started + 1_000);
        return Promise.resolve([]);
      });
      // Omit the observer exactly as production insertRows does.
      const receipts = await insertTestRunRowsWithSql(fake.sql, [row('a.test.ts', many)],
        { ...context, runGroupId: 'case-write-run', harnessSlug: 'papercusp', workspaceId: 'test-workspace' },
        { insertTimeoutMs: 20, totalInsertMs: 1_000 });
      expect(receipts).toEqual([expect.objectContaining({ outcome: 'inserted', id: '100' })]);
      expect(fake.statements.map(s => [s.table, s.rows.length])).toEqual([
        ['test_runs', 1], ['test_case_runs', TEST_CASE_INSERT_BATCH_SIZE],
      ]);
      expect(stderr).toHaveBeenCalledTimes(1);
      const line = String(stderr.mock.calls[0]?.[0]);
      expect(line).toMatch(/^\[admin-test-runs\] case-write /);
      expect(JSON.parse(line.slice('[admin-test-runs] case-write '.length))).toEqual({
        schemaVersion: 1, runGroupId: 'case-write-run', harnessSlug: 'papercusp', workspaceId: 'test-workspace',
        acknowledgedCases: TEST_CASE_INSERT_BATCH_SIZE, unacknowledgedCases: 1, reason: 'flush_deadline',
      });
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reports only acknowledged cases when a later case batch times out, without replaying it', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const many = Array.from({ length: TEST_CASE_INSERT_BATCH_SIZE + 1 }, (_, i) => testCase(i));
      let caseBatches = 0;
      const fake = fakeSql((table, rows) => table === 'test_runs' ? returningIds(rows)
        : ++caseBatches === 1 ? Promise.resolve([]) : new Promise(() => {}));
      const pending = insertTestRunRowsWithSql(fake.sql, [row('a.test.ts', many)], context,
        { insertTimeoutMs: 20, totalInsertMs: 1_000 });
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toEqual([expect.objectContaining({ outcome: 'inserted', id: '100' })]);
      expect(fake.statements.map(s => [s.table, s.rows.length])).toEqual([
        ['test_runs', 1], ['test_case_runs', TEST_CASE_INSERT_BATCH_SIZE], ['test_case_runs', 1],
      ]);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(stderr.mock.calls[0]?.[0]).slice('[admin-test-runs] case-write '.length)))
        .toMatchObject({ acknowledgedCases: TEST_CASE_INSERT_BATCH_SIZE, unacknowledgedCases: 1,
          reason: 'pg_insert_timeout_20ms' });
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it('bounds and redacts ordinary database failures in the default diagnostic', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const NEVER_EMIT_MARKER = 'never-emit-me';
      const failure = new Error('password=' + NEVER_EMIT_MARKER + ' ' + 'x'.repeat(500));
      const fake = fakeSql((table, rows) => table === 'test_runs' ? returningIds(rows) : Promise.reject(failure));
      const receipts = await insertTestRunRowsWithSql(fake.sql, [row('a.test.ts', [testCase(0)])],
        { ...context, runGroupId: 'r'.repeat(500) });
      expect(receipts).toEqual([expect.objectContaining({ outcome: 'inserted' })]);
      expect(receipts[0]?.caseInsertOutcome?.reason).toContain('password=[redacted]');
      expect(JSON.stringify(receipts)).not.toContain('synthetic-secret-value');
      const diagnostic = JSON.parse(String(stderr.mock.calls[0]?.[0]).slice('[admin-test-runs] case-write '.length));
      expect(diagnostic).toMatchObject({ acknowledgedCases: 0, unacknowledgedCases: 1 });
      expect(diagnostic.runGroupId).toHaveLength(200);
      expect(diagnostic.reason.length).toBeLessThanOrEqual(200);
      expect(diagnostic.reason).toContain('password=[redacted]');
      expect(diagnostic.reason).not.toContain('synthetic-secret-value');
    } finally {
      stderr.mockRestore();
    }
  });

  it('keeps successful case writes quiet and file receipts intact when diagnostics cannot be written', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const ok = fakeSql((table, rows) => table === 'test_runs' ? returningIds(rows) : Promise.resolve([]));
      expect(await insertTestRunRowsWithSql(ok.sql, [row('a.test.ts', [testCase(0)])], context))
        .toEqual([expect.objectContaining({ outcome: 'inserted' })]);
      expect(stderr).not.toHaveBeenCalled();
      stderr.mockImplementation(() => { throw new Error('closed stderr'); });
      const missing = Object.assign(new Error('relation test_case_runs does not exist'), { code: '42P01' });
      const failed = fakeSql((table, rows) => table === 'test_runs' ? returningIds(rows) : Promise.reject(missing));
      expect(await insertTestRunRowsWithSql(failed.sql, [row('a.test.ts', [testCase(0)])], context))
        .toEqual([expect.objectContaining({ outcome: 'inserted' })]);
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
    }
  });
});
