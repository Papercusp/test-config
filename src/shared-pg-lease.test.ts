/**
 * WI-10003715 — the shared PG client must be LEASED, never closed out from under a sibling.
 *
 * Vitest runs every reporter's onTestRunEnd concurrently (Vitest.report → Promise.all). The
 * test-runs reporter and the executed-source-map reporter share one postgres.js client, and each
 * used to call closeSharedPg() in its finally. Whichever finished first ended the client while the
 * other was mid-flush, so the pass-proof writer's next chunk failed with CONNECTION_ENDED — the
 * largest workspaces lost every pass proof at the first green gate that recorded any.
 *
 * No real database here: a fake handle is installed in the SAME pinned slot the reporters use,
 * and it rejects any query issued after end() exactly the way postgres.js does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pinModuleState } from '@papercusp/module-singleton';
import { fileURLToPath } from 'node:url';
import type { TestModule } from 'vitest/node';

import { closeSharedPg, closeSharedPgIfUnheld, insertTestRunRowsWithSql, retainSharedPg, tryGetPg, type PgHandle, type PgSql, type TestRunRow } from './admin-test-runs-reporter.ts';
import ExecutedSourceMapReporter, { EXECUTED_SOURCE_MAP_FLUSH_TIMEOUT_MS } from './executed-source-map-reporter.ts';

const shared = pinModuleState('@papercusp/test-config.shared-pg', () => ({
  promise: undefined as Promise<PgHandle> | undefined,
  holders: 0,
}));

function installFakeClient() {
  const state = { ended: false, queries: 0 };
  const end = vi.fn(async () => {
    state.ended = true;
  });
  const sql = (async () => {
    await new Promise((r) => setTimeout(r, 1));
    if (state.ended) throw new Error('write CONNECTION_ENDED localhost:5432');
    state.queries += 1;
    return [];
  }) as unknown as NonNullable<PgHandle>['sql'];
  (sql as unknown as { end: typeof end }).end = end;
  shared.promise = Promise.resolve({ sql } as PgHandle);
  return { state, end };
}

/** The executed-source-map writer's shape: a loop of chunked queries through the shared handle. */
async function chunkedWrite(chunks: number): Promise<void> {
  const handle = await tryGetPg();
  const q = handle!.sql as unknown as () => Promise<unknown>;
  for (let i = 0; i < chunks; i += 1) await q();
}

afterEach(async () => {
  shared.holders = 0;
  shared.promise = undefined;
});

