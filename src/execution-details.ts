/**
 * The versioned per-file execution-details contract written by the admin test
 * reporter and consumed by detached evidence recovery.
 *
 * Keep this module dependency-free: the reporter is loaded by every Vitest
 * process, while recovery runs in operator-core. A shared runtime parser keeps
 * those two paths on the same contract without pulling operator-only code into
 * the reporter.
 */
import { parseMutationDescriptor, type MutationDescriptor } from './mutation-descriptor.ts';
import { createHash } from 'node:crypto';

/** Complete runner collection, independent of bounded human-readable samples.
 * Reuse additionally needs the original run/fence, process/reset receipts and
 * complete relevant input identities; this field proves population integrity.
 */
export type RecordedPopulationIdentity = [project: string, file: string, title: string, occurrence: number, leg: string];
export interface RecordedPopulationCase {
  identity: RecordedPopulationIdentity;
  selected: boolean;
  outcome: 'passed' | 'failed' | 'skipped';
}
export interface RecordedTestPopulation {
  schemaVersion: 'population-v1';
  cases: RecordedPopulationCase[];
  executionOrder: RecordedPopulationIdentity[];
  populationHash: string;
  selectionHash: string;
  outcomesHash: string;
  executionOrderHash: string;
}

function populationIdentity(value: unknown): value is RecordedPopulationIdentity {
  return Array.isArray(value) && value.length === 5
    && typeof value[0] === 'string' && value[0].trim() === value[0] && !/[\u0000-\u001f\u007f]/.test(value[0])
    && typeof value[1] === 'string' && value[1].length > 0 && !/[\\\u0000-\u001f\u007f]/.test(value[1])
    && !value[1].split('/').some(part => !part || part === '.' || part === '..') && !/^[A-Za-z]:/.test(value[1])
    && isRecordedCaseIdentity(value[2]) && Number.isSafeInteger(value[3]) && value[3] > 0
    && typeof value[4] === 'string' && value[4].length > 0 && value[4].trim() === value[4]
    && !/[\u0000-\u001f\u007f]/.test(value[4]);
}

function comparePopulationIdentity(a: RecordedPopulationIdentity, b: RecordedPopulationIdentity): number {
  for (const index of [0, 1, 2, 4] as const) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a[3] - b[3];
}

function populationDigest(kind: string, value: unknown): string {
  return createHash('sha256').update(JSON.stringify(['population-v1', kind, value]), 'utf8').digest('hex');
}

/** No sample/cap is accepted. Unreadable identities or incomplete execution
 * yield no population proof; the ordinary diagnostic row may still persist.
 */
export function createRecordedTestPopulation(
  cases: readonly RecordedPopulationCase[], executionOrder: readonly RecordedPopulationIdentity[],
): RecordedTestPopulation | undefined {
  if (!Array.isArray(cases) || cases.length === 0 || !Array.isArray(executionOrder)) return undefined;
  if (cases.some(row => !isRecord(row) || Object.keys(row).length !== 3
    || !populationIdentity(row.identity) || typeof row.selected !== 'boolean'
    || !['passed', 'failed', 'skipped'].includes(row.outcome)
    || (!row.selected && row.outcome !== 'skipped'))) return undefined;
  const sorted = cases.map(row => ({ identity: [...row.identity] as RecordedPopulationIdentity,
    selected: row.selected, outcome: row.outcome }))
    .sort((a, b) => comparePopulationIdentity(a.identity, b.identity));
  const occurrences = new Map<string, number>();
  const selected = new Set<string>();
  for (const row of sorted) {
    const [project, file, title, occurrence, leg] = row.identity;
    const key = JSON.stringify([project, file, title, leg]);
    const expected = (occurrences.get(key) ?? 0) + 1;
    if (occurrence !== expected) return undefined;
    occurrences.set(key, expected);
    if (row.selected) selected.add(JSON.stringify(row.identity));
  }
  const observed = new Set<string>();
  for (const identity of executionOrder) {
    if (!populationIdentity(identity) || !selected.has(JSON.stringify(identity))) return undefined;
    observed.add(JSON.stringify(identity));
  }
  if (observed.size !== selected.size) return undefined;
  const order = executionOrder.map(identity => [...identity] as RecordedPopulationIdentity);
  return { schemaVersion: 'population-v1', cases: sorted, executionOrder: order,
    populationHash: populationDigest('population', sorted.map(row => row.identity)),
    selectionHash: populationDigest('selection', sorted.filter(row => row.selected).map(row => row.identity)),
    outcomesHash: populationDigest('outcomes', sorted.map(row => [row.identity, row.selected, row.outcome])),
    executionOrderHash: populationDigest('execution-order', order) };
}

