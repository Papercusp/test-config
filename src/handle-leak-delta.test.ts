import { describe, expect, it } from 'vitest';
import {
  classifyFile,
  countResources,
  diffCounts,
  isSourceClean,
  leakWeight,
  summarizeCensus,
  type FileVerdict,
} from './handle-leak-delta.js';

describe('countResources', () => {
  it('folds the flat getActiveResourcesInfo array into counts', () => {
    expect(countResources(['PipeWrap', 'PipeWrap', 'Timeout'])).toEqual({ PipeWrap: 2, Timeout: 1 });
  });

  it('returns an empty object for no resources rather than throwing', () => {
    expect(countResources([])).toEqual({});
  });
});

describe('diffCounts', () => {
  it('reports only types that actually moved', () => {
    // PipeWrap is stdio and identical on both sides — it must not appear, or every
    // file in the repo would report a "leak" of the worker's own plumbing.
    const before = { PipeWrap: 4, Timeout: 1 };
    const after = { PipeWrap: 4, Timeout: 2 };
    expect(diffCounts(before, after)).toEqual([{ resource: 'Timeout', delta: 1 }]);
  });

  it('handles a type present on only ONE side (union of keys, not either side alone)', () => {
    // A resource class that did not exist at file start is the common leak shape;
    // iterating only `before`'s keys would miss it entirely.
    expect(diffCounts({}, { ChildProcess: 2 })).toEqual([{ resource: 'ChildProcess', delta: 2 }]);
    expect(diffCounts({ ChildProcess: 2 }, {})).toEqual([{ resource: 'ChildProcess', delta: -2 }]);
  });

  it('orders largest-delta-first and breaks ties by name, so reports are deterministic', () => {
    const out = diffCounts({}, { Timeout: 1, ChildProcess: 3, TCPSocketWrap: 1 });
    expect(out.map((d) => d.resource)).toEqual(['ChildProcess', 'TCPSocketWrap', 'Timeout']);
  });

  it('is empty when nothing moved', () => {
    expect(diffCounts({ Timeout: 1 }, { Timeout: 1 })).toEqual([]);
  });
});

describe('classifyFile', () => {
  it('a POSITIVE delta marks the file as the SOURCE of the leak', () => {
    // The a-leaker case from the controlled probe (plan D-016): armed an uncleared
    // timer and dirtied a registry, so its own exit carries both.
    const v = classifyFile('a-leaker.test.ts', { Timeout: 1 }, { Timeout: 2, __registry: 1 });
    expect(v.leaked).toEqual([
      { resource: 'Timeout', delta: 1 },
      { resource: '__registry', delta: 1 },
    ]);
    expect(v.consumed).toEqual([]);
    expect(isSourceClean(v)).toBe(false);
  });

  it('a NEGATIVE delta marks the file as a VICTIM, and a victim is NOT at fault', () => {
    // b-victim ran a timer armed by an earlier file, so the count DROPS across it.
    // This is the property that lets us stop blaming the file vitest blames.
    const v = classifyFile('b-victim.test.ts', { Timeout: 2 }, { Timeout: 1 });
    expect(v.consumed).toEqual([{ resource: 'Timeout', delta: -1 }]);
    expect(v.leaked).toEqual([]);
    expect(isSourceClean(v)).toBe(true);
  });

  it('a file that FAILS because it inherited a dirty worker is still source-clean', () => {
    // The c-registry case: it is the file that went red, its own delta is {}. Blaming
    // the absolute count instead of the delta accuses exactly this innocent file.
    const v = classifyFile('c-registry.test.ts', { __registry: 1 }, { __registry: 1 });
    expect(v.leaked).toEqual([]);
    expect(v.consumed).toEqual([]);
    expect(isSourceClean(v)).toBe(true);
  });

  it('honours an ignore list but defaults to ignoring NOTHING', () => {
    const before = { Timeout: 0 };
    const after = { Timeout: 1 };
    expect(classifyFile('f.test.ts', before, after).leaked).toHaveLength(1);
    expect(classifyFile('f.test.ts', before, after, ['Timeout']).leaked).toHaveLength(0);
  });
});

describe('summarizeCensus', () => {
  const leaker = (file: string, delta: number): FileVerdict => ({
    file,
    leaked: [{ resource: 'Timeout', delta }],
    consumed: [],
  });
  const clean = (file: string): FileVerdict => ({ file, leaked: [], consumed: [] });

  it('reports a RATE over observed files, and ranks sources worst-first', () => {
    const census = summarizeCensus([leaker('small.test.ts', 1), clean('ok.test.ts'), leaker('big.test.ts', 5)]);
    expect(census.filesObserved).toBe(3);
    expect(census.filesLeaking).toBe(2);
    expect(census.rate).toBeCloseTo(2 / 3);
    expect(census.sources.map((s) => s.file)).toEqual(['big.test.ts', 'small.test.ts']);
    expect(census.byResource).toEqual({ Timeout: 6 });
  });

  it('rate is 0 — not NaN — when nothing was observed', () => {
    // A zero-division NaN here would serialize into the report as `null` and read
    // as "measured, clean", which is the failure mode this whole plan keeps hitting.
    const census = summarizeCensus([]);
    expect(census.rate).toBe(0);
    expect(census.filesObserved).toBe(0);
  });

  it('counts victims separately and never as leaking files', () => {
    const victim: FileVerdict = { file: 'v.test.ts', leaked: [], consumed: [{ resource: 'Timeout', delta: -1 }] };
    const census = summarizeCensus([leaker('a.test.ts', 1), victim]);
    expect(census.filesLeaking).toBe(1);
    expect(census.victims.map((v) => v.file)).toEqual(['v.test.ts']);
  });

  it('a file that both leaks and consumes is reported as a source AND a victim', () => {
    // Real files do both: consume an inherited handle and leave their own behind.
    const mixed: FileVerdict = {
      file: 'both.test.ts',
      leaked: [{ resource: 'ChildProcess', delta: 1 }],
      consumed: [{ resource: 'Timeout', delta: -1 }],
    };
    const census = summarizeCensus([mixed]);
    expect(census.filesLeaking).toBe(1);
    expect(census.victims.map((v) => v.file)).toEqual(['both.test.ts']);
  });
});

describe('leakWeight', () => {
  it('sums leaked counts across resource types', () => {
    expect(
      leakWeight({
        file: 'f',
        leaked: [
          { resource: 'Timeout', delta: 2 },
          { resource: 'ChildProcess', delta: 3 },
        ],
        consumed: [],
      }),
    ).toBe(5);
  });

  it('ignores consumed resources, so a victim never outranks a real source', () => {
    expect(leakWeight({ file: 'f', leaked: [], consumed: [{ resource: 'Timeout', delta: -9 }] })).toBe(0);
  });
});
