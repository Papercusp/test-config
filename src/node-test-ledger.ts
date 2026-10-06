/**
 * node:test ledger RECORDER (EI-24836213046334894) — the parent half of
 * node-test-ledger-collector.ts.
 *
 * scripts/test-files.mjs calls `beginNodeTestLedger` before it spawns `node --test`, passes
 * the returned `reporterArgs` to the child, and calls `record()` after the child exits.
 * Rows go through the SAME writer as the Vitest reporter (`insertRows`), so source
 * (local / ci / mutation-probe), harness + workspace scope, branch and commit are
 * resolved identically, and the worktree is proven stable around the run with the same
 * before/after snapshot (a run whose tree moved is recorded worktree_dirty=true, never a
 * false clean).
 *
 * Fail-soft by contract: recording never changes the run's exit code, and a missing or
 * unreadable summary records nothing (unknown is not "zero tests").
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureWorktreeSnapshot,
  closeSharedPgIfUnheld,
  describeWorktreeDirt,
  insertRows,
  resolveMutationProbePhase,
  resolveTestRunHarnessSlug,
  resolveTestRunWorkspaceId,
  setRunRoot,
  shouldRecordTestRunPath,
} from './admin-test-runs-reporter.ts';
import type { TestRunRow } from './admin-test-runs-reporter.ts';
import {
  MAX_RECORDED_FAILED_CASES,
  TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
  isRecordedCaseTitle,
} from './execution-details.ts';
import type { TestRunExecutionDetails } from './execution-details.ts';
import { NODE_TEST_LEDGER_SUMMARY_SCHEMA_VERSION } from './node-test-ledger-collector.ts';
import type { NodeTestFileResult, NodeTestLedgerSummary } from './node-test-ledger-collector.ts';

/** Absolute path of the child-side collector, for `--test-reporter`. */
export const NODE_TEST_LEDGER_COLLECTOR_PATH = fileURLToPath(
  new URL('./node-test-ledger-collector.ts', import.meta.url),
);

type WorktreeSnapshot = Awaited<ReturnType<typeof captureWorktreeSnapshot>>;

export interface NodeTestRowContext {
  repoRoot: string;
  finishedAt: Date;
  worktreeDirty: boolean;
  worktreeDirtyReason: string | null;
  commitSha: string | null;
  runGroupId: string | null;
  workspaceId: string | null;
  harnessSlug: string | null;
  mutationPhase: string | null;
  testNamePattern: string | null;
}

/** Parse a collector summary; anything off-contract is unproven and yields null. */
export function parseNodeTestLedgerSummary(text: string): NodeTestLedgerSummary | null {
  // The collector writes exactly one JSON line; take the last non-empty one defensively.
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!line) return null;
  try {
    const value = JSON.parse(line) as Partial<NodeTestLedgerSummary>;
    if (value?.schemaVersion !== NODE_TEST_LEDGER_SUMMARY_SCHEMA_VERSION || !Array.isArray(value.files)) return null;
    return value as NodeTestLedgerSummary;
  } catch {
    return null;
  }
}

function toPosixRel(repoRoot: string, file: string): string {
  return relative(repoRoot, file).split(sep).join('/');
}

function fileStatus(result: NodeTestFileResult): TestRunRow['status'] | null {
  if (result.fileLevelFailure !== null || result.failed > 0) return 'fail';
  if (result.passed > 0) return 'pass';
  if (result.skipped > 0) return 'skip';
  return null; // no executed case: nothing measured, so no row
}

/**
 * Summary -> ledger rows. Pure. `output_tail` carries one `<full case name>: <message>`
 * line per failed case — the line shape spec-mutation-failure-lines matches when it
 * pairs a mutant's failed case with a bound test case — and execution_details carries the
 * exact failedCaseTitles, under the same contract parseTestRunExecutionDetails enforces.
 */
