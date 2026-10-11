/**
 * Mutation descriptor — what one mutation-probe invocation actually tested
 * (plan mutation-probe-evidence-value-2026-10-11, P-001; field set ruled in D-003).
 *
 * `scripts/mutation-probe.sh` exports the invocation-level descriptor once as
 * PAPERCUSP_MUTATION_DESCRIPTOR (JSON, without `leg`). The test-run reporter
 * completes it per row — `leg` is the row's PAPERCUSP_MUTATION_PHASE (the probe's
 * own phase vocabulary: baseline, copy-baseline, mutant, historical,
 * consumption-control, …) and `testFileSha256` hashes the test file the row ran —
 * then persists it at `execution_details.mutation`.
 *
 * Every leg of one invocation therefore shares `probeInvocationId` and differs only
 * in `leg` / `testFileSha256`, which is what lets a reader link a caught mutant to
 * the calibration pass it was measured against, and a later catch to an earlier
 * survivor of the same unchanged test.
 *
 * Parsing is strict (unknown keys, malformed hashes and over-long text are refused)
 * because `execution-details.ts` treats an unparseable row as unproven. Like that
 * module this one stays dependency-free; the reporter hashes the test file.
 */

export const MUTATION_DESCRIPTOR_SCHEMA_VERSION = 1 as const;
export const MUTATION_PROBE_MODES = ['copy-out', 'in-tree', 'historical'] as const;
export type MutationProbeMode = (typeof MUTATION_PROBE_MODES)[number];
export const MAX_MUTATION_EXPRESSION_CHARS = 2_000;
export const MAX_MUTANT_DIFF_CHARS = 8_000;
export const MAX_SUBJECT_PATH_CHARS = 1_024;

/** Phases the probe runs the GUARD under before mutating: a pass here is the calibration leg. */
export const CALIBRATION_LEGS: readonly string[] = ['baseline', 'copy-baseline'];

/** Invocation-level fields, as exported by the probe. */
export interface MutationInvocationDescriptor {
  schemaVersion: typeof MUTATION_DESCRIPTOR_SCHEMA_VERSION;
  probeInvocationId: string;
  mode: MutationProbeMode;
  /** Repository-relative when the subject lies inside the probe's git toplevel. */
  subjectPath: string;
  /** Exactly one of mutateExpression / againstCommit is non-null. */
  mutateExpression: string | null;
  /** Full 40-character commit sha of the historical snapshot (historical mode). */
  againstCommit: string | null;
  subjectBeforeSha256: string;
  subjectAfterSha256: string;
  /** Bounded unified diff of the subject, before → after. */
  mutantDiff: string;
  mutantDiffTruncated: boolean;
  testCommandSha256: string;
}

/** The per-row descriptor persisted at execution_details.mutation. */
export interface MutationDescriptor extends MutationInvocationDescriptor {
  leg: string;
  /** sha256 of the test file this row ran, or null when it could not be read. */
  testFileSha256: string | null;
}

const INVOCATION_KEYS = new Set<keyof MutationInvocationDescriptor>([
  'schemaVersion', 'probeInvocationId', 'mode', 'subjectPath', 'mutateExpression', 'againstCommit',
  'subjectBeforeSha256', 'subjectAfterSha256', 'mutantDiff', 'mutantDiffTruncated', 'testCommandSha256',
]);
const ROW_KEYS = new Set<string>([...INVOCATION_KEYS, 'leg', 'testFileSha256']);

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const INVOCATION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
const LEG = /^[a-z][a-z-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function invocationFieldsValid(value: Record<string, unknown>): boolean {
  if (value.schemaVersion !== MUTATION_DESCRIPTOR_SCHEMA_VERSION) return false;
  if (typeof value.probeInvocationId !== 'string' || !INVOCATION_ID.test(value.probeInvocationId)) return false;
  if (!(MUTATION_PROBE_MODES as readonly unknown[]).includes(value.mode)) return false;
  if (!boundedString(value.subjectPath, MAX_SUBJECT_PATH_CHARS)) return false;
  const expression = value.mutateExpression;
  const commit = value.againstCommit;
  if (expression !== null && !boundedString(expression, MAX_MUTATION_EXPRESSION_CHARS)) return false;
  if (commit !== null && (typeof commit !== 'string' || !COMMIT.test(commit))) return false;
  if ((expression === null) === (commit === null)) return false;
  if ((value.mode === 'historical') !== (commit !== null)) return false;
  for (const key of ['subjectBeforeSha256', 'subjectAfterSha256', 'testCommandSha256'] as const) {
    if (typeof value[key] !== 'string' || !SHA256.test(value[key] as string)) return false;
  }
  if (typeof value.mutantDiff !== 'string' || value.mutantDiff.length > MAX_MUTANT_DIFF_CHARS) return false;
  return typeof value.mutantDiffTruncated === 'boolean';
}

/** Strictly parse the probe's invocation-level export; undefined when anything is off. */
export function parseMutationInvocationDescriptor(value: unknown): MutationInvocationDescriptor | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !INVOCATION_KEYS.has(key as keyof MutationInvocationDescriptor))) {
    return undefined;
  }
  return invocationFieldsValid(value) ? (value as unknown as MutationInvocationDescriptor) : undefined;
}

/** Strictly parse a persisted execution_details.mutation value. */
export function parseMutationDescriptor(value: unknown): MutationDescriptor | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !ROW_KEYS.has(key))) return undefined;
  if (typeof value.leg !== 'string' || !LEG.test(value.leg)) return undefined;
  if (value.testFileSha256 !== null && (typeof value.testFileSha256 !== 'string' || !SHA256.test(value.testFileSha256))) {
    return undefined;
  }
  return invocationFieldsValid(value) ? (value as unknown as MutationDescriptor) : undefined;
}

/**
 * Read the probe's export from the environment. Absent → null (not a probe row, or a
 * probe that predates the export); malformed → null as well, so a broken export can
 * never make the whole row unparseable.
 */
export function readMutationInvocationDescriptor(
  env: Record<string, string | undefined> = process.env,
): MutationInvocationDescriptor | null {
  const raw = env.PAPERCUSP_MUTATION_DESCRIPTOR?.trim();
  if (!raw || env.PAPERCUSP_MUTATION_PROBE !== '1') return null;
  try {
    return parseMutationInvocationDescriptor(JSON.parse(raw)) ?? null;
  } catch {
    return null;
  }
}

/** Complete the invocation descriptor for one row: its leg and the hash of the test file it ran. */
export function mutationDescriptorForRow(
  invocation: MutationInvocationDescriptor | null,
  leg: string | null,
  testFileSha256: string | null,
): MutationDescriptor | undefined {
  if (!invocation || !leg || !LEG.test(leg)) return undefined;
  if (testFileSha256 !== null && !SHA256.test(testFileSha256)) return undefined;
  return { ...invocation, leg, testFileSha256 };
}
