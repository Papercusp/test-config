/**
 * test-rubric-unification-2026-10-12 P-001 (R-1): per-case records from the Vitest reporter.
 *
 * Unit layer for the two pieces the real-Postgres test (test-case-runs.integration.test.ts)
 * exercises end to end: reading every case out of a TestModule, and writing case rows behind
 * their file rows without ever costing the file rows (D-007).
 */
import { describe, expect, it } from 'vitest';
import {
  collectTestCases,
  insertTestCaseRowsWithSql,
  insertTestRunRowsWithSql,
  TEST_CASE_ERROR_TAIL_MAX_CHARS,
  TEST_CASE_INSERT_BATCH_SIZE,
  type PgSql,
  type TestCaseInsertOutcome,
  type TestCaseRecord,
  type TestRunRow,
} from './admin-test-runs-reporter.ts';

type FakeCase = {
  fullName?: string;
  result: () => { state: string; errors?: unknown[] };
  diagnostic?: () => { duration?: number } | undefined;
};

const moduleOf = (cases: FakeCase[], state = 'passed') =>
  ({ state: () => state, children: { allTests: () => cases } }) as unknown as Parameters<typeof collectTestCases>[0];

describe('collectTestCases', () => {
  it('records every case in module order with its title path, status, duration and failure tail', () => {
    const cases = collectTestCases(moduleOf([
      { fullName: 'suite > passes', result: () => ({ state: 'passed' }), diagnostic: () => ({ duration: 3.6 }) },
      {
        fullName: 'suite > fails',
        result: () => ({ state: 'failed', errors: [{ message: 'expected 1 to be 2' }, { message: 'second error' }] }),
        diagnostic: () => ({ duration: 1 }),
      },
      { fullName: 'suite > skipped', result: () => ({ state: 'skipped' }), diagnostic: () => undefined },
    ], 'failed'));
    expect(cases).toEqual<TestCaseRecord[]>([
      { caseIndex: 0, caseKey: 'suite > passes', occurrence: 1, status: 'pass', durationMs: 4, errorTail: null },
      { caseIndex: 1, caseKey: 'suite > fails', occurrence: 1, status: 'fail', durationMs: 1, errorTail: 'expected 1 to be 2' },
      { caseIndex: 2, caseKey: 'suite > skipped', occurrence: 1, status: 'skip', durationMs: null, errorTail: null },
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
    expect(receipts).toEqual([{
      filePath: 'a.test.ts', status: 'pass', outcome: 'inserted', id: '100',
      receiptId: expect.any(String), attempt: 0,
      row: expect.objectContaining({ filePath: 'a.test.ts', status: 'pass' }),
      insertDiagnostics: expect.objectContaining({ schemaVersion: 1 }),
    }]);
    expect(outcomes).toEqual([{ written: 0, unwritten: 1, reason: 'test_case_runs_missing' }]);
  });

  it('never queues case rows behind a file batch that did not complete', async () => {
    const fake = fakeSql(() => new Promise(() => {}));
    const outcomes: TestCaseInsertOutcome[] = [];
    const receipts = await insertTestRunRowsWithSql(fake.sql, [row('a.test.ts', [testCase(0)])], context,
      { insertTimeoutMs: 20, totalInsertMs: 1_000 }, (outcome) => outcomes.push(outcome));
    expect(receipts[0]?.outcome).toBe('timeout');
    expect(fake.statements.map((s) => s.table)).toEqual(['test_runs']);
    expect(outcomes).toEqual([]);
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
});
