import { describe, expect, it } from 'vitest';
import { historicalTestTimeout, type TestTimingIdentity, type TestTimingSample } from './test-timeout-history';

const NOW = Date.UTC(2026, 9, 29);
const identity: TestTimingIdentity = {
  file: 'packages/example/slow.test.ts', caseKey: 'suite > test', occurrence: 1,
  layer: 'unit', runnerIdentity: 'node26-linux-x64',
};
const sample = (runId: string, duration: number, overrides: Partial<TestTimingSample> = {}): TestTimingSample => ({
  ...identity, runId, observedAtMs: NOW - 1_000, status: 'pass', clean: true,
  caseDurationMs: duration, fileDurationMs: duration * 10, ...overrides,
});
const history = (duration: number) => ['a', 'b', 'c'].map(id => sample(id, duration));

describe('history-derived test timeout policy', () => {
  it('gives a historically slow case its own headroom instead of a uniform 180s limit', () => {
    const rows = [...history(90_000), ...history(100).map(row => ({ ...row, caseKey: 'suite > fast' }))];
    expect(historicalTestTimeout(identity, rows, NOW)).toMatchObject({ timeoutMs: 365_000, basis: 'case-history' });
    expect(historicalTestTimeout({ ...identity, caseKey: 'suite > fast' }, rows, NOW))
      .toMatchObject({ timeoutMs: 15_000, basis: 'case-history' });
  });

  it('does not learn larger budgets from failures, dirty runs, skipped results or incompatible runtimes', () => {
    const rejected = [
      { status: 'fail' }, { status: 'skip' }, { clean: false }, { runnerIdentity: 'node-other' },
      { layer: 'integration' }, { file: 'other.test.ts' },
      { observedAtMs: NOW + 1 }, { observedAtMs: NOW - 15 * 24 * 60 * 60_000 },
    ];
    const rows = [...history(100), ...rejected.flatMap((override, n) =>
      history(400_000).map(row => ({ ...row, runId: `${n}-${row.runId}`, ...override })))];
    expect(historicalTestTimeout(identity, rows, NOW)).toMatchObject({ timeoutMs: 15_000, sampleCount: 3 });
  });

  it('keeps duplicate test-name occurrences distinct', () => {
    const rows = [...history(100), ...history(90_000).map(row => ({ ...row, occurrence: 2 }))];
    expect(historicalTestTimeout(identity, rows, NOW).timeoutMs).toBe(15_000);
    expect(historicalTestTimeout({ ...identity, occurrence: 2 }, rows, NOW).timeoutMs).toBe(365_000);
  });

  it('uses file history for new cases and counts each parent run once', () => {
    const rows = history(1_000).flatMap(row => [row, { ...row, caseKey: 'second case' }]);
    expect(historicalTestTimeout({ ...identity, caseKey: 'new case' }, rows, NOW))
      .toEqual({ timeoutMs: 45_000, basis: 'file-history', sampleCount: 3, estimateMs: 10_000 });
  });

  it('does not treat duplicate receipts for one run as an adequate sample', () => {
    const rows = history(1_000).map(row => ({ ...row, runId: 'same' }));
    expect(historicalTestTimeout(identity, rows, NOW)).toMatchObject({ basis: 'fallback', timeoutMs: 180_000 });
  });

  it('ignores invalid durations and always retains a finite hang bound', () => {
    for (const value of [NaN, Infinity, -1]) {
      const rows = history(value).map(row => ({ ...row, fileDurationMs: null }));
      expect(historicalTestTimeout(identity, rows, NOW, value).timeoutMs).toBe(180_000);
    }
    expect(historicalTestTimeout(identity, history(60 * 60_000), NOW).timeoutMs).toBe(30 * 60_000);
    expect(historicalTestTimeout(identity, [], NOW, Infinity).timeoutMs).toBe(180_000);
  });

  it('uses only the latest twenty independent runs, leaving old slow cases out', () => {
    const rows = Array.from({ length: 20 }, (_, n) => sample(String(n), 100, { observedAtMs: NOW - n }));
    rows.push(sample('old', 400_000, { observedAtMs: NOW - 10_000 }));
    expect(historicalTestTimeout(identity, rows, NOW)).toMatchObject({ timeoutMs: 15_000, sampleCount: 20 });
  });

  it('rejects an invalid observation clock instead of treating stale history as current', () => {
    expect(() => historicalTestTimeout(identity, history(100), NaN)).toThrow('finite observation clock');
  });
});