/** Recompute from persisted rows; supplied digests never establish integrity. */
export function parseRecordedTestPopulation(value: unknown): RecordedTestPopulation | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 7 || value.schemaVersion !== 'population-v1'
    || !Array.isArray(value.cases) || !Array.isArray(value.executionOrder)) return undefined;
  const rebuilt = createRecordedTestPopulation(value.cases, value.executionOrder);
  if (!rebuilt || ['populationHash', 'selectionHash', 'outcomesHash', 'executionOrderHash']
    .some(key => value[key] !== rebuilt[key as keyof RecordedTestPopulation])
    || JSON.stringify(value.cases.map(row => row.identity)) !== JSON.stringify(rebuilt.cases.map(row => row.identity))) return undefined;
  return rebuilt;
}

function executionPopulationMatches(value: Record<string, unknown>): boolean {
  const population = parseRecordedTestPopulation(value.population);
  return !!population && value.collectionFailed === false
    && population.cases.every(row => row.identity[1] === value.filePath)
    && population.cases.filter(row => row.outcome === 'passed').length === value.passed
    && population.cases.filter(row => row.outcome === 'failed').length === value.failed
    && population.cases.filter(row => row.outcome === 'skipped').length === value.skipped;
}

export const TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION = 1 as const;

// Failed case titles are NOT capped (green-main-ratchet-convergence-2026-10-17 D-005, P-017):
// the gate keys its blocking verdict and downgrade coverage by file + case, so every failed
// case of a failing row must be named. The natural bound is the row's own `failed` count.
export const MAX_RECORDED_PASSED_CASES = 1_280;
export const MAX_RECORDED_CASE_TITLE_CHARS = 2_048;

/**
 * True when the persisted passed-title set is known to be incomplete. The count
 * measures cases, while titles are unique exact identities, so any count mismatch
 * means omitted or ambiguous identities even when an older row has no marker.
 */
export function passedCaseTitlesIncomplete(
  execution: Pick<TestRunExecutionDetails, 'passed' | 'passedCaseTitles' | 'passedCaseTitlesTruncated'>,
): boolean {
  const titles = execution.passedCaseTitles ?? [];
  return execution.passedCaseTitlesTruncated === true || execution.passed > titles.length;
}

