/**
 * Handle/timer leak CENSUS AGGREGATION — folds the per-process JSONL artifacts
 * written by setup-handle-leak-detector.ts into one census over a whole suite
 * run (plan gate-suite-speedup-2026-08-12 D-014/D-016/D-018; WI-38215).
 *
 * The census is the precondition for the enforced, shrink-only leak baseline:
 * you cannot ratchet a population you have not counted, and D-008 forbids
 * standing up an exclusion list instead of counting.
 *
 * ── THE DENOMINATOR IS THE WHOLE PROBLEM ─────────────────────────────────────
 *
 * The detector's artifact is not a census on its own, and reading it as one
 * produces a specific, confident, wrong number. Until record version 2 it
 * appended a line ONLY for files that had a finding, so:
 *
 *     filesObserved == filesLeaking   =>   rate == 1.0   =>   "100% of test
 *     files leak", from an instrument that is working perfectly.
 *
 * That is the repo's standing failure mode (a bounded measurement rendered as a
 * confident total) and CLAUDE.md's rule about it is explicit: the boundedness
 * marker belongs ON THE AGGREGATE, not on the row list, because the aggregate is
 * what gets read as a verdict. So this module refuses to emit a rate it cannot
 * justify: `leakRate` is NULL, not a number, whenever the artifact cannot prove
 * it saw the clean files too.
 *
 * The proof is per-record and positive: a v>=2 record is written for EVERY file,
 * finding or not, so a run whose records are all v>=2 has a real denominator.
 * Inferring it instead — "some records have empty leaked+consumed, so clean
 * files must be recorded" — is unsound in exactly the case that matters, a run
 * where everything leaks, and unsound the other way for a v1 artifact that
 * happens to contain a victim-only record.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CENSUS_RECORD_VERSION,
  leakWeight,
  summarizeCensus,
  type FileVerdict,
  type LeakCensus,
  type PostMortemFireRecord,
  type ResourceCounts,
} from './handle-leak-delta.js';

/**
 * The artifact's record-format contract is DEFINED in handle-leak-delta.ts and
 * re-exported here, so a reader of the aggregator still finds it where they look
 * for it. It lives there because the detector — a setup file that runs in front of
 * every test file in the repo — must be able to stamp the version without
 * importing this directory-walking module. See the definition for the full reason.
 */
export { CENSUS_RECORD_VERSION, type PostMortemFireRecord };

/** One line of the JSONL artifact. `v` is absent on v1 records. */
export type CensusRecord = FileVerdict & {
  pid?: number;
  v?: number;
  /**
   * Post-mortem fires observed since the previous record was written. The record
   * is their TRANSPORT, not their attribution — each entry names its own armer
   * and landing file, neither of which need be `file`.
   */
  postMortem?: PostMortemFireRecord[];
};

export type CensusDenominator = {
  /** True only when every parsed record proves it was written for a clean file too. */
  complete: boolean;
  /** Distinct files the artifact actually recorded. A FLOOR when `complete` is false. */
  observed: number;
  /** Human-readable why — carried so a report cannot print the number without the caveat. */
  reason: string;
};

export type CensusReport = {
  census: LeakCensus;
  /**
   * filesLeaking / filesObserved — or NULL when the artifact only recorded files
   * that had findings, in which case no honest rate exists from this data alone.
   */
  leakRate: number | null;
  denominator: CensusDenominator;
  /** Distinct pids that contributed records — i.e. how many vitest workers reported. */
  processes: number;
  /**
   * True when at least one worker process recorded MORE THAN ONE file — i.e. the
   * run reused workers (`isolate: false`).
   *
   * This is what decides whether the VICTIM list means anything. A negative delta
   * is the victim signature only if another file could have run in the same
   * worker first; in an ISOLATED run it just means the file closed something that
   * existed before its first hook (a module-import-time handle), which is benign.
   * Derived from the artifacts rather than configured, so it cannot disagree with
   * the run that produced them.
   */
  workerReuse: boolean;
  /** Lines that were not parseable JSON. A worker killed mid-append truncates its last line. */
  malformedLines: number;
  /** Records dropped because the same file was recorded more than once (retries, shards). */
  duplicateFileRecords: number;
  /**
   * Every post-mortem fire population seen, merged across records and pids and
   * ranked by count. Reported SEPARATELY from the census counts and never folded
   * into them: these are the observed poisoning events, a different measurement
   * from "timers left armed", and summing the two would repeat the mistake D-019
   * forbids for the two lenses.
   */
  postMortemFires: PostMortemFireRecord[];
};

