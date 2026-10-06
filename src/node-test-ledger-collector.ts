/**
 * node:test ledger COLLECTOR (EI-24836213046334894).
 *
 * scripts/test-files.mjs routes node:test files (papercusp-desktop/test/*.test.js, root
 * maintenance scripts) to `node --test`, which never loads the Vitest ledger reporter
 * (admin-test-runs-reporter.ts). Without this module a node:test run, and every
 * scripts/mutation-probe.sh guard run over one, left NO harness_shared.test_runs row, so its
 * proof could not be bound with fromTestRun and a baseline could never be paired with its
 * mutant by file path.
 *
 * This file is the CHILD half: a node:test custom reporter that folds the runner's event
 * stream into one JSON summary per run. It is loaded as
 *
 *     node --test --test-reporter=spec --test-reporter-destination=stdout \
 *                 --test-reporter=<this file> --test-reporter-destination=<summary.json> …
 *
 * so the human spec output is unchanged. The PARENT half (node-test-ledger.ts) turns the
 * summary into ledger rows with the same source / worktree / commit semantics as Vitest.
 *
 * Node strips the types natively when it loads this file, so it must stay ERASABLE-ONLY
 * TypeScript (no enums, namespaces or parameter properties) and import only node builtins.
 */
import { basename } from 'node:path';

export const NODE_TEST_LEDGER_SUMMARY_SCHEMA_VERSION = 1 as const;

/** Vitest's TestCase.fullName joins ancestor titles with this separator; mirror it. */
export const NODE_TEST_NAME_SEPARATOR = ' > ';

const MAX_MESSAGE_CHARS = 500;

export interface NodeTestFailedCase {
  /** Full case name: ancestor suite/test names and the case name joined by ' > '. */
  title: string;
  /** The assertion/error message on one line. */
  message: string;
  /**
   * True only when the TEST BODY threw (node:test failureType 'testCodeFailure'), the same
   * population Vitest reports as a failed assertion. A hook failure, timeout or cancellation
   * is a failed case but not assertion evidence: mutation-probe must not score it CAUGHT.
   */
  codeFailure: boolean;
}

export interface NodeTestFileResult {
  /** The file as the runner reported it (absolute in process-isolation mode). */
  file: string;
  passed: number;
  failed: number;
  skipped: number;
  failedCases: NodeTestFailedCase[];
  /** Set when the FILE failed (load error, crash) rather than an individual case. */
  fileLevelFailure: string | null;
  durationMs: number;
}

export interface NodeTestLedgerSummary {
  schemaVersion: typeof NODE_TEST_LEDGER_SUMMARY_SCHEMA_VERSION;
  files: NodeTestFileResult[];
}

interface ReporterEvent {
  type: string;
  data?: Record<string, unknown>;
}

interface FileState {
  result: NodeTestFileResult;
  /** Names of the tests currently open at each nesting level (from test:start). */
  stack: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * One-line message for a failed case. node:test wraps the thrown value in an
 * ERR_TEST_FAILURE whose `cause` is the real assertion error, so prefer the cause.
 */
export function oneLineMessage(error: unknown): string {
  const outer = record(error);
  const cause = record(outer?.cause);
  const raw =
    (typeof cause?.message === 'string' && cause.message) ||
    (typeof outer?.message === 'string' && outer.message) ||
    (typeof error === 'string' ? error : '') ||
    'failed';
  const flat = raw.replace(/\s+/g, ' ').trim() || 'failed';
  return flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS - 1)}…` : flat;
}

function isFlagSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/** True when a nesting-0 failure is the runner reporting the FILE itself, not a case in it. */
function isFileLevelFailure(file: string, name: string, nesting: number, error: unknown): boolean {
  if (nesting !== 0) return false;
  const failureType = record(error)?.failureType;
  if (failureType !== 'testCodeFailure') return false;
  return name === file || file.endsWith(name) || name.endsWith(basename(file));
}

export function createNodeTestLedgerFold(): {
  push(event: ReporterEvent): void;
  summary(): NodeTestLedgerSummary;
} {
  const files = new Map<string, FileState>();

  const stateFor = (file: string): FileState => {
    let state = files.get(file);
    if (!state) {
      state = {
        result: { file, passed: 0, failed: 0, skipped: 0, failedCases: [], fileLevelFailure: null, durationMs: 0 },
        stack: [],
      };
      files.set(file, state);
    }
    return state;
  };

  return {
    push(event) {
      const data = record(event?.data);
      if (!data) return;
      // A file-less event cannot be attributed to a ledger row; dropping it is the honest
      // outcome (no row) rather than inventing a path.
      const file = typeof data.file === 'string' && data.file.length > 0 ? data.file : null;
      if (!file) return;
      const name = typeof data.name === 'string' ? data.name : '';
      const nesting = typeof data.nesting === 'number' && data.nesting >= 0 ? data.nesting : 0;
      const state = stateFor(file);

      if (event.type === 'test:start') {
        state.stack.length = nesting;
        state.stack.push(name);
        return;
      }
      if (event.type !== 'test:pass' && event.type !== 'test:fail') return;

      const details = record(data.details) ?? {};
      if (nesting === 0 && typeof details.duration_ms === 'number' && Number.isFinite(details.duration_ms)) {
        state.result.durationMs += details.duration_ms;
      }
      const isSuite = details.type === 'suite';
      const title = [...state.stack.slice(0, nesting), name].join(NODE_TEST_NAME_SEPARATOR);

      if (event.type === 'test:pass') {
        if (isSuite) return;
        if (isFlagSet(data.skip) || isFlagSet(data.todo)) state.result.skipped += 1;
        else state.result.passed += 1;
        return;
      }

      // test:fail
      const error = details.error;
      if (isFileLevelFailure(file, name, nesting, error)) {
        state.result.fileLevelFailure = oneLineMessage(error);
        return;
      }
      // A suite fails because a child failed; the child is already counted.
      if (isSuite && record(error)?.failureType === 'subtestsFailed') return;
      // A failing todo does not fail the run (node:test semantics), so it is not a failure here.
      if (isFlagSet(data.todo)) {
        state.result.skipped += 1;
        return;
      }
      state.result.failed += 1;
      state.result.failedCases.push({
        title,
        message: oneLineMessage(error),
        codeFailure: record(error)?.failureType === 'testCodeFailure',
      });
    },
    summary() {
      return {
        schemaVersion: NODE_TEST_LEDGER_SUMMARY_SCHEMA_VERSION,
        files: [...files.values()].map((state) => ({
          ...state.result,
          durationMs: Math.round(state.result.durationMs),
          failedCases: [...state.result.failedCases],
        })),
      };
    },
  };
}

/** The node:test custom reporter: consume every event, emit one JSON summary line. */
export default async function* nodeTestLedgerCollector(
  source: AsyncIterable<ReporterEvent>,
): AsyncGenerator<string> {
  const fold = createNodeTestLedgerFold();
  for await (const event of source) {
    try {
      fold.push(event);
    } catch {
      /* a reporter must never break the run it observes */
    }
  }
  yield `${JSON.stringify(fold.summary())}\n`;
}