/** Exact identities, never clipped prefixes or assertion-message/DOM lines. */
export function isRecordedCaseTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && value.length <= MAX_RECORDED_CASE_TITLE_CHARS && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/** The normalized case ledger preserves parameterized titles containing text whitespace. */
export function isRecordedCaseIdentity(value: unknown): value is string {
  return typeof value === 'string' && isRecordedCaseTitle(value.replace(/[\t\r\n]/g, ' '));
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

/** Explicit file routes shared by Vitest config and pre-execution BAR checks.
 * These describe configured execution, not measured proof: only the runner can
 * stamp a ledger row's testLayer. Keep exceptions here instead of inferring a
 * unit layer from a filename that a maintained project routes to integration.
 */
export const REGISTERED_VITEST_FILE_PROJECTS = [
  {
    root: 'apps/operator',
    name: 'pty-process-integration',
    layer: 'integration',
    config: 'vitest.pty-process.integration.config.ts',
    files: ['lib/psu-pty-host-assume-fence.integration.test.ts'],
  },
  {
    root: 'apps/operator-public',
    name: 'artifact-storage-integration',
    layer: 'integration',
    files: ['src/routes/gcs-storage.test.ts', 'src/routes/workspace-host-artifacts.test.ts', 'src/routes/release-files.test.ts'],
  },
  {
    root: 'apps/papercusp-publish',
    name: 'archive-storage-integration',
    layer: 'integration',
    files: ['src/archive-storage.test.ts'],
  },
  {
    root: 'apps/operator-public',
    name: 'wallet-binding-calibration-integration',
    layer: 'integration',
    files: ['src/__tests__/wallet-binding-calibration.test.ts'],
  },
  {
    root: 'apps/operator-public',
    name: 'treasury-integration',
    layer: 'integration',
    files: ['src/__tests__/treasury.test.ts', 'src/__tests__/transparency-routes.test.ts'],
  },
  {
    root: 'apps/operator-public',
    name: 'funded-turn-host-integration',
    layer: 'integration',
    files: ['src/__tests__/funded-turn-host.integration.test.ts', 'src/__tests__/identity-metered-usage.test.ts'],
  },
] as const;

export function registeredVitestFileLayer(path: string): RecordedTestLayer | undefined {
  const normalized = path.trim().replaceAll('\\', '/').toLowerCase();
  for (const project of REGISTERED_VITEST_FILE_PROJECTS) {
    if (project.files.some(file => `${project.root}/${file}` === normalized)) return project.layer;
  }
  return undefined;
}

/** Independently measured by a registered runtime reader, never a test assertion. */
export interface RecordedRuntimeEnvironment {
  schemaVersion: 1;
  units: string[];
  fingerprint: string;
  observedAt: string;
}

/** Exact arguments of the executed operational producer, including its original scope. */
export interface RecordedOperationalExecution {
  schemaVersion: 1;
  command: string[];
}

export function parseRecordedOperationalExecution(value: unknown): RecordedOperationalExecution | undefined {
  if (!isRecord(value) || Object.keys(value).some(key => !['schemaVersion', 'command'].includes(key))
    || value.schemaVersion !== 1 || !Array.isArray(value.command)
    || value.command.length === 0 || value.command.length > 50
    || value.command.some(arg => typeof arg !== 'string' || arg.length === 0 || arg.length > 1_000)) return undefined;
  return value as unknown as RecordedOperationalExecution;
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

/** A local SDK child-span receipt. Reporter metadata is a hint until the
 * server joins it to the independently written invocation ledger. */
export interface ExecutionBoundaryReceipt {
  boundary: 'graph:query:evidence';
  callId: string;
  workspaceId: string;
  harness: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  traceFlags: number;
  startedAt: number;
  endedAt: number;
  outcome: 'ok' | 'error';
  /** Hash of the loaded handler function body; no transitive-source claim. */
  sourceFingerprint: string;
  buildSha: string | null;
  artifactFingerprint: string | null;
  environmentFingerprint: string;
  workflowId: null;
}
export interface TestBoundaryObservation {
  caseKey: string;
  occurrence: number;
  receipt: ExecutionBoundaryReceipt;
}
export function parseExecutionBoundaryReceipt(value: unknown): ExecutionBoundaryReceipt | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 16
    || Object.keys(value).some(key => !['boundary', 'callId', 'workspaceId', 'harness', 'traceId', 'spanId',
      'parentSpanId', 'traceFlags', 'startedAt', 'endedAt', 'outcome', 'sourceFingerprint', 'buildSha',
      'artifactFingerprint', 'environmentFingerprint', 'workflowId'].includes(key))) return undefined;
  const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const identity = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f]/.test(v);
  const span = (v: unknown, length: number) => typeof v === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(v) && !/^0+$/.test(v);
  if (!(value.boundary === 'graph:query:evidence' && identity(value.callId) && identity(value.workspaceId)
    && identity(value.harness) && span(value.traceId, 32) && span(value.spanId, 16) && span(value.parentSpanId, 16)
    && value.spanId !== value.parentSpanId && Number.isInteger(value.traceFlags) && (value.traceFlags as number) >= 0
    && (value.traceFlags as number) <= 255 && Number.isFinite(value.startedAt) && Number.isFinite(value.endedAt)
    && (value.startedAt as number) > 0 && (value.endedAt as number) >= (value.startedAt as number)
    && ['ok', 'error'].includes(value.outcome as string) && digest(value.sourceFingerprint)
    && digest(value.environmentFingerprint) && value.workflowId === null
    && (value.buildSha === null || typeof value.buildSha === 'string' && /^[a-f0-9]{10,64}$/.test(value.buildSha))
    && (value.artifactFingerprint === null || digest(value.artifactFingerprint)))) return undefined;
  return value as unknown as ExecutionBoundaryReceipt;
}
export function parseTestBoundaryObservations(value: unknown): TestBoundaryObservation[] | undefined {
  if (!Array.isArray(value) || value.length > 32 || value.some(row => !isRecord(row)
    || Object.keys(row).length !== 3 || !isRecordedCaseTitle(row.caseKey)
    || !Number.isSafeInteger(row.occurrence) || (row.occurrence as number) < 1
    || !parseExecutionBoundaryReceipt(row.receipt))) return undefined;
  return value as TestBoundaryObservation[];
}

/** Server-observed execution identity. Tokens are keyed to the mining scope;
 * private SQL, arguments and results never belong in the test-run ledger.
 * A reporter copy remains a hint until joined to the canonical invocation. */