/** Lens 2 (timer arm/clear bookkeeping) prefixes its keys; lens 1 uses bare Node names. */
export const TIMER_LENS_PREFIX = 'timer:';

/**
 * Lens-1 resource names that observe THE SAME OBJECTS as lens 2.
 *
 * Node reports a `setTimeout`/`setInterval` handle as `Timeout` and a
 * `setImmediate` handle as `Immediate`, so a ref'd leaked timer is counted once
 * by EACH lens. Measured on the 2026-08-12 affected run: boot-all.test.ts
 * reported `Timeout+51` beside `timer:setTimeout+52` — one population, two
 * instruments, not 103 leaks.
 */
export const OVERLAPPING_LENS1_RESOURCES = ['Timeout', 'Immediate'] as const;

export type ResourceBreakdown = {
  /** Lens 2 — arm/clear bookkeeping. Authoritative for TIMERS: it also sees unref'd ones. */
  timers: ResourceCounts;
  /** Lens 1 — resource introspection. Authoritative for what a timer wrapper cannot see. */
  handles: ResourceCounts;
  /** Lens-1 keys present here that double-count lens 2's timers. */
  overlapping: string[];
};

/**
 * Split the census's flat `byResource` by which lens produced each key.
 *
 * WHY THIS IS NOT COSMETIC: the flat map invites a grand total, and a grand total
 * is WRONG — the lenses overlap on ref'd timers (see above) while each sees
 * things the other cannot (lens 2 catches unref'd timers, measured live on
 * cell-read.test.ts at `timer:setTimeout+121` with NO `Timeout` at all; lens 1
 * catches sockets, pipes and child processes that no timer wrapper can see).
 * The two counts are therefore neither additive nor nested, and the only honest
 * presentation keeps them apart.
 */
export function splitByLens(byResource: ResourceCounts): ResourceBreakdown {
  const timers: ResourceCounts = {};
  const handles: ResourceCounts = {};
  for (const [resource, count] of Object.entries(byResource)) {
    if (resource.startsWith(TIMER_LENS_PREFIX)) timers[resource] = count;
    else handles[resource] = count;
  }
  const overlapping = OVERLAPPING_LENS1_RESOURCES.filter(
    (r) => handles[r] !== undefined && Object.keys(timers).length > 0,
  );
  return { timers, handles, overlapping };
}

function isRecord(value: unknown): value is CensusRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<CensusRecord>;
  return typeof v.file === 'string' && Array.isArray(v.leaked) && Array.isArray(v.consumed);
}

/**
 * Parse one artifact's contents. Tolerant by design: a truncated trailing line is
 * the EXPECTED shape when a worker is killed mid-append, and losing the whole
 * artifact over it would silently shrink the denominator — the failure this
 * module exists to prevent. Malformed lines are counted, never thrown on.
 */
