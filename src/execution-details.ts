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

export interface TestRunExecutionDetails {
  schemaVersion: typeof TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION;
  root: string;
  filePath: string;
  runGroupId: string | null;
  workspaceId: string | null;
  harnessSlug: string | null;
  testNamePattern: string | null;
  /** Observed from the executing project's registered config; absent on older rows. */
  testLayer?: 'unit' | 'integration' | 'browser';
  passed: number;
  failed: number;
  skipped: number;
  collectionFailed: boolean;
  mutationPhase: string | null;
  /** The commit observed after the run; null means runtime identity is unproven. */
  commitSha: string | null;
  /** True unless the whole worktree was proven stable around the run. */
  worktreeDirty: boolean;
}

const executionDetailsKeys = new Set<keyof TestRunExecutionDetails>([
  'schemaVersion', 'root', 'filePath', 'runGroupId', 'workspaceId', 'harnessSlug',
  'testNamePattern', 'passed', 'failed', 'skipped', 'collectionFailed', 'mutationPhase',
  'commitSha', 'worktreeDirty', 'testLayer',
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
 * The reporter persists this contract through postgres-js's multi-row insert
 * helper, which stores a pre-serialized value as a jsonb STRING scalar rather
 * than a jsonb object — and every existing ledger row is shaped that way. A
 * reader handed the raw column therefore sees a string. Decoding it HERE, in
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
  return value.testLayer === 'unit' || value.testLayer === 'integration' || value.testLayer === 'browser'
    ? value.testLayer : undefined;
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
    || !isNonNegativeSafeInteger(value.passed) || !isNonNegativeSafeInteger(value.failed)
    || !isNonNegativeSafeInteger(value.skipped) || typeof value.collectionFailed !== 'boolean'
    || !isNullableString(value.mutationPhase) || !isNullableString(value.commitSha)
    || typeof value.worktreeDirty !== 'boolean') {
    return undefined;
  }
  return value as unknown as TestRunExecutionDetails;
}
