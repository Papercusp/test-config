/**
 * EI-24836213046334894 — node:test runs reach the test_runs ledger.
 *
 * Three layers: the collector's event fold (synthetic events), the pure row builder (against
 * the REAL parseTestRunExecutionDetails contract the evidence readers enforce), and a real
 * `node --test` child driven through beginNodeTestLedger exactly as scripts/test-files.mjs
 * drives it, so a change in node:test's event stream fails here rather than silently
 * dropping ledger rows again.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestRunRow, WorktreeGitSnapshot } from './admin-test-runs-reporter.ts';
import { parseTestRunExecutionDetails } from './execution-details.ts';
import { createNodeTestLedgerFold, oneLineMessage } from './node-test-ledger-collector.ts';
import type { NodeTestLedgerSummary } from './node-test-ledger-collector.ts';
import {
  beginNodeTestLedger,
  buildNodeTestRunRows,
  parseNodeTestLedgerSummary,
} from './node-test-ledger.ts';
import type { NodeTestRowContext } from './node-test-ledger.ts';

const ROOT = '/repo';
const FILE = '/repo/papercusp-desktop/test/guard.test.js';

function ctx(overrides: Partial<NodeTestRowContext> = {}): NodeTestRowContext {
  return {
    repoRoot: ROOT,
    finishedAt: new Date('2026-10-06T17:00:00.000Z'),
    worktreeDirty: false,
    worktreeDirtyReason: null,
    commitSha: 'c0ffee1234567890',
    runGroupId: null,
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    mutationPhase: null,
    testNamePattern: null,
    ...overrides,
  };
}

function ev(type: string, data: Record<string, unknown>) {
  return { type, data: { file: FILE, nesting: 0, ...data } };
}

describe('node:test ledger collector fold', () => {
  it('names nested cases by their ancestors and counts pass / fail / skip / todo per file', () => {
    const fold = createNodeTestLedgerFold();
    fold.push(ev('test:start', { name: 'suite' }));
    fold.push(ev('test:start', { name: 'ok', nesting: 1 }));
    fold.push(ev('test:pass', { name: 'ok', nesting: 1, details: { type: 'test', duration_ms: 1 } }));
    fold.push(ev('test:start', { name: 'bad', nesting: 1 }));
    fold.push(ev('test:fail', {
      name: 'bad', nesting: 1,
      details: { type: 'test', error: { message: 'test failed', cause: { message: 'expected\n 1 to be 2' } } },
    }));
    fold.push(ev('test:start', { name: 'later', nesting: 1 }));
    fold.push(ev('test:pass', { name: 'later', nesting: 1, skip: true, details: { type: 'test' } }));
    fold.push(ev('test:fail', {
      name: 'suite', details: { type: 'suite', duration_ms: 12.4, error: { failureType: 'subtestsFailed' } },
    }));
    fold.push(ev('test:start', { name: 'todo case' }));
    fold.push(ev('test:fail', { name: 'todo case', todo: true, details: { type: 'test', error: { message: 'x' } } }));

    const [file] = fold.summary().files;
    expect(file).toMatchObject({ file: FILE, passed: 1, failed: 1, skipped: 2, fileLevelFailure: null, durationMs: 12 });
    expect(file.failedCases).toEqual([{ title: 'suite > bad', message: 'expected 1 to be 2' }]);
  });

  it('records a crashed file as a file-level failure, not a case', () => {
    const fold = createNodeTestLedgerFold();
    fold.push(ev('test:fail', {
      name: 'papercusp-desktop/test/guard.test.js',
      details: { error: { failureType: 'testCodeFailure', message: 'SyntaxError: Unexpected token' } },
    }));
    const [file] = fold.summary().files;
    expect(file).toMatchObject({ passed: 0, failed: 0, failedCases: [], fileLevelFailure: 'SyntaxError: Unexpected token' });
  });

  it('drops events with no file rather than inventing a path', () => {
    const fold = createNodeTestLedgerFold();
    fold.push({ type: 'test:pass', data: { name: 'orphan', nesting: 0 } });
    expect(fold.summary().files).toEqual([]);
  });

  it('flattens and bounds messages', () => {
    expect(oneLineMessage({ message: 'a\n\n b' })).toBe('a b');
    expect(oneLineMessage(undefined)).toBe('failed');
    expect(oneLineMessage({ message: 'x'.repeat(900) }).length).toBe(500);
  });
});

describe('buildNodeTestRunRows', () => {
  const summary = (files: NodeTestLedgerSummary['files']): NodeTestLedgerSummary => ({ schemaVersion: 1, files });
  const result = (o: Partial<NodeTestLedgerSummary['files'][number]> = {}) => ({
    file: FILE, passed: 0, failed: 0, skipped: 0, failedCases: [], fileLevelFailure: null, durationMs: 40, ...o,
  });

  it('writes a repo-relative row whose execution details satisfy the stored contract', () => {
    const [row] = buildNodeTestRunRows(summary([result({ passed: 7 })]), ctx());
    expect(row).toMatchObject({
      filePath: 'papercusp-desktop/test/guard.test.js', status: 'pass', durationMs: 40,
      outputTail: null, worktreeDirty: false, commitSha: 'c0ffee1234567890', isScratchConfig: false,
    });
    expect(row.startedAt.toISOString()).toBe('2026-10-06T16:59:59.960Z');
    const parsed = parseTestRunExecutionDetails(row.executionDetails);
    expect(parsed).toMatchObject({ filePath: 'papercusp-desktop/test/guard.test.js', passed: 7, failed: 0, collectionFailed: false });
  });

  it('puts one `<full name>: <message>` line per failed case in output_tail and the titles in execution details', () => {
    const failedCases = [
      { title: 'guard > rejects libavcodec', message: 'expected exit 1' },
      { title: 'D-013: the guard fails on each newly covered GPL library', message: 'got 0' },
    ];
    const [row] = buildNodeTestRunRows(
      summary([result({ passed: 5, failed: 2, failedCases })]),
      ctx({ mutationPhase: 'mutant' }),
    );
    expect(row.status).toBe('fail');
    expect(row.outputTail?.split('\n')).toEqual([
      'guard > rejects libavcodec: expected exit 1',
      'D-013: the guard fails on each newly covered GPL library: got 0',
    ]);
    const parsed = parseTestRunExecutionDetails(row.executionDetails);
    expect(parsed?.failedCaseTitles).toEqual(failedCases.map((c) => c.title));
    expect(parsed?.mutationPhase).toBe('mutant');
  });

  it('marks a file that crashed before any case as collectionFailed with no titles', () => {
    const [row] = buildNodeTestRunRows(summary([result({ fileLevelFailure: 'SyntaxError' })]), ctx());
    expect(row.status).toBe('fail');
    expect(row.outputTail).toBe('papercusp-desktop/test/guard.test.js: SyntaxError');
    expect(parseTestRunExecutionDetails(row.executionDetails)).toMatchObject({ collectionFailed: true, failed: 0 });
  });

  it('carries a dirty tree and its reason, and records nothing for unmeasured or out-of-root files', () => {
    const rows = buildNodeTestRunRows(
      summary([result({ passed: 1 }), result({ file: '/elsewhere/x.test.js', passed: 1 }), result({ file: '/repo/empty.test.js' })]),
      ctx({ worktreeDirty: true, worktreeDirtyReason: 'HEAD moved a -> b' }),
    );
    expect(rows.map((r) => r.filePath)).toEqual(['papercusp-desktop/test/guard.test.js']);
    expect(parseTestRunExecutionDetails(rows[0].executionDetails)).toMatchObject({
      worktreeDirty: true, worktreeDirtyReason: 'HEAD moved a -> b',
    });
  });

  it('refuses an off-contract summary', () => {
    expect(parseNodeTestLedgerSummary('')).toBeNull();
    expect(parseNodeTestLedgerSummary('{"schemaVersion":2,"files":[]}')).toBeNull();
    expect(parseNodeTestLedgerSummary('not json')).toBeNull();
    expect(parseNodeTestLedgerSummary('{"schemaVersion":1,"files":[]}\n')).toEqual({ schemaVersion: 1, files: [] });
  });
});

describe('beginNodeTestLedger — a real node --test child', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function runChild(fixture: string) {
    dir = mkdtempSync(join(tmpdir(), 'node-test-ledger-fixture-'));
    writeFileSync(join(dir, 'fx.test.mjs'), fixture);
    const written: TestRunRow[] = [];
    const snapshot: WorktreeGitSnapshot = { commit: 'feedface00', porcelain: '' };
    const session = beginNodeTestLedger({
      repoRoot: dir,
      readSnapshot: async () => snapshot,
      writeRows: async (rows) => {
        written.push(...rows);
      },
    });
    const child = spawnSync(process.execPath, ['--test', ...session.reporterArgs, 'fx.test.mjs'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' },
    });
    return { session, child, written };
  }

  it('keeps the spec output on stdout and records a failing mutant run with its failed case', async () => {
    const { session, child, written } = runChild([
      "import { test, describe } from 'node:test';",
      "import assert from 'node:assert';",
      "describe('outer', () => {",
      "  test('passes', () => assert.ok(true));",
      "  test('fails here', () => assert.strictEqual(1, 2, 'one is not two'));",
      '});',
    ].join('\n'));
    expect(child.status).toBe(1);
    expect(child.stdout).toContain('fails here');

    const outcome = await session.record();
    expect(outcome).toEqual({ recorded: 1, reason: null });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ filePath: 'fx.test.mjs', status: 'fail', commitSha: 'feedface00', worktreeDirty: false });
    expect(written[0].outputTail).toMatch(/^outer > fails here: one is not two/);
    expect(parseTestRunExecutionDetails(written[0].executionDetails)).toMatchObject({
      passed: 1, failed: 1, failedCaseTitles: ['outer > fails here'],
    });
  });

  it('records nothing, and says why, when the child never reported', async () => {
    dir = mkdtempSync(join(tmpdir(), 'node-test-ledger-fixture-'));
    const written: TestRunRow[] = [];
    const session = beginNodeTestLedger({
      repoRoot: dir,
      readSnapshot: async () => ({ commit: 'a', porcelain: '' }),
      writeRows: async (rows) => {
        written.push(...rows);
      },
    });
    const outcome = await session.record();
    expect(outcome.recorded).toBe(0);
    expect(outcome.reason).toMatch(/no collector summary/);
    expect(written).toEqual([]);
  });
});