export interface SqlCoverageExecutionReceipt {
  schemaVersion: 1;
  callId: string;
  workspaceId: string;
  harness: string;
  scopeId: string;
  toolName: string;
  contractRef: string;
  startedAt: number;
  endedAt: number;
  outcome: 'ok';
  argsToken: string;
  resultToken: string;
  sourceFingerprint: string;
  buildSha: string;
  artifactFingerprint: string;
  environmentFingerprint: string;
}

export interface TestSqlCoverageObservation {
  caseKey: string;
  occurrence: number;
  fixtureRef: string;
  scopeId: string;
  parserVersion: string;
  fingerprint: string;
  featuresToken: string;
  contractRef: string;
  verdict: 'exact' | 'partial' | 'none';
  missingFeatures: string[];
  sqlExecution: SqlCoverageExecutionReceipt;
  toolExecution: SqlCoverageExecutionReceipt;
}

const sqlCoverageDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sqlCoverageIdentity = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

export function parseSqlCoverageExecutionReceipt(value: unknown): SqlCoverageExecutionReceipt | undefined {
  const keys = ['schemaVersion', 'callId', 'workspaceId', 'harness', 'scopeId', 'toolName', 'contractRef', 'startedAt', 'endedAt',
    'outcome', 'argsToken', 'resultToken', 'sourceFingerprint', 'buildSha', 'artifactFingerprint', 'environmentFingerprint'];
  if (!isRecord(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || value.schemaVersion !== 1 || value.outcome !== 'ok'
    || !['callId', 'workspaceId', 'harness', 'toolName', 'contractRef'].every(key => sqlCoverageIdentity(value[key]))
    || !['scopeId', 'argsToken', 'resultToken', 'sourceFingerprint', 'artifactFingerprint', 'environmentFingerprint']
      .every(key => sqlCoverageDigest(value[key]))
    || typeof value.buildSha !== 'string' || !/^[a-f0-9]{10,64}$/.test(value.buildSha)
    || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.endedAt)
    || (value.startedAt as number) <= 0 || (value.endedAt as number) < (value.startedAt as number)) return undefined;
  return value as unknown as SqlCoverageExecutionReceipt;
}

export function parseTestSqlCoverageObservations(value: unknown): TestSqlCoverageObservation[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const keys = ['caseKey', 'occurrence', 'fixtureRef', 'scopeId', 'parserVersion', 'fingerprint', 'featuresToken',
    'contractRef', 'verdict', 'missingFeatures', 'sqlExecution', 'toolExecution'];
  const seen = new Set<string>();
  for (const row of value) {
    if (!isRecord(row) || Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))
      || !isRecordedCaseTitle(row.caseKey) || !Number.isSafeInteger(row.occurrence) || (row.occurrence as number) < 1
      || !['fixtureRef', 'parserVersion', 'contractRef'].every(key => sqlCoverageIdentity(row[key]))
      || !['scopeId', 'fingerprint', 'featuresToken'].every(key => sqlCoverageDigest(row[key]))
      || !['exact', 'partial', 'none'].includes(row.verdict as string)
      || !Array.isArray(row.missingFeatures) || row.missingFeatures.length > 32
      || row.missingFeatures.some(feature => !sqlCoverageIdentity(feature))
      || new Set(row.missingFeatures).size !== row.missingFeatures.length) return undefined;
    const sql = parseSqlCoverageExecutionReceipt(row.sqlExecution);
    const tool = parseSqlCoverageExecutionReceipt(row.toolExecution);
    if (!sql || !tool || sql.toolName !== 'dev:pg_query' || tool.toolName === sql.toolName || sql.callId === tool.callId
      || tool.contractRef !== row.contractRef
      || sql.scopeId !== row.scopeId || tool.scopeId !== row.scopeId
      || sql.workspaceId !== tool.workspaceId || sql.harness !== tool.harness
      || sql.buildSha !== tool.buildSha || sql.artifactFingerprint !== tool.artifactFingerprint
      || sql.environmentFingerprint !== tool.environmentFingerprint
      || (row.verdict === 'exact' ? row.missingFeatures.length !== 0 || sql.resultToken !== tool.resultToken
        : row.missingFeatures.length === 0 || sql.resultToken === tool.resultToken)) return undefined;
    const identity = JSON.stringify([row.caseKey, row.occurrence, sql.callId, tool.callId]);
    if (seen.has(identity)) return undefined;
    seen.add(identity);
  }
  return value as TestSqlCoverageObservation[];
}

