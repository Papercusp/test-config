/**
 * WI-6554700010042457: derive test budgets from the existing test_runs /
 * test_case_runs ledger. This policy does not open a database or install a timer;
 * the caller supplies measurements from the same runtime and test layer.
 */
export interface TestTimingIdentity {
  file: string;
  caseKey: string;
  occurrence: number;
  layer: string;
  runnerIdentity: string;
}

export interface TestTimingSample extends TestTimingIdentity {
  runId: string;
  observedAtMs: number;
  status: string;
  clean: boolean;
  caseDurationMs: number | null;
  fileDurationMs: number | null;
}

export interface HistoricalTestTimeout {
  timeoutMs: number;
  basis: 'case-history' | 'file-history' | 'fallback';
  sampleCount: number;
  estimateMs: number | null;
}

const HISTORY_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const MIN_SAMPLES = 3;
const MAX_SAMPLES = 20;
const MIN_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_FALLBACK_MS = 180_000;

function validDuration(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function boundTimeout(value: number): number {
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.ceil(value)));
}

/**
 * Use recent successful clean runs, never failures, skipped/reused rows, or a
 * different case occurrence/runtime. A file's total duration is a conservative
 * fallback when individual case measurements have not accumulated yet.
 */
export function historicalTestTimeout(
  identity: TestTimingIdentity,
  history: readonly TestTimingSample[],
  nowMs: number,
  fallbackMs: number = DEFAULT_FALLBACK_MS,
): HistoricalTestTimeout {
  if (!Number.isFinite(nowMs)) throw new Error('Test timeout history needs a finite observation clock');
  const byRun = new Map<string, TestTimingSample>();
  for (const sample of history) {
    if (sample.file !== identity.file || sample.layer !== identity.layer ||
        sample.runnerIdentity !== identity.runnerIdentity || !sample.runnerIdentity ||
        sample.status !== 'pass' || sample.clean !== true || !sample.runId ||
        !Number.isFinite(sample.observedAtMs) || sample.observedAtMs > nowMs ||
        nowMs - sample.observedAtMs > HISTORY_MAX_AGE_MS) continue;
    // Repeated case names in one file must not overwrite one another. Keep file
    // fallback candidates separately below; only this exact occurrence seeds a case.
    if (sample.caseKey !== identity.caseKey || sample.occurrence !== identity.occurrence) continue;
    const previous = byRun.get(sample.runId);
    if (!previous || previous.observedAtMs < sample.observedAtMs) byRun.set(sample.runId, sample);
  }
  const caseSamples = [...byRun.values()]
    .sort((a, b) => b.observedAtMs - a.observedAtMs)
    .filter(sample => validDuration(sample.caseDurationMs))
    .slice(0, MAX_SAMPLES)
    .map(sample => sample.caseDurationMs as number);

  const fileRuns = new Map<string, TestTimingSample>();
  for (const sample of history) {
    if (sample.file !== identity.file || sample.layer !== identity.layer ||
        sample.runnerIdentity !== identity.runnerIdentity || !sample.runnerIdentity ||
        sample.status !== 'pass' || sample.clean !== true || !sample.runId ||
        !Number.isFinite(sample.observedAtMs) || sample.observedAtMs > nowMs ||
        nowMs - sample.observedAtMs > HISTORY_MAX_AGE_MS || !validDuration(sample.fileDurationMs)) continue;
    const previous = fileRuns.get(sample.runId);
    if (!previous || previous.observedAtMs < sample.observedAtMs) fileRuns.set(sample.runId, sample);
  }
  const fileSamples = [...fileRuns.values()]
    .sort((a, b) => b.observedAtMs - a.observedAtMs)
    .slice(0, MAX_SAMPLES)
    .map(sample => sample.fileDurationMs as number);

  const samples = caseSamples.length >= MIN_SAMPLES ? caseSamples : fileSamples;
  if (samples.length < MIN_SAMPLES) {
    return {
      timeoutMs: boundTimeout(Number.isFinite(fallbackMs) && fallbackMs > 0 ? fallbackMs : DEFAULT_FALLBACK_MS),
      basis: 'fallback', sampleCount: 0, estimateMs: null,
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const estimateMs = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  return {
    timeoutMs: boundTimeout(estimateMs * 4 + 5_000),
    basis: caseSamples.length >= MIN_SAMPLES ? 'case-history' : 'file-history',
    sampleCount: samples.length,
    estimateMs,
  };
}
