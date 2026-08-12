/**
 * The ENFORCED, SHRINK-ONLY leak baseline — the ratchet the census exists to feed
 * (plan gate-suite-speedup-2026-08-12 D-019 §3; WI-38215).
 *
 * The census answers "how much does this suite leak". This module answers the
 * only question a gate can act on: "did it get WORSE". Nothing here scores the
 * absolute population — D-001 forbids arriving and failing the build on a
 * pre-existing leak population, and D-008 forbids standing up an exclusion list
 * instead of counting one.
 *
 * ── THE TWO LENSES ARE RATCHETED SEPARATELY, NEVER SUMMED (D-019 §3) ─────────
 *
 * Lens 1 (resource introspection) names a leaked setTimeout handle `Timeout`;
 * lens 2 (arm/clear bookkeeping) names the same object `timer:setTimeout`. A
 * REF'D leaked timer is therefore counted once by each, while each lens also
 * sees things the other is structurally blind to (lens 2 sees unref'd timers;
 * lens 1 sees sockets, pipes and child processes). The counts are NEITHER
 * additive NOR nested, so one summed number is not merely imprecise — it is
 * wrong in both directions at once:
 *
 *   - a fix that clears a REF'D timer removes 2 units, a fix to an UNREF'D one
 *     removes 1, so a summed ratchet rewards them unequally for equal work; and
 *   - a change that clears one timer while leaking one socket nets to zero and
 *     passes a summed ratchet, having introduced a brand-new handle leak.
 *
 * `compareToBaseline` therefore compares `timers` and `handles` as two
 * independent scalars per file, and there is deliberately no total anywhere in
 * this module's output. The second failure above is pinned by a test.
 *
 * ── WHY "CHECK" AND "UPDATE" HAVE DIFFERENT PRECONDITIONS ────────────────────
 *
 * These two directions are not symmetric, and conflating them is how a ratchet
 * silently un-ratchets itself:
 *
 *   CHECK (did anything get worse?) is sound against ANY artifact version. Even
 *   the v1 writer appended a line for every file that HAD a finding, so a
 *   leaking file is never missing — a new source or a grown count cannot hide.
 *
 *   UPDATE (ratchet the numbers down) requires a COMPLETE denominator (every
 *   record v>=2). Under v1 a clean file and a file that never ran are the same
 *   observation — absence — so "it stopped leaking" is indistinguishable from
 *   "it wasn't exercised", and ratcheting on that evidence writes a baseline
 *   that no longer describes anything. `ratchetDown` refuses rather than guess.
 *
 * The same asymmetry, one level down, governs files the run did not touch at
 * all: `test:affected` exercises a subset of workspaces, so a baseline entry
 * that was not OBSERVED in this run is reported as not-exercised and left
 * untouched. It is never a failure (it did not get worse) and never a removal
 * (it was not proven fixed).
 *
 * ── NEW LEAKS ARE NOT BASELINED ──────────────────────────────────────────────
 *
 * `ratchetDown` only ever LOWERS a number or REMOVES an entry. It cannot add
 * one, and there is no flag that makes it. A newly-leaking file is a regression
 * to fix, not a row to append — the moment the tool can widen its own baseline
 * it stops being a ratchet and becomes the parking lot CLAUDE.md's shrink-only
 * rule exists to prevent. A genuinely-unavoidable new entry is a hand edit to
 * the JSON, in a diff a reviewer can see, with a reason beside it.
 */
import { TIMER_LENS_PREFIX, type CensusReport } from './leak-census-aggregate.js';
import type { FileVerdict, PostMortemFireRecord } from './handle-leak-delta.js';

/** Which instrument produced a count. They are compared separately and never summed. */
export type LensName = 'timers' | 'handles';

/** One file's leaked population, split by lens. Victim (`consumed`) deltas are NOT counted: a victim is not at fault. */
export type LeakBaselineEntry = {
  /** Lens 2 — `timer:*` units left armed. Authoritative for timers; sees unref'd ones. */
  timers: number;
  /** Lens 1 — non-timer resource units left open (sockets, pipes, child processes, …). */
  handles: number;
};

export type LeakBaseline = {
  version: 1;
  /** When the baseline was last ratcheted DOWN, ISO-8601 UTC. */
  updated: string;
  /** Per test file, worst-known leaked population. Shrink-only. */
  files: Record<string, LeakBaselineEntry>;
  /**
   * Known post-mortem fires, keyed by `formatFireKey`. A fire is one file's code
   * executing inside another file's test run (D-020 §3) — a stronger claim than
   * any arm count, so it is ratcheted as its own population and rendered first.
   */
  postMortemFires: Record<string, number>;
};

