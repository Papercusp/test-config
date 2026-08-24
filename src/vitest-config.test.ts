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
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineVitestConfig, isWritableDir } from './vitest-config.ts';

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
  it('routes an *.integration.test.ts remediation through the repository test router', () => {
    withArgv('lib/foo.integration.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).toThrow(/integration test/i);
    withArgv('lib/foo.integration.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).toThrow(
      /owning package's integration config is vitest\.integration\.config\.ts/,
    );
    withArgv('lib/foo.integration.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).toThrow(
      /from the repository root \(not the owning package cwd\)/,
    );
    withArgv('lib/foo.integration.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).toThrow(
      /npm run test:file -- lib\/foo\.integration\.test\.ts/,
    );
  });

  it('routes an *.browser.test.ts remediation through the repository test router', () => {
    withArgv('lib/foo.browser.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).toThrow(
      /owning package's browser config is vitest\.browser\.config\.ts/,
    );
    withArgv('lib/foo.browser.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).toThrow(
      /from the repository root \(not the owning package cwd\)/,
    );
    withArgv('lib/foo.browser.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).toThrow(
      /npm run test:file -- lib\/foo\.browser\.test\.ts/,
    );
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

describe('isWritableDir (EI-6063 — existence is not writability)', () => {
  // process.getuid is POSIX-only and undefined for a root-run process check on non-POSIX;
  // guard the permission-based case so it never false-fails under a root test runner
  // (root bypasses the write-permission bit entirely, so chmod 555 would not block it).
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'pcv-writable-test-'));
  });
  afterEach(() => {
    // restore write perms before cleanup, else rmSync itself can ENOENT/EACCES
    try {
      chmodSync(scratch, 0o755);
    } catch {
      /* already gone */
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  it('returns true for a genuinely writable directory', () => {
    expect(isWritableDir(scratch)).toBe(true);
  });

  it('returns false for a directory that does not exist', () => {
    expect(isWritableDir(join(scratch, 'does-not-exist'))).toBe(false);
  });

  it.skipIf(isRoot)(
    'returns false for a directory that EXISTS but is READ-ONLY — the exact EI-6063 repro (TMPDIR=/tmp/claude exists, existsSync()=true, but every write ENOENTs/EACCESs)',
    () => {
      chmodSync(scratch, 0o555); // r-xr-xr-x: exists + readable + listable, NOT writable
      expect(existsSync(scratch)).toBe(true); // the OLD guard's check — still passes
      expect(isWritableDir(scratch)).toBe(false); // the NEW guard's check — correctly catches it
    },
  );

  it('never leaves its own write-probe behind on success', () => {
    isWritableDir(scratch);
    // mkdtempSync gave us an otherwise-empty dir; the probe must be cleaned up.
    expect(readdirSync(scratch)).toEqual([]);
  });
});

describe('module-load TMPDIR override falls back off a read-only TMPDIR (EI-6063)', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const savedTmpdir = process.env.TMPDIR;
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'pcv-tmpdir-override-test-'));
  });
  afterEach(() => {
    try {
      chmodSync(scratch, 0o755);
    } catch {
      /* already gone */
    }
    rmSync(scratch, { recursive: true, force: true });
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    vi.resetModules();
  });

  it.skipIf(isRoot)(
    'moves TMPDIR off a read-only-but-EXISTING directory at import time, instead of trusting existsSync() alone',
    async () => {
      chmodSync(scratch, 0o555); // exists, but not writable — the pre-fix guard let this slip through
      process.env.TMPDIR = scratch;
      vi.resetModules();
      await import('./vitest-config.ts');
      expect(process.env.TMPDIR).not.toBe(scratch);
      // must land on an actually-writable candidate, not merely "different"
      expect(isWritableDir(process.env.TMPDIR!)).toBe(true);
    },
  );
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
