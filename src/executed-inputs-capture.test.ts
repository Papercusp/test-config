import * as fs from 'node:fs';
import nativeFs from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectReusablePasses } from '../../../scripts/lib/test-pass-reuse.mjs';
import {
  PC_EXECUTED_INPUTS_DIR_ENV,
  beginFile,
  beginDatabaseResetCapture,
  captureModuleImports,
  captureWorkerCompilerInputs,
  currentRecorder,
  endFile,
  installCapture,
  installModuleEvaluationCapture,
  repoPathOf,
  recordRead,
  resetCaptureForTests,
  snapshotCaptureForTests,
  type CaptureTargets,
} from './executed-inputs-capture';

// The capture layer patches fs inside every capture-armed gate worker, so whatever it does
// happens INSIDE the code under test. It must stay invisible: register-papercusp.test.ts replaces
// `process.cwd` and asserts nothing calls it, and it failed only in capture-armed gate runs
// (green-checkpoint 493c1e35 on 1a412c98, 2026-09-28) because every intercepted fs call read the
// live `process.cwd` property.

/** True when the setup file already installed capture on the real fs in this worker. */
// The env var alone is not enough: vitest-config wires the setup file only when the executed
// source map is also armed, so a partial arm (env set, setup absent) must count as unarmed.
const armed = Boolean(process.env[PC_EXECUTED_INPUTS_DIR_ENV]?.trim()) && currentRecorder() !== null;

// Unit tests below reset and re-install capture against fakes. Restore the setup file's real
// recorder after each one, or an armed worker loses it (and this file's inputs record).
let restoreCapture: () => void = () => {};
beforeEach(() => { restoreCapture = snapshotCaptureForTests(); });
afterEach(() => restoreCapture());