export function buildNodeTestRunRows(summary: NodeTestLedgerSummary, ctx: NodeTestRowContext): TestRunRow[] {
  const rows: TestRunRow[] = [];
  for (const result of summary.files) {
    if (typeof result?.file !== 'string' || result.file.length === 0) continue;
    const filePath = toPosixRel(ctx.repoRoot, result.file);
    if (!filePath || !shouldRecordTestRunPath(filePath)) continue;
    const status = fileStatus(result);
    if (status === null) continue;

    const lines = result.failedCases.map((c) => `${c.title}: ${c.message}`);
    if (result.fileLevelFailure !== null) lines.unshift(`${filePath}: ${result.fileLevelFailure}`);
    const outputTail = lines.length > 0 ? lines.join('\n').slice(-4000) : null;

    const collectionFailed =
      result.fileLevelFailure !== null && result.passed === 0 && result.failed === 0 && result.skipped === 0;
    const failedCaseTitles = collectionFailed
      ? []
      : [...new Set(result.failedCases.map((c) => c.title))]
          .filter((title) => isRecordedCaseTitle(title))
          .slice(0, Math.min(MAX_RECORDED_FAILED_CASES, result.failed));

    const durationMs = Math.max(0, Math.round(result.durationMs));
    const executionDetails: TestRunExecutionDetails = {
      schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
      root: ctx.repoRoot,
      filePath,
      runGroupId: ctx.runGroupId,
      workspaceId: ctx.workspaceId,
      harnessSlug: ctx.harnessSlug,
      testNamePattern: ctx.testNamePattern,
      passed: result.passed,
      failed: result.failed,
      ...(failedCaseTitles.length > 0 ? { failedCaseTitles } : {}),
      skipped: result.skipped,
      collectionFailed,
      mutationPhase: ctx.mutationPhase,
      commitSha: ctx.commitSha,
      worktreeDirty: ctx.worktreeDirty,
      ...(ctx.worktreeDirty && ctx.worktreeDirtyReason ? { worktreeDirtyReason: ctx.worktreeDirtyReason } : {}),
    };
    rows.push({
      filePath,
      status,
      durationMs,
      startedAt: new Date(ctx.finishedAt.getTime() - durationMs),
      finishedAt: ctx.finishedAt,
      outputTail,
      isScratchConfig: false,
      worktreeDirty: ctx.worktreeDirty,
      commitSha: ctx.commitSha,
      executionDetails,
    });
  }
  return rows;
}

export interface NodeTestLedgerOutcome {
  recorded: number;
  reason: string | null;
  /**
   * Cases whose test body threw, in the shape scripts/test-files.mjs prints as
   * TEST_FILE_ASSERTION_FAILURE lines (formatFailedAssertionDiagnostics). Without them a
   * node:test mutant run is always `inconclusive` to mutation-probe, however it failed.
   */
  assertionFailures: Array<{ file: string; name: string; messages: string[] }>;
}

/** Summary -> the router's assertion-failure diagnostics. Pure; only body failures count. */
export function nodeTestAssertionFailures(summary: NodeTestLedgerSummary): NodeTestLedgerOutcome['assertionFailures'] {
  const out: NodeTestLedgerOutcome['assertionFailures'] = [];
  for (const result of summary.files) {
    if (typeof result?.file !== 'string' || !Array.isArray(result.failedCases)) continue;
    for (const c of result.failedCases) {
      if (c?.codeFailure === true) out.push({ file: result.file, name: c.title, messages: [c.message] });
    }
  }
  return out;
}

export interface NodeTestLedgerSession {
  /** Extra `node --test` args: spec stays on stdout, the collector writes the summary file. */
  reporterArgs: string[];
  /** Read the summary, snapshot the tree again, and insert the rows. Never throws. */
  record(opts?: { testNamePattern?: string | null }): Promise<NodeTestLedgerOutcome>;
}

export interface BeginNodeTestLedgerOptions {
  repoRoot: string;
  /** Test seams; production uses the real snapshot and the shared ledger writer. */
  readSnapshot?: () => Promise<WorktreeSnapshot>;
  writeRows?: (rows: readonly TestRunRow[]) => Promise<void>;
}

