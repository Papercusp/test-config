// P-001 (plan gate-latency-selection-and-retry-policy-2026-09-06): the filter-list channel that
// replaced positional file filters for `--related` runs. `applyFilterList` is the pure rule;
// these pin its two hard properties — it never narrows past what the layer/lane would run, and
// an empty intersection never becomes an empty `include` (which vitest reads as "everything").
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PC_TEST_FILTER_LIST_ENV, applyFilterList, readFilterList } from './vitest-config.ts';

const NOTHING = '__pc-empty-lane__/matches-nothing.test.ts';

describe('applyFilterList — lane (explicit file list) include', () => {
  it('keeps exactly the listed lane files, in lane order, normalising separators', () => {
    const lane = ['lib/a.test.ts', 'lib/b.test.ts', 'lib/c.test.ts'];
    const r = applyFilterList(lane, ['./lib/c.test.ts', 'lib\\a.test.ts', 'lib/not-in-lane.test.ts'], {
      explicitFiles: true,
    });
    expect(r.applied).toBe(true);
    if (!r.applied) throw new Error('unreachable');
    expect(r.include).toEqual(['lib/a.test.ts', 'lib/c.test.ts']);
    expect(r.selected).toBe(2);
    expect(r.listed).toBe(3);
  });

  it('never narrows to an EMPTY include — an empty intersection becomes the matches-nothing sentinel', () => {
    const r = applyFilterList(['lib/a.test.ts'], ['lib/zzz.test.ts'], { explicitFiles: true });
    expect(r.applied).toBe(true);
    if (!r.applied) throw new Error('unreachable');
    expect(r.include).toEqual([NOTHING]);
    expect(r.selected).toBe(0);
  });

  it('cannot run a listed file the lane does not own (lane semantics are preserved)', () => {
    const r = applyFilterList(['lib/pure.test.ts'], ['lib/stateful.test.ts'], { explicitFiles: true });
    if (!r.applied) throw new Error('unreachable');
    expect(r.include).not.toContain('lib/stateful.test.ts');
  });
});

describe('applyFilterList — layer (glob) include', () => {
  it('keeps listed files that match the layer suffix globs, sorted', () => {
    const r = applyFilterList(['**/*.test.ts', '**/*.test.tsx'], ['b/z.test.tsx', 'a/y.test.ts', 'a/x.spec.ts'], {
      explicitFiles: false,
    });
    if (!r.applied) throw new Error('unreachable');
    expect(r.include).toEqual(['a/y.test.ts', 'b/z.test.tsx']);
    expect(r.selected).toBe(2);
  });

  it('DECLINES (wide include, not a guess) when the include has a shape it cannot match', () => {
    const include = ['src/**/*.test.ts', 'other/only-this.test.ts'];
    const r = applyFilterList(include, ['src/a.test.ts'], { explicitFiles: false });
    expect(r.applied).toBe(false);
    if (r.applied) throw new Error('unreachable');
    expect(r.include).toBe(include);
    expect(r.reason).toMatch(/unsupported include pattern/);
  });

  it('empty intersection under globs also becomes the sentinel, never []', () => {
    const r = applyFilterList(['**/*.integration.test.ts'], ['a/y.test.ts'], { explicitFiles: false });
    if (!r.applied) throw new Error('unreachable');
    expect(r.include).toEqual([NOTHING]);
  });
});

describe('readFilterList', () => {
  it('is null when the channel is unused, reads a JSON array, and rejects anything else', () => {
    expect(readFilterList({})).toBeNull();
    expect(readFilterList({ [PC_TEST_FILTER_LIST_ENV]: '   ' })).toBeNull();

    const dir = mkdtempSync(join(tmpdir(), 'filter-list-'));
    try {
      const ok = join(dir, 'ok.json');
      writeFileSync(ok, JSON.stringify(['lib/a.test.ts']));
      expect(readFilterList({ [PC_TEST_FILTER_LIST_ENV]: ok })).toEqual({ path: ok, files: ['lib/a.test.ts'] });

      const bad = join(dir, 'bad.json');
      writeFileSync(bad, JSON.stringify({ not: 'an array' }));
      expect(() => readFilterList({ [PC_TEST_FILTER_LIST_ENV]: bad })).toThrow(/JSON array/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
