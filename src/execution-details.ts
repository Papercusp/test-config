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

export const MAX_RECORDED_FAILED_CASES = 64;
export const MAX_RECORDED_PASSED_CASES = 64;
export const MAX_RECORDED_CASE_TITLE_CHARS = 2_048;

/** Exact identities, never clipped prefixes or assertion-message/DOM lines. */
export function isRecordedCaseTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && value.length <= MAX_RECORDED_CASE_TITLE_CHARS && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

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

/** Independently measured by a registered runtime reader, never a test assertion. */
export interface RecordedRuntimeEnvironment {
  schemaVersion: 1;
  units: string[];
  fingerprint: string;
  observedAt: string;
}

export function parseRecordedRuntimeEnvironment(value: unknown): RecordedRuntimeEnvironment | undefined {
  if (!isRecord(value) || Object.keys(value).some(key =>
    !['schemaVersion', 'units', 'fingerprint', 'observedAt'].includes(key))
    || value.schemaVersion !== 1 || !Array.isArray(value.units)
    || value.units.length === 0 || value.units.length > 32
    || value.units.some(unit => typeof unit !== 'string' || !unit.trim() || unit.trim() !== unit || unit.length > 120)
    || new Set(value.units).size !== value.units.length
    || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !isRecordedInstant(value.observedAt)) return undefined;
  return value as unknown as RecordedRuntimeEnvironment;
}

/** A single observation cannot prove which runtime a whole test execution used. */
export function stableRecordedRuntimeEnvironment(
  before: unknown, after: unknown,
): RecordedRuntimeEnvironment | undefined {
  const first = parseRecordedRuntimeEnvironment(before);
  const last = parseRecordedRuntimeEnvironment(after);
  if (!first || !last || first.fingerprint !== last.fingerprint
    || JSON.stringify([...first.units].sort()) !== JSON.stringify([...last.units].sort())
    || Date.parse(last.observedAt) < Date.parse(first.observedAt)) return undefined;
  return first;
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
  /**
   * Measured failed TestCase.fullName identities, independent of output_tail.
   * That human diagnostic is tail-truncated and can contain only DOM text.
   * Optional for legacy writers; bounded names are exact, not truncated.
   */
  failedCaseTitles?: string[];
  /** Measured TestCase.fullName identities for passed assertions; bounded, never caller-authored. */
  passedCaseTitles?: string[];
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
  /**
   * When the WHOLE Vitest run began (ISO-8601 UTC), stamped in the reporter's onInit,
   * before Vitest discovers, imports or collects any module (EI-24827834166866368).
   * The row's `started_at` column is finished_at - test duration, so it postdates
   * collection: an edit made after Vitest read a file but before that file's tests
   * started is invisible to an mtime check against it. Every byte this run executed
   * was read at or after `runStartedAt`, so it is the sound lower bound for "was this
   * file modified after the run measured it".
   *
   * Expand-then-contract, like `worktreeDirtyReason`: this parser accepts the key
   * before the reporter writes it, because the deployed operator parses rows the
   * working-tree reporter writes, and an unknown key makes the row unproven.
   */
  runStartedAt?: string;
  runtimeEnvironmentBefore?: RecordedRuntimeEnvironment;
  runtimeEnvironmentAfter?: RecordedRuntimeEnvironment;
  /** Why a runtime witness is absent, or confirmation that it was captured. */
  runtimeEnvironmentBeforeCaptureStatus?: RuntimeEnvironmentCaptureStatus;
  runtimeEnvironmentAfterCaptureStatus?: RuntimeEnvironmentCaptureStatus;
  /** Original reporter-hashed artifacts of workers which exist only inside a test. */
  isolatedRuntimeReceipts?: IsolatedRuntimeReceipt[];
}

export interface IsolatedRuntimeReceipt {
  runId: string;
  resultSha256: string;
  sourceSha256: string;
  lifecycleSha256: string;
}

export function parseIsolatedRuntimeReceipts(value: unknown): IsolatedRuntimeReceipt[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 32) return undefined;
  const keys = ['runId', 'resultSha256', 'sourceSha256', 'lifecycleSha256'];
  if (value.some(row => !isRecord(row) || Object.keys(row).length !== keys.length
    || Object.keys(row).some(key => !keys.includes(key))
    || typeof row.runId !== 'string' || !/^\d{8}T\d{6}Z-\d+(?:\.\d+)?$/.test(row.runId)
    || keys.slice(1).some(key => typeof row[key] !== 'string' || !/^[a-f0-9]{64}$/.test(row[key] as string)))
    || new Set(value.map(row => row.runId)).size !== value.length) return undefined;
  return value as IsolatedRuntimeReceipt[];
}