/**
 * Start a node:test ledger session. AWAIT it BEFORE spawning the child: the before-snapshot
 * has to SETTLE first.
 *
 * EI-24836213046334894: scripts/test-files.mjs runs `node --test` through spawnSync, which
 * blocks this event loop for the whole run. A before-snapshot still in flight at that point
 * cannot finish: its git child's exec timeout fires mid-block and reports an empty HEAD
 * (every as-committed R-6 run recorded `HEAD unreadable (before= after=<sha>)`). A retry would
 * be worse, because it would read the tree AFTER the run, and a "before" equal to "after"
 * proves nothing about stability.
 */
export async function beginNodeTestLedger(options: BeginNodeTestLedgerOptions): Promise<NodeTestLedgerSession> {
  const { repoRoot } = options;
  const readSnapshot = options.readSnapshot ?? captureWorktreeSnapshot;
  const writeRows = options.writeRows ?? insertRows;
  // The snapshot and the ledger path filter both resolve against the checkout under test.
  setRunRoot(repoRoot);
  // Settled here, observed in record(): a failed before-snapshot is a dirty run, never a throw.
  const before = await readSnapshot().then(
    (snapshot) => ({ snapshot, error: null as unknown }),
    (error: unknown) => ({ snapshot: null, error }),
  );
  const dir = mkdtempSync(join(tmpdir(), 'node-test-ledger-'));
  const summaryPath = join(dir, 'summary.json');

  return {
    reporterArgs: [
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      `--test-reporter=${NODE_TEST_LEDGER_COLLECTOR_PATH}`,
      `--test-reporter-destination=${summaryPath}`,
    ],
    async record(opts = {}) {
      let assertionFailures: NodeTestLedgerOutcome['assertionFailures'] = [];
      try {
        let text: string;
        try {
          text = readFileSync(summaryPath, 'utf8');
        } catch {
          return { recorded: 0, reason: 'no collector summary (the node:test child did not report)', assertionFailures };
        }
        const summary = parseNodeTestLedgerSummary(text);
        if (!summary) return { recorded: 0, reason: 'collector summary is malformed', assertionFailures };
        assertionFailures = nodeTestAssertionFailures(summary);

        let worktreeDirty = true;
        let worktreeDirtyReason: string | null = 'snapshot not taken';
        let commitSha: string | null = null;
        try {
          if (!before.snapshot) throw before.error ?? new Error('before-snapshot unavailable');
          const after = await readSnapshot();
          worktreeDirtyReason = describeWorktreeDirt(before.snapshot, after);
          worktreeDirty = worktreeDirtyReason !== null;
          commitSha = after.commit;
        } catch (err) {
          // Missing proof of stability is dirty, never a false clean (same rule as Vitest).
          worktreeDirty = true;
          worktreeDirtyReason = `snapshot threw: ${err instanceof Error ? err.message : String(err)}`;
        }

        const rows = buildNodeTestRunRows(summary, {
          repoRoot,
          finishedAt: new Date(),
          worktreeDirty,
          worktreeDirtyReason,
          commitSha,
          runGroupId: process.env.PAPERCUSP_TEST_RUN_GROUP ?? null,
          workspaceId: resolveTestRunWorkspaceId(),
          harnessSlug: resolveTestRunHarnessSlug(),
          mutationPhase: resolveMutationProbePhase(),
          testNamePattern: opts.testNamePattern ?? null,
        });
        if (rows.length === 0) return { recorded: 0, reason: 'no recordable file executed a case', assertionFailures };
        await writeRows(rows);
        return { recorded: rows.length, reason: worktreeDirty ? `worktree_dirty: ${worktreeDirtyReason}` : null, assertionFailures };
      } catch (err) {
        return { recorded: 0, reason: `recording failed: ${err instanceof Error ? err.message : String(err)}`, assertionFailures };
      } finally {
        rmSync(dir, { recursive: true, force: true });
        if (!options.writeRows) await closeSharedPgIfUnheld().catch(() => undefined);
      }
    },
  };
}
