/**
 * Handle/timer LEAK ATTRIBUTION — the pure half.
 *
 * WHY THIS EXISTS (plan gate-suite-speedup-2026-08-12, D-014/D-016; WI-38215):
 * when vitest reuses a worker across test files (`isolate: false`, which the
 * pure/stateful lane split wants for a measured -83% import cost), a file that
 * exits leaving a timer armed, a listener bound, or an entry in a pinned
 * singleton registry POISONS whichever file runs next in that worker. Three of
 * the four files polluted in the 2026-08-12 measurement were this class, not
 * the module-state class the plan originally assumed.
 *
 * The problem this module solves is ATTRIBUTION, not detection. Vitest already
 * surfaces the *symptom*, but it names the wrong file: a leaked timer that
 * rejects is reported as "This error originated in <the file that happened to
 * be running when it fired>". Measured live — a 5s timer armed by
 * authority-rpc-swarm-transport was reported against sse-prime.test.ts, and
 * reproduced exactly in a controlled probe (D-016). Anyone who acts on that
 * report edits an innocent file.
 *
 * The fix is a DELTA taken across each test file's own execution, which yields
 * the source directly and has two properties worth knowing:
 *
 *   1. A POSITIVE delta is the SOURCE signature — this file's exit left the
 *      resource behind.
 *   2. A NEGATIVE delta is the VICTIM signature — this file consumed a resource
 *      it never created (it ran someone else's leaked timer). Source and victim
 *      are therefore distinguished by SIGN, with no heuristics.
 *
 * And the property that decides where this ships (D-016): source detection is
 * ISOLATION-INDEPENDENT. A leaker's own exit delta is identical under
 * `--isolate` and `--no-isolate` (verified by experiment), because the resource
 * is counted at the leaker's exit whether or not anything downstream is harmed.
 * So this runs against the CURRENT isolated suite and finds real leaks in a
 * suite that is green today — it does not wait on the lane split.
 *
 * Blame the DELTA, never the absolute count: a file that INHERITS a dirty
 * worker must not be blamed for it. In the probe, the file that actually FAILED
 * had a delta of {} — under an absolute-threshold rule it is exactly the file
 * that would have been wrongly accused.
 */

/** A count per Node resource type, as reported by `process.getActiveResourcesInfo()`. */
export type ResourceCounts = Record<string, number>;

/** One resource type whose count moved across a test file's execution. */
export type ResourceDelta = { resource: string; delta: number };

/** What one test file did to its worker's resource population. */
export type FileVerdict = {
  file: string;
  /** Positive deltas — resources this file's exit LEFT BEHIND. This file is the SOURCE. */
  leaked: ResourceDelta[];
  /** Negative deltas — resources this file CONSUMED but never created. This file is a VICTIM. */
  consumed: ResourceDelta[];
};

/** Aggregate census over many files. `rate` is a RATE, never an exclusion list (D-008). */
export type LeakCensus = {
  filesObserved: number;
  filesLeaking: number;
  /** filesLeaking / filesObserved, or 0 when nothing was observed. */
  rate: number;
  /** Total leaked count per resource type, summed over source files. */
  byResource: ResourceCounts;
  /** Source files, worst first — the actionable list. */
  sources: FileVerdict[];
  /** Files that ran somebody else's leaked resource. Diagnostic, never blamed. */
  victims: FileVerdict[];
};

/**
 * Fold `process.getActiveResourcesInfo()`'s flat array of type names into counts.
 * Kept separate from the snapshot call itself so it is testable without a live
 * process, and so a caller can fold in extra domain counters (e.g. the size of a
 * pinned singleton registry) before diffing.
 */
export function countResources(resources: readonly string[]): ResourceCounts {
  const counts: ResourceCounts = {};
  for (const r of resources) counts[r] = (counts[r] ?? 0) + 1;
  return counts;
}

/**
 * Signed difference `after - before`, restricted to types that actually moved.
 * Types present in only one side are handled (treated as 0 on the missing side),
 * which is why the key set is the UNION and not either side alone.
 */
export function diffCounts(before: ResourceCounts, after: ResourceCounts): ResourceDelta[] {
  const out: ResourceDelta[] = [];
  for (const resource of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[resource] ?? 0) - (before[resource] ?? 0);
    if (delta !== 0) out.push({ resource, delta });
  }
  // Stable, largest-leak-first: makes the report deterministic across runs, which
  // matters because these verdicts get diffed against a baseline.
  return out.sort((a, b) => b.delta - a.delta || a.resource.localeCompare(b.resource));
}

/**
 * Classify one file's before/after snapshots into leaked (source) and consumed
 * (victim) sets.
 *
 * `ignore` exists for resource types that are structurally noisy rather than
 * leaked. It defaults to EMPTY on purpose: this repo's guard convention is an
 * empty-and-shrink-only baseline, and a census taken through a pre-populated
 * filter cannot discover what the filter hides.
 */
export function classifyFile(
  file: string,
  before: ResourceCounts,
  after: ResourceCounts,
  ignore: readonly string[] = [],
): FileVerdict {
  const skip = new Set(ignore);
  const moved = diffCounts(before, after).filter((d) => !skip.has(d.resource));
  return {
    file,
    leaked: moved.filter((d) => d.delta > 0),
    consumed: moved.filter((d) => d.delta < 0),
  };
}

/** True when this file left nothing behind. Victim-only files ARE clean — they are not at fault. */
export function isSourceClean(verdict: FileVerdict): boolean {
  return verdict.leaked.length === 0;
}

/** Total resources a file leaked, across types — the ranking key for the report. */
export function leakWeight(verdict: FileVerdict): number {
  return verdict.leaked.reduce((n, d) => n + d.delta, 0);
}

/** Aggregate per-file verdicts into the census that gets reported. */
export function summarizeCensus(verdicts: readonly FileVerdict[]): LeakCensus {
  const sources = verdicts.filter((v) => !isSourceClean(v)).sort((a, b) => leakWeight(b) - leakWeight(a));
  const victims = verdicts.filter((v) => v.consumed.length > 0);
  const byResource: ResourceCounts = {};
  for (const v of sources) {
    for (const d of v.leaked) byResource[d.resource] = (byResource[d.resource] ?? 0) + d.delta;
  }
  return {
    filesObserved: verdicts.length,
    filesLeaking: sources.length,
    rate: verdicts.length === 0 ? 0 : sources.length / verdicts.length,
    byResource,
    sources,
    victims,
  };
}