describe('original file database reset capture', () => {
  const identity = { captureId: '12345678-9abc-def0-1234-56789abcdef0',
    runGroupId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  it('records allocation, provision readiness and the actual drop outcome without endpoints', () => {
    beginFile(identity);
    const first = beginDatabaseResetCapture('it_0123456789ab', 'empty');
    first.ready(); first.cleanup('dropped');
    const second = beginDatabaseResetCapture('it_abcdef012345', 'template');
    second.ready(); second.cleanup('detached');
    const reset = endFile('/repo/first.test.ts')?.workerDatabaseReset;
    expect(reset).toMatchObject({ ...identity, testFile: '/repo/first.test.ts', databases: [
      { name: 'it_0123456789ab', origin: 'empty', readyAt: expect.any(String), cleanup: { outcome: 'dropped' } },
      { name: 'it_abcdef012345', origin: 'template', cleanup: { outcome: 'detached' } },
    ] });
    expect(new Set(reset?.databases.map(db => db.allocationId)).size).toBe(2);
    expect(JSON.stringify(reset)).not.toContain('postgres:');
  });

  it('does not let late cleanup upgrade a completed record or leak into the next file', () => {
    beginFile(identity);
    const pending = beginDatabaseResetCapture('it_0123456789ab', 'empty');
    pending.ready();
    const prior = endFile('/repo/first.test.ts')!;
    beginFile({ ...identity, captureId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
    pending.cleanup('dropped');
    expect(prior.workerDatabaseReset?.databases[0]?.cleanup).toBeNull();
    expect(endFile('/repo/second.test.ts')?.workerDatabaseReset?.databases).toEqual([]);
    beginFile(); beginDatabaseResetCapture('it_abcdef012345', 'empty').cleanup('dropped');
    expect(endFile('/repo/unobserved.test.ts')).not.toHaveProperty('workerDatabaseReset');
  });
});

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
      const receipt = captureWorkerCompilerInputs(observation, '12345678-9abc-def0-1234-56789abcdef0', '/repo/test.ts')!;
      expect(receipt).toMatchObject({ scope: 'vitest-inlined-vm-calls', populationStatus: 'unknown',
        vmCallCount: 2, inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(receipt.missing).toContain('transform-pipeline-unobserved');
      expect(receipt.missing).toContain('vm-options-partially-observed');
      const moved = { ...observation!, vmInputs: observation!.vmInputs!.map(row => ({ ...row, codeRef: '/moved/artifact.js' })) };
      expect(captureWorkerCompilerInputs(moved, receipt.captureId, receipt.testFile)?.inputSha256).toBe(receipt.inputSha256);
      const changed = { ...observation!, vmInputs: observation!.vmInputs!.map(row => ({ ...row, columnOffset: -30 })) };
      expect(captureWorkerCompilerInputs(changed, receipt.captureId, receipt.testFile)?.inputSha256).not.toBe(receipt.inputSha256);
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
    const missing = captureWorkerCompilerInputs(observation, '12345678-9abc-def0-1234-56789abcdef0', '/repo/test.ts');
    expect(missing).toMatchObject({ vmCallCount: 0, inputSha256: null, populationStatus: 'unknown' });
    expect(missing?.missing).toContain('vm-calls-unobserved');
    expect(captureWorkerCompilerInputs(undefined, '12345678-9abc-def0-1234-56789abcdef0', '/repo/test.ts')).toBeUndefined();
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

  it('retains both evaluator references when another writer arrives during an archive write', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-evaluator-overlap-'));
    const code = 'export const shared = "complete bytes";';
    const path = join(root, `${createHash('sha256').update(code).digest('hex')}.js`);
    const evaluator = { runInlinedModule(..._args: unknown[]) { return 'executed'; } };
    const originalWrite = nativeFs.writeFileSync;
    let overlapped = false;
    beginFile();
    installModuleEvaluationCapture({ moduleRunner: { evaluator } }, root, {});
    // Deterministically interleave a second worker's publication after the first
    // file is created but before its write completes. No timing or large files.
    nativeFs.writeFileSync = ((target, data, options) => {
      if (!overlapped && data === code && typeof target !== 'number') {
        overlapped = true;
        const fd = nativeFs.openSync(target, 'wx', 0o600);
        try {
          nativeFs.writeSync(fd, code.slice(0, 5));
          expect(evaluator.runInlinedModule({}, code, { id: '/repo/second.ts' })).toBe('executed');
          nativeFs.writeSync(fd, code.slice(5));
        } finally { nativeFs.closeSync(fd); }
        return;
      }
      return originalWrite(target, data, options);
    }) as typeof nativeFs.writeFileSync;
    syncBuiltinESMExports();
    try {
      expect(evaluator.runInlinedModule({}, code, { id: '/repo/first.ts' })).toBe('executed');
      const observation = endFile('/repo/test.ts')?.moduleEvaluations;
      expect(overlapped).toBe(true);
      expect(observation?.entries).toHaveLength(2);
      expect(observation?.entries.map(entry => entry.codeRef)).toEqual([path, path]);
      expect(observation?.reasons).not.toContain('evaluator-code-archive-unavailable');
      expect(nativeFs.readFileSync(path, 'utf8')).toBe(code);
      expect(nativeFs.readdirSync(root)).toEqual([path.slice(root.length + 1)]);
    } finally {
      nativeFs.writeFileSync = originalWrite;
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not publish partial evaluator bytes when a write is interrupted', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-evaluator-interrupted-'));
    const code = 'export const interrupted = true;';
    const path = join(root, `${createHash('sha256').update(code).digest('hex')}.js`);
    const evaluator = { runInlinedModule(..._args: unknown[]) { return 'executed'; } };
    const originalWrite = nativeFs.writeFileSync;
    beginFile();
    installModuleEvaluationCapture({ moduleRunner: { evaluator } }, root, {});
    nativeFs.writeFileSync = ((target, data, options) => {
      if (data !== code) return originalWrite(target, data, options);
      originalWrite(target, code.slice(0, 5), options);
      throw new Error('interrupted archive write');
    }) as typeof nativeFs.writeFileSync;
    syncBuiltinESMExports();
    try {
      expect(evaluator.runInlinedModule({}, code, { id: '/repo/first.ts' })).toBe('executed');
      const observation = endFile('/repo/test.ts')?.moduleEvaluations;
      expect(observation?.reasons).toContain('evaluator-code-archive-unavailable');
      expect(observation?.entries[0]?.codeRef).toBeUndefined();
      expect(nativeFs.existsSync(path)).toBe(false);
      expect(nativeFs.readdirSync(root)).toEqual([]);
      nativeFs.writeFileSync = originalWrite;
      syncBuiltinESMExports();
      beginFile();
      installModuleEvaluationCapture({ moduleRunner: { evaluator } }, root, {});
      evaluator.runInlinedModule({}, code, { id: '/repo/recovery.ts' });
      expect(endFile('/repo/test.ts')?.moduleEvaluations?.entries[0]?.codeRef).toBe(path);
    } finally {
      nativeFs.writeFileSync = originalWrite;
      syncBuiltinESMExports();
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

  it('keeps a repository filename beginning with two dots inside the source population', () => {
    expect(repoPathOf('/repo/..fixture/input.json', repo, neverCwd)).toBe('/repo/..fixture/input.json');
    expect(repoPathOf('/repo/../outside.json', repo, neverCwd)).toBeNull();
  });
});

describe('unmeasured filesystem input custody', () => {
  it('keeps external, descriptor, unsupported and unresolved paths explicitly opaque without disclosing them', () => {
    const rec = beginFile();
    recordRead(rec, '/private/fixture.json', '/repo', () => { throw new Error('absolute cwd'); });
    recordRead(rec, 42, '/repo', '/repo');
    recordRead(rec, new URL('https://example.test/fixture'), '/repo', '/repo');
    recordRead(rec, 'fixture.json', '/repo', () => { throw new Error('cwd unavailable'); });
    recordRead(rec, '/repo/node_modules/package/index.js', '/repo', '/repo');
    recordRead(rec, '/repo/..fixture/input.json', '/repo', '/repo');
    const record = endFile('/repo/test.ts')!;
    expect(record.reads).toEqual(['/repo/..fixture/input.json']);
    expect(record.opaque).toEqual(['fs-file-descriptor', 'fs-path-unobserved', 'outside-repo-read']);
    expect(JSON.stringify(record)).not.toContain('/private/fixture.json');
  });

  it('preserves actual external read results and makes the existing reuse consumer run the file again', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-external-input-'));
    const file = join(root, 'fixture.txt');
    const testFile = 'src/external-input.test.ts';
    resetCaptureForTests();
    const targets = { readFileSync: (path: fs.PathOrFileDescriptor, encoding: BufferEncoding) =>
      nativeFs.readFileSync(path, encoding) };
    installCapture({ fs: targets, fsPromises: {}, childProcess: {} }, resolve(process.cwd()));
    try {
      nativeFs.writeFileSync(file, 'first');
      beginFile();
      expect(targets.readFileSync(file, 'utf8')).toBe('first');
      const record = endFile(testFile)!;
      nativeFs.writeFileSync(file, 'second');
      beginFile();
      expect(targets.readFileSync(file, 'utf8')).toBe('second');
      expect(endFile(testFile)?.opaque).toContain('outside-repo-read');
      const proof = { recordedSha: 'a'.repeat(40), recordedAtMs: 1, executedModules: [testFile], inputsCaptured: true,
        runContext: 'local', runnerIdentity: 'measured-worker', readPaths: [], opaqueReasons: record.opaque };
      const select = (opaqueReasons: string[]) => selectReusablePasses({ candidates: [testFile],
        proofs: new Map([[testFile, { ...proof, opaqueReasons }]]), judgedSha: 'b'.repeat(40),
        changedBetween: () => new Set<string>(), runContext: proof.runContext, runnerIdentity: proof.runnerIdentity });
      // Positive control: the identical source-only record would be reused.
      expect(select([]).skip).toEqual([testFile]);
      expect(select(record.opaque).skip).toEqual([]);
      expect(select(record.opaque).exclusions).toMatchObject([{ reason: 'opaque',
        evidence: { opaqueReasons: expect.arrayContaining(['outside-repo-read']) } }]);
      beginFile();
      let error: unknown;
      try { targets.readFileSync(join(root, 'missing.txt'), 'utf8'); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: 'ENOENT' });
      expect(endFile(testFile)?.opaque).toContain('outside-repo-read');
    } finally { resetCaptureForTests(); rmSync(root, { recursive: true, force: true }); }
  });

  it('captures a descriptor opened before the recorder while preserving scalar, vector and callback reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-descriptor-input-'));
    const file = join(root, 'fixture.txt');
    nativeFs.writeFileSync(file, 'abcdef');
    const fd = nativeFs.openSync(file, 'r');
    resetCaptureForTests();
    const targets = {
      readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) =>
        nativeFs.readSync(fd, buffer, offset, length, position),
      readvSync: (...args: Parameters<typeof nativeFs.readvSync>) => nativeFs.readvSync(...args),
      read: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null,
        callback: (error: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void) =>
        nativeFs.read(fd, buffer, offset, length, position, callback),
    };
    installCapture({ fs: targets, fsPromises: {}, childProcess: {} }, resolve(process.cwd()));
    try {
      beginFile();
      const first = Buffer.alloc(2), second = Buffer.alloc(2), third = Buffer.alloc(2);
      expect(targets.readSync(fd, first, 0, 2, 0)).toBe(2);
      expect(targets.readvSync(fd, [second], 2)).toBe(2);
      await new Promise<void>((resolve, reject) => targets.read(fd, third, 0, 2, 4,
        (error, bytesRead, buffer) => {
          if (error) { reject(error); return; }
          try { expect(bytesRead).toBe(2); expect(buffer).toBe(third); resolve(); } catch (error) { reject(error); }
        }));
      expect([first.toString(), second.toString(), third.toString()]).toEqual(['ab', 'cd', 'ef']);
      expect(endFile('/repo/test.ts')?.opaque).toContain('fs-file-descriptor');
    } finally { nativeFs.closeSync(fd); resetCaptureForTests(); rmSync(root, { recursive: true, force: true }); }
  });

  it('captures preopened buffered file streams across recorders and refuses source-only reuse', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-file-stream-input-'));
    const file = join(root, 'fixture.txt');
    nativeFs.writeFileSync(file, 'abcdef');
    const stream = nativeFs.createReadStream(file, { highWaterMark: 6 });
    await new Promise<void>((resolve, reject) => {
      stream.once('readable', resolve);
      stream.once('error', reject);
    });
    // The bytes are already buffered before installation and beginFile. No
    // later public fs export or native read is needed to supply these bytes.
    expect(stream.readableLength).toBe(6);
    const prototype = nativeFs.ReadStream.prototype;
    const descriptors = Object.getOwnPropertyDescriptors(prototype);
    const testFile = 'src/file-stream-input.test.ts';
    resetCaptureForTests();
    const targets = { fs: {}, fsPromises: {}, childProcess: {}, readStreamPrototype: prototype };
    installCapture(targets, resolve(process.cwd()));
    try {
      beginFile();
      expect(stream.read(2).toString()).toBe('ab');
      const record = endFile(testFile)!;
      expect(record.opaque).toContain('fs-file-stream');
      expect(JSON.stringify(record)).not.toContain(file);
      beginFile();
      expect(stream.read(2).toString()).toBe('cd');
      expect(endFile('/repo/second-stream.test.ts')?.opaque).toContain('fs-file-stream');
      beginFile();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe('ef');
      expect(endFile('/repo/iterator-stream.test.ts')?.opaque).toContain('fs-file-stream');
      const proof = { recordedSha: 'a'.repeat(40), recordedAtMs: 1, executedModules: [testFile], inputsCaptured: true,
        runContext: 'local', runnerIdentity: 'measured-worker', readPaths: [], opaqueReasons: record.opaque };
      const select = (opaqueReasons: string[]) => selectReusablePasses({ candidates: [testFile],
        proofs: new Map([[testFile, { ...proof, opaqueReasons }]]), judgedSha: 'b'.repeat(40),
        changedBetween: () => new Set<string>(), runContext: proof.runContext, runnerIdentity: proof.runnerIdentity });
      expect(select([]).skip).toEqual([testFile]);
      expect(select(record.opaque).skip).toEqual([]);
    } finally {
      stream.destroy();
      for (const key of Reflect.ownKeys(prototype))
        if (!Object.hasOwn(descriptors, key)) Reflect.deleteProperty(prototype, key);
      Object.defineProperties(prototype, descriptors);
      resetCaptureForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves file stream consumption and data delivery receivers, returns and errors across recorders', () => {
    const value = Buffer.from('buffered'), error = new Error('original stream failure');
    const calls: unknown[][] = [];
    const prototype = { read(this: unknown, ...args: unknown[]) { calls.push([this, ...args]); return value; },
      emit(this: unknown, ...args: unknown[]) {
        calls.push([this, ...args]);
        if (args[0] === 'error') throw error;
        return true;
      } };
    resetCaptureForTests();
    installCapture({ fs: {}, fsPromises: {}, childProcess: {}, readStreamPrototype: prototype }, '/repo');
    const stream = Object.create(prototype);
    beginFile();
    expect(stream.emit('readable')).toBe(true);
    expect(() => stream.emit('error', error)).toThrow(error);
    expect(endFile('/repo/non-data.test.ts')?.opaque).toEqual([]);
    beginFile();
    expect(stream.read(8)).toBe(value);
    expect(endFile('/repo/pull.test.ts')?.opaque).toEqual(['fs-file-stream']);
    beginFile();
    expect(stream.emit('data', value)).toBe(true);
    expect(endFile('/repo/flow.test.ts')?.opaque).toEqual(['fs-file-stream']);
    expect(calls).toEqual([[stream, 'readable'], [stream, 'error', error], [stream, 8], [stream, 'data', value]]);
    resetCaptureForTests();
  });

  it('rejects missing or frozen file stream seams and allows a later valid installation', () => {
    const valid = () => ({ read() {}, emit() {} });
    for (const prototype of [{}, Object.freeze(valid())]) {
      resetCaptureForTests();
      expect(() => installCapture({ fs: {}, fsPromises: {}, childProcess: {}, readStreamPrototype: prototype }, '/repo'))
        .toThrow('file-stream-capture-unavailable');
      const replacement = valid();
      installCapture({ fs: {}, fsPromises: {}, childProcess: {}, readStreamPrototype: replacement }, '/repo');
      beginFile(); replacement.read();
      expect(endFile('/repo/recovered.test.ts')?.opaque).toEqual(['fs-file-stream']);
    }
    resetCaptureForTests();
  });

  it('captures direct FileHandle reads opened before the recorder and refuses source-only reuse', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-file-handle-input-'));
    const file = join(root, 'fixture.txt');
    nativeFs.writeFileSync(file, 'abcdef');
    const handle = await nativeFs.promises.open(file, 'r');
    const prototype = Object.getPrototypeOf(handle);
    const descriptors = Object.getOwnPropertyDescriptors(prototype);
    const testFile = 'src/file-handle-input.test.ts';
    resetCaptureForTests();
    const targets = { fs: {}, fsPromises: {}, childProcess: {}, fileHandlePrototype: prototype };
    installCapture(targets, resolve(process.cwd()));
    try {
      const observe = async (operation: () => Promise<unknown>) => {
        beginFile();
        await operation();
        const record = endFile(testFile)!;
        expect(record.opaque).toContain('fs-file-descriptor');
        expect(JSON.stringify(record)).not.toContain(file);
        return record;
      };
      await observe(async () => {
        const buffer = Buffer.alloc(2);
        const result = await handle.read(buffer, 0, 2, 0);
        expect(result.buffer).toBe(buffer);
        expect(result.bytesRead).toBe(2);
        expect(buffer.toString()).toBe('ab');
      });
      await observe(async () => {
        const buffers = [Buffer.alloc(2)];
        expect((await handle.readv(buffers, 2)).bytesRead).toBe(2);
        expect(buffers[0]!.toString()).toBe('cd');
      });
      const record = await observe(async () => { expect(await handle.readFile('utf8')).toBe('abcdef'); });
      await observe(async () => { expect((await handle.stat()).size).toBe(6); });
      await observe(async () => {
        const stream = handle.createReadStream({ start: 0, autoClose: false });
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        expect(Buffer.concat(chunks).toString()).toBe('abcdef');
      });
      const proof = { recordedSha: 'a'.repeat(40), recordedAtMs: 1, executedModules: [testFile], inputsCaptured: true,
        runContext: 'local', runnerIdentity: 'measured-worker', readPaths: [], opaqueReasons: record.opaque };
      const select = (opaqueReasons: string[]) => selectReusablePasses({ candidates: [testFile],
        proofs: new Map([[testFile, { ...proof, opaqueReasons }]]), judgedSha: 'b'.repeat(40),
        changedBetween: () => new Set<string>(), runContext: proof.runContext, runnerIdentity: proof.runnerIdentity });
      expect(select([]).skip).toEqual([testFile]);
      expect(select(record.opaque).skip).toEqual([]);
      beginFile();
      await handle.close();
      await expect(handle.readFile('utf8')).rejects.toMatchObject({ code: 'EBADF' });
      expect(endFile(testFile)?.opaque).toContain('fs-file-descriptor');
    } finally {
      await handle.close();
      Object.defineProperties(prototype, descriptors);
      resetCaptureForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('captures preopened directory cursors including deferred iteration and refuses source-only reuse', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-directory-input-'));
    nativeFs.writeFileSync(join(root, 'first.txt'), 'first');
    nativeFs.writeFileSync(join(root, 'second.txt'), 'second');
    const directories = Array.from({ length: 4 }, () => nativeFs.opendirSync(root));
    const prototype = nativeFs.Dir.prototype;
    const descriptors = Object.getOwnPropertyDescriptors(prototype);
    const testFile = 'src/directory-input.test.ts';
    resetCaptureForTests();
    const targets = { fs: {}, fsPromises: {}, childProcess: {}, directoryPrototype: prototype };
    installCapture(targets, resolve(process.cwd()));
    try {
      beginFile();
      expect(directories[0]!.readSync()?.isFile()).toBe(true);
      const record = endFile(testFile)!;
      expect(record.opaque).toContain('fs-directory-cursor');
      expect(JSON.stringify(record)).not.toContain(root);
      beginFile();
      expect((await directories[1]!.read())?.isFile()).toBe(true);
      expect(endFile(testFile)?.opaque).toContain('fs-directory-cursor');
      beginFile();
      await new Promise<void>((resolve, reject) => directories[2]!.read((error, entry) => {
        if (error) { reject(error); return; }
        try { expect(entry?.isFile()).toBe(true); resolve(); } catch (error) { reject(error); }
      }));
      expect(endFile(testFile)?.opaque).toContain('fs-directory-cursor');
      // Node's iterator uses a private bound reader, bypassing public read().
      // Creation before beginFile must not lose its later per-file reads.
      const iterator = directories[3]![Symbol.asyncIterator]();
      for (const file of [testFile, 'src/second-directory-input.test.ts']) {
        beginFile();
        expect((await iterator.next()).value?.isFile()).toBe(true);
        expect(endFile(file)?.opaque).toContain('fs-directory-cursor');
      }
      await iterator.return!();
      const proof = { recordedSha: 'a'.repeat(40), recordedAtMs: 1, executedModules: [testFile], inputsCaptured: true,
        runContext: 'local', runnerIdentity: 'measured-worker', readPaths: [], opaqueReasons: record.opaque };
      const select = (opaqueReasons: string[]) => selectReusablePasses({ candidates: [testFile],
        proofs: new Map([[testFile, { ...proof, opaqueReasons }]]), judgedSha: 'b'.repeat(40),
        changedBetween: () => new Set<string>(), runContext: proof.runContext, runnerIdentity: proof.runnerIdentity });
      expect(select([]).skip).toEqual([testFile]);
      expect(select(record.opaque).skip).toEqual([]);
      beginFile();
      directories[0]!.closeSync();
      expect(() => directories[0]!.readSync()).toThrow();
      expect(endFile(testFile)?.opaque).toContain('fs-directory-cursor');
    } finally {
      for (const directory of directories) {
        try { directory.closeSync(); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
        }
      }
      Object.defineProperties(prototype, descriptors);
      resetCaptureForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves directory iterator identity and delegates advancement across recorders', async () => {
    const pending = Promise.resolve({ value: 'entry', done: false });
    const error = new Error('original directory read');
    const calls: unknown[][] = [];
    const iterator = { next(this: unknown, ...args: unknown[]) { calls.push([this, ...args]); return pending; } };
    const prototype = { read() { throw error; }, readSync() {},
      entries() { return iterator; }, [Symbol.asyncIterator]() { return iterator; } };
    resetCaptureForTests();
    installCapture({ fs: {}, fsPromises: {}, childProcess: {}, directoryPrototype: prototype }, '/repo');
    expect(prototype.entries()).toBe(iterator);
    expect(prototype[Symbol.asyncIterator]()).toBe(iterator);
    beginFile();
    expect(iterator.next('first')).toBe(pending);
    expect(() => prototype.read()).toThrow(error);
    expect(endFile('/repo/first.test.ts')?.opaque).toEqual(['fs-directory-cursor']);
    beginFile();
    expect(iterator.next('second')).toBe(pending);
    expect(endFile('/repo/second.test.ts')?.opaque).toEqual(['fs-directory-cursor']);
    expect(calls).toEqual([[iterator, 'first'], [iterator, 'second']]);
    await pending;
    resetCaptureForTests();
  });

  it('keeps future files opaque after an unobservable directory iterator and rejects unsupported prototypes', () => {
    const valid = () => ({ read() {}, readSync() {},
      [Symbol.asyncIterator]() { return Object.freeze({ next() {} }); } });
    for (const prototype of [{}, Object.freeze(valid())]) {
      resetCaptureForTests();
      expect(() => installCapture({ fs: {}, fsPromises: {}, childProcess: {}, directoryPrototype: prototype }, '/repo'))
        .toThrow('directory-capture-unavailable');
      const replacement = valid();
      installCapture({ fs: {}, fsPromises: {}, childProcess: {}, directoryPrototype: replacement }, '/repo');
      replacement[Symbol.asyncIterator]();
      beginFile();
      expect(endFile('/repo/future.test.ts')?.opaque).toEqual(['fs-directory-cursor']);
    }
    resetCaptureForTests();
  });

  it('preserves FileHandle method receivers, promises, optional streams and failures across file recorders', () => {
    const pending = Promise.resolve('read'), stream = {}, lines = {}, web = {};
    const error = new Error('original stat failure');
    const calls: unknown[][] = [];
    const prototype = { read(this: unknown, ...args: unknown[]) { calls.push([this, ...args]); return pending; },
      readv() {}, readFile() {}, stat() { throw error; }, createReadStream() { return stream; },
      readLines() { return lines; }, readableWebStream() { return web; } };
    resetCaptureForTests();
    installCapture({ fs: {}, fsPromises: {}, childProcess: {}, fileHandlePrototype: prototype }, '/repo');
    const handle = Object.create(prototype);
    beginFile();
    const buffer = Buffer.alloc(2);
    expect(handle.read(buffer, 0, 2, 3)).toBe(pending);
    expect(calls).toEqual([[handle, buffer, 0, 2, 3]]);
    expect(() => handle.stat()).toThrow(error);
    const first = endFile('/repo/first.test.ts')!;
    beginFile();
    expect(handle.createReadStream()).toBe(stream);
    expect(handle.readLines()).toBe(lines);
    expect(handle.readableWebStream()).toBe(web);
    expect(endFile('/repo/second.test.ts')?.opaque).toEqual(['fs-file-descriptor']);
    expect(first.opaque).toEqual(['fs-file-descriptor']);
    resetCaptureForTests();
  });

  it('refuses unsupported or frozen FileHandle seams and allows a subsequent valid installation', () => {
    const valid = () => ({ read() {}, readv() {}, readFile() {}, stat() {}, createReadStream() {} });
    for (const prototype of [{}, Object.freeze(valid())]) {
      resetCaptureForTests();
      expect(() => installCapture({ fs: {}, fsPromises: {}, childProcess: {}, fileHandlePrototype: prototype }, '/repo'))
        .toThrow('file-handle-capture-unavailable');
      const replacement = valid();
      installCapture({ fs: {}, fsPromises: {}, childProcess: {}, fileHandlePrototype: replacement }, '/repo');
      beginFile(); replacement.stat();
      expect(endFile('/repo/test.ts')?.opaque).toEqual(['fs-file-descriptor']);
    }
    resetCaptureForTests();
  });

  it('keeps parent traversal through a directory symlink opaque before path normalization', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-parent-input-'));
    const repo = join(root, 'repo'), external = join(root, 'external');
    nativeFs.mkdirSync(repo); nativeFs.mkdirSync(join(external, 'child'), { recursive: true });
    nativeFs.writeFileSync(join(repo, 'fixture.txt'), 'lexical');
    nativeFs.writeFileSync(join(external, 'fixture.txt'), 'actual');
    nativeFs.symlinkSync(join(external, 'child'), join(repo, 'bridge'));
    // join/resolve would erase the operation whose kernel semantics we need to observe.
    const traversed = `${repo}/bridge/../fixture.txt`;
    const testFile = 'src/parent-input.test.ts';
    resetCaptureForTests();
    const targets = { readFileSync: (file: fs.PathOrFileDescriptor, encoding: BufferEncoding) =>
      nativeFs.readFileSync(file, encoding) };
    installCapture({ fs: targets, fsPromises: {}, childProcess: {} }, repo);
    try {
      for (const file of [traversed, Buffer.from(traversed)]) {
        beginFile();
        expect(targets.readFileSync(file, 'utf8')).toBe('actual');
        const record = endFile(join(repo, testFile))!;
        expect(record.opaque).toContain('fs-path-unobserved');
        expect(JSON.stringify(record)).not.toContain(external);
        const select = (opaqueReasons: string[]) => selectReusablePasses({ candidates: [testFile],
          proofs: new Map([[testFile, { recordedSha: 'a'.repeat(40), recordedAtMs: 1,
            executedModules: [testFile], inputsCaptured: true, runContext: 'local',
            runnerIdentity: 'measured-worker', readPaths: record.reads, opaqueReasons }]]),
          judgedSha: 'b'.repeat(40), changedBetween: () => new Set<string>(),
          runContext: 'local', runnerIdentity: 'measured-worker' });
        expect(select([]).skip).toEqual([testFile]);
        expect(select(record.opaque).skip).toEqual([]);
      }
    } finally { resetCaptureForTests(); rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses reuse through file and directory symlinks while preserving target reads and errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-linked-input-'));
    const repo = join(root, 'repo'), external = join(root, 'external');
    nativeFs.mkdirSync(repo); nativeFs.mkdirSync(external);
    nativeFs.writeFileSync(join(external, 'fixture.txt'), 'first');
    nativeFs.writeFileSync(join(repo, 'local.txt'), 'local');
    nativeFs.symlinkSync(join(external, 'fixture.txt'), join(repo, 'file.txt'));
    nativeFs.symlinkSync(external, join(repo, 'directory'));
    nativeFs.symlinkSync('local.txt', join(repo, 'internal.txt'));
    nativeFs.symlinkSync(join(external, 'missing.txt'), join(repo, 'dangling.txt'));
    const testFile = 'src/linked-input.test.ts';
    resetCaptureForTests();
    const targets = { readFileSync: (path: fs.PathOrFileDescriptor, encoding: BufferEncoding) =>
      nativeFs.readFileSync(path, encoding) };
    installCapture({ fs: targets, fsPromises: {}, childProcess: {} }, repo);
    try {
      for (const [path, expected] of [['file.txt', 'first'], ['directory/fixture.txt', 'first'],
        ['internal.txt', 'local']] as const) {
        beginFile();
        expect(targets.readFileSync(join(repo, path), 'utf8')).toBe(expected);
        const record = endFile(join(repo, testFile))!;
        expect(record.opaque).toContain('fs-symlink');
        expect(JSON.stringify(record)).not.toContain(external);
        const select = (opaqueReasons: string[]) => selectReusablePasses({ candidates: [testFile],
          proofs: new Map([[testFile, { recordedSha: 'a'.repeat(40), recordedAtMs: 1,
            executedModules: [testFile], inputsCaptured: true, runContext: 'local',
            runnerIdentity: 'measured-worker', readPaths: record.reads, opaqueReasons }]]),
          judgedSha: 'b'.repeat(40), changedBetween: () => new Set<string>(),
          runContext: 'local', runnerIdentity: 'measured-worker' });
        expect(select([]).skip).toEqual([testFile]);
        expect(select(record.opaque).skip).toEqual([]);
        expect(select(record.opaque).exclusions).toMatchObject([{ reason: 'opaque' }]);
      }
      nativeFs.writeFileSync(join(external, 'fixture.txt'), 'second');
      beginFile();
      expect(targets.readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('second');
      expect(endFile(join(repo, testFile))?.opaque).toContain('fs-symlink');
      beginFile();
      expect(() => targets.readFileSync(join(repo, 'dangling.txt'), 'utf8')).toThrow(
        expect.objectContaining({ code: 'ENOENT' }));
      expect(endFile(join(repo, testFile))?.opaque).toContain('fs-symlink');
      // Ordinary files and absence observations retain their existing path custody.
      beginFile();
      expect(targets.readFileSync(join(repo, 'local.txt'), 'utf8')).toBe('local');
      expect(() => targets.readFileSync(join(repo, 'missing.txt'), 'utf8')).toThrow(
        expect.objectContaining({ code: 'ENOENT' }));
      expect(endFile(join(repo, testFile))?.opaque).toEqual([]);
    } finally { resetCaptureForTests(); rmSync(root, { recursive: true, force: true }); }
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