export const EMPTY_BASELINE: LeakBaseline = {
  version: 1,
  updated: '1970-01-01T00:00:00.000Z',
  files: {},
  postMortemFires: {},
};

export type LeakRegression =
  | { kind: 'new-source'; file: string; observed: LeakBaselineEntry }
  | { kind: 'grew'; file: string; lens: LensName; baseline: number; observed: number }
  | { kind: 'new-fire'; key: string; observed: number }
  | { kind: 'fire-grew'; key: string; baseline: number; observed: number };

export type LeakImprovement =
  | { kind: 'shrank'; file: string; lens: LensName; baseline: number; observed: number }
  | { kind: 'cleared'; file: string }
  | { kind: 'fire-cleared'; key: string };

export type RatchetVerdict =
  /** The run exercised files and nothing got worse. */
  | 'held'
  /** At least one lens, on at least one file, is above its baseline. */
  | 'regressed'
  /** No records at all — the ratchet has nothing to judge. NEVER read this as a pass. */
  | 'no-data';

export type RatchetResult = {
  verdict: RatchetVerdict;
  regressions: LeakRegression[];
  /**
   * Only populated when the denominator is complete. Under an incomplete
   * artifact an absent file is unexplained, so "cleared" would be a guess in the
   * silent-false-clean direction — the exact failure the v2 record exists to
   * close. Empty here means "not judgeable", never "no progress".
   */
  improvements: LeakImprovement[];
  improvementsJudgeable: boolean;
  /** Why improvements could not be judged, or null when they could. */
  improvementsUnjudgeableReason: string | null;
  /** Baseline files this run did not exercise. Neither a failure nor a removal. */
  notExercised: string[];
  /** How many distinct files the run actually recorded. */
  observedFiles: number;
};

/** Stable key for one (armer, landing, kind) fire population. */
export function formatFireKey(fire: Pick<PostMortemFireRecord, 'armedIn' | 'landedIn' | 'kind'>): string {
  return `${fire.armedIn} -> ${fire.landedIn} [${fire.kind}]`;
}

/**
 * Split one file's LEAKED deltas into the two lens scalars.
 *
 * `consumed` is deliberately ignored: a negative delta means the file ran
 * somebody else's leak (or closed a handle that predated its first hook), and
 * blaming it would send the next reader hunting a bug in the wrong file.
 */
export function lensUnits(verdict: FileVerdict): LeakBaselineEntry {
  let timers = 0;
  let handles = 0;
  for (const d of verdict.leaked) {
    if (d.resource.startsWith(TIMER_LENS_PREFIX)) timers += d.delta;
    else handles += d.delta;
  }
  return { timers, handles };
}

/** Every file the run recorded, mapped to its lens scalars. Clean files map to zeroes. */
function observedEntries(report: CensusReport): Map<string, LeakBaselineEntry> {
  const observed = new Map<string, LeakBaselineEntry>();
  for (const v of report.census.sources) observed.set(v.file, lensUnits(v));
  // Sources are the only files carrying leaks; the rest of the observed
  // population is clean by construction. `filesObserved` counts them, but the
  // census only retains verdicts for sources and victims, so a clean file is
  // present in the denominator without a row here — which is all the ratchet
  // needs, since a baseline entry is judged by whether it appears among sources.
  for (const v of report.census.victims) if (!observed.has(v.file)) observed.set(v.file, { timers: 0, handles: 0 });
  return observed;
}

const LENSES: readonly LensName[] = ['timers', 'handles'];

/**
 * Compare a census against the baseline.
 *
 * Regression detection runs against ANY artifact version (see the header): the
 * v1 writer still recorded every file that had a finding, so nothing that got
 * worse can be missing. Only the improvement half is gated on a complete
 * denominator.
 */
