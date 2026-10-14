import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
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
  installModuleEvaluationCapture,
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

describe('prospective evaluator inputs', () => {
  it('retains every supplied code version and delegates without changing identity or errors', async () => {
    const result = Promise.resolve('value');
    const error = new Error('evaluator failure');
    const calls: unknown[][] = [];
    const evaluator = { runInlinedModule(this: unknown, ...args: unknown[]) {
      expect(this).toBe(evaluator);
      calls.push(args);
      if (args[1] === 'throw') throw error;
      return result;
    } };
    beginFile();
    installModuleEvaluationCapture({ moduleRunner: { evaluator } });
    const module = { id: '/repo/route.ts?variant=1' }, context = {};
    expect(evaluator.runInlinedModule(context, 'first', module)).toBe(result);
    expect(evaluator.runInlinedModule(context, 'second', module)).toBe(result);
    expect(() => evaluator.runInlinedModule(context, 'throw', module)).toThrow(error);
    const observed = endFile('/repo/test.ts')?.moduleEvaluations;
    expect(observed?.entries).toEqual(['first', 'second', 'throw'].map(code => ({
      id: module.id, sha256: createHash('sha256').update(code).digest('hex'), byteLength: Buffer.byteLength(code),
    })));
    expect(calls[0]).toEqual([context, 'first', module]);
    expect(observed?.basis).toBe('before-evaluator-call');
    expect(observed?.reasons).toContain('code-bytes-not-retained');
    // The installed worker seam routes to a fresh file recorder, never old observations.
    beginFile();
    installModuleEvaluationCapture({ moduleRunner: { evaluator } });
    evaluator.runInlinedModule(context, 'third', module);
    expect(endFile('/repo/next.ts')?.moduleEvaluations?.entries).toHaveLength(1);
    await result;
  });

  it('preserves missing, frozen and malformed seams as explicit gaps', () => {
    for (const mocker of [undefined, { moduleRunner: { evaluator: Object.freeze({ runInlinedModule() {} }) } }]) {
      beginFile();
      installModuleEvaluationCapture(mocker);
      expect(endFile('/repo/test.ts')?.moduleEvaluations?.reasons).toContain('evaluator-seam-unavailable');
    }
    const evaluator = { runInlinedModule(..._args: unknown[]) {} };
    beginFile();
    installModuleEvaluationCapture({ moduleRunner: { evaluator } });
    evaluator.runInlinedModule({}, null, { id: '/repo/test.ts' });
    const observed = endFile('/repo/test.ts')?.moduleEvaluations;
    expect(observed?.entries).toEqual([]);
    expect(observed?.reasons).toContain('invalid-evaluator-input');
    beginFile(); installModuleEvaluationCapture({ moduleRunner: { evaluator } });
    expect(() => evaluator.runInlinedModule({}, 'source', {
      get id() { throw new Error('observation unavailable'); },
    })).not.toThrow();
    expect(endFile('/repo/test.ts')?.moduleEvaluations?.reasons).toContain('invalid-evaluator-input');
  });

  it('correlates concurrent evaluator calls with the actual asynchronous VM arguments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-vm-inputs-'));
    const compiled: unknown[][] = [];
    const vmTarget = { runInThisContext(...args: unknown[]) { compiled.push(args); return 'compiled'; } };
    const returned: Promise<unknown>[] = [];
    const evaluator = { runInlinedModule(_context: unknown, code: string, module: { id: string }) {
      const result = Promise.resolve().then(() => vmTarget.runInThisContext(
        `'use strict';async (exports)=>{{${code}\n}}`,
        { filename: module.id, lineOffset: 0, columnOffset: -31 },
      ));
      returned.push(result);
      return result;
    } };
    try {
      beginFile();
      installModuleEvaluationCapture({ moduleRunner: { evaluator } }, root, vmTarget);
      const first = evaluator.runInlinedModule({}, 'return 1;', { id: '/repo/one.ts' });
      const second = evaluator.runInlinedModule({}, 'return 2;', { id: '/repo/two.ts' });
      expect(first).toBe(returned[0]); expect(second).toBe(returned[1]);
      // A VM compilation outside the evaluator cannot be assigned to either call.
      vmTarget.runInThisContext('unrelated', { filename: '/repo/one.ts' });
      await Promise.all([first, second]);
      const observation = endFile('/repo/test.ts')?.moduleEvaluations;
      expect(observation?.vmInputs).toHaveLength(2);
      expect(observation?.vmInputs).toMatchObject([
        { inputIndex: 0, id: '/repo/one.ts', api: 'runInThisContext', filename: '/repo/one.ts', columnOffset: -31 },
        { inputIndex: 1, id: '/repo/two.ts', api: 'runInThisContext', filename: '/repo/two.ts', columnOffset: -31 },
      ]);
      for (const row of observation?.vmInputs ?? []) {
        const actual = compiled[row.inputIndex + 1]![0] as string;
        expect(fs.readFileSync(row.codeRef!, 'utf8')).toBe(actual);
        expect(row.sha256).toBe(createHash('sha256').update(actual).digest('hex'));
        expect(row.byteLength).toBe(Buffer.byteLength(actual));
        expect(row.sha256).not.toBe(observation?.entries[row.inputIndex]?.sha256);
      }
      expect(observation?.reasons).not.toContain('evaluator-wrapper-unobserved');
      expect(observation?.reasons).toContain('pre-setup-evaluations-unobserved');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps unmatched and unavailable VM compilation boundaries explicitly unobserved', () => {
    const vmTarget = { runInThisContext(..._args: unknown[]) { return 'value'; } };
    const evaluator = { runInlinedModule(_context: unknown, code: string, _module: { id: string }) {
      return vmTarget.runInThisContext(`'use strict';async (exports)=>{{${code}\n}}`, { filename: '/repo/other.ts' });
    } };
    beginFile(); installModuleEvaluationCapture({ moduleRunner: { evaluator } }, undefined, vmTarget);
    expect(evaluator.runInlinedModule({}, 'return 1;', { id: '/repo/one.ts' })).toBe('value');
    const observation = endFile('/repo/test.ts')?.moduleEvaluations;
    expect(observation?.vmInputs).toEqual([]);
    expect(observation?.reasons).toContain('evaluator-wrapper-unobserved');
  });

  it('records external evaluator call IDs without claiming loader bytes or changing results', () => {
    const result = Promise.resolve({ namespace: true }), error = new Error('external failed');
    const evaluator = { runInlinedModule() {}, runExternalModule(this: unknown, id: string) {
      expect(this).toBe(evaluator);
      if (id === 'throw') throw error;
      return result;
    } };
    beginFile(); installModuleEvaluationCapture({ moduleRunner: { evaluator } }, undefined, {});
    expect(evaluator.runExternalModule('node:os')).toBe(result);
    expect(evaluator.runExternalModule('node:os')).toBe(result);
    expect(() => evaluator.runExternalModule('throw')).toThrow(error);
    const observation = endFile('/repo/test.ts')?.moduleEvaluations;
    expect(observation?.externalCalls).toEqual([{ id: 'node:os' }, { id: 'node:os' }, { id: 'throw' }]);
    expect(observation?.reasons).not.toContain('external-evaluations-unobserved');
    expect(observation?.reasons).toContain('external-loader-bytes-unobserved');
  });

  it('retains exact evaluator bytes and refuses overwritten or redirected artifacts without changing execution', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-evaluator-artifacts-'));
    const code = 'export const transformed = 1;';
    const sha256 = createHash('sha256').update(code).digest('hex');
    const path = join(root, `${sha256}.js`);
    const evaluator = { runInlinedModule(..._args: unknown[]) { return 'executed'; } };
    const mocker = { moduleRunner: { evaluator } };
    const capture = () => {
      beginFile();
      installModuleEvaluationCapture(mocker, root);
      expect(evaluator.runInlinedModule({}, code, { id: '/repo/module.ts' })).toBe('executed');
      return endFile('/repo/test.ts')?.moduleEvaluations;
    };
    try {
      expect(capture()?.entries[0]?.codeRef).toBe(fs.realpathSync(path));
      expect(fs.readFileSync(path, 'utf8')).toBe(code);
      expect(capture()?.reasons).not.toContain('code-bytes-not-retained');
      fs.writeFileSync(path, 'tampered');
      expect(capture()?.entries[0]?.codeRef).toBeUndefined();
      expect(capture()?.reasons).toContain('evaluator-code-archive-unavailable');
      expect(fs.readFileSync(path, 'utf8')).toBe('tampered');
      fs.unlinkSync(path);
      const target = join(root, 'redirected.js');
      fs.writeFileSync(target, code);
      fs.symlinkSync(target, path);
      expect(capture()?.reasons).toContain('code-bytes-not-retained');
      expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
