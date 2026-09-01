/**
 * Counts what `isSilencedConsoleMessage` SUPPRESSES, so a silenced violation
 * still leaves one readable trace per test file.
 *
 * WHY THIS EXISTS (EI-21253580842180372). `vitest-fail-on-console` replaces
 * `console.error` / `console.warn` with a collector for the duration of a test
 * and never forwards to the saved original. Its `silenceMessage` hook returns
 * EARLY — before the message is collected — so a silenced message is neither
 * thrown as a failure nor printed to stdout. The suppression is total: the text
 * reaches no console, no stdout, and therefore no `test_runs.output_tail`.
 *
 * That is the correct behaviour for genuine noise, and it must stay: without it
 * `vitest-fail-on-console` turned incidental best-effort logs into failures and
 * red-pinned the green-checkpoint on 2026-08-02 (WI-6869) — 47 unit files failed
 * within 18 minutes, 33 via that path.
 *
 * But one allowlist entry is not noise. The unit-layer no-real-PG rail
 * (EI-19311807188719573) THROWS at `buildClient` when a unit test reaches for a
 * live database; most call sites catch that throw and fail open, logging it —
 * and the allowlist then swallows the log. The connection is correctly blocked
 * and NOTHING anywhere records that it happened. The first measured run of that
 * rail blocked 196 real connections across the operator-core unit suite; today
 * nobody can tell whether that population is 196, 52, or zero, because the only
 * probe (grepping run output) is guaranteed to return zero by construction.
 *
 * A detector whose output is unconditionally discarded is not a detector. This
 * module restores the missing half — a COUNT, not the hundreds of per-occurrence
 * lines the allowlist rightly suppresses — which is exactly the trade-off the
 * allowlist's own comment argues for and does not deliver.
 *
 * SCOPE / PROCESS BOUNDARY. `silenceMessage` runs in the vitest WORKER;
 * `AdminTestRunsReporter` runs in the MAIN process. A counter incremented here
 * is NOT readable from `onTestRunEnd` — the intuitive "increment in the filter,
 * print in the reporter" design silently reports zero. So the census is
 * deliberately per-worker/per-file and is emitted to stdout from a worker-side
 * hook, which vitest forwards to the reporter and thence to `output_tail`.
 */

import { pinModuleState } from '@papercusp/module-singleton';

/**
 * Buckets worth counting SEPARATELY. Everything else aggregates into `other`:
 * the point is to surface the rail, not to re-litigate every allowlist entry.
 *
 * Keyed by a stable slug, matched on the same exact substrings the allowlist
 * uses, so a bucket cannot drift from the entry it is counting.
 */
const CENSUS_BUCKETS: ReadonlyArray<{ key: string; match: string; label: string }> = [
  {
    key: 'real-pg-blocked',
    match: 'A UNIT test tried to open a REAL Postgres connection',
    label: 'unit-layer real-PG connections blocked [EI-19311807188719573]',
  },
];

const OTHER_BUCKET = 'other';

/**
 * Pinned to `globalThis` rather than left as a bare module-scoped `Map`. This
 * package is reached both by bare specifier and by relative path across the
 * vitest config, the setup files and the reporter; a split module record would
 * give each its own counter and report a confident, wrong, partial total.
 * Hand-rolling the `Symbol.for` pair is what `lint:no-hand-rolled-module-pin`
 * exists to stop — it fixes correctness but hides the key from
 * `listModuleDuplications()`. Precedent in this same package:
 * `setup-handle-leak-detector.ts`.
 */
const census = pinModuleState(
  '@papercusp/test-config.silenced-console-census',
  () => new Map<string, number>(),
);

/** Shared by every line this module emits, so the whole block greps as one unit. */
const SUMMARY_PREFIX = '[silenced-console-census]';

