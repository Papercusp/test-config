import { describe, expect, it } from 'vitest';

import { CENSUS_RECORD_VERSION } from './handle-leak-delta.js';
import { buildCensusReport, type CensusRecord, type CensusReport } from './leak-census-aggregate.js';
import {
  EMPTY_BASELINE,
  compareToBaseline,
  formatFireKey,
  lensUnits,
  parseBaseline,
  ratchetDown,
  renderRatchetReport,
  serializeBaseline,
  type LeakBaseline,
  type LeakBaselineEntry,
} from './leak-baseline.js';

const NOW = '2026-08-12T19:30:00.000Z';

type Leak = { timers?: number; handles?: number; handleResource?: string };

/** A v2 record (clean files recorded) with an optional leak in either lens. */
function v2(file: string, leak: Leak = {}, opts: { pid?: number } = {}): CensusRecord {
  const leaked = [
    ...(leak.timers ? [{ resource: 'timer:setTimeout', delta: leak.timers }] : []),
    ...(leak.handles ? [{ resource: leak.handleResource ?? 'TCPSocketWrap', delta: leak.handles }] : []),
  ];
  return { file, leaked, consumed: [], v: CENSUS_RECORD_VERSION, pid: opts.pid ?? 1 };
}

/** A v1 record — written only for files WITH a finding, so the denominator is a floor. */
function v1(file: string, leak: Leak = {}): CensusRecord {
  const { v: _v, ...rest } = v2(file, leak);
  return rest;
}

const reportOf = (records: readonly CensusRecord[]): CensusReport => buildCensusReport(records);

function baselineOf(files: Record<string, LeakBaselineEntry>, fires: Record<string, number> = {}): LeakBaseline {
  return { version: 1, updated: NOW, files, postMortemFires: fires };
}

describe('lensUnits', () => {
  it('splits leaked deltas by lens and never blames a victim', () => {
    expect(
      lensUnits({
        file: 'a.test.ts',
        leaked: [
          { resource: 'timer:setTimeout', delta: 3 },
          { resource: 'timer:setInterval', delta: 2 },
          { resource: 'TCPSocketWrap', delta: 4 },
        ],
        consumed: [{ resource: 'Timeout', delta: -9 }],
      }),
    ).toEqual({ timers: 5, handles: 4 });
  });

  it('counts a leaked ref\'d timer in BOTH lenses, because Node names it twice', () => {
    // Not a bug: `Timeout` (lens 1) and `timer:setTimeout` (lens 2) are the same
    // object seen by two instruments. Keeping both is only safe because the two
    // scalars are never added together — the property the next block pins.
    expect(
      lensUnits({
        file: 'a.test.ts',
        leaked: [
          { resource: 'timer:setTimeout', delta: 51 },
          { resource: 'Timeout', delta: 51 },
        ],
        consumed: [],
      }),
    ).toEqual({ timers: 51, handles: 51 });
  });
});

describe('the two lenses are ratcheted SEPARATELY (D-019 §3)', () => {
  // The control: a comparator that ratchets ONE summed number. It is deliberately
  // wrong and lives here permanently, so the property below is demonstrated
  // against a real alternative rather than merely asserted.
  const summedComparatorSaysRegressed = (before: LeakBaselineEntry, after: LeakBaselineEntry): boolean =>
    after.timers + after.handles > before.timers + before.handles;

  const before: LeakBaselineEntry = { timers: 4, handles: 1 };
  const traded = v2('swap.test.ts', { timers: 3, handles: 2 });

  it('flags a file that traded a timer for a socket — the summed control does NOT', () => {
    const after = lensUnits({ file: 'swap.test.ts', leaked: traded.leaked, consumed: [] });
    expect(summedComparatorSaysRegressed(before, after)).toBe(false); // the control is fooled

    const result = compareToBaseline(reportOf([traded]), baselineOf({ 'swap.test.ts': before }));
    expect(result.verdict).toBe('regressed');
    expect(result.regressions).toEqual([
      { kind: 'grew', file: 'swap.test.ts', lens: 'handles', baseline: 1, observed: 2 },
    ]);
  });

  it('calibration: the summed control DOES fire on a plain increase, so it is not simply dead', () => {
    expect(summedComparatorSaysRegressed(before, { timers: 9, handles: 1 })).toBe(true);
  });

  it('reports the shrunk lens as an improvement in the SAME run that reports the grown one', () => {
    const result = compareToBaseline(reportOf([traded]), baselineOf({ 'swap.test.ts': before }));
    expect(result.improvements).toEqual([
      { kind: 'shrank', file: 'swap.test.ts', lens: 'timers', baseline: 4, observed: 3 },
    ]);
  });
});

