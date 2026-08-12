import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CENSUS_RECORD_VERSION,
  aggregateCensusDir,
  buildCensusReport,
  dedupeByFile,
  parseCensusJsonl,
  renderCensusReport,
  splitByLens,
  type CensusRecord,
} from './leak-census-aggregate.js';

function rec(file: string, leaked: number, opts: { v?: number; pid?: number } = {}): CensusRecord {
  return {
    file,
    leaked: leaked > 0 ? [{ resource: 'Timeout', delta: leaked }] : [],
    consumed: [],
    ...(opts.v === undefined ? {} : { v: opts.v }),
    ...(opts.pid === undefined ? {} : { pid: opts.pid }),
  };
}

const v2 = (file: string, leaked: number, pid?: number) =>
  rec(file, leaked, { v: CENSUS_RECORD_VERSION, pid });

describe('parseCensusJsonl', () => {
  it('parses whole lines and ignores blanks', () => {
    const contents = `${JSON.stringify(v2('a.test.ts', 1))}\n\n${JSON.stringify(v2('b.test.ts', 0))}\n`;
    const { records, malformed } = parseCensusJsonl(contents);
    expect(records.map((r) => r.file)).toEqual(['a.test.ts', 'b.test.ts']);
    expect(malformed).toBe(0);
  });

  it('keeps every complete record when a worker was killed mid-append', () => {
    // The EXPECTED shape of a killed worker's artifact: a truncated final line.
    // Discarding the file over it would silently shrink the denominator.
    const contents = `${JSON.stringify(v2('a.test.ts', 1))}\n{"file":"b.test.ts","lea`;
    const { records, malformed } = parseCensusJsonl(contents);
    expect(records).toHaveLength(1);
    expect(malformed).toBe(1);
  });

  it('rejects JSON that parses but is not a verdict', () => {
    const { records, malformed } = parseCensusJsonl('{"file":"a.test.ts"}\n[]\n"nope"\n');
    expect(records).toHaveLength(0);
    expect(malformed).toBe(3);
  });
});

describe('dedupeByFile', () => {
  it('keeps the worst observation so a clean retry cannot hide a real leak', () => {
    const { records, duplicates } = dedupeByFile([v2('a.test.ts', 0), v2('a.test.ts', 3)]);
    expect(records).toHaveLength(1);
    expect(records[0]?.leaked[0]?.delta).toBe(3);
    expect(duplicates).toBe(1);
  });

  it('does not sum duplicates into an inflated leak count', () => {
    const { records } = dedupeByFile([v2('a.test.ts', 2), v2('a.test.ts', 2)]);
    expect(records[0]?.leaked[0]?.delta).toBe(2);
  });
});

describe('buildCensusReport — the denominator envelope', () => {
  it('refuses a rate when the artifact recorded only files with findings (v1)', () => {
    // Every v1 record leaks by construction, so census.rate is 1.0 — a perfectly
    // computed, completely wrong "100% of files leak". The report must not carry it.
    const report = buildCensusReport([rec('a.test.ts', 1), rec('b.test.ts', 2)]);
    expect(report.census.rate).toBe(1);
    expect(report.leakRate).toBeNull();
    expect(report.denominator.complete).toBe(false);
    expect(report.denominator.reason).toMatch(/FLOOR/);
  });

  it('reports a rate once every record proves clean files were recorded', () => {
    const report = buildCensusReport([v2('a.test.ts', 1), v2('b.test.ts', 0), v2('c.test.ts', 0), v2('d.test.ts', 0)]);
    expect(report.denominator.complete).toBe(true);
    expect(report.denominator.observed).toBe(4);
    expect(report.leakRate).toBeCloseTo(0.25);
  });

  it('treats a MIXED artifact as incomplete — the weakest record governs', () => {
    const report = buildCensusReport([v2('a.test.ts', 0), rec('b.test.ts', 1)]);
    expect(report.denominator.complete).toBe(false);
    expect(report.leakRate).toBeNull();
  });

  it('calls an empty artifact unknown, never a clean bill of health', () => {
    const report = buildCensusReport([]);
    expect(report.denominator.complete).toBe(false);
    expect(report.leakRate).toBeNull();
    expect(report.denominator.reason).toMatch(/unknown, not zero/);
    expect(report.census.filesLeaking).toBe(0);
  });

  it('counts distinct reporting workers', () => {
    const report = buildCensusReport([v2('a.test.ts', 1, 10), v2('b.test.ts', 0, 10), v2('c.test.ts', 0, 11)]);
    expect(report.processes).toBe(2);
  });

  it('derives worker reuse from the artifacts — one file per pid means an isolated run', () => {
    const isolated = buildCensusReport([v2('a.test.ts', 1, 10), v2('b.test.ts', 0, 11)]);
    expect(isolated.workerReuse).toBe(false);
    const reused = buildCensusReport([v2('a.test.ts', 1, 10), v2('b.test.ts', 0, 10)]);
    expect(reused.workerReuse).toBe(true);
  });

  it('ranks sources worst-first and totals by resource', () => {
    const report = buildCensusReport([v2('small.test.ts', 1), v2('big.test.ts', 5), v2('ok.test.ts', 0)]);
    expect(report.census.sources.map((s) => s.file)).toEqual(['big.test.ts', 'small.test.ts']);
    expect(report.census.byResource).toEqual({ Timeout: 6 });
  });

  it('does not count a victim as a source', () => {
    const victim: CensusRecord = {
      file: 'victim.test.ts',
      leaked: [],
      consumed: [{ resource: 'Timeout', delta: -1 }],
      v: CENSUS_RECORD_VERSION,
    };
    const report = buildCensusReport([v2('leaker.test.ts', 1), victim, v2('ok.test.ts', 0)]);
    expect(report.census.sources.map((s) => s.file)).toEqual(['leaker.test.ts']);
    expect(report.census.victims.map((s) => s.file)).toEqual(['victim.test.ts']);
    expect(report.leakRate).toBeCloseTo(1 / 3);
  });
});