/**
 * Distinct exemplar texts retained per NOTABLE bucket, and the cap on each one.
 *
 * WHY EXEMPLARS AND NOT JUST A COUNT (EI-19417655142979569). The count above
 * answers "did the rail fire, and how often" — which is what stops the wrong
 * hypothesis the rail's silence used to invite ("the fail-soft branch never
 * executed"). It does NOT answer "which subsystem degraded", and that is the
 * half that cost two agents ~1h on deliver-and-wake.test.ts: the roster read in
 * `reportIdleRecipients` fell back to EMPTY_IDLE_REPORT, and nothing said so.
 *
 * The text that names the subsystem is ALREADY HERE. Fail-soft handlers log
 * `[inbox-wake] idle-probe roster read failed, reporting no idle recipients:
 * ${e.message}`, so the wrapper's own prefix is interpolated INTO the string
 * `recordSilencedMessage` receives — and the previous version discarded it at
 * the exact moment it held it. Retaining a few DISTINCT ones costs a bounded
 * handful of lines per file, not the hundreds of per-occurrence lines the
 * allowlist rightly suppresses, so the module's founding trade-off is intact.
 *
 * Deduped on the TRUNCATED text: two messages that differ only past the cap
 * share the diagnostic prefix, which is the part worth reading, so collapsing
 * them is the intended behaviour rather than a lossy accident. Truncation keeps
 * the HEAD because the wrapper prefix leads and the rail's boilerplate trails.
 */
const EXEMPLAR_CAP = 3;
const EXEMPLAR_MAX_CHARS = 240;

const exemplars = pinModuleState(
  '@papercusp/test-config.silenced-console-census.exemplars',
  () => new Map<string, Set<string>>(),
);

/**
 * Record one suppressed message. Call ONLY when `isSilencedConsoleMessage`
 * returned true — this module counts suppressions, not candidates.
 *
 * Deliberately total and non-throwing: it runs inside the console hook of every
 * test in the monorepo, so it must be incapable of failing one.
 */
export function recordSilencedMessage(msg: unknown): void {
  try {
    if (typeof msg !== 'string') return;
    const bucket = CENSUS_BUCKETS.find((b) => msg.includes(b.match));
    const key = bucket ? bucket.key : OTHER_BUCKET;
    census.set(key, (census.get(key) ?? 0) + 1);
    // Only NOTABLE buckets keep exemplars. `other` is expected noise in a healthy
    // run — the same reason `summariseSilencedConsole` stays silent for it.
    if (bucket) recordExemplar(bucket.key, msg);
  } catch {
    // A census is strictly an observation. It may never affect a verdict.
  }
}

/** Retain up to `EXEMPLAR_CAP` distinct, truncated texts for one bucket. */
function recordExemplar(key: string, msg: string): void {
  let seen = exemplars.get(key);
  if (!seen) {
    seen = new Set<string>();
    exemplars.set(key, seen);
  }
  if (seen.size >= EXEMPLAR_CAP) return;
  seen.add(
    msg.length > EXEMPLAR_MAX_CHARS ? `${msg.slice(0, EXEMPLAR_MAX_CHARS)}…` : msg,
  );
}

/** Current counts, as a plain object. Test seam + programmatic readers. */
export function readSilencedConsoleCensus(): Record<string, number> {
  return Object.fromEntries(census);
}

/** Retained exemplar texts per notable bucket. Test seam + programmatic readers. */
export function readSilencedConsoleExemplars(): Record<string, string[]> {
  return Object.fromEntries([...exemplars].map(([key, texts]) => [key, [...texts]]));
}

/** Drop all counts. For unit tests of this module; not used in the hot path. */
export function resetSilencedConsoleCensus(): void {
  census.clear();
  exemplars.clear();
}

/**
 * A count line naming every NOTABLE bucket, followed by up to `EXEMPLAR_CAP`
 * `↳` lines per bucket carrying the DISTINCT suppressed texts — the count says
 * the rail fired, the exemplars say which subsystem degraded
 * (EI-19417655142979569). Returns `null` when there is nothing worth saying:
 * when only `other` accumulated, ordinary allowlisted noise is expected in a
 * healthy run and a line per file reporting it would be the very noise the
 * allowlist removes.
 *
 * Every line carries the same prefix so the block greps as one unit even when
 * vitest interleaves it with other workers' stdout.
 */
export function summariseSilencedConsole(): string | null {
  const parts: string[] = [];
  const detail: string[] = [];
  for (const bucket of CENSUS_BUCKETS) {
    const n = census.get(bucket.key) ?? 0;
    if (n === 0) continue;
    parts.push(`${n} ${bucket.label}`);
    for (const sample of exemplars.get(bucket.key) ?? []) {
      detail.push(`${SUMMARY_PREFIX}   ↳ ${sample}`);
    }
  }
  if (parts.length === 0) return null;
  return [`${SUMMARY_PREFIX} ${parts.join('; ')}`, ...detail].join('\n');
}