describe('compareToBaseline', () => {
  it('holds when every observed file is at or below its baseline', () => {
    const result = compareToBaseline(
      reportOf([v2('a.test.ts', { timers: 2 }), v2('b.test.ts')]),
      baselineOf({ 'a.test.ts': { timers: 2, handles: 0 } }),
    );
    expect(result.verdict).toBe('held');
    expect(result.regressions).toEqual([]);
  });

  it('fails a brand-new leaking file', () => {
    const result = compareToBaseline(reportOf([v2('new.test.ts', { timers: 1 })]), EMPTY_BASELINE);
    expect(result.verdict).toBe('regressed');
    expect(result.regressions).toEqual([
      { kind: 'new-source', file: 'new.test.ts', observed: { timers: 1, handles: 0 } },
    ]);
  });

  it('does not fail a new file that is clean', () => {
    expect(compareToBaseline(reportOf([v2('new.test.ts')]), EMPTY_BASELINE).verdict).toBe('held');
  });

  it('detects a regression even from a v1 artifact — a leaking file is never missing from one', () => {
    const result = compareToBaseline(reportOf([v1('a.test.ts', { timers: 5 })]), baselineOf({ 'a.test.ts': { timers: 2, handles: 0 } }));
    expect(result.verdict).toBe('regressed');
    expect(result.regressions).toEqual([
      { kind: 'grew', file: 'a.test.ts', lens: 'timers', baseline: 2, observed: 5 },
    ]);
  });

  it('refuses to call anything CLEARED from a v1 artifact, where absent and clean are the same observation', () => {
    const result = compareToBaseline(reportOf([v1('a.test.ts', { timers: 1 })]), baselineOf({ 'b.test.ts': { timers: 3, handles: 0 } }));
    expect(result.improvementsJudgeable).toBe(false);
    expect(result.improvements).toEqual([]);
    expect(result.improvementsUnjudgeableReason).toContain('FLOOR');
    expect(result.verdict).toBe('held'); // nothing got worse — but nothing was proven fixed either
  });

  it('does call it cleared from a v2 artifact, which records clean files', () => {
    const result = compareToBaseline(reportOf([v2('a.test.ts')]), baselineOf({ 'a.test.ts': { timers: 3, handles: 0 } }));
    expect(result.improvementsJudgeable).toBe(true);
    expect(result.improvements).toEqual([{ kind: 'cleared', file: 'a.test.ts' }]);
  });

  it('leaves a baseline file the run never exercised alone — neither failed nor cleared', () => {
    const result = compareToBaseline(reportOf([v2('a.test.ts')]), baselineOf({ 'elsewhere.test.ts': { timers: 7, handles: 0 } }));
    expect(result.verdict).toBe('held');
    expect(result.notExercised).toEqual(['elsewhere.test.ts']);
    expect(result.improvements).toEqual([]);
  });

  it('reports NO DATA rather than a pass when the run recorded nothing', () => {
    const result = compareToBaseline(reportOf([]), baselineOf({ 'a.test.ts': { timers: 1, handles: 0 } }));
    expect(result.verdict).toBe('no-data');
    expect(renderRatchetReport(result)).toContain('This is not a pass');
  });
});

describe('post-mortem fires are ratcheted as their own population', () => {
  const fire = { armedIn: 'armer.test.ts', landedIn: 'victim.test.ts', kind: 'setTimeout', count: 1 };
  const withFire = (count: number): CensusRecord => ({ ...v2('armer.test.ts'), postMortem: [{ ...fire, count }] });
  const key = formatFireKey(fire);

  it('fails an unknown fire', () => {
    const result = compareToBaseline(reportOf([withFire(1)]), EMPTY_BASELINE);
    expect(result.regressions).toEqual([{ kind: 'new-fire', key, observed: 1 }]);
    expect(renderRatchetReport(result)).toContain('POST-MORTEM FIRE REGRESSIONS');
  });

  it('fails a known fire that fired more often', () => {
    const result = compareToBaseline(reportOf([withFire(4)]), baselineOf({}, { [key]: 2 }));
    expect(result.regressions).toEqual([{ kind: 'fire-grew', key, baseline: 2, observed: 4 }]);
  });

  it('never folds a fire into the leak counts', () => {
    const result = compareToBaseline(reportOf([withFire(3)]), baselineOf({}, { [key]: 3 }));
    expect(result.verdict).toBe('held');
    expect(result.regressions).toEqual([]);
  });
});