export function compareToBaseline(report: CensusReport, baseline: LeakBaseline): RatchetResult {
  const observed = observedEntries(report);
  const regressions: LeakRegression[] = [];

  for (const [file, units] of observed) {
    const known = baseline.files[file];
    if (!known) {
      if (units.timers > 0 || units.handles > 0) regressions.push({ kind: 'new-source', file, observed: units });
      continue;
    }
    // THE TWO LENSES ARE COMPARED INDEPENDENTLY. A file that trades a timer for
    // a socket has introduced a handle leak; a summed comparison would call it a
    // wash and let it through.
    for (const lens of LENSES) {
      if (units[lens] > known[lens]) {
        regressions.push({ kind: 'grew', file, lens, baseline: known[lens], observed: units[lens] });
      }
    }
  }

  const observedFires = new Map<string, number>();
  for (const fire of report.postMortemFires) observedFires.set(formatFireKey(fire), fire.count);
  for (const [key, count] of observedFires) {
    const known = baseline.postMortemFires[key];
    if (known === undefined) regressions.push({ kind: 'new-fire', key, observed: count });
    else if (count > known) regressions.push({ kind: 'fire-grew', key, baseline: known, observed: count });
  }

  const notExercised = Object.keys(baseline.files).filter((f) => !observed.has(f)).sort();

  const improvements: LeakImprovement[] = [];
  const judgeable = report.denominator.complete;
  if (judgeable) {
    for (const [file, known] of Object.entries(baseline.files)) {
      const units = observed.get(file);
      if (!units) continue; // not exercised — silence is not evidence of a fix
      if (units.timers === 0 && units.handles === 0) {
        improvements.push({ kind: 'cleared', file });
        continue;
      }
      for (const lens of LENSES) {
        if (units[lens] < known[lens]) {
          improvements.push({ kind: 'shrank', file, lens, baseline: known[lens], observed: units[lens] });
        }
      }
    }
    for (const key of Object.keys(baseline.postMortemFires)) {
      if (!observedFires.has(key)) improvements.push({ kind: 'fire-cleared', key });
    }
  }

  // A run that recorded NOTHING produces no regressions, which would otherwise
  // render as a pass — the same false-clean shape as an empty census. It gets
  // its own verdict so a caller cannot mistake absence for health.
  const verdict: RatchetVerdict =
    report.denominator.observed === 0 ? 'no-data' : regressions.length > 0 ? 'regressed' : 'held';

  return {
    verdict,
    regressions,
    improvements,
    improvementsJudgeable: judgeable,
    improvementsUnjudgeableReason: judgeable ? null : report.denominator.reason,
    notExercised,
    observedFiles: report.denominator.observed,
  };
}

export type RatchetDownResult =
  | { ok: true; baseline: LeakBaseline; lowered: LeakImprovement[] }
  | { ok: false; reason: string };

/**
 * Produce the next baseline: same entries, lower numbers.
 *
 * Refuses on an incomplete denominator, and never adds or raises anything — the
 * two invariants that make this a ratchet rather than a rubber stamp. `now` is
 * injected so the caller owns the clock (and the test does not have to freeze it).
 */
export function ratchetDown(
  baseline: LeakBaseline,
  report: CensusReport,
  now: string,
): RatchetDownResult {
  if (!report.denominator.complete) {
    return {
      ok: false,
      reason: `refusing to ratchet: ${report.denominator.reason}. An absent file cannot be told apart from a clean one, so lowering the baseline on this artifact would record a fix that may not have happened.`,
    };
  }
  if (report.denominator.observed === 0) {
    return { ok: false, reason: 'refusing to ratchet: the run recorded no files at all, so nothing was proven fixed' };
  }

  const observed = observedEntries(report);
  const files: Record<string, LeakBaselineEntry> = {};
  const lowered: LeakImprovement[] = [];

  for (const [file, known] of Object.entries(baseline.files)) {
    const units = observed.get(file);
    if (!units) {
      files[file] = known; // not exercised — carried unchanged
      continue;
    }
    if (units.timers === 0 && units.handles === 0) {
      lowered.push({ kind: 'cleared', file });
      continue; // entry removed: proven clean in a run that records clean files
    }
    const next: LeakBaselineEntry = { timers: known.timers, handles: known.handles };
    for (const lens of LENSES) {
      if (units[lens] < known[lens]) {
        lowered.push({ kind: 'shrank', file, lens, baseline: known[lens], observed: units[lens] });
        next[lens] = units[lens];
      }
      // A count ABOVE the baseline is a regression, never a new high-water mark.
      // Carrying `known` here is what makes the entry monotonically non-increasing.
    }
    files[file] = next;
  }

  const observedFires = new Set(report.postMortemFires.map(formatFireKey));
  const postMortemFires: Record<string, number> = {};
  for (const [key, count] of Object.entries(baseline.postMortemFires)) {
    if (!observedFires.has(key)) {
      lowered.push({ kind: 'fire-cleared', key });
      continue;
    }
    const seen = report.postMortemFires.find((f) => formatFireKey(f) === key);
    postMortemFires[key] = seen && seen.count < count ? seen.count : count;
  }

  return { ok: true, baseline: { version: 1, updated: now, files, postMortemFires }, lowered };
}