export interface RecordedLlmBlockCustody {
  experimentId: string;
  blockIndex: number;
  scenarioId: string;
  arm: 'compact' | 'full';
  variantId: string;
  beforeSha256: string;
  afterSha256: string;
  requestManifestSha256: string;
  pid: number;
  processStartTicks: string;
  runIds: string[];
}

export function parseRecordedLlmBlockCustody(value: unknown): RecordedLlmBlockCustody | undefined {
  const keys = ['experimentId', 'blockIndex', 'scenarioId', 'arm', 'variantId', 'beforeSha256', 'afterSha256',
    'requestManifestSha256', 'pid', 'processStartTicks', 'runIds'];
  if (!isRecord(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
      || !['experimentId', 'scenarioId', 'variantId'].every(key => typeof value[key] === 'string' && value[key].length > 0)
      || !Number.isSafeInteger(value.blockIndex) || (value.blockIndex as number) < 0 || (value.blockIndex as number) > 9
      || !['compact', 'full'].includes(value.arm as string)
      || !['beforeSha256', 'afterSha256', 'requestManifestSha256'].every(key => typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key]))
      || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1 || typeof value.processStartTicks !== 'string'
      || !/^\d+$/.test(value.processStartTicks) || !Array.isArray(value.runIds) || value.runIds.length !== 3
      || value.runIds.some(id => typeof id !== 'string' || !id) || new Set(value.runIds).size !== 3) return undefined;
  return value as unknown as RecordedLlmBlockCustody;
}

export interface TestRunExecutionDetails {
  schemaVersion: typeof TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION;
  root: string;
  filePath: string;
  runGroupId: string | null;
  /** Explicit native execution custody; absent on legacy or unscoped runs. */
  attribution?: { ownerId: string; workItemId: string };
  workspaceId: string | null;
  harnessSlug: string | null;
  testNamePattern: string | null;
  /** Observed from the executing project's registered config; absent on older rows. */
  testLayer?: RecordedTestLayer;
  /** Node/platform/Vitest identity for compatible per-case timing history. */
  testTimingRuntimeIdentity?: string;
  /** Identity of an individual live LLM scenario case; absent on other and older rows. */
  scenarioId?: string;
  /** Exact rich reports emitted by this native LLM execution. */
  llmRunIds?: string[];
  llmBlockCustody?: RecordedLlmBlockCustody;
  boundaryObservations?: TestBoundaryObservation[];
  sqlCoverageObservations?: TestSqlCoverageObservation[];
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
  /** Present when the bounded list omitted one or more otherwise-recordable passed identities. */
  passedCaseTitlesTruncated?: true;
  skipped: number;
  collectionFailed: boolean;
  /** Exact collection/selection/outcomes and observed order; legacy absence is unknown. */
  population?: RecordedTestPopulation;
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
  /** Absent on historical/status-only rows; absence does not prove producer/install/window scope. */
  operational?: RecordedOperationalExecution;
  runtimeEnvironmentBefore?: RecordedRuntimeEnvironment;
  runtimeEnvironmentAfter?: RecordedRuntimeEnvironment;
  /** Why a runtime witness is absent, or confirmation that it was captured. */
  runtimeEnvironmentBeforeCaptureStatus?: RuntimeEnvironmentCaptureStatus;
  runtimeEnvironmentAfterCaptureStatus?: RuntimeEnvironmentCaptureStatus;
  /** Original reporter-hashed artifacts of workers which exist only inside a test. */
  isolatedRuntimeReceipts?: IsolatedRuntimeReceipt[];
  /**
   * What a mutation-probe leg tested (mutation-descriptor.ts). Expand-then-contract
   * (plan mutation-probe-evidence-value-2026-10-11 D-001): parsed before the probe
   * exports it, so the deployed operator never meets an unknown key.
   */
  mutation?: MutationDescriptor;
  /**
   * The executed rubric check this row records (framework 'rubric-check'): plan
   * test-rubric-unification-2026-10-12 D-004 rule 1. Absent on test-file rows.
   */
  check?: RecordedRubricCheck;
}

/** Ledger framework value for rows that record an executed rubric probe, instrument or tests check. */
export const RUBRIC_CHECK_FRAMEWORK = 'rubric-check' as const;

/**
 * `tests` records a verdict JUDGED from the test-run ledger (the latest row of each named
 * test file), as the spec-conformance run does for a requirement whose check is a tests check.
 * Its value is the count of passing files; the deciding test-file rows stay in the same ledger.
 */
