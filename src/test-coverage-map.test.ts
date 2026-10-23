import { describe, expect, it } from 'vitest';
import { coverageHash, coverageLines, coveragePath, parseTestCoverage } from './test-coverage-map.ts';

describe('P016 bounded source-mapped execution contract', () => {
  it('requires positive hits on every statement starting at a line', () => {
    expect(coverageLines({ statementMap: {
      a: { start: { line: 2 }, end: { line: 8 } }, b: { start: { line: 2 }, end: { line: 2 } },
      c: { start: { line: 4 }, end: { line: 4 } },
    }, s: { a: 1, b: 0, c: 2 } })).toEqual({ executable: [2, 4], covered: [4] });
  });
  it('rejects escaping paths and inconsistent or unbounded line maps', () => {
    expect(coveragePath('/repo', '/outside/a.ts')).toBeNull();
    expect(coveragePath('/repo', '/repo/src/a.ts')).toBe('src/a.ts');
    const hash = coverageHash('source');
    const row = { schemaVersion: 1, root: '/repo', scopeRoot: '/repo/pkg', testFile: 'a.test.ts',
      testSha256: hash, observedAt: '2026-10-23T00:00:00Z', populationComplete: false,
      population: [{ path: 'a.test.ts', sha256: hash }],
      sources: [{ path: 'a.ts', sha256: hash, executable: [2], covered: [2] }] };
    expect(parseTestCoverage(row)).toEqual(row);
    for (const source of [{ ...row.sources[0], covered: [3] }, { ...row.sources[0], path: '../a.ts' },
      { ...row.sources[0], executable: [2, 2] }, { ...row.sources[0], sha256: 'guess' }]) {
      expect(parseTestCoverage({ ...row, sources: [source] })).toBeNull();
    }
    expect(parseTestCoverage({ ...row, population: [] })).toBeNull();
  });
});