export type RuntimeEnvironmentCaptureStatus =
  | 'captured'
  | 'not-configured'
  | 'unavailable'
  | 'invalid'
  | 'timed-out'
  | 'error';

const executionDetailsKeys = new Set<keyof TestRunExecutionDetails>([
  'schemaVersion', 'root', 'filePath', 'runGroupId', 'workspaceId', 'harnessSlug',
  'testNamePattern', 'scenarioId', 'passed', 'failed', 'skipped', 'collectionFailed', 'mutationPhase',
  'commitSha', 'worktreeDirty', 'testLayer', 'worktreeDirtyReason', 'runStartedAt', 'failedCaseTitles',
  'passedCaseTitles', 'runtimeEnvironmentBefore', 'runtimeEnvironmentAfter',
  'runtimeEnvironmentBeforeCaptureStatus', 'runtimeEnvironmentAfterCaptureStatus',
  'isolatedRuntimeReceipts',
]);

function isRuntimeEnvironmentCaptureStatus(value: unknown): value is RuntimeEnvironmentCaptureStatus {
  return value === 'captured' || value === 'not-configured' || value === 'unavailable'
    || value === 'invalid' || value === 'timed-out' || value === 'error';
}

/** A recorded instant: a non-empty string Date can parse. Used for `runStartedAt`. */
export function isRecordedInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(new Date(value).getTime());
}

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
    || (value.failedCaseTitles !== undefined && (
      !Array.isArray(value.failedCaseTitles)
      || value.failedCaseTitles.length > MAX_RECORDED_FAILED_CASES
      || value.failedCaseTitles.length > (value.failed as number)
      || value.failedCaseTitles.some(title => !isRecordedCaseTitle(title))
      || new Set(value.failedCaseTitles).size !== value.failedCaseTitles.length
      || (value.failedCaseTitles.length > 0 && value.collectionFailed !== false)))
    || (value.passedCaseTitles !== undefined && (
      !Array.isArray(value.passedCaseTitles)
      || value.passedCaseTitles.length > MAX_RECORDED_PASSED_CASES
      || value.passedCaseTitles.length > (value.passed as number)
      || value.passedCaseTitles.some(title => !isRecordedCaseTitle(title))
      || new Set(value.passedCaseTitles).size !== value.passedCaseTitles.length
      || (value.passedCaseTitles.length > 0 && value.collectionFailed !== false)
      || (value.failedCaseTitles !== undefined
        && value.passedCaseTitles.some(title => Array.isArray(value.failedCaseTitles) && value.failedCaseTitles.includes(title)))))
    || !isNullableString(value.mutationPhase) || !isNullableString(value.commitSha)
    || typeof value.worktreeDirty !== 'boolean'
    || (value.worktreeDirtyReason !== undefined
      && (typeof value.worktreeDirtyReason !== 'string' || value.worktreeDirtyReason.length === 0
        || value.worktreeDirty !== true))
    || (value.runStartedAt !== undefined && !isRecordedInstant(value.runStartedAt))
    || (value.isolatedRuntimeReceipts !== undefined && !parseIsolatedRuntimeReceipts(value.isolatedRuntimeReceipts))
    || (value.runtimeEnvironmentBefore !== undefined && !parseRecordedRuntimeEnvironment(value.runtimeEnvironmentBefore))
    || (value.runtimeEnvironmentAfter !== undefined && !parseRecordedRuntimeEnvironment(value.runtimeEnvironmentAfter))
    || (value.runtimeEnvironmentBeforeCaptureStatus !== undefined
      && (!isRuntimeEnvironmentCaptureStatus(value.runtimeEnvironmentBeforeCaptureStatus)
        || (value.runtimeEnvironmentBeforeCaptureStatus === 'captured') !== (value.runtimeEnvironmentBefore !== undefined)))
    || (value.runtimeEnvironmentAfterCaptureStatus !== undefined
      && (!isRuntimeEnvironmentCaptureStatus(value.runtimeEnvironmentAfterCaptureStatus)
        || (value.runtimeEnvironmentAfterCaptureStatus === 'captured') !== (value.runtimeEnvironmentAfter !== undefined)))) {
    return undefined;
  }
  return value as unknown as TestRunExecutionDetails;
}
