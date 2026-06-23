/**
 * vitest-config.test.ts
 *
 * handoff-coordination-dx-followups-2026-06-04 §A5 — the unit-layer guard that
 * turns the silent "No test files found" footgun into an actionable error when
 * an *.integration.test.* / *.browser.test.* file is run by path under the
 * default (unit) config (which EXCLUDES those globs).
 *
 * The guard inspects process.argv for a positional file filter naming a layered
 * test, so each case overrides argv (then restores it) to drive it
 * deterministically — independent of the ambient vitest invocation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineVitestConfig } from './vitest-config.ts';

let savedArgv: string[];
beforeEach(() => {
  savedArgv = process.argv;
});
afterEach(() => {
  process.argv = savedArgv;
});

/** Simulate `vitest run <…tokens…>`. */
function withArgv(...tokens: string[]): void {
  process.argv = ['node', 'vitest', 'run', ...tokens];
}

describe('defineVitestConfig unit-layer integration-path guard (§A5)', () => {
  it('throws an actionable error (naming the integration config) for an *.integration.test.ts run by path under the unit config', () => {
    withArgv('lib/foo.integration.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).toThrow(/integration test/i);
    withArgv('lib/foo.integration.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).toThrow(/--config vitest\.integration\.config\.ts/);
  });

  it('points an *.browser.test.ts at the browser config', () => {
    withArgv('lib/foo.browser.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).toThrow(/--config vitest\.browser\.config\.ts/);
  });

  it('does NOT fire for a plain unit *.test.ts path', () => {
    withArgv('lib/foo.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).not.toThrow();
  });

  it('does NOT fire when the integration config is already in use (layer != unit)', () => {
    withArgv('lib/foo.integration.test.ts');
    expect(() => defineVitestConfig({ layer: 'integration' })).not.toThrow();
  });

  it('ignores flag tokens — a `-t <pattern>` filter is not mistaken for a misrouted file', () => {
    withArgv('-t', 'some integration test name');
    expect(() => defineVitestConfig({ layer: 'unit' })).not.toThrow();
  });
});

describe('defineVitestConfig worker cap wiring (EI-2590)', () => {
  // The green-checkpoint exports VITEST_MAX_FORKS/THREADS=8; this asserts the
  // shared config actually READS them into `maxWorkers` (Vitest 4's unified knob),
  // which it did not before — so the gate ran uncapped (~host cores) and its heavy
  // `await import()` transforms serialized into 74-97s timeouts.
  const savedForks = process.env.VITEST_MAX_FORKS;
  const savedThreads = process.env.VITEST_MAX_THREADS;
  afterEach(() => {
    if (savedForks === undefined) delete process.env.VITEST_MAX_FORKS;
    else process.env.VITEST_MAX_FORKS = savedForks;
    if (savedThreads === undefined) delete process.env.VITEST_MAX_THREADS;
    else process.env.VITEST_MAX_THREADS = savedThreads;
  });

  const maxWorkersOf = (opts: Parameters<typeof defineVitestConfig>[0]) =>
    (defineVitestConfig(opts).test as { maxWorkers?: number } | undefined)?.maxWorkers;

  it('unit layer caps maxWorkers to VITEST_MAX_FORKS when set', () => {
    process.env.VITEST_MAX_FORKS = '8';
    delete process.env.VITEST_MAX_THREADS;
    expect(maxWorkersOf({ layer: 'unit' })).toBe(8);
  });

  it('leaves maxWorkers UNSET when the env var is absent (dev/CI ⇒ vitest default, unchanged)', () => {
    delete process.env.VITEST_MAX_FORKS;
    delete process.env.VITEST_MAX_THREADS;
    expect(maxWorkersOf({ layer: 'unit' })).toBeUndefined();
  });

  it('browser layer reads VITEST_MAX_THREADS (its pool is threads), not VITEST_MAX_FORKS', () => {
    delete process.env.VITEST_MAX_FORKS;
    process.env.VITEST_MAX_THREADS = '6';
    expect(maxWorkersOf({ layer: 'browser' })).toBe(6);
    // And the forks var does NOT cap the threads pool.
    process.env.VITEST_MAX_FORKS = '8';
    delete process.env.VITEST_MAX_THREADS;
    expect(maxWorkersOf({ layer: 'browser' })).toBeUndefined();
  });

  it('ignores a non-numeric / zero cap (no maxWorkers key)', () => {
    process.env.VITEST_MAX_FORKS = '0';
    expect(maxWorkersOf({ layer: 'unit' })).toBeUndefined();
    process.env.VITEST_MAX_FORKS = 'not-a-number';
    expect(maxWorkersOf({ layer: 'unit' })).toBeUndefined();
  });
});
