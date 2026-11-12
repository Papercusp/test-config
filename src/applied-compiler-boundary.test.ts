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
import { parseAppliedCompilerReceipt, readAppliedCompilerInputs, type AppliedCompilerReceipt } from './applied-compiler-inputs.ts';

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