export function parseCensusJsonl(contents: string): { records: CensusRecord[]; malformed: number } {
  const records: CensusRecord[] = [];
  let malformed = 0;
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

/**
 * Collapse records for the same file, keeping the WORST observation.
 *
 * A file can legitimately appear twice (a vitest retry, a sharded re-run). Summing
 * them would inflate the leak counts, and keeping the first would let a retry that
 * happened not to leak hide a real leak. "Leaked in any observation" is the
 * semantics a census wants: the file IS a source.
 */
export function dedupeByFile(records: readonly CensusRecord[]): {
  records: CensusRecord[];
  duplicates: number;
} {
  const worst = new Map<string, CensusRecord>();
  let duplicates = 0;
  for (const record of records) {
    const seen = worst.get(record.file);
    if (!seen) {
      worst.set(record.file, record);
      continue;
    }
    duplicates += 1;
    if (leakWeight(record) > leakWeight(seen)) worst.set(record.file, record);
  }
  return { records: [...worst.values()], duplicates };
}

/**
 * Merge every record's post-mortem fires into one ranked population.
 *
 * Deliberately reads the FULL record list rather than the deduplicated one: a
 * duplicate record (a retry, a shard re-run) is dropped from the census because
 * counting one file's untidiness twice would inflate it, but the fires it carries
 * are distinct events that actually happened in that process — dropping them
 * would lose observations, which is the opposite failure.
 */
export function mergePostMortemFires(records: readonly CensusRecord[]): PostMortemFireRecord[] {
  const merged = new Map<string, PostMortemFireRecord>();
  for (const record of records) {
    for (const fire of record.postMortem ?? []) {
      const key = JSON.stringify([fire.armedIn, fire.landedIn, fire.kind]);
      const seen = merged.get(key);
      if (seen) seen.count += fire.count;
      else merged.set(key, { ...fire });
    }
  }
  return [...merged.values()].sort((a, b) => b.count - a.count);
}

/** Build the census + its honesty envelope from already-parsed records. */
export function buildCensusReport(
  records: readonly CensusRecord[],
  opts: { malformedLines?: number } = {},
): CensusReport {
  const { records: unique, duplicates } = dedupeByFile(records);
  const census = summarizeCensus(unique);
  // Every record must carry the version that PROVES clean files were recorded. An
  // empty artifact proves nothing either, so it is incomplete rather than a
  // vacuous "complete" — a run that produced no records is exactly when a false
  // clean bill is most tempting.
  const complete = unique.length > 0 && unique.every((r) => (r.v ?? 1) >= CENSUS_RECORD_VERSION);
  const perPid = new Map<number, number>();
  for (const r of unique) {
    if (typeof r.pid !== 'number') continue;
    perPid.set(r.pid, (perPid.get(r.pid) ?? 0) + 1);
  }
  const pids = new Set(perPid.keys());
  const workerReuse = [...perPid.values()].some((n) => n > 1);
  return {
    census,
    postMortemFires: mergePostMortemFires(records),
    leakRate: complete ? census.rate : null,
    denominator: {
      complete,
      observed: unique.length,
      reason: complete
        ? `every record is v>=${CENSUS_RECORD_VERSION}, so clean files were recorded and the denominator is the observed file population`
        : unique.length === 0
          ? 'no records were parsed — the denominator is unknown, not zero'
          : `at least one record predates v${CENSUS_RECORD_VERSION}, which recorded ONLY files with findings; ${unique.length} is a FLOOR on leaking files, not the file population, and no rate can be derived`,
    },
    processes: pids.size,
    workerReuse,
    malformedLines: opts.malformedLines ?? 0,
    duplicateFileRecords: duplicates,
  };
}

/**
 * Read every `leaks-*.jsonl` in a report directory and aggregate them.
 *
 * A missing directory is reported as an empty census rather than thrown: "the
 * suite ran and wrote nothing" and "the directory is not there" are both answered
 * by an incomplete denominator, and neither is a clean bill of health.
 */
export function aggregateCensusDir(dir: string): CensusReport {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith('leaks-') && n.endsWith('.jsonl'));
  } catch {
    return buildCensusReport([], {});
  }
  const records: CensusRecord[] = [];
  let malformed = 0;
  for (const name of names) {
    let contents = '';
    try {
      contents = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseCensusJsonl(contents);
    records.push(...parsed.records);
    malformed += parsed.malformed;
  }
  return buildCensusReport(records, { malformedLines: malformed });
}

