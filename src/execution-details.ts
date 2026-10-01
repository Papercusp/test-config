/**
 * The versioned per-file execution-details contract written by the admin test
 * reporter and consumed by detached evidence recovery.
 *
 * Keep this module dependency-free: the reporter is loaded by every Vitest
 * process, while recovery runs in operator-core. A shared runtime parser keeps
 * those two paths on the same contract without pulling operator-only code into
 * the reporter.
 */

export const TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION = 1 as const;

/**
 * THE test-layer taxonomy (EI-24434635346407728). One vocabulary for what a ledger row
 * may RECORD and what an acceptance BAR may REQUIRE: operator-core's
 * `CheckFileTestLayer` is this type, so a clause can never demand a layer the recorder
 * is unable to write. Before this, the recorder knew only unit|integration|browser
 * while BARs required e2e|llm too, which made those clauses unsatisfiable.
 *
 * The recorded value is a RUNTIME fact, stamped by the process that executed the file
 * (a Vitest project's `provide.papercuspTestLayer`, the Playwright reporter, the live
 * llm-test runner) — never inferred from a path, so a replay of recorded model output
 * that runs under the unit config records `unit`, not `llm`.
 */
export const RECORDED_TEST_LAYERS = ['unit', 'integration', 'e2e', 'llm', 'browser'] as const;
export type RecordedTestLayer = (typeof RECORDED_TEST_LAYERS)[number];

export function isRecordedTestLayer(value: unknown): value is RecordedTestLayer {
  return typeof value === 'string' && (RECORDED_TEST_LAYERS as readonly string[]).includes(value);
}

export interface TestRunExecutionDetails {
  schemaVersion: typeof TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION;
  root: string;
  filePath: string;
  runGroupId: string | null;
  workspaceId: string | null;
  harnessSlug: string | null;
  testNamePattern: string | null;
  /** Observed from the executing project's registered config; absent on older rows. */
  testLayer?: RecordedTestLayer;
  /** Identity of an individual live LLM scenario case; absent on other and older rows. */
  scenarioId?: string;
  passed: number;
  failed: number;
  skipped: number;
  collectionFailed: boolean;
  mutationPhase: string | null;
  /** The commit observed after the run; null means runtime identity is unproven. */
  commitSha: string | null;
  /** True unless the whole worktree was proven stable around the run. */
  worktreeDirty: boolean;
  /**
   * WHY `worktreeDirty` is true, named at flush time (WI-10004866). The gate
   * re-materializes its checkout on the next run, so the ledger row is the only
   * place the cause survives. Present only on dirty rows; absent on clean rows
   * and on every row written before this field existed.
   *
   * Rollout is expand-then-contract: this parser accepts the key BEFORE the
   * reporter writes it, because the parser is strict (an unknown key makes the
   * row unproven) and the deployed operator parses rows that the working-tree
   * reporter writes.
   */
  worktreeDirtyReason?: string;
}

const executionDetailsKeys = new Set<keyof TestRunExecutionDetails>([
  'schemaVersion', 'root', 'filePath', 'runGroupId', 'workspaceId', 'harnessSlug',
  'testNamePattern', 'scenarioId', 'passed', 'failed', 'skipped', 'collectionFailed', 'mutationPhase',
  'commitSha', 'worktreeDirty', 'testLayer', 'worktreeDirtyReason',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Writers used to hand postgres-js a pre-serialized value, which its default
 * jsonb serializer encoded again into a jsonb STRING scalar. Writers now pass
 * the object, and migration 1311 unwraps strings on insert and backfills them
 * (EI-24799048791133095). A string can still arrive from a writer on an older
 * deployed generation, or from a row that did not decode. Decoding it HERE, in
 * the one shared parser, is what keeps each reader from having to know that:
 * detached evidence recovery once called this parser on the raw column and
 * rejected every row, so no integration file past the foreground cap could ever
 * settle its spec evidence (WI-10002465). A string that does not decode to the
 * exact contract is still unproven.
 */
function decodeStoredDetails(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Read runtime layer attribution without treating a caller's adequacy label as evidence. */
export function recordedTestLayer(stored: unknown): TestRunExecutionDetails['testLayer'] {
  const value = decodeStoredDetails(stored);
  if (!isRecord(value) || value.schemaVersion !== TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION) return undefined;
  return isRecordedTestLayer(value.testLayer) ? value.testLayer : undefined;
}

/** Parse the exact persisted contract; malformed or extended rows are unproven. */
export function parseTestRunExecutionDetails(stored: unknown): TestRunExecutionDetails | undefined {
  const value = decodeStoredDetails(stored);
  if (!isRecord(value) || Object.keys(value).some(key => !executionDetailsKeys.has(key as keyof TestRunExecutionDetails))) {
    return undefined;
  }
  if (value.schemaVersion !== TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION
    || (value.testLayer !== undefined && recordedTestLayer(value) === undefined)
    || typeof value.root !== 'string' || value.root.length === 0
    || typeof value.filePath !== 'string' || value.filePath.length === 0
    || !isNullableString(value.runGroupId) || !isNullableString(value.workspaceId)
    || !isNullableString(value.harnessSlug) || !isNullableString(value.testNamePattern)
    || (value.scenarioId !== undefined && (typeof value.scenarioId !== 'string' || value.scenarioId.length === 0))
    || !isNonNegativeSafeInteger(value.passed) || !isNonNegativeSafeInteger(value.failed)
    || !isNonNegativeSafeInteger(value.skipped) || typeof value.collectionFailed !== 'boolean'
    || !isNullableString(value.mutationPhase) || !isNullableString(value.commitSha)
    || typeof value.worktreeDirty !== 'boolean'
    || (value.worktreeDirtyReason !== undefined
      && (typeof value.worktreeDirtyReason !== 'string' || value.worktreeDirtyReason.length === 0
        || value.worktreeDirty !== true))) {
    return undefined;
  }
  return value as unknown as TestRunExecutionDetails;
}
