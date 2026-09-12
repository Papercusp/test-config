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
  passed: number;
  failed: number;
  skipped: number;
  collectionFailed: boolean;
  mutationPhase: string | null;
}

const executionDetailsKeys = new Set<keyof TestRunExecutionDetails>([
  'schemaVersion', 'root', 'filePath', 'runGroupId', 'workspaceId', 'harnessSlug',
  'testNamePattern', 'passed', 'failed', 'skipped', 'collectionFailed', 'mutationPhase',
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

/** Parse the exact persisted contract; malformed or extended rows are unproven. */
export function parseTestRunExecutionDetails(value: unknown): TestRunExecutionDetails | undefined {
  if (!isRecord(value) || Object.keys(value).some(key => !executionDetailsKeys.has(key as keyof TestRunExecutionDetails))) {
    return undefined;
  }
  if (value.schemaVersion !== TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION
    || typeof value.root !== 'string' || value.root.length === 0
    || typeof value.filePath !== 'string' || value.filePath.length === 0
    || !isNullableString(value.runGroupId) || !isNullableString(value.workspaceId)
    || !isNullableString(value.harnessSlug) || !isNullableString(value.testNamePattern)
    || !isNonNegativeSafeInteger(value.passed) || !isNonNegativeSafeInteger(value.failed)
    || !isNonNegativeSafeInteger(value.skipped) || typeof value.collectionFailed !== 'boolean'
    || !isNullableString(value.mutationPhase)) {
    return undefined;
  }
  return value as unknown as TestRunExecutionDetails;
}