describe('ratchetDown', () => {
  it('refuses an incomplete denominator instead of recording a fix that may not have happened', () => {
    const result = ratchetDown(baselineOf({ 'a.test.ts': { timers: 3, handles: 0 } }), reportOf([v1('a.test.ts', { timers: 1 })]), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('refusing to ratchet');
  });

  it('refuses an empty run', () => {
    expect(ratchetDown(baselineOf({ 'a.test.ts': { timers: 1, handles: 0 } }), reportOf([]), NOW).ok).toBe(false);
  });

  it('lowers a count that shrank, per lens', () => {
    const result = ratchetDown(
      baselineOf({ 'a.test.ts': { timers: 5, handles: 4 } }),
      reportOf([v2('a.test.ts', { timers: 2, handles: 4 })]),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.files['a.test.ts']).toEqual({ timers: 2, handles: 4 });
    expect(result.baseline.updated).toBe(NOW);
  });

  it('removes an entry proven clean', () => {
    const result = ratchetDown(baselineOf({ 'a.test.ts': { timers: 5, handles: 0 } }), reportOf([v2('a.test.ts')]), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.files).toEqual({});
    expect(result.lowered).toEqual([{ kind: 'cleared', file: 'a.test.ts' }]);
  });

  it('NEVER raises a count — a number above baseline is a regression, not a new high-water mark', () => {
    const result = ratchetDown(baselineOf({ 'a.test.ts': { timers: 1, handles: 0 } }), reportOf([v2('a.test.ts', { timers: 99 })]), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.files['a.test.ts']).toEqual({ timers: 1, handles: 0 });
  });

  it('NEVER adds an entry for a newly-leaking file — a new leak is fixed, not baselined', () => {
    const result = ratchetDown(EMPTY_BASELINE, reportOf([v2('new.test.ts', { timers: 8, handles: 3 })]), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.files).toEqual({});
  });

  it('carries a file the run did not exercise unchanged', () => {
    const result = ratchetDown(baselineOf({ 'elsewhere.test.ts': { timers: 7, handles: 0 } }), reportOf([v2('a.test.ts')]), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.files).toEqual({ 'elsewhere.test.ts': { timers: 7, handles: 0 } });
    expect(result.lowered).toEqual([]);
  });

  it('drops a fire the run no longer produced and never re-raises one it did', () => {
    const fire = { armedIn: 'a.test.ts', landedIn: 'b.test.ts', kind: 'setTimeout', count: 9 };
    const key = formatFireKey(fire);
    const gone = ratchetDown(baselineOf({}, { [key]: 2, 'x -> y [setInterval]': 1 }), reportOf([{ ...v2('a.test.ts'), postMortem: [fire] }]), NOW);
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    expect(gone.baseline.postMortemFires).toEqual({ [key]: 2 });
    expect(gone.lowered).toEqual([{ kind: 'fire-cleared', key: 'x -> y [setInterval]' }]);
  });
});

describe('baseline document', () => {
  it('round-trips through parse/serialize with sorted keys for a reviewable diff', () => {
    const baseline = baselineOf({ 'z.test.ts': { timers: 1, handles: 0 }, 'a.test.ts': { timers: 0, handles: 2 } });
    const text = serializeBaseline(baseline);
    expect(text.indexOf('a.test.ts')).toBeLessThan(text.indexOf('z.test.ts'));
    expect(parseBaseline(text)).toEqual(baseline);
  });

  it('treats a missing baseline as empty, so an unratcheted repo starts from zero', () => {
    expect(parseBaseline(null)).toEqual(EMPTY_BASELINE);
    expect(parseBaseline('')).toEqual(EMPTY_BASELINE);
  });

  it('throws on a non-numeric entry rather than coercing it to a silent zero', () => {
    expect(() => parseBaseline('{"files":{"a.test.ts":{"timers":"lots","handles":0}}}')).toThrow(/not numeric/);
  });
});