/**
 * Render the census as text.
 *
 * The rate line is the one that gets quoted into a plan or a status report, so it
 * is written to be un-quotable out of context: when the denominator is incomplete
 * it prints the caveat INSTEAD of a percentage, never a percentage with a footnote.
 */
export function renderCensusReport(report: CensusReport): string {
  const { census, denominator } = report;
  const lines: string[] = [];
  lines.push('HANDLE/TIMER LEAK CENSUS');
  lines.push(
    denominator.complete
      ? `  leak rate: ${(census.rate * 100).toFixed(3)}% (${census.filesLeaking}/${census.filesObserved} files)`
      : `  leak rate: UNAVAILABLE — ${denominator.reason}`,
  );
  lines.push(`  leaking files (floor): ${census.filesLeaking}`);
  lines.push(`  workers reporting: ${report.processes}`);
  if (report.malformedLines > 0) lines.push(`  malformed lines: ${report.malformedLines}`);
  if (report.duplicateFileRecords > 0) lines.push(`  duplicate file records: ${report.duplicateFileRecords}`);

  // POST-MORTEM FIRES lead the findings, above the hygiene counts, because they
  // are a different and stronger claim. Everything below this block is "how
  // untidy is the suite"; this block is "which file actually poisoned which",
  // the question D-014 says must be answerable before the non-isolated split can
  // ship. A run with a huge arm count and no fires is messy but not dangerous.
  if (report.postMortemFires.length > 0) {
    lines.push('  ⚠ POST-MORTEM FIRES — a timer fired AFTER its arming file finished (worst first):');
    for (const fire of report.postMortemFires) {
      lines.push(`    ${fire.armedIn} -> ${fire.landedIn} — ${fire.kind} ×${fire.count}`);
    }
    lines.push('    (armer -> file it landed in. THIS is cross-file poisoning; the counts below are hygiene.)');
  } else {
    // Said explicitly, because silence here would otherwise read as a clean bill
    // when the true meaning may be that no v2 detector wrote any fire records.
    lines.push('  post-mortem fires: none recorded (no timer observed firing after its arming file finished)');
  }

  // Rendered per LENS, never as one list: a flat list invites a grand total, and
  // the lenses overlap on ref'd timers while each sees what the other cannot.
  const { timers, handles, overlapping } = splitByLens(census.byResource);
  const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1];
  const timerRows = Object.entries(timers).sort(byCount);
  const handleRows = Object.entries(handles).sort(byCount);
  if (timerRows.length > 0) {
    lines.push('  timers left armed (lens 2 — arm/clear bookkeeping; sees unref\'d timers):');
    for (const [resource, count] of timerRows) lines.push(`    ${resource}: ${count}`);
  }
  if (handleRows.length > 0) {
    lines.push('  handles left open (lens 1 — resource introspection):');
    for (const [resource, count] of handleRows) lines.push(`    ${resource}: ${count}`);
  }
  if (overlapping.length > 0) {
    lines.push(
      `  ⚠ DO NOT SUM THE TWO LENSES: ${overlapping.join('/')} above is the same population as the timer: rows`,
    );
    lines.push('    (Node names a leaked setTimeout handle "Timeout"), so adding them invents leaks that do not exist.');
  }
  if (census.sources.length > 0) {
    lines.push('  sources (worst first):');
    for (const v of census.sources) {
      const detail = v.leaked.map((d) => `${d.resource}+${d.delta}`).join(' ');
      lines.push(`    ${v.file} — ${detail}`);
    }
  }
  if (census.victims.length > 0) {
    lines.push(
      report.workerReuse
        ? '  victims (ran someone else\'s leak — NOT at fault):'
        : '  negative deltas (NOT victims — this run did not reuse workers, so no other file could have polluted them; a file closing a handle that existed before its first hook):',
    );
    for (const v of census.victims) {
      const detail = v.consumed.map((d) => `${d.resource}${d.delta}`).join(' ');
      lines.push(`    ${v.file} — ${detail}`);
    }
  }
  return lines.join('\n');
}
