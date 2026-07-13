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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { availableParallelism } from 'node:os';
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

  it('defaults maxWorkers to the host-sane cap when the env var is absent (WI-4300 — unset is NOT uncapped on a shared box)', () => {
    delete process.env.VITEST_MAX_FORKS;
    delete process.env.VITEST_MAX_THREADS;
    const expected = Math.min(32, Math.max(8, Math.floor(availableParallelism() / 4)));
    expect(maxWorkersOf({ layer: 'unit' })).toBe(expected);
    expect(maxWorkersOf({ layer: 'browser' })).toBe(expected);
  });

  it('browser layer reads VITEST_MAX_THREADS (its pool is threads), not VITEST_MAX_FORKS', () => {
    delete process.env.VITEST_MAX_FORKS;
    process.env.VITEST_MAX_THREADS = '6';
    expect(maxWorkersOf({ layer: 'browser' })).toBe(6);
    // The forks var does NOT cap the threads pool — with THREADS absent the browser
    // layer falls back to the host-sane default (WI-4300), never to the forks value.
    process.env.VITEST_MAX_FORKS = '4';
    delete process.env.VITEST_MAX_THREADS;
    expect(maxWorkersOf({ layer: 'browser' })).toBe(
      Math.min(32, Math.max(8, Math.floor(availableParallelism() / 4))),
    );
  });

  it("explicit '0' is the deliberate uncapped escape hatch; garbage falls back to the safe default (WI-4300)", () => {
    process.env.VITEST_MAX_FORKS = '0';
    expect(maxWorkersOf({ layer: 'unit' })).toBeUndefined();
    // Garbage must NEVER mean uncapped on the shared box — it gets the default cap.
    process.env.VITEST_MAX_FORKS = 'not-a-number';
    expect(maxWorkersOf({ layer: 'unit' })).toBe(
      Math.min(32, Math.max(8, Math.floor(availableParallelism() / 4))),
    );
  });
});

describe('defineVitestConfig unhandled-error diagnostics (EI-10766)', () => {
  type UnhandledErrorHandler = (error: Error & { code?: string }) => false | undefined;

  function handler(): UnhandledErrorHandler {
    return (defineVitestConfig({ layer: 'unit' }).test as {
      onUnhandledError?: UnhandledErrorHandler;
    }).onUnhandledError!;
  }

  it('still suppresses only the known benign rpc teardown race without printing the alarm', () => {
    const error = new Error('Closing rpc while "onUserConsoleLog" was pending');
    error.name = 'EnvironmentTeardownError';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(handler()(error)).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('prints an actionable banner for every other unhandled error without suppressing it', () => {
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(handler()(error)).toBeUndefined();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]?.[0]).toContain('UNHANDLED ERROR failed this test file');
    expect(consoleError.mock.calls[0]?.[0]).toContain('NOT an assertion');
    expect(consoleError.mock.calls[0]?.[0]).toContain('code=EPIPE');
    expect(consoleError.mock.calls[0]?.[0]).toContain('Every `expect` in this file may have PASSED');
  });
});