export const RECORDED_RUBRIC_CHECK_KINDS = ['probe', 'instrument', 'tests', 'cargo', 'requirements'] as const;
export type RecordedRubricCheckKind = typeof RECORDED_RUBRIC_CHECK_KINDS[number];

/** One executed probe or instrument check: its id, the measured value, and that value's unit. */
export interface RecordedRubricCheck {
  /** Stable within the rubric: `<criterionKey>:<childIndex>` for a probe, `<criterionKey>:instrument` for an instrument. */
  id: string;
  rubricRef: string;
  criterionKey: string;
  kind: RecordedRubricCheckKind;
  /** null when nothing was measured (the row's status is then 'error'), never a silent 0. */
  value: number | string | boolean | null;
  /** null when the check reports no unit (a boolean or text probe). */
  unit: string | null;
  /**
   * The instrument threshold the row's pass/fail status was judged against, recorded so a later
   * threshold change cannot silently reinterpret history. Absent when the check carried none.
   */
  expect?: RecordedRubricCheckExpect;
  /** Original bounded measurement context; absent on legacy scalar-only rows. */
  provenance?: RecordedMeasurementProvenance;
  /**
   * The one subject this measurement describes (a lead, a run, a work-item), mirroring a
   * scorecard's observation.subject. Absent on a rubric-wide check. A subject row is never
   * read as another subject's or as the rubric-wide result (crm plan D-049).
   */
  subject?: RecordedRubricCheckSubject;
}

export interface RecordedRubricCheckSubject {
  kind?: string;
  ref: string;
}

export const MAX_RECORDED_SUBJECT_REF_CHARS = 200;

export function parseRecordedRubricCheckSubject(value: unknown): RecordedRubricCheckSubject | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'kind' && key !== 'ref')) return undefined;
  if (typeof value.ref !== 'string' || !value.ref.trim().length || value.ref.length > MAX_RECORDED_SUBJECT_REF_CHARS) return undefined;
  if (value.kind !== undefined && (typeof value.kind !== 'string' || !value.kind.length || value.kind.length > 64)) return undefined;
  return value as unknown as RecordedRubricCheckSubject;
}

export const MAX_MEASUREMENT_PROVENANCE_BYTES = 16_384;
export const MAX_MEASUREMENT_PROCEDURE_BYTES = 8_192;
export const MEASUREMENT_PROVENANCE_GAPS = [
  'procedure-truncated', 'diagnostics-truncated', 'redacted', 'transaction-clock-unavailable',
] as const;

export interface RecordedMeasurementProvenance {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  transactionAt?: string;
  /** Snapshot is sanitized canonical JSON, never an executable replay instruction. */
  procedure: { sha256: string; snapshot: string };
  diagnostics: Array<{ path: string; value: number | string | boolean | null }>;
  /** Complete, independently scrubbed scalar input; surrounding diagnostics may be partial.
   * Supports predicate evaluation only, never reconstruction of query/source inputs. */
  predicateInput?: { path: string; value: number | string | boolean | null };
  truncated: boolean;
  redacted: boolean;
  gaps: Array<typeof MEASUREMENT_PROVENANCE_GAPS[number]>;
}

/** UTF8 JSON bytes, shared by producers and the strict historical reader. */
export function measurementJsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? new TextEncoder().encode(json).length : Infinity;
  } catch { return Infinity; }
}

