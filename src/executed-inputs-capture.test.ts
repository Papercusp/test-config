import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PC_EXECUTED_INPUTS_DIR_ENV,
  beginFile,
  captureModuleImports,
  currentRecorder,
  endFile,
  installCapture,
  repoPathOf,
  resetCaptureForTests,
  type CaptureTargets,
} from './executed-inputs-capture';

// The capture layer patches fs inside every capture-armed gate worker, so whatever it does
// happens INSIDE the code under test. It must stay invisible: register-papercusp.test.ts replaces
// `process.cwd` and asserts nothing calls it, and it failed only in capture-armed gate runs
// (green-checkpoint 493c1e35 on 1a412c98, 2026-09-28) because every intercepted fs call read the
// live `process.cwd` property.

/** True when the setup file already installed capture on the real fs in this worker. */
const armed = Boolean(process.env[PC_EXECUTED_INPUTS_DIR_ENV]?.trim());

describe('final worker module observation', () => {
  it('retains body imports and external flags while excluding builtin and virtual IDs', () => {
    expect(captureModuleImports({ moduleExecutionInfo: new Map([
      ['/repo/dynamic-route.ts', {}],
      ['/repo/native.cjs', { external: true }],
      ['node:fs', { external: true }],
    ]) })).toEqual({ '/repo/dynamic-route.ts': { external: false }, '/repo/native.cjs': { external: true } });
  });

  it('leaves missing, malformed and throwing worker state unknown', () => {
    expect(captureModuleImports(undefined)).toBeNull();
    expect(captureModuleImports({ moduleExecutionInfo: new Map() })).toBeNull();
    expect(captureModuleImports({ moduleExecutionInfo: new Map([['/repo/route.ts', { external: 'invalid' }]]) })).toBeNull();
    expect(captureModuleImports({ get moduleExecutionInfo() { throw new Error('unavailable'); } })).toBeNull();
  });
});

describe('repoPathOf', () => {
  const repo = '/repo';
  const neverCwd = () => {
    throw new Error('cwd consulted for an absolute path');
  };

  it('never consults the working directory for an absolute path', () => {
    expect(repoPathOf('/repo/src/a.ts', repo, neverCwd)).toBe('/repo/src/a.ts');
    expect(repoPathOf('/elsewhere/a.ts', repo, neverCwd)).toBe(null);
  });

  it('resolves a relative path against the working directory, as a string or a getter', () => {
    expect(repoPathOf('src/a.ts', repo, '/repo')).toBe('/repo/src/a.ts');
    expect(repoPathOf('src/a.ts', repo, () => '/repo/lib')).toBe('/repo/lib/src/a.ts');
    expect(repoPathOf('a.ts', repo, () => '/elsewhere')).toBe(null);
  });
});

describe('installCapture — invisible to the code under test', () => {
  // Unarmed worker: install on FAKE targets (never the real fs) so the property is proven even
  // where the gate's capture is off. Skipped when armed: capture installs once per process, so
  // the fake targets would never be wrapped and beginFile/endFile would clobber the real recorder.
  it.skipIf(armed)('records reads without calling a replaced process.cwd; relatives resolve natively', () => {
    const origCwd = process.cwd;
    const repoRoot = resolve(origCwd());
    const reached: unknown[] = [];
    const fakeFs: Record<string, unknown> = { existsSync: (p: unknown) => (reached.push(p), false) };
    const targets: CaptureTargets = { fs: fakeFs, fsPromises: {}, childProcess: {} };
    const scratch = mkdtempSync(join(tmpdir(), 'capture-cwd-'));
    const calls: string[] = [];
    try {
      installCapture(targets, repoRoot);
      beginFile();
      process.cwd = () => {
        calls.push('cwd-called');
        return scratch; // a MOCKED cwd: the recorder must neither call it nor resolve against it
      };
      const existsSync = fakeFs.existsSync as (p: string) => boolean;
      existsSync(join(repoRoot, 'package.json'));
      existsSync('src/relative-probe.ts');
      process.cwd = origCwd;
      const record = endFile(join(repoRoot, 'probe.test.ts'));

      expect(calls).toEqual([]);
      expect(reached).toHaveLength(2); // the wrapped original still ran
      expect(record?.reads).toEqual(
        [join(repoRoot, 'package.json'), join(repoRoot, 'src/relative-probe.ts')].sort(),
      );
    } finally {
      process.cwd = origCwd;
      resetCaptureForTests();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // Armed worker (the gate): the setup file installed capture on the REAL fs. This is exactly
  // the scenario that failed register-papercusp.test.ts.
  it.runIf(armed)('the installed capture never calls a replaced process.cwd', () => {
    const origCwd = process.cwd;
    const absolute = resolve(origCwd(), 'package.json');
    const calls: string[] = [];
    try {
      process.cwd = () => {
        calls.push('cwd-called');
        return origCwd();
      };
      fs.existsSync(absolute);
      fs.existsSync('package.json');
    } finally {
      process.cwd = origCwd;
    }
    expect(calls).toEqual([]);
    expect(currentRecorder()?.reads.has(absolute)).toBe(true);
  });
});