/** Parse a baseline document, tolerating a missing file (an unratcheted repo starts empty). */
export function parseBaseline(contents: string | null): LeakBaseline {
  if (contents === null || contents.trim() === '') return { ...EMPTY_BASELINE };
  const parsed: unknown = JSON.parse(contents);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('leak baseline is not an object');
  const doc = parsed as Partial<LeakBaseline>;
  const files: Record<string, LeakBaselineEntry> = {};
  for (const [file, entry] of Object.entries(doc.files ?? {})) {
    const timers = Number((entry as Partial<LeakBaselineEntry>)?.timers ?? 0);
    const handles = Number((entry as Partial<LeakBaselineEntry>)?.handles ?? 0);
    if (!Number.isFinite(timers) || !Number.isFinite(handles)) throw new Error(`leak baseline entry for ${file} is not numeric`);
    files[file] = { timers, handles };
  }
  const postMortemFires: Record<string, number> = {};
  for (const [key, count] of Object.entries(doc.postMortemFires ?? {})) {
    const n = Number(count);
    if (!Number.isFinite(n)) throw new Error(`leak baseline fire count for ${key} is not numeric`);
    postMortemFires[key] = n;
  }
  return { version: 1, updated: String(doc.updated ?? EMPTY_BASELINE.updated), files, postMortemFires };
}

/** Serialize with sorted keys so a ratchet produces a reviewable, order-stable diff. */
export function serializeBaseline(baseline: LeakBaseline): string {
  const files: Record<string, LeakBaselineEntry> = {};
  for (const file of Object.keys(baseline.files).sort()) files[file] = baseline.files[file] as LeakBaselineEntry;
  const postMortemFires: Record<string, number> = {};
  for (const key of Object.keys(baseline.postMortemFires).sort()) {
    postMortemFires[key] = baseline.postMortemFires[key] as number;
  }
  return `${JSON.stringify({ version: 1, updated: baseline.updated, files, postMortemFires }, null, 2)}\n`;
}

/**
 * Render the ratchet verdict.
 *
 * Fires lead, then regressions, then what could NOT be judged. The
 * not-judgeable section is printed even when empty-ish for the same reason the
 * census prints "post-mortem fires: none recorded": a silent report reads as a
 * clean bill, and the whole point of this module is that some silences mean
 * "not measured" rather than "fine".
 */
export function renderRatchetReport(result: RatchetResult): string {
  const lines: string[] = [];
  lines.push('LEAK BASELINE RATCHET');
  lines.push(
    result.verdict === 'no-data'
      ? '  verdict: NO DATA — the run recorded no files. This is not a pass; nothing was judged.'
      : result.verdict === 'regressed'
        ? `  verdict: REGRESSED — ${result.regressions.length} finding(s) above baseline`
        : `  verdict: held (${result.observedFiles} files exercised)`,
  );

  const fires = result.regressions.filter((r) => r.kind === 'new-fire' || r.kind === 'fire-grew');
  if (fires.length > 0) {
    lines.push('  ⚠ POST-MORTEM FIRE REGRESSIONS — a file executed inside another file\'s run:');
    for (const r of fires) {
      lines.push(
        r.kind === 'new-fire'
          ? `    NEW  ${r.key} ×${r.observed}`
          : `    GREW ${r.key} ${r.baseline} -> ${r.observed}`,
      );
    }
  }

  const leaks = result.regressions.filter((r) => r.kind === 'new-source' || r.kind === 'grew');
  if (leaks.length > 0) {
    lines.push('  leak regressions (each lens judged separately — the two are never summed):');
    for (const r of leaks) {
      lines.push(
        r.kind === 'new-source'
          ? `    NEW  ${r.file} — timers ${r.observed.timers}, handles ${r.observed.handles}`
          : `    GREW ${r.file} — ${r.lens} ${r.baseline} -> ${r.observed}`,
      );
    }
    lines.push('    A new leak is fixed, not baselined: the ratchet cannot widen itself.');
  }

  if (result.improvementsJudgeable) {
    lines.push(
      result.improvements.length > 0
        ? `  improvements ready to ratchet down: ${result.improvements.length} (run with --update)`
        : '  improvements: none this run',
    );
  } else {
    lines.push(`  improvements: NOT JUDGEABLE — ${result.improvementsUnjudgeableReason ?? 'incomplete denominator'}`);
  }

  if (result.notExercised.length > 0) {
    lines.push(
      `  not exercised by this run: ${result.notExercised.length} baseline file(s) — carried unchanged, neither failed nor cleared`,
    );
  }
  return lines.join('\n');
}