describe('shared PG lease (WI-10003715)', () => {
  it.each(['resolve', 'reject'] as const)('keeps a source-map flush alive after its timeout until the writer %ss', async settlement => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const envKeys = ['PC_EXECUTED_SOURCE_MAP_WORKSPACE', 'PC_EXECUTED_SOURCE_MAP_OUT',
      'PC_EXECUTED_SOURCE_MAP_RESULT', 'PC_EXECUTED_SOURCE_MAP_NO_PERSIST', 'PC_EXECUTED_INPUTS_DIR'];
    const saved = envKeys.map(key => process.env[key]);
    for (const key of envKeys) delete process.env[key];
    process.env.PC_EXECUTED_SOURCE_MAP_WORKSPACE = '@papercusp/test-config';
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let resolveStatement!: () => void;
    let rejectStatement!: (error: Error) => void;
    const first = new Promise<void>((resolve, reject) => {
      resolveStatement = resolve;
      rejectStatement = reject;
    });
    let ended = false;
    const end = vi.fn(async () => { ended = true; });
    const statement = vi.fn(async () => {
      if (ended) throw new Error('CONNECTION_ENDED');
      if (statement.mock.calls.length === 1) { enter(); await first; }
      return [];
    });
    const sql = Object.assign(statement, { end }) as unknown as PgSql;
    shared.promise = Promise.resolve({ sql });
    const sibling = retainSharedPg();
    const reporter = new ExecutedSourceMapReporter(
      async () => ({ commit: 'c0ffee0000000000000000000000000000000000', porcelain: '' }),
      undefined, () => '/fake/install/.git',
    );
    const moduleId = fileURLToPath(import.meta.url);
    let done: Promise<void> | undefined;
    try {
      reporter.onInit({} as never);
      await reporter.onTestModuleEnd({ moduleId, state: () => 'passed',
        project: { config: { isolate: true } }, diagnostic: () => ({ importDurations: { [moduleId]: {} } }),
      } as unknown as TestModule);
      done = reporter.onTestRunEnd();
      await vi.waitFor(() => expect(statement).toHaveBeenCalledTimes(1));
      await entered;
      await sibling();
      await vi.advanceTimersByTimeAsync(EXECUTED_SOURCE_MAP_FLUSH_TIMEOUT_MS);
      await done;
      await reporter.onExit();
      expect(statement).toHaveBeenCalledTimes(1);
      expect(end).not.toHaveBeenCalled();
      if (settlement === 'resolve') resolveStatement();
      else rejectStatement(new Error('source-map insert rejected'));
      await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(1));
      expect(statement).toHaveBeenCalledTimes(settlement === 'resolve' ? 3 : 1);
    } finally {
      resolveStatement();
      await done;
      await sibling();
      await reporter.onExit();
      await closeSharedPgIfUnheld();
      for (const [index, key] of envKeys.entries()) {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      }
      vi.useRealTimers();
    }
  });

  it('control: the OLD unconditional close from a sibling breaks an in-flight chunked write', async () => {
    const { state } = installFakeClient();
    const write = chunkedWrite(20);
    await new Promise((r) => setTimeout(r, 3));
    await closeSharedPg(); // the sibling reporter's former finally
    await expect(write).rejects.toThrow(/CONNECTION_ENDED/);
    expect(state.queries).toBeGreaterThan(0);
    expect(state.queries).toBeLessThan(20);
  });

  it('a sibling releasing its lease mid-flush does not end the client; the last release does', async () => {
    const { state, end } = installFakeClient();
    const siblingLease = retainSharedPg(); // test-runs reporter
    const writerLease = retainSharedPg(); // executed-source-map reporter
    const write = chunkedWrite(20);
    await new Promise((r) => setTimeout(r, 3));
    await siblingLease(); // sibling finishes its onTestRunEnd first
    expect(end).not.toHaveBeenCalled();
    await expect(write).resolves.toBeUndefined();
    expect(state.queries).toBe(20);
    await writerLease();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('release is idempotent (onTestRunEnd then onExit) and never over-decrements a sibling', async () => {
    const { end } = installFakeClient();
    const a = retainSharedPg();
    const b = retainSharedPg();
    await a();
    await a(); // onExit after onTestRunEnd
    expect(shared.holders).toBe(1);
    expect(end).not.toHaveBeenCalled();
    await b();
    expect(shared.holders).toBe(0);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('an unleased reporter (closeSharedPgIfUnheld) cannot end a client someone else holds', async () => {
    const { end } = installFakeClient();
    const held = retainSharedPg();
    await closeSharedPgIfUnheld();
    expect(end).not.toHaveBeenCalled();
    await held();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('preserves a late INSERT acknowledgement before releasing the reporter lease within its total budget', async () => {
    vi.useFakeTimers();
    let resolveInsert!: (value: unknown) => void;
    let rejectInsert!: (error: Error) => void;
    const statement = vi.fn(() => new Promise((resolve, reject) => {
      resolveInsert = resolve;
      rejectInsert = reject;
    }));
    const end = vi.fn(async () => {
      rejectInsert(new Error('write CONNECTION_DESTROYED localhost:5432'));
    });
    const sql = Object.assign(
      (first: unknown) => Array.isArray(first) && !('raw' in first) ? {} : statement(),
      { end },
    ) as unknown as PgSql;
    shared.promise = Promise.resolve({ sql });
    const lease = retainSharedPg();
    const at = new Date('2026-10-15T20:00:00Z');
    const row: TestRunRow = {
      filePath: 'late.test.ts', status: 'fail', durationMs: 1,
      startedAt: at, finishedAt: at, outputTail: null,
      isScratchConfig: false, worktreeDirty: false, commitSha: 'abc123', executionDetails: null,
    };
    const write = insertTestRunRowsWithSql(sql, [row], {
      branch: 'staging', inferredCommit: null, declaredSource: 'mutation-probe', runGroupId: null,
      harnessSlug: null, workspaceId: null, loopLagP95Ms: null, rssMb: null,
    }, { insertTimeoutMs: 20, totalInsertMs: 100 }).then(async receipts => {
      // The same lifetime boundary as AdminTestRunsReporter's onTestRunEnd finally.
      await lease();
      return receipts;
    });
    try {
      await vi.advanceTimersByTimeAsync(21);
      expect(end).not.toHaveBeenCalled();
      resolveInsert([{ id: '901', file_path: row.filePath }]);
      const receipts = await write;
      expect(receipts).toMatchObject([{ outcome: 'inserted', id: '901', filePath: row.filePath }]);
      expect(statement).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledTimes(1);
    } finally {
      resolveInsert([]);
      await vi.runAllTimersAsync();
      await write;
      vi.useRealTimers();
    }
  });

  it('defers sql.end until a timed-out INSERT settles after the total budget', async () => {
    vi.useFakeTimers();
    let resolveInsert!: (value: unknown) => void;
    const statement = vi.fn(() => new Promise(resolve => {
      resolveInsert = resolve;
    }));
    const end = vi.fn(async () => undefined);
    const sql = Object.assign(
      (first: unknown) => Array.isArray(first) && !('raw' in first) ? {} : statement(),
      { end },
    ) as unknown as PgSql;
    shared.promise = Promise.resolve({ sql });
    const lease = retainSharedPg();
    const at = new Date('2026-10-15T20:00:00Z');
    const row: TestRunRow = {
      filePath: 'late-after-budget.test.ts', status: 'fail', durationMs: 1,
      startedAt: at, finishedAt: at, outputTail: null,
      isScratchConfig: false, worktreeDirty: false, commitSha: 'abc123', executionDetails: null,
    };
    const write = insertTestRunRowsWithSql(sql, [row], {
      branch: 'staging', inferredCommit: null, declaredSource: 'mutation-probe', runGroupId: null,
      harnessSlug: null, workspaceId: null, loopLagP95Ms: null, rssMb: null,
    }, { insertTimeoutMs: 20, totalInsertMs: 100 }).then(async receipts => {
      await lease();
      return receipts;
    });
    try {
      await vi.advanceTimersByTimeAsync(101);
      await expect(write).resolves.toMatchObject([
        { outcome: 'timeout', reason: 'pg_insert_timeout_100ms' },
      ]);
      expect(end).not.toHaveBeenCalled();

      resolveInsert([{ id: '902', file_path: row.filePath }]);
      await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(1));
    } finally {
      resolveInsert([]);
      await vi.runAllTimersAsync();
      await write;
      vi.useRealTimers();
    }
  });
});