export function parseRecordedMeasurementProvenance(value: unknown): RecordedMeasurementProvenance | undefined {
  if (!isRecord(value) || Object.keys(value).some(key => ![
    'schemaVersion', 'startedAt', 'finishedAt', 'transactionAt', 'procedure', 'diagnostics', 'predicateInput', 'truncated', 'redacted', 'gaps',
  ].includes(key)) || value.schemaVersion !== 1
    || !isRecordedInstant(value.startedAt) || !isRecordedInstant(value.finishedAt)
    || Date.parse(value.startedAt) > Date.parse(value.finishedAt)
    || (value.transactionAt !== undefined && !isRecordedInstant(value.transactionAt))
    || typeof value.truncated !== 'boolean' || typeof value.redacted !== 'boolean'
    || !Array.isArray(value.gaps) || value.gaps.length > MEASUREMENT_PROVENANCE_GAPS.length
    || new Set(value.gaps).size !== value.gaps.length
    || value.gaps.some(gap => !MEASUREMENT_PROVENANCE_GAPS.includes(gap))
    || value.redacted !== value.gaps.includes('redacted')
    || value.truncated !== value.gaps.some(gap => gap === 'procedure-truncated' || gap === 'diagnostics-truncated')
    || !isRecord(value.procedure) || Object.keys(value.procedure).length !== 2
    || Object.keys(value.procedure).some(key => key !== 'sha256' && key !== 'snapshot')
    || typeof value.procedure.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.procedure.sha256)
    || typeof value.procedure.snapshot !== 'string'
    || new TextEncoder().encode(value.procedure.snapshot).length > MAX_MEASUREMENT_PROCEDURE_BYTES
    || !Array.isArray(value.diagnostics) || value.diagnostics.length > 64
    || measurementJsonBytes(value) > MAX_MEASUREMENT_PROVENANCE_BYTES) return undefined;
  try { JSON.parse(value.procedure.snapshot); } catch { return undefined; }
  if (value.predicateInput !== undefined) {
    const input = value.predicateInput;
    if (!isRecord(input) || Object.keys(input).length !== 2
      || Object.keys(input).some(key => key !== 'path' && key !== 'value')
      || typeof input.path !== 'string' || !input.path.length || input.path.length > 256
      || !(input.value === null || typeof input.value === 'boolean'
        || (typeof input.value === 'number' && Number.isFinite(input.value))
        || (typeof input.value === 'string' && input.value.length <= 256))) return undefined;
  }
  const paths = new Set<string>();
  for (const entry of value.diagnostics) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2
      || Object.keys(entry).some(key => key !== 'path' && key !== 'value')
      || typeof entry.path !== 'string' || !entry.path.length || entry.path.length > 256
      || paths.has(entry.path)) return undefined;
    paths.add(entry.path);
    const scalar = entry.value;
    if (!(scalar === null || typeof scalar === 'boolean'
      || (typeof scalar === 'number' && Number.isFinite(scalar))
      || (typeof scalar === 'string' && scalar.length <= 256))) return undefined;
  }
  return value as unknown as RecordedMeasurementProvenance;
}

export const RECORDED_RUBRIC_CHECK_OPS = ['lt', 'lte', 'gt', 'gte', 'eq'] as const;
export interface RecordedRubricCheckExpect {
  op: typeof RECORDED_RUBRIC_CHECK_OPS[number];
  value: number;
}

const recordedRubricCheckKeys = new Set(['id', 'rubricRef', 'criterionKey', 'kind', 'value', 'unit', 'expect', 'provenance', 'subject']);

function isRecordedRubricCheckExpect(value: unknown): value is RecordedRubricCheckExpect {
  return isRecord(value)
    && Object.keys(value).every((key) => key === 'op' || key === 'value')
    && RECORDED_RUBRIC_CHECK_OPS.includes(value.op as RecordedRubricCheckExpect['op'])
    && typeof value.value === 'number' && Number.isFinite(value.value);
}

