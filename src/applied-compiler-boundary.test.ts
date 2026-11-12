import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { createServer, Plugin } from 'vite';
import { executedSourceOriginalsPlugin } from './vitest-config.ts';
import { parseAppliedCompilerReceipt, readAppliedCompilerInputs, successfulAppliedCompilerOutput,
  installAppliedCompilerInputCapture, type AppliedCompilerReceipt } from './applied-compiler-inputs.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const blobHash = (value: Buffer) => createHash('sha1').update('blob ' + value.length + '\0').update(value).digest('hex');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const patchPath = join(repoRoot, 'patches/vite+7.3.5.patch');
let fixture: string;
let createPatchedServer: typeof createServer;

beforeAll(async () => {
  fixture = mkdtempSync(join(tmpdir(), 'applied-compiler-patch-'));
  const viteRoot = dirname(createRequire(import.meta.url).resolve('vite/package.json'));
  const isolated = join(fixture, 'node_modules/vite');
  mkdirSync(dirname(isolated), { recursive: true });
  cpSync(viteRoot, isolated, { recursive: true, filter: path => path === viteRoot || !path.startsWith(join(viteRoot, 'node_modules')) });
  // Dependencies are read through a symlink; only the isolated Vite copy is patched.
  symlinkSync(dirname(viteRoot), join(isolated, 'node_modules'), 'dir');
  const patch = readFileSync(patchPath, 'utf8');
  const index = /^index ([a-f0-9]+)\.\.([a-f0-9]+) /m.exec(patch)!;
  expect(index).not.toBeNull();
  const target = join(isolated, 'dist/node/chunks/config.js');
  const installedHash = blobHash(readFileSync(target));
  if (installedHash === index[2]) execFileSync('git', ['apply', '--reverse', patchPath], { cwd: fixture });
  else if (installedHash !== index[1]) {
    // A maintained dependency generation may contain the previous committed
    // patch. Normalize only a verified tracked postimage in this isolated copy.
    const revisions = execFileSync('git', ['log', '-8', '--format=%H', '--', 'patches/vite+7.3.5.patch'],
      { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n');
    let restored = false;
    for (const revision of revisions.filter(revision => /^[a-f0-9]{40}$/.test(revision))) {
      const prior = execFileSync('git', ['show', revision + ':patches/vite+7.3.5.patch'], { cwd: repoRoot, encoding: 'utf8' });
      const hashes = /^index ([a-f0-9]+)\.\.([a-f0-9]+) /m.exec(prior);
      if (hashes?.[1] === index[1] && hashes[2] === installedHash) {
        execFileSync('git', ['apply', '--reverse', '-'], { cwd: fixture, input: prior }); restored = true; break;
      }
    }
    if (!restored && installedHash === 'd47de69dfa01e96415ed334a119b32dde12f7b51') {
      // The original before-call patch can still be uncommitted during this
      // source change. Upgrade ONLY that exact measured donor, ONLY here, then
      // require the current full postimage before reversing/applying the patch.
      const hunk = patch.split('\n').findIndex(line => line.startsWith('@@ -6119,'));
      expect(hunk).toBeGreaterThan(0);
      const lines = patch.split('\n').slice(hunk + 1);
      const end = lines.findIndex(line => line.startsWith('@@'));
      const current = lines.slice(0, end).filter(line => !line.startsWith('-')).map(line => line.slice(1)).join('\n') + '\n';
      const prior = current.replace('\tlet papercuspSettle;\n', '')
        .replace('papercuspSettle = observe({', 'observe({')
        .replace(/\t\tlet result;\n\t\ttry \{[\s\S]*?\{ status: "success", result \}\); \} catch \{\}\n/,
          '\t\tconst result = await transform(code, resolvedOptions);\n');
      const donor = readFileSync(target, 'utf8');
      expect(prior).not.toBe(current);
      expect(donor.split(prior)).toHaveLength(2);
      writeFileSync(target, donor.replace(prior, current));
      expect(blobHash(readFileSync(target))).toBe(index[2]);
      execFileSync('git', ['apply', '--reverse', patchPath], { cwd: fixture });
      restored = true;
    }
    expect(restored, 'isolated donor must match a maintained exact postimage').toBe(true);
  }
  expect(blobHash(readFileSync(target))).toBe(index[1]);
  execFileSync('git', ['apply', '--check', patchPath], { cwd: fixture });
  execFileSync('git', ['apply', patchPath], { cwd: fixture });
  expect(blobHash(readFileSync(target))).toBe(index[2]);
  const vite = await import(/* @vite-ignore */ pathToFileURL(join(isolated, 'dist/node/index.js')).href);
  createPatchedServer = vite.createServer;
}, 30_000);

afterAll(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

async function serverFor(root: string, plugins: Plugin[] = [], capture = true) {
  return createPatchedServer({ root, configFile: false, logLevel: 'silent', esbuild: { target: 'es2015' },
    optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, watch: null },
    plugins: [...(capture ? [executedSourceOriginalsPlugin()] : []), ...plugins] });
}

describe('maintained Vite applied compiler boundary', () => {
  it('settlement: real compiler success and failure bind to their original before-call sequence', async () => {
    const root = join(fixture, 'settlement'); mkdirSync(root);
    const good = join(root, 'good.ts'), bad = join(root, 'bad.ts');
    writeFileSync(good, 'export const value: number = 1;');
    writeFileSync(bad, 'export const broken: number = ;');
    const server = await serverFor(root);
    try {
      const environment = server.environments.ssr!;
      expect(await environment.transformRequest(good)).not.toBeNull();
      const successful = readAppliedCompilerInputs(environment)!;
      expect(successful.calls[0]!.outcome?.status).toBe('success');
      expect(successfulAppliedCompilerOutput(successful, 1)).toMatch(/^[a-f0-9]{64}$/);
      expect(successful.missing).not.toContain('compiler-outcome-unobserved');
      await expect(environment.transformRequest(bad)).rejects.toThrow();
      const failed = readAppliedCompilerInputs(environment)!;
      expect(failed.calls).toHaveLength(2);
      expect(failed.calls[1]).toMatchObject({ sequence: 2, moduleId: bad, outcome: { status: 'failure' } });
      expect(failed.calls[1]!.outcome).toHaveProperty('errorSha256', expect.stringMatching(/^[a-f0-9]{64}$/));
      expect(successfulAppliedCompilerOutput(failed, 2)).toBeUndefined();
      expect(failed.calls[0]).toEqual(successful.calls[0]);
      expect(successful.calls).toHaveLength(1);
      expect(failed.populationStatus).toBe('unknown');
      expect(failed.missing).toHaveLength(4);
      expect(Object.isFrozen(failed.calls[1]!.outcome)).toBe(true);
      expect(parseAppliedCompilerReceipt(JSON.parse(JSON.stringify(failed)))).toEqual(failed);
      const forged = { ...failed, calls: [failed.calls[0], { ...failed.calls[1], outcome: failed.calls[0]!.outcome }] };
      expect(parseAppliedCompilerReceipt(forged)).toBeUndefined();
      expect(successfulAppliedCompilerOutput(forged, 2)).toBeUndefined();
      expect(parseAppliedCompilerReceipt({ ...failed, captureId: '00000000-0000-0000-0000-000000000000' })).toBeUndefined();
    } finally { await server.close(); }
  }, 30_000);

  it('settlement: inflight and legacy calls never become output, and out-of-order callbacks retain exact custody', () => {
    // Call the observer protocol directly to hold calls inflight. Real compiler
    // success/rejection delivery is separately exercised above, not mocked.
    const config = {}, environment = {};
    expect(installAppliedCompilerInputCapture(config)).toBe(true);
    const observe = Object.getOwnPropertyDescriptor(config,
      Symbol.for('@papercusp/test-config.applied-compiler-observer-v1'))!.value;
    const functions = Object.fromEntries(['loadTsconfigJsonForFile', 'parse', 'parseExtends', 'parseFile',
      'resolveSolutionTSConfig', 'transform', 'transformWithEsbuild'].map(name => [name, function measuredFunction() {}]));
    const event = (moduleId: string) => ({ version: 1, environment, moduleId, code: 'code', options: { loader: 'ts' },
      tsconfig: { status: 'not-used', inputs: [] }, implementation: { viteVersion: 'test', esbuildVersion: 'test', functions } });
    const settle1 = observe(event('/repo/first.ts')), settle2 = observe(event('/repo/second.ts'));
    const before = readAppliedCompilerInputs(environment)!;
    expect(before.missing).toContain('compiler-outcome-unobserved');
    expect(successfulAppliedCompilerOutput(before, 1)).toBeUndefined();
    settle2({ status: 'success', result: { code: 'second output' } });
    const middle = readAppliedCompilerInputs(environment)!;
    expect(middle.calls[1]!.outcome?.status).toBe('success');
    expect(middle.calls[0]!.outcome).toBeUndefined();
    expect(successfulAppliedCompilerOutput(middle, 1)).toBeUndefined();
    expect(successfulAppliedCompilerOutput(middle, 2)).toMatch(/^[a-f0-9]{64}$/);
    settle1({ status: 'failure', error: new Error('compiler rejected private source') });
    const after = readAppliedCompilerInputs(environment)!;
    expect(after.missing).toHaveLength(4);
    expect(after.calls[0]!.outcome?.status).toBe('failure');
    expect(after.calls[1]).toEqual(middle.calls[1]);
    expect(after.calls.map(call => call.inputSha256)).toEqual(before.calls.map(call => call.inputSha256));
    expect(JSON.stringify(after)).not.toContain('compiler rejected private source');
    expect(before.calls.every(call => !call.outcome)).toBe(true);
    expect(Object.isFrozen(after.calls[0]!.outcome)).toBe(true);
    settle1({ status: 'success', result: { code: 'late duplicate' } });
    expect(readAppliedCompilerInputs(environment)).toEqual(after);
    const legacy = { ...after, missing: [...after.missing, 'compiler-outcome-unobserved'],
      calls: after.calls.map(({ outcome: _outcome, ...call }) => call) };
    expect(parseAppliedCompilerReceipt(legacy)).toEqual(legacy);
    expect(successfulAppliedCompilerOutput(legacy, 2)).toBeUndefined();
    expect(parseAppliedCompilerReceipt({ ...legacy, missing: after.missing })).toBeUndefined();
    for (const outcome of [{ ...after.calls[0]!.outcome, status: 'inflight' },
      { ...after.calls[0]!.outcome, resultSha256: 'a'.repeat(64) },
      { ...after.calls[1]!.outcome, resultSha256: 'not-a-hash' }])
      expect(parseAppliedCompilerReceipt({ ...after, calls: [{ ...after.calls[0], outcome }, after.calls[1]] })).toBeUndefined();
  });

  it('captures applied per-file arguments and consumed extends bytes, with equivalent repeats', async () => {
    const root = join(fixture, 'option-mutation');
    mkdirSync(root);
    const file = join(root, 'input.ts');
    const source = 'export class Example { value = 1; }\n';
    const configSource = JSON.stringify({ extends: './compiler-base.json' });
    writeFileSync(file, source);
    writeFileSync(join(root, 'tsconfig.json'), configSource);
    const runs: Array<{ code: string; receipt: AppliedCompilerReceipt }> = [];
    for (const useDefineForClassFields of [true, false, true]) {
      const baseSource = JSON.stringify({ compilerOptions: { useDefineForClassFields } });
      writeFileSync(join(root, 'compiler-base.json'), baseSource);
      const server = await serverFor(root);
      try {
        const environment = server.environments.ssr!;
        expect(readAppliedCompilerInputs(environment)).toBeUndefined();
        const result = await environment.transformRequest(file);
        expect(result).not.toBeNull();
        const receipt = readAppliedCompilerInputs(environment)!;
        expect(receipt).toMatchObject({ basis: 'before-compiler-call', populationStatus: 'unknown', truncated: false,
          compilerProcess: { pid: process.pid } });
        expect(receipt.calls).toHaveLength(1);
        expect(receipt.calls[0]).toMatchObject({ sequence: 1, moduleId: file, codeSha256: hash(source), tsconfigStatus: 'captured',
          implementation: { viteVersion: '7.3.5' } });
        expect(receipt.calls[0]!.inputSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.calls[0]!.optionsSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.calls[0]!.tsconfigInputs).toEqual([
          { path: join(root, 'compiler-base.json'), sha256: hash(baseSource), byteLength: Buffer.byteLength(baseSource) },
          { path: join(root, 'tsconfig.json'), sha256: hash(configSource), byteLength: Buffer.byteLength(configSource) },
        ]);
        expect(Object.isFrozen(receipt)).toBe(true);
        expect(Object.isFrozen(receipt.calls[0]!.tsconfigInputs[0])).toBe(true);
        expect(parseAppliedCompilerReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
        runs.push({ code: result!.code, receipt });
      } finally { await server.close(); }
    }
    expect(runs[0]!.code).not.toBe(runs[1]!.code);
    expect(runs[0]!.code).toBe(runs[2]!.code);
    expect(runs[0]!.receipt.calls[0]!.optionsSha256).not.toBe(runs[1]!.receipt.calls[0]!.optionsSha256);
    expect(runs[0]!.receipt.calls[0]!.inputSha256).not.toBe(runs[1]!.receipt.calls[0]!.inputSha256);
    expect(runs[0]!.receipt.calls[0]!.inputSha256).toBe(runs[2]!.receipt.calls[0]!.inputSha256);
    expect(runs[0]!.receipt.captureId).not.toBe(runs[2]!.receipt.captureId);
    expect(readFileSync(file, 'utf8')).toBe(source);
  }, 30_000);

  it('retains original parser-cache inputs after disk mutation and does not invent cache-hit test custody', async () => {
    const root = join(fixture, 'parser-cache');
    mkdirSync(root);
    const file = join(root, 'input.ts');
    const sibling = join(root, 'sibling.ts');
    const source = 'export class Example { value = 1; }\n';
    const original = JSON.stringify({ compilerOptions: { useDefineForClassFields: true } });
    writeFileSync(file, source); writeFileSync(sibling, source);
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: './compiler-base.json' }));
    writeFileSync(join(root, 'compiler-base.json'), original);
    const server = await serverFor(root);
    try {
      const environment = server.environments.ssr!;
      const first = await environment.transformRequest(file);
      const before = readAppliedCompilerInputs(environment)!;
      writeFileSync(join(root, 'compiler-base.json'), JSON.stringify({ compilerOptions: { useDefineForClassFields: false } }));
      const cached = await environment.transformRequest(file);
      expect(cached!.code).toBe(first!.code);
      expect(readAppliedCompilerInputs(environment)).toEqual(before);
      const second = await environment.transformRequest(sibling);
      const after = readAppliedCompilerInputs(environment)!;
      expect(after.calls).toHaveLength(2);
      expect(after.calls[1]!.optionsSha256).not.toBe(after.calls[0]!.optionsSha256);
      // sourcefile is itself an exact compiler argument, so different module
      // paths rotate the argument digest even when effective TS options agree.
      expect(after.calls[1]!.moduleId).toBe(sibling);
      expect(second!.code).toBe(first!.code);
      expect(after.calls[1]!.tsconfigInputs.find(input => input.path.endsWith('/compiler-base.json'))!.sha256).toBe(hash(original));
      expect(hash(readFileSync(join(root, 'compiler-base.json')))).not.toBe(hash(original));
      expect(after.missing).toContain('cached-module-test-custody-unobserved');
      expect(before.calls).toHaveLength(1);
    } finally { await server.close(); }
  }, 30_000);

  it('keeps private plugin state unknown and rejects forged completeness or changed call digests', async () => {
    const root = join(fixture, 'plugin-closure');
    mkdirSync(root);
    const file = join(root, 'input.ts');
    writeFileSync(file, 'export const value: number = 1;\n');
    const runs: Array<{ code: string; receipt: AppliedCompilerReceipt }> = [];
    for (const setting of [1, 2]) {
      const server = await serverFor(root, [{ name: 'private-closure', transform(code, id) {
        if (id === file) return { code: code + '\nexport const setting = ' + setting + ';', map: null };
      } }]);
      try {
        const result = await server.environments.ssr!.transformRequest(file);
        runs.push({ code: result!.code, receipt: readAppliedCompilerInputs(server.environments.ssr)! });
      } finally { await server.close(); }
    }
    expect(runs[0]!.code).not.toBe(runs[1]!.code);
    expect(runs[0]!.receipt.calls[0]!.inputSha256).toBe(runs[1]!.receipt.calls[0]!.inputSha256);
    const receipt = runs[0]!.receipt;
    expect(receipt.missing).toContain('plugin-private-inputs-unobserved');
    expect(receipt.missing).toContain('transitive-compiler-implementation-unobserved');
    for (const changed of [{ ...receipt, populationStatus: 'complete' }, { ...receipt, missing: [] },
      { ...receipt, calls: [{ ...receipt.calls[0], optionsSha256: 'a'.repeat(64) }] },
      { ...receipt, calls: [{ ...receipt.calls[0], implementation: null }] }])
      expect(parseAppliedCompilerReceipt(changed)).toBeUndefined();
    let invoked = false;
    const accessor = Object.defineProperty({ ...receipt }, 'calls', { get() { invoked = true; return receipt.calls; } });
    expect(parseAppliedCompilerReceipt(accessor)).toBeUndefined();
    expect(invoked).toBe(false);
  }, 30_000);

  it('does not produce a receipt when capture is not installed', async () => {
    const root = join(fixture, 'unarmed'); mkdirSync(root);
    const file = join(root, 'input.ts'); writeFileSync(file, 'export const value: number = 1;');
    const server = await serverFor(root, [], false);
    try {
      expect(await server.environments.ssr!.transformRequest(file)).not.toBeNull();
      expect(readAppliedCompilerInputs(server.environments.ssr)).toBeUndefined();
    } finally { await server.close(); }
  }, 30_000);
});