describe('splitByLens', () => {
  it('separates the two instruments so nothing can total them', () => {
    const split = splitByLens({ 'timer:setTimeout': 52, Timeout: 51, TCPSocketWrap: 11 });
    expect(split.timers).toEqual({ 'timer:setTimeout': 52 });
    expect(split.handles).toEqual({ Timeout: 51, TCPSocketWrap: 11 });
  });

  it('flags the lens-1 names that double-count lens 2 timers', () => {
    const split = splitByLens({ 'timer:setTimeout': 52, Timeout: 51, Immediate: 2, PipeWrap: 3 });
    expect(split.overlapping).toEqual(['Timeout', 'Immediate']);
  });

  it('does not flag an overlap when only one lens reported', () => {
    // cell-read.test.ts measured live: timer:setTimeout+121 with NO Timeout at all
    // (unref'd timers, which lens 1 is structurally blind to). Nothing to warn about.
    expect(splitByLens({ 'timer:setTimeout': 121 }).overlapping).toEqual([]);
    expect(splitByLens({ Timeout: 4, PipeWrap: 3 }).overlapping).toEqual([]);
  });
});

describe('renderCensusReport', () => {
  it('prints NO percentage at all when the denominator is incomplete', () => {
    // The anti-misquote property: a percentage with a footnote gets quoted without
    // the footnote, so an unjustified rate must not appear in the text at all.
    const text = renderCensusReport(buildCensusReport([rec('a.test.ts', 1)]));
    expect(text).toMatch(/leak rate: UNAVAILABLE/);
    expect(text).not.toMatch(/%/);
  });

  it('prints the rate once it is justified', () => {
    const text = renderCensusReport(buildCensusReport([v2('a.test.ts', 1), v2('b.test.ts', 0)]));
    expect(text).toMatch(/leak rate: 50\.000% \(1\/2 files\)/);
  });

  it('warns against summing the lenses when both reported the same timers', () => {
    const both: CensusRecord = {
      file: 'a.test.ts',
      leaked: [
        { resource: 'timer:setTimeout', delta: 52 },
        { resource: 'Timeout', delta: 51 },
      ],
      consumed: [],
      v: CENSUS_RECORD_VERSION,
    };
    const text = renderCensusReport(buildCensusReport([both]));
    expect(text).toMatch(/DO NOT SUM THE TWO LENSES/);
    // The two instruments must never share one list, or the reader totals them.
    expect(text).toMatch(/timers left armed/);
    expect(text).toMatch(/handles left open/);
  });

  it('labels victims as not at fault when workers were reused', () => {
    const victim = (pid: number): CensusRecord => ({
      file: `victim-${pid}.test.ts`,
      leaked: [],
      consumed: [{ resource: 'Timeout', delta: -1 }],
      v: CENSUS_RECORD_VERSION,
      pid,
    });
    // Same pid twice => worker reuse => another file really could have polluted it.
    const text = renderCensusReport(buildCensusReport([victim(7), { ...victim(7), file: 'other.test.ts' }]));
    expect(text).toMatch(/NOT at fault/);
  });

  it('refuses to call a negative delta a VICTIM in an isolated run', () => {
    // One file per pid => nothing else ran in that worker => there is no other
    // file to have been victimised BY, so the victim framing would be a fiction.
    const lone: CensusRecord = {
      file: 'lone.test.ts',
      leaked: [],
      consumed: [{ resource: 'Timeout', delta: -1 }],
      v: CENSUS_RECORD_VERSION,
      pid: 7,
    };
    const text = renderCensusReport(buildCensusReport([lone]));
    expect(text).toMatch(/NOT victims/);
    expect(text).toMatch(/did not reuse workers/);
  });
});

describe('aggregateCensusDir', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'leak-census-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('merges every worker artifact in the directory', () => {
    writeFileSync(join(dir, 'leaks-10.jsonl'), `${JSON.stringify(v2('a.test.ts', 1, 10))}\n`);
    writeFileSync(join(dir, 'leaks-11.jsonl'), `${JSON.stringify(v2('b.test.ts', 0, 11))}\n`);
    const report = aggregateCensusDir(dir);
    expect(report.denominator.observed).toBe(2);
    expect(report.processes).toBe(2);
    expect(report.leakRate).toBeCloseTo(0.5);
  });

  it('ignores files that are not leak artifacts', () => {
    writeFileSync(join(dir, 'leaks-10.jsonl'), `${JSON.stringify(v2('a.test.ts', 1, 10))}\n`);
    writeFileSync(join(dir, 'notes.txt'), 'not json at all');
    writeFileSync(join(dir, 'leaks-10.jsonl.tmp'), 'garbage');
    const report = aggregateCensusDir(dir);
    expect(report.denominator.observed).toBe(1);
    expect(report.malformedLines).toBe(0);
  });

  it('reports a MISSING directory as unknown rather than throwing or claiming clean', () => {
    const report = aggregateCensusDir(join(dir, 'does-not-exist'));
    expect(report.denominator.complete).toBe(false);
    expect(report.leakRate).toBeNull();
  });

  it('survives an unreadable entry without losing the readable ones', () => {
    writeFileSync(join(dir, 'leaks-10.jsonl'), `${JSON.stringify(v2('a.test.ts', 1, 10))}\n`);
    // A directory named like an artifact — readFileSync throws EISDIR on it.
    mkdirSync(join(dir, 'leaks-99.jsonl'));
    const report = aggregateCensusDir(dir);
    expect(report.denominator.observed).toBe(1);
  });
});