export function parseRecordedRubricCheck(value: unknown): RecordedRubricCheck | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !recordedRubricCheckKeys.has(key))) return undefined;
  const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (!nonEmpty(value.id) || !nonEmpty(value.rubricRef) || !nonEmpty(value.criterionKey)) return undefined;
  if (!RECORDED_RUBRIC_CHECK_KINDS.includes(value.kind as RecordedRubricCheckKind)) return undefined;
  const v = value.value;
  if (!(v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) {
    return undefined;
  }
  if (!(value.unit === null || nonEmpty(value.unit))) return undefined;
  if (value.expect !== undefined && !isRecordedRubricCheckExpect(value.expect)) return undefined;
  if (value.provenance !== undefined && !parseRecordedMeasurementProvenance(value.provenance)) return undefined;
  if (value.subject !== undefined && !parseRecordedRubricCheckSubject(value.subject)) return undefined;
  return value as unknown as RecordedRubricCheck;
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
  'schemaVersion', 'root', 'filePath', 'runGroupId', 'attribution', 'workspaceId', 'harnessSlug',
  'testNamePattern', 'scenarioId', 'llmRunIds', 'passed', 'failed', 'skipped', 'collectionFailed', 'mutationPhase',
  'commitSha', 'worktreeDirty', 'testLayer', 'testTimingRuntimeIdentity', 'worktreeDirtyReason', 'runStartedAt', 'failedCaseTitles',
  'passedCaseTitles', 'passedCaseTitlesTruncated', 'runtimeEnvironmentBefore', 'runtimeEnvironmentAfter',
  'runtimeEnvironmentBeforeCaptureStatus', 'runtimeEnvironmentAfterCaptureStatus',
  'isolatedRuntimeReceipts', 'mutation', 'check', 'operational', 'boundaryObservations', 'llmBlockCustody',
  'sqlCoverageObservations', 'population',
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
    || (value.testTimingRuntimeIdentity !== undefined && (typeof value.testTimingRuntimeIdentity !== 'string'
      || !value.testTimingRuntimeIdentity.trim() || value.testTimingRuntimeIdentity.length > 300))
    || typeof value.root !== 'string' || value.root.length === 0
    || typeof value.filePath !== 'string' || value.filePath.length === 0
    || !isNullableString(value.runGroupId) || !isNullableString(value.workspaceId)
    || (value.attribution !== undefined && (!isRecord(value.attribution)
      || Object.keys(value.attribution).length !== 2
      || typeof value.attribution.ownerId !== 'string' || !value.attribution.ownerId.trim()
      || typeof value.attribution.workItemId !== 'string'
      || !/^(?:WI|EI|F)-[A-Za-z0-9._-]+$/.test(value.attribution.workItemId)
      || typeof value.runGroupId !== 'string' || !value.runGroupId.trim()))
    || !isNullableString(value.harnessSlug) || !isNullableString(value.testNamePattern)
    || (value.scenarioId !== undefined && (typeof value.scenarioId !== 'string' || value.scenarioId.length === 0))
    || (value.llmRunIds !== undefined && (value.testLayer !== 'llm'
      || !Array.isArray(value.llmRunIds) || value.llmRunIds.length === 0 || value.llmRunIds.length > 1000
      || value.llmRunIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 200)
      || new Set(value.llmRunIds).size !== value.llmRunIds.length))
    || (value.llmBlockCustody !== undefined && !parseRecordedLlmBlockCustody(value.llmBlockCustody))
    || !isNonNegativeSafeInteger(value.passed) || !isNonNegativeSafeInteger(value.failed)
    || !isNonNegativeSafeInteger(value.skipped) || typeof value.collectionFailed !== 'boolean'
    || (value.population !== undefined && !executionPopulationMatches(value))
    || (value.failedCaseTitles !== undefined && (
      !Array.isArray(value.failedCaseTitles)
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
    || (value.passedCaseTitlesTruncated !== undefined && (
      value.passedCaseTitlesTruncated !== true
      || (value.passed as number) <= (Array.isArray(value.passedCaseTitles) ? value.passedCaseTitles.length : 0)))
    || !isNullableString(value.mutationPhase) || !isNullableString(value.commitSha)
    || typeof value.worktreeDirty !== 'boolean'
    || (value.worktreeDirtyReason !== undefined
      && (typeof value.worktreeDirtyReason !== 'string' || value.worktreeDirtyReason.length === 0
        || value.worktreeDirty !== true))
    || (value.runStartedAt !== undefined && !isRecordedInstant(value.runStartedAt))
    || (value.operational !== undefined && !parseRecordedOperationalExecution(value.operational))
    || (value.boundaryObservations !== undefined && !parseTestBoundaryObservations(value.boundaryObservations))
    || (value.sqlCoverageObservations !== undefined && !parseTestSqlCoverageObservations(value.sqlCoverageObservations))
    || (value.isolatedRuntimeReceipts !== undefined && !parseIsolatedRuntimeReceipts(value.isolatedRuntimeReceipts))
    || (value.runtimeEnvironmentBefore !== undefined && !parseRecordedRuntimeEnvironment(value.runtimeEnvironmentBefore))
    || (value.runtimeEnvironmentAfter !== undefined && !parseRecordedRuntimeEnvironment(value.runtimeEnvironmentAfter))
    || (value.runtimeEnvironmentBeforeCaptureStatus !== undefined
      && (!isRuntimeEnvironmentCaptureStatus(value.runtimeEnvironmentBeforeCaptureStatus)
        || (value.runtimeEnvironmentBeforeCaptureStatus === 'captured') !== (value.runtimeEnvironmentBefore !== undefined)))
    || (value.runtimeEnvironmentAfterCaptureStatus !== undefined
      && (!isRuntimeEnvironmentCaptureStatus(value.runtimeEnvironmentAfterCaptureStatus)
        || (value.runtimeEnvironmentAfterCaptureStatus === 'captured') !== (value.runtimeEnvironmentAfter !== undefined)))
    || (value.mutation !== undefined && !parseMutationDescriptor(value.mutation))
    || (value.check !== undefined && !parseRecordedRubricCheck(value.check))) {
    return undefined;
  }
  return value as unknown as TestRunExecutionDetails;
}
