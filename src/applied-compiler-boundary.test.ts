import { createHash, randomUUID } from 'node:crypto';
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
import { captureRecordedProofContext, parseTestRunExecutionDetails, TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
  type TestRunExecutionDetails } from './execution-details.ts';
import { captureCurrentWorkerProcessIdentity } from './runtime-proof.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const blobHash = (value: Buffer) => createHash('sha1').update('blob ' + value.length + '\0').update(value).digest('hex');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const patchPath = join(repoRoot, 'patches/vite+7.3.5.patch');
let fixture: string;
let createPatchedServer: typeof createServer;
let patchedViteRoot: string;

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
    if (!restored && ['d47de69dfa01e96415ed334a119b32dde12f7b51',
      '732046e1c4a35b19c964146fa0e6041f0f60ee2b'].includes(installedHash)) {
      // Exact measured donors can precede git-sync. Normalize ONLY this isolated
      // copy, and require the whole vanilla blob before applying the new patch.
      let donor = readFileSync(target, 'utf8');
      for (const hunk of patch.split(/^@@[^\n]*\n/m).slice(1)) {
        const lines = hunk.match(/[^\n]*\n/g) ?? [];
        const before = lines.filter(line => [' ', '-'].includes(line[0]!)).map(line => line.slice(1)).join('');
        const after = lines.filter(line => [' ', '+'].includes(line[0]!)).map(line => line.slice(1)).join('');
        if (donor.split(after).length === 2) donor = donor.replace(after, before);
        else if (donor.split(before).length !== 2) {
          const original = before.match(/[^\n]*\n/g)!;
          const start = original.slice(0, 3).join(''), end = original.slice(-3).join('');
          expect(donor.split(start)).toHaveLength(2);
          const offset = donor.indexOf(start), finish = donor.indexOf(end, offset) + end.length;
          expect(finish).toBeGreaterThan(offset);
          donor = donor.slice(0, offset) + before + donor.slice(finish);
        }
      }
      expect(blobHash(Buffer.from(donor))).toBe(index[1]);
      writeFileSync(target, donor);
      restored = true;
    }
    expect(restored, 'isolated donor must match a maintained exact postimage').toBe(true);
  }
  expect(blobHash(readFileSync(target))).toBe(index[1]);
  execFileSync('git', ['apply', '--check', patchPath], { cwd: fixture });
  execFileSync('git', ['apply', patchPath], { cwd: fixture });
  expect(blobHash(readFileSync(target))).toBe(index[2]);
  patchedViteRoot = isolated;
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

  function implementationRuntime(name: string) {
    const root = join(fixture, name), vite = join(root, 'node_modules/vite');
    mkdirSync(dirname(vite), { recursive: true });
    cpSync(patchedViteRoot, vite, { recursive: true,
      filter: path => path === patchedViteRoot || !path.startsWith(join(patchedViteRoot, 'node_modules')) });
    const original = dirname(createRequire(import.meta.url).resolve('vite/package.json'));
    mkdirSync(join(vite, 'node_modules'));
    for (const dependency of Object.keys(JSON.parse(readFileSync(join(original, 'package.json'), 'utf8')).dependencies)) {
      if (dependency === 'esbuild') continue;
      const link = join(vite, 'node_modules', dependency); mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(dirname(original), dependency), link, 'dir');
    }
    const esbuild = join(vite, 'node_modules/esbuild');
    const source = dirname(createRequire(import.meta.url).resolve('esbuild/package.json'));
    cpSync(source, esbuild, { recursive: true, filter: path => path === source || !path.startsWith(join(source, 'node_modules')) });
    symlinkSync(dirname(source), join(esbuild, 'node_modules'), 'dir');
    return { root, vite, esbuild, helper: join(esbuild, 'lib/pc-implementation-control.js') };
  }

  function implementationRun(runtime: ReturnType<typeof implementationRuntime>, overwrite = false, native = '') {
    // Permanent real-compiler control: each process loads its own copied Vite
    // and esbuild. Installed dependencies are only read, never edited.
    const script = `
      import { pathToFileURL } from 'node:url';
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { createRequire } from 'node:module';
      const [entry, producer, root, helper, overwrite] = process.argv.slice(1);
      const { createServer } = await import(pathToFileURL(entry));
      const { installAppliedCompilerInputCapture, readAppliedCompilerInputs } = await import(pathToFileURL(producer));
      if (overwrite === 'true') writeFileSync(helper, 'module.exports = { value: 999 };');
      const file = join(root, 'input.ts'), sibling = join(root, 'sibling.ts');
      writeFileSync(file, 'export const value: number = 1;');
      writeFileSync(sibling, 'export const value: number = 1;');
      const server = await createServer({ root, configFile: false, logLevel: 'silent', esbuild: { target: 'es2015' },
        optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, watch: null },
        plugins: [{ name: 'implementation-control', configResolved: installAppliedCompilerInputCapture }] });
      try {
        const environment = server.environments.ssr;
        const result = await environment.transformRequest(file);
        const receipt = readAppliedCompilerInputs(environment), frozen = JSON.stringify(receipt);
        await environment.transformRequest(sibling);
        const warm = readAppliedCompilerInputs(environment);
        process.stdout.write(JSON.stringify({ code: result.code, receipt, warm, originalUnchanged: frozen === JSON.stringify(receipt) }));
      } finally {
        await server.close();
        await createRequire(pathToFileURL(entry))('esbuild').stop();
      }
    `;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script,
      join(runtime.vite, 'dist/node/index.js'), join(repoRoot, 'libs/test-config/src/applied-compiler-inputs.ts'),
      runtime.root, runtime.helper, String(overwrite)], { encoding: 'utf8', timeout: 25_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, ...(native ? { ESBUILD_BINARY_PATH: native } : {}) } })) as {
        code: string; receipt: AppliedCompilerReceipt; warm: AppliedCompilerReceipt; originalUnchanged: boolean };
  }

  function nativeUseRuntime(name: string, patched = true) {
    const runtime = implementationRuntime(name);
    // patch-package applies the maintained esbuild patch at install, so the
    // copied esbuild may already be the patched postimage. Normalise the
    // isolated copy to the exact donor first: the patched flag alone decides
    // the isolated runtime state, never the ambient install.
    const patch = join(repoRoot, 'patches/esbuild+0.27.3.patch');
    const source = readFileSync(patch, 'utf8'), hashes = /^index ([a-f0-9]+)\.\.([a-f0-9]+) /m.exec(source)!;
    const main = join(runtime.esbuild, 'lib/main.js');
    expect(hashes).not.toBeNull();
    if (blobHash(readFileSync(main)) === hashes[2]) execFileSync('git', ['apply', '--reverse', patch], { cwd: runtime.vite });
    expect(blobHash(readFileSync(main)), 'exact isolated esbuild donor').toBe(hashes[1]);
    if (patched) {
      execFileSync('git', ['apply', '--check', patch], { cwd: runtime.vite });
      execFileSync('git', ['apply', patch], { cwd: runtime.vite });
      expect(blobHash(readFileSync(main))).toBe(hashes[2]);
    }
    return runtime;
  }

  function nativeUseRun(runtime: ReturnType<typeof implementationRuntime>, mode: string, native = '', decoy = '') {
    const script = `
      import { pathToFileURL } from 'node:url';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { createRequire } from 'node:module';
      import { channel } from 'node:diagnostics_channel';
      import { once } from 'node:events';
      const [entry, producer, root, mode, binary, decoyEntry] = process.argv.slice(1);
      const { createServer } = await import(pathToFileURL(entry));
      const { installAppliedCompilerInputCapture, readAppliedCompilerInputs } = await import(pathToFileURL(producer));
      const esbuild = createRequire(pathToFileURL(entry))('esbuild');
      const hook = Symbol.for('@papercusp/test-config.esbuild-native-use-observer-v1');
      const output = { receipts: [], codes: [], deliveries: [], errors: [], snapshotsUnchanged: [] };
      let child;
      const spawned = message => { if (message.process.spawnargs?.some(arg => arg.startsWith('--service='))) child = message.process; };
      const spawns = channel('tracing:child_process.spawn:end');
      spawns.subscribe(spawned);
      async function stop() {
        const current = child;
        // esbuild unrefs its child. Keep cleanup alive until the exit event;
        // an await alone does not retain a Node event-loop handle.
        current?.ref();
        try {
          await esbuild.stop();
          if (current && current.exitCode === null && current.signalCode === null) await once(current, 'exit');
        } finally { current?.unref(); }
      }
      async function compile(names) {
        for (const name of names) writeFileSync(join(root, name), 'export const value: number = 1;');
        const server = await createServer({ root, configFile: false, logLevel: 'silent', esbuild: { target: 'es2015' },
          optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, watch: null },
          plugins: [{ name: 'native-use-control', configResolved: installAppliedCompilerInputCapture }] });
        try {
          const environment = server.environments.ssr;
          let results;
          if (mode === 'concurrent') results = await Promise.all(names.map(name => environment.transformRequest(join(root, name))));
          else {
            results = [];
            let original, before;
            for (const name of names) {
              results.push(await environment.transformRequest(join(root, name)));
              if (!original) { original = readAppliedCompilerInputs(environment); before = JSON.stringify(original); }
            }
            output.snapshotsUnchanged.push(JSON.stringify(original) === before);
          }
          output.codes.push(...results.map(result => result.code));
          output.receipts.push(readAppliedCompilerInputs(environment));
        } finally { await server.close(); }
      }
      let unrelated;
      try {
        if (mode === 'throwing') {
          Object.defineProperty(esbuild, hook, { value: () => { throw new Error('observer failure'); } });
          output.codes.push((await esbuild.transform('export const value: number = 1;', { loader: 'ts' })).code);
          try { await esbuild.transform('const = invalid;', { loader: 'ts' }); } catch (error) { output.errors.push(error.message); }
        } else if (mode === 'negative') {
          // Negative adapter controls use an unpatched real compiler and
          // explicit synthetic observation messages, never positive pipe proof.
          await esbuild.transform('export const warm: number = 0;', { loader: 'ts' });
          const realChild = child, service = {};
          for (const control of ['unpatched', 'duplicate-request', 'missing-reply', 'closed', 'foreign-id', 'unavailable-image', 'duplicate-reply', 'foreign-export']) {
            const config = {}, environment = {};
            installAppliedCompilerInputCapture(config);
            const observe = Object.getOwnPropertyDescriptor(config, Symbol.for('@papercusp/test-config.applied-compiler-observer-v1')).value;
            const functions = Object.fromEntries(['loadTsconfigJsonForFile', 'parse', 'parseExtends', 'parseFile',
              'resolveSolutionTSConfig', 'transform', 'transformWithEsbuild'].map(name => [name, name === 'transform' ? esbuild.transform : function measured() {}]));
            const settle = observe({ version: 1, environment, moduleId: join(root, control + '.ts'), code: 'export const value: number = 1;',
              options: { loader: 'ts' }, tsconfig: { status: 'not-used', inputs: [] },
              implementation: { viteVersion: '7.3.5', esbuildVersion: esbuild.version, functions,
                moduleUrl: pathToFileURL(join(entry, '../chunks/config.js')).href, esbuild } });
            let invocations = 0;
            const result = await settle.run(async () => {
              invocations++;
              const send = () => esbuild[hook]({ version: 1, channel: service, requestId: 7,
                implementation: control === 'foreign-export' ? {} : esbuild,
                child: control === 'unavailable-image' ? {} : realChild,
                register(reply) {
                  if (control === 'missing-reply') return;
                  const response = { version: 1, phase: control === 'closed' ? 'closed' : 'response', channel: service,
                    requestId: control === 'foreign-id' ? 8 : 7, implementation: esbuild, child: realChild };
                  reply(response); if (control === 'duplicate-reply') reply(response);
                } });
              if (control !== 'unpatched') send();
              if (control === 'duplicate-request') send();
              return esbuild.transform('export const value: number = 1;', { loader: 'ts' });
            });
            await settle.run(() => { throw new Error('duplicate invocation'); });
            if (invocations !== 1) throw new Error('compiler invoked more than once');
            settle({ status: 'success', result });
            output.codes.push(result.code); output.receipts.push(readAppliedCompilerInputs(environment));
          }
        } else if (mode === 'restart') {
          const bytes = readFileSync(binary);
          for (const suffix of ['', '\\nPAPERCUSP_NATIVE_USE_CONTROL\\n', '']) {
            await stop();
            writeFileSync(binary, Buffer.concat([bytes, Buffer.from(suffix)]), { mode: 0o755 });
            await esbuild.transform('export const warm: number = 0;', { loader: 'ts' });
            await compile(['input.ts']);
          }
        } else {
          await esbuild.transform('export const warm: number = 0;', { loader: 'ts' });
          if (mode === 'concurrent') {
            unrelated = createRequire(import.meta.url)(decoyEntry);
            globalThis[Symbol.for('papercusp.test.unrelated-esbuild')] = unrelated;
            const queued = [];
            // Deliberate fixture callback reversal, not production latency.
            globalThis[Symbol.for('papercusp.test.esbuild-delivery')] = (id, deliver) => {
              queued.push({ id, deliver });
              if (queued.length === 2) for (const item of [...queued].reverse()) { output.deliveries.push(item.id); item.deliver(); }
            };
            await compile(['first.ts', 'second.ts']);
          } else await compile(['first.ts', 'second.ts']);
        }
        process.stdout.write(JSON.stringify(output));
      } finally {
        spawns.unsubscribe(spawned);
        if (unrelated) await unrelated.stop();
        await stop();
      }
    `;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script,
      join(runtime.vite, 'dist/node/index.js'), join(repoRoot, 'libs/test-config/src/applied-compiler-inputs.ts'),
      runtime.root, mode, native, decoy], { encoding: 'utf8', timeout: 40_000, maxBuffer: 3 * 1024 * 1024,
      env: { ...process.env, ...(native ? { ESBUILD_BINARY_PATH: native } : {}) } })) as {
        receipts: AppliedCompilerReceipt[]; codes: string[]; deliveries: number[]; errors: string[]; snapshotsUnchanged: boolean[] };
  }

  it('native use: a prewarmed real service binds each current request without inventing a spawn', () => {
    const runtime = nativeUseRuntime('native-use-prewarm');
    const result = nativeUseRun(runtime, 'prewarm'), receipt = result.receipts[0]!;
    expect(receipt.calls).toHaveLength(2);
    const uses = receipt.calls.map(call => call.implementationInputs!.nativeUse!);
    if (process.platform !== 'linux') { expect(uses.every(use => use.status !== 'observed')).toBe(true); return; }
    expect(uses.map(use => use.status)).toEqual(['observed', 'observed']);
    expect(receipt.calls.map(call => call.implementationInputs!.nativeStatus)).toEqual(['unobserved', 'unobserved']);
    expect(uses[0]!.request!.serviceId).toBe(uses[1]!.request!.serviceId);
    expect(uses[0]!.request!.requestId).not.toBe(uses[1]!.request!.requestId);
    for (const [index, use] of uses.entries()) expect(use.request!.image.origin).toEqual({
      captureId: receipt.captureId, sequence: index + 1, moduleId: receipt.calls[index]!.moduleId });
    expect(parseAppliedCompilerReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    expect(result.snapshotsUnchanged).toEqual([true]);
    expect(receipt.populationStatus).toBe('unknown');
    expect(receipt.missing).toContain('cached-module-test-custody-unobserved');
  }, 60_000);

  it('native use: concurrent real replies keep request custody under fixture reversal and an unrelated service', () => {
    const runtime = nativeUseRuntime('native-use-concurrent'), decoy = nativeUseRuntime('native-use-decoy');
    const main = join(runtime.esbuild, 'lib/main.js');
    let source = readFileSync(main, 'utf8');
    const original = '      if (packet.value.error) callback(packet.value.error, {}, true);\n      else callback(null, packet.value, true);';
    expect(source.split(original)).toHaveLength(2);
    source = source.replace(original, `      const deliver = () => { ${original} };
      const delayed = globalThis[Symbol.for('papercusp.test.esbuild-delivery')];
      if (typeof delayed === 'function') delayed(packet.id, deliver); else deliver();`);
    source += `\nconst pcOriginalNativeUseTransform = transform;
      transform = (input, options) => {
        const unrelated = globalThis[Symbol.for('papercusp.test.unrelated-esbuild')];
        if (unrelated) {
          const hook = Symbol.for('@papercusp/test-config.esbuild-native-use-observer-v1');
          if (!Object.hasOwn(unrelated, hook)) Object.defineProperty(unrelated, hook, { value: module.exports[hook] });
          unrelated.transform('export const decoy: number = 2;', { loader: 'ts' }).catch(() => {});
        }
        return pcOriginalNativeUseTransform(input, options);
      };\n`;
    writeFileSync(main, source);
    const result = nativeUseRun(runtime, 'concurrent', '', join(decoy.esbuild, 'lib/main.js'));
    const receipt = result.receipts[0]!, uses = receipt.calls.map(call => call.implementationInputs!.nativeUse!);
    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries[0]).toBeGreaterThan(result.deliveries[1]!);
    expect(uses).toHaveLength(2);
    if (process.platform === 'linux') {
      expect(uses.map(use => use.status)).toEqual(['observed', 'observed']);
      expect(new Set(uses.map(use => use.request!.image.process.pid)).size).toBe(1);
      expect(new Set(uses.map(use => use.request!.requestId)).size).toBe(2);
      for (const [index, use] of uses.entries()) expect(use.request!.image.origin).toEqual({
        captureId: receipt.captureId, sequence: index + 1, moduleId: receipt.calls[index]!.moduleId });
    }
    expect(parseAppliedCompilerReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  }, 60_000);

  it('native use: real A/B/A service stop and restart rotates image inputs while custody remains separate', () => {
    const runtime = nativeUseRuntime('native-use-restart');
    if (process.platform !== 'linux') { expect(nativeUseRun(runtime, 'prewarm').receipts[0]!.calls[0]!.implementationInputs!.nativeUse!.status).not.toBe('observed'); return; }
    const seed = nativeUseRun(runtime, 'prewarm').receipts[0]!.calls[0]!.implementationInputs!.nativeUse!.request!;
    const bytes = readFileSync(seed.image.path), binary = join(runtime.root, 'esbuild-native-use-control');
    writeFileSync(binary, bytes, { mode: 0o755 });
    const result = nativeUseRun(runtime, 'restart', binary), calls = result.receipts.map(receipt => receipt.calls[0]!);
    const uses = calls.map(call => call.implementationInputs!.nativeUse!.request!);
    expect(uses.map(use => use.image.sha256)).toEqual([hash(bytes), hash(Buffer.concat([bytes, Buffer.from('\nPAPERCUSP_NATIVE_USE_CONTROL\n')])), hash(bytes)]);
    expect(new Set(uses.map(use => use.serviceId)).size).toBe(3);
    expect(calls[0]!.inputSha256).not.toBe(calls[1]!.inputSha256);
    expect(calls[0]!.inputSha256).toBe(calls[2]!.inputSha256);
    expect(new Set(result.codes).size).toBe(1);
    expect(result.snapshotsUnchanged).toEqual([true, true, true]);
    expect(calls.every(call => call.implementationInputs!.nativeStatus === 'unobserved')).toBe(true);
    for (const receipt of result.receipts) {
      expect(parseAppliedCompilerReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
      expect(receipt.missing).toContain('transitive-compiler-implementation-unobserved');
    }
  }, 90_000);

  it('native use: unsupported, missing, duplicate and foreign observations fail closed without changing compilation', () => {
    const runtime = nativeUseRuntime('native-use-negative', false), result = nativeUseRun(runtime, 'negative');
    expect(result.receipts.map(receipt => receipt.calls[0]!.implementationInputs!.nativeUse!.status)).toEqual([
      'unobserved', 'ambiguous', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'ambiguous', 'unobserved']);
    expect(result.receipts.every(receipt => receipt.calls[0]!.implementationInputs!.nativeUse!.request === null)).toBe(true);
    expect(new Set(result.codes).size).toBe(1);
    for (const receipt of result.receipts) expect(parseAppliedCompilerReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    const throwing = nativeUseRun(nativeUseRuntime('native-use-throwing'), 'throwing');
    expect(throwing.codes).toHaveLength(1);
    expect(throwing.errors[0]).toContain('Transform failed');
    const legacyConfig = {}, legacyEnvironment = {};
    installAppliedCompilerInputCapture(legacyConfig);
    const legacyObserve = Object.getOwnPropertyDescriptor(legacyConfig,
      Symbol.for('@papercusp/test-config.applied-compiler-observer-v1'))!.value;
    const legacyFunctions = Object.fromEntries(['loadTsconfigJsonForFile', 'parse', 'parseExtends', 'parseFile',
      'resolveSolutionTSConfig', 'transform', 'transformWithEsbuild'].map(name => [name, function legacyFunction() {}]));
    const legacySettle = legacyObserve({ version: 1, environment: legacyEnvironment,
      moduleId: '/repo/legacy-native-use.ts', code: 'legacy', options: {}, tsconfig: { status: 'not-used', inputs: [] },
      implementation: { viteVersion: 'legacy', esbuildVersion: 'legacy', functions: legacyFunctions } });
    legacySettle({ status: 'success', result: { code: 'legacy' } });
    const legacy = readAppliedCompilerInputs(legacyEnvironment)!;
    expect(legacy.calls[0]!.implementationInputs).toBeUndefined();
    expect(parseAppliedCompilerReceipt(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
    const receipt = nativeUseRun(nativeUseRuntime('native-use-origin'), 'prewarm').receipts[0]!;
    if (process.platform === 'linux') {
      for (const origin of [{ captureId: randomUUID() }, { sequence: 2 }, { moduleId: join(runtime.root, 'foreign.ts') }]) {
        const changed = JSON.parse(JSON.stringify(receipt)) as AppliedCompilerReceipt;
        Object.assign(changed.calls[0]!.implementationInputs!.nativeUse!.request!.image.origin, origin);
        expect(parseAppliedCompilerReceipt(changed)).toBeUndefined();
      }
      const changed = JSON.parse(JSON.stringify(receipt)) as AppliedCompilerReceipt;
      (changed.calls[0]!.implementationInputs!.nativeUse! as { status: string }).status = 'unavailable';
      expect(parseAppliedCompilerReceipt(changed)).toBeUndefined();
      for (const malformed of [{ schemaVersion: 'complete' }, { status: 'complete' }, { request: { requestId: -1 } }]) {
        const bad = JSON.parse(JSON.stringify(receipt)) as AppliedCompilerReceipt;
        Object.assign(bad.calls[0]!.implementationInputs!.nativeUse!, malformed);
        expect(parseAppliedCompilerReceipt(bad)).toBeUndefined();
      }
    }
  }, 90_000);

  it('implementation inputs: loaded transitive JS mutation rotates identity at equal versions and function text, not later disk bytes', () => {
    const runtime = implementationRuntime('implementation-js');
    const main = join(runtime.esbuild, 'lib/main.js');
    writeFileSync(main, readFileSync(main, 'utf8') + `
      const pcImplementationControl = require('./pc-implementation-control.js');
      const pcOriginalTransform = transform;
      transform = (input, options) => pcOriginalTransform(input + '\\nexport const implementationControl = ' + pcImplementationControl.value + ';', options);
    `);
    const helper = (value: number) => 'module.exports = { value: ' + value + ' };';
    const runs: ReturnType<typeof implementationRun>[] = [];
    for (const value of [1, 2, 1, 1]) {
      writeFileSync(runtime.helper, helper(value));
      runs.push(implementationRun(runtime, runs.length === 3));
    }
    const calls = runs.map(run => run.receipt.calls[0]!);
    expect(calls[0]!.implementation).toEqual(calls[1]!.implementation);
    expect(calls.map(call => call.codeSha256)).toEqual(Array(4).fill(calls[0]!.codeSha256));
    expect(calls.map(call => call.optionsSha256)).toEqual(Array(4).fill(calls[0]!.optionsSha256));
    const sources = calls.map(call => call.implementationInputs!.javascript);
    expect(sources[0]!.find(source => source.path === main)).toEqual(sources[1]!.find(source => source.path === main));
    expect(sources.map(rows => rows.find(source => source.path === runtime.helper)?.sha256))
      .toEqual([hash(helper(1)), hash(helper(2)), hash(helper(1)), hash(helper(1))]);
    expect(calls[0]!.inputSha256).not.toBe(calls[1]!.inputSha256);
    expect(calls[0]!.inputSha256).toBe(calls[2]!.inputSha256);
    expect(calls[0]!.inputSha256).toBe(calls[3]!.inputSha256);
    expect(runs[0]!.code).not.toBe(runs[1]!.code);
    expect(runs[0]!.code).toBe(runs[2]!.code);
    expect(runs[0]!.code).toBe(runs[3]!.code);
    expect(readFileSync(runtime.helper, 'utf8')).toBe(helper(999));
    for (const run of runs) {
      expect(run.originalUnchanged).toBe(true);
      expect(run.receipt.calls[0]!.implementationInputs).toMatchObject({ status: 'partial', javascriptStatus: 'captured' });
      expect(run.warm.calls[0]).toEqual(run.receipt.calls[0]);
      expect(run.receipt.missing).toContain('transitive-compiler-implementation-unobserved');
      expect(parseAppliedCompilerReceipt(JSON.parse(JSON.stringify(run.receipt)))).toEqual(run.receipt);
    }
    const receipt = runs[0]!.receipt, call = receipt.calls[0]!, inputs = call.implementationInputs!;
    for (const changed of [{ ...inputs, status: 'complete' }, { ...inputs, javascriptStatus: 'guessed' },
      { ...inputs, javascript: [...inputs.javascript].reverse() }, { ...inputs, nativeStatus: 'guessed' },
      { ...inputs, javascript: inputs.javascript.map((source, i) => i ? source : { ...source, sha256: 'a'.repeat(64) }) }])
      expect(parseAppliedCompilerReceipt({ ...receipt, calls: [{ ...call, implementationInputs: changed }] })).toBeUndefined();
    expect(parseAppliedCompilerReceipt({ ...receipt, missing: receipt.missing.filter(gap => gap !== 'transitive-compiler-implementation-unobserved') })).toBeUndefined();
  }, 120_000);

  it('implementation inputs: native image mutation and equivalent repeat bind to actual spawned service, retaining original warm custody', () => {
    const runtime = implementationRuntime('implementation-native');
    writeFileSync(runtime.helper, 'module.exports = {};');
    const initial = implementationRun(runtime);
    const first = initial.receipt.calls[0]!.implementationInputs!;
    if (process.platform !== 'linux') {
      expect(first.nativeStatus).not.toBe('observed');
      expect(first.native).toBeNull();
      return;
    }
    expect(first.nativeStatus).toBe('observed');
    const binary = join(runtime.root, 'esbuild-native-control'), bytes = readFileSync(first.native!.path);
    const runs: ReturnType<typeof implementationRun>[] = [];
    for (const suffix of ['', '\nPAPERCUSP_NATIVE_IDENTITY_CONTROL\n', '']) {
      // ELF permits a trailing section; compilation stays equivalent while the
      // executing image changes. This touches only a disposable fixture copy.
      writeFileSync(binary, Buffer.concat([bytes, Buffer.from(suffix)]), { mode: 0o755 });
      runs.push(implementationRun(runtime, false, binary));
    }
    const calls = runs.map(run => run.receipt.calls[0]!);
    expect(calls[0]!.implementation).toEqual(calls[1]!.implementation);
    expect(calls[0]!.implementationInputs!.javascript).toEqual(calls[1]!.implementationInputs!.javascript);
    expect(calls.map(call => call.implementationInputs!.native!.sha256))
      .toEqual([hash(bytes), hash(Buffer.concat([bytes, Buffer.from('\nPAPERCUSP_NATIVE_IDENTITY_CONTROL\n')])), hash(bytes)]);
    expect(calls[0]!.inputSha256).not.toBe(calls[1]!.inputSha256);
    expect(calls[0]!.inputSha256).toBe(calls[2]!.inputSha256);
    expect(new Set(runs.map(run => run.code)).size).toBe(1);
    for (const run of runs) {
      const native = run.receipt.calls[0]!.implementationInputs!.native!;
      expect(native.path).toBe(binary);
      expect(native.process.pid).not.toBe(process.pid);
      expect(native.origin).toEqual({ captureId: run.receipt.captureId, sequence: 1, moduleId: join(runtime.root, 'input.ts') });
      expect(run.warm.calls[1]!.implementationInputs!.native).toEqual(native);
      expect(run.warm.calls[0]).toEqual(run.receipt.calls[0]);
      expect(run.receipt.missing).toContain('transitive-compiler-implementation-unobserved');
    }
  }, 120_000);

  it('execution-details JSON: real compiler implementation inputs retain unknown scope and reject tampering or foreign worker custody', () => {
    const runtime = implementationRuntime('implementation-execution-details');
    const { receipt } = implementationRun(runtime);
    const implementationInputs = receipt.calls[0]!.implementationInputs!;
    expect(implementationInputs).toMatchObject({ status: 'partial', javascriptStatus: 'captured' });
    expect(implementationInputs.javascript.length).toBeGreaterThan(0);
    expect(receipt.missing).toContain('transitive-compiler-implementation-unobserved');

    // The envelope is a contract fixture; only the nested compiler receipt is
    // produced by the real isolated compiler. It grants no VM/test-use custody.
    const captureId = randomUUID(), testFile = join(runtime.root, 'execution-record.test.ts');
    const processIdentity = captureCurrentWorkerProcessIdentity();
    const row: TestRunExecutionDetails = {
      schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
      root: runtime.root, filePath: 'execution-record.test.ts', runGroupId: null,
      workspaceId: null, harnessSlug: 'papercusp', testNamePattern: null,
      passed: 1, failed: 0, skipped: 0, collectionFailed: false,
      mutationPhase: null, commitSha: null, worktreeDirty: false,
      workerExecution: { schemaVersion: 'worker-execution-v1', captureId, testFile,
        before: processIdentity, after: processIdentity },
      workerCompilerInputs: { schemaVersion: 'worker-compiler-inputs-v1',
        scope: 'vitest-inlined-vm-calls', populationStatus: 'unknown', captureId, testFile,
        inputSha256: null, vmCallCount: 0,
        missing: ['transform-pipeline-unobserved', 'vm-options-partially-observed', 'vm-calls-unobserved'],
        appliedCompilerInputs: receipt },
    };
    row.proofContext = captureRecordedProofContext(row);
    const json = JSON.stringify(row), parsed = parseTestRunExecutionDetails(json);
    expect(parsed).toBeDefined();
    expect(parsed!.workerCompilerInputs).toEqual(row.workerCompilerInputs);
    expect(parsed!.workerCompilerInputs!.appliedCompilerInputs!.calls[0]!.implementationInputs)
      .toEqual(implementationInputs);
    expect(parsed!.proofContext!.components.compilerConfiguration).toBeNull();
    expect(parsed!.workerCompilerInputs!.populationStatus).toBe('unknown');
    expect(parsed!.workerCompilerInputs!.appliedCompilerInputs!.missing).toEqual(receipt.missing);

    const decode = () => JSON.parse(json) as TestRunExecutionDetails;
    const altered = decode();
    const alteredReceipt = altered.workerCompilerInputs!.appliedCompilerInputs!;
    alteredReceipt.calls = alteredReceipt.calls.map((call, index) => index ? call : { ...call,
      implementationInputs: { ...call.implementationInputs!,
        javascript: call.implementationInputs!.javascript.map((source, sourceIndex) => sourceIndex ? source
          : { ...source, sha256: hash('tampered compiler implementation') }) } });
    expect(parseTestRunExecutionDetails(JSON.stringify(altered))).toBeUndefined();
    const omittedGap = decode();
    omittedGap.workerCompilerInputs!.appliedCompilerInputs!.missing = receipt.missing
      .filter(reason => reason !== 'transitive-compiler-implementation-unobserved');
    expect(parseTestRunExecutionDetails(JSON.stringify(omittedGap))).toBeUndefined();
    for (const patch of [{ captureId: randomUUID() }, { testFile: join(runtime.root, 'other.test.ts') }]) {
      const foreign = decode();
      Object.assign(foreign.workerCompilerInputs!, patch);
      expect(parseTestRunExecutionDetails(JSON.stringify(foreign))).toBeUndefined();
    }
    const missingWorker = decode();
    delete missingWorker.workerExecution;
    expect(parseTestRunExecutionDetails(JSON.stringify(missingWorker))).toBeUndefined();
    const foreignWorker = decode();
    foreignWorker.workerExecution!.captureId = randomUUID();
    expect(parseTestRunExecutionDetails(JSON.stringify(foreignWorker))).toBeUndefined();
    const foreignFile = decode();
    foreignFile.filePath = 'other.test.ts';
    expect(parseTestRunExecutionDetails(JSON.stringify(foreignFile))).toBeUndefined();
  }, 60_000);

  it('execution-details JSON: real native-use receipts preserve matching origins and reject foreign origins', () => {
    const runtime = nativeUseRuntime('native-use-execution-details');
    const { receipts } = nativeUseRun(runtime, 'prewarm'), receipt = receipts[0]!;
    expect(receipt.calls).toHaveLength(2);
    const uses = receipt.calls.map(call => call.implementationInputs!.nativeUse!);
    expect(uses.every(use => use !== undefined)).toBe(true);
    if (process.platform === 'linux') {
      expect(uses.map(use => use.status)).toEqual(['observed', 'observed']);
      expect(uses[0]!.request!.serviceId).toBe(uses[1]!.request!.serviceId);
      expect(uses[0]!.request!.requestId).not.toBe(uses[1]!.request!.requestId);
    } else expect(uses.every(use => use.status !== 'observed')).toBe(true);

    // Only the nested receipt is observed compiler evidence. Persisting this
    // outer contract fixture establishes no VM/test-use or population custody.
    const captureId = randomUUID(), testFile = join(runtime.root, 'native-use-record.test.ts');
    const processIdentity = captureCurrentWorkerProcessIdentity();
    const row: TestRunExecutionDetails = {
      schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
      root: runtime.root, filePath: 'native-use-record.test.ts', runGroupId: null,
      workspaceId: null, harnessSlug: 'papercusp', testNamePattern: null,
      passed: 1, failed: 0, skipped: 0, collectionFailed: false,
      mutationPhase: null, commitSha: null, worktreeDirty: false,
      workerExecution: { schemaVersion: 'worker-execution-v1', captureId, testFile,
        before: processIdentity, after: processIdentity },
      workerCompilerInputs: { schemaVersion: 'worker-compiler-inputs-v1',
        scope: 'vitest-inlined-vm-calls', populationStatus: 'unknown', captureId, testFile,
        inputSha256: null, vmCallCount: 0,
        missing: ['transform-pipeline-unobserved', 'vm-options-partially-observed', 'vm-calls-unobserved'],
        appliedCompilerInputs: receipt },
    };
    row.proofContext = captureRecordedProofContext(row);
    const path = join(runtime.root, 'execution-details.json');
    writeFileSync(path, JSON.stringify(row));
    const json = readFileSync(path, 'utf8'), parsed = parseTestRunExecutionDetails(json);
    expect(parsed).toBeDefined();
    expect(parsed!.workerCompilerInputs).toEqual(row.workerCompilerInputs);
    expect(parsed!.workerCompilerInputs!.appliedCompilerInputs!.calls
      .map(call => call.implementationInputs!.nativeUse)).toEqual(uses);
    expect(parsed!.proofContext!.components.compilerConfiguration).toBeNull();
    expect(parsed!.workerCompilerInputs!.populationStatus).toBe('unknown');
    expect(parsed!.workerCompilerInputs!.appliedCompilerInputs!.populationStatus).toBe('unknown');
    expect(parsed!.workerCompilerInputs!.appliedCompilerInputs!.missing).toEqual(receipt.missing);
    expect(receipt.missing).toContain('transitive-compiler-implementation-unobserved');
    if (process.platform !== 'linux') return;

    for (const [index, call] of receipt.calls.entries()) {
      expect(uses[index]!.request!.image.origin).toEqual({
        captureId: receipt.captureId, sequence: call.sequence, moduleId: call.moduleId });
      for (const patch of [{ captureId: randomUUID() }, { sequence: call.sequence + 1 },
        { moduleId: join(runtime.root, 'foreign.ts') }]) {
        const foreign = JSON.parse(json) as TestRunExecutionDetails;
        const foreignReceipt = foreign.workerCompilerInputs!.appliedCompilerInputs!;
        Object.assign(foreignReceipt.calls[index]!.implementationInputs!.nativeUse!.request!.image.origin, patch);
        // Origin custody is checked independently of the semantic input hash.
        expect(foreignReceipt.calls[index]!.inputSha256).toBe(call.inputSha256);
        expect(parseAppliedCompilerReceipt(foreignReceipt)).toBeUndefined();
        expect(parseTestRunExecutionDetails(JSON.stringify(foreign))).toBeUndefined();
      }
    }
  }, 60_000);

  it('implementation inputs: unavailable loaded source fails closed without changing the compiler result or invoking twice', async () => {
    const config = {}, environment = {};
    installAppliedCompilerInputCapture(config);
    const observe = Object.getOwnPropertyDescriptor(config, Symbol.for('@papercusp/test-config.applied-compiler-observer-v1'))!.value;
    const functions = Object.fromEntries(['loadTsconfigJsonForFile', 'parse', 'parseExtends', 'parseFile',
      'resolveSolutionTSConfig', 'transform', 'transformWithEsbuild'].map(name => [name, function measuredFunction() {}]));
    const settle = observe({ version: 1, environment, moduleId: '/repo/input.ts', code: 'source', options: { loader: 'ts' },
      tsconfig: { status: 'not-used', inputs: [] }, implementation: { viteVersion: 'test', esbuildVersion: 'test', functions } });
    const before = readAppliedCompilerInputs(environment)!;
    let calls = 0;
    const result = { code: 'unchanged compiler result' };
    expect(await settle.run(async () => { calls++; return result; })).toBe(result);
    expect(await settle.run(async () => { calls++; throw new Error('must not invoke'); })).toBe(result);
    settle({ status: 'success', result });
    const receipt = readAppliedCompilerInputs(environment)!;
    expect(calls).toBe(1);
    expect(before.calls[0]!.implementationInputs).toBeUndefined();
    expect(receipt.calls[0]!.implementationInputs).toMatchObject({ status: 'partial', javascriptStatus: 'unavailable', nativeStatus: 'unobserved', native: null });
    expect(Object.isFrozen(receipt.calls[0]!.implementationInputs!.javascript)).toBe(true);
    expect(receipt.calls[0]!.inputSha256).toBeNull();
    expect(successfulAppliedCompilerOutput(receipt, 1)).toBeUndefined();
    expect(parseAppliedCompilerReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });

  it('resolution search: original negative lookups rotate for nearer configs with fixed source', async () => {
    const root = join(fixture, 'resolution-nearer'), directory = join(root, 'sub', 'deep');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'input.ts'), near = join(root, 'sub', 'tsconfig.json');
    const source = 'export class Example { value = 1; }';
    const config = JSON.stringify({ compilerOptions: { useDefineForClassFields: true } });
    writeFileSync(file, source); writeFileSync(join(root, 'tsconfig.json'), config);
    const runs: Array<{ code: string; receipt: AppliedCompilerReceipt }> = [];
    for (const state of ['original', 'nearer-equivalent', 'nearer-changed', 'repeat']) {
      if (state === 'nearer-equivalent') writeFileSync(near, config);
      if (state === 'nearer-changed') writeFileSync(near, JSON.stringify({ compilerOptions: { useDefineForClassFields: false } }));
      const server = await serverFor(root);
      try {
        const environment = server.environments.ssr!;
        const result = await environment.transformRequest(file);
        runs.push({ code: result!.code, receipt: readAppliedCompilerInputs(environment)! });
      } finally { await server.close(); }
    }
    const calls = runs.map(run => run.receipt.calls[0]!);
    expect(new Set(calls.map(call => call.codeSha256))).toEqual(new Set([hash(source)]));
    expect(calls[0]!.tsconfigSearch!.lookups).toEqual([
      { path: join(directory, 'tsconfig.json'), outcome: 'missing', errorCode: 'ENOENT' },
      { path: near, outcome: 'missing', errorCode: 'ENOENT' },
      { path: join(root, 'tsconfig.json'), outcome: 'file', errorCode: null },
    ]);
    expect(calls[1]!.tsconfigSearch!.lookups).toEqual([
      { path: join(directory, 'tsconfig.json'), outcome: 'missing', errorCode: 'ENOENT' },
      { path: near, outcome: 'file', errorCode: null },
    ]);
    expect(calls[0]!.optionsSha256).toBe(calls[1]!.optionsSha256);
    expect(calls[0]!.inputSha256).not.toBe(calls[1]!.inputSha256);
    expect(runs[0]!.code).toBe(runs[1]!.code);
    expect(calls[1]!.inputSha256).not.toBe(calls[2]!.inputSha256);
    expect(runs[1]!.code).not.toBe(runs[2]!.code);
    expect(calls[2]!.inputSha256).toBe(calls[3]!.inputSha256);
    for (const run of runs) {
      expect(run.receipt.missing).toContain('tsconfig-resolution-search-unobserved');
      expect(run.receipt.populationStatus).toBe('unknown');
      expect(parseAppliedCompilerReceipt(JSON.parse(JSON.stringify(run.receipt)))).toEqual(run.receipt);
    }
    expect(Object.isFrozen(calls[0]!.tsconfigSearch!.lookups[0])).toBe(true);
  }, 30_000);

  it('resolution search: captures actual extends fallback failures and changed resolved targets', async () => {
    const root = join(fixture, 'resolution-extends'), pkg = join(root, 'node_modules', 'pc-config-search-control');
    mkdirSync(pkg, { recursive: true });
    const file = join(root, 'input.ts'), configFile = join(root, 'tsconfig.json');
    const source = 'export class Example { value = 1; }';
    const base = JSON.stringify({ compilerOptions: { useDefineForClassFields: true } });
    writeFileSync(file, source);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'pc-config-search-control', version: '1.0.0' }));
    writeFileSync(join(pkg, 'tsconfig.json'), base); writeFileSync(join(root, 'alternate.json'), base);
    const receipts: AppliedCompilerReceipt[] = [];
    for (const extended of ['pc-config-search-control', './alternate.json']) {
      writeFileSync(configFile, JSON.stringify({ extends: extended }));
      const server = await serverFor(root);
      try {
        await server.environments.ssr!.transformRequest(file);
        receipts.push(readAppliedCompilerInputs(server.environments.ssr)!);
      } finally { await server.close(); }
    }
    expect(receipts[0]!.calls[0]!.tsconfigSearch!.extends).toEqual([
      { from: configFile, request: 'pc-config-search-control', resolved: null, errorCode: 'MODULE_NOT_FOUND' },
      { from: configFile, request: 'pc-config-search-control/tsconfig.json', resolved: join(pkg, 'tsconfig.json'), errorCode: null },
    ]);
    expect(receipts[1]!.calls[0]!.tsconfigSearch!.extends).toEqual([
      { from: configFile, request: './alternate.json', resolved: join(root, 'alternate.json'), errorCode: null },
    ]);
    expect(receipts[0]!.calls[0]!.codeSha256).toBe(receipts[1]!.calls[0]!.codeSha256);
    expect(receipts[0]!.calls[0]!.optionsSha256).toBe(receipts[1]!.calls[0]!.optionsSha256);
    expect(receipts[0]!.calls[0]!.inputSha256).not.toBe(receipts[1]!.calls[0]!.inputSha256);
    expect(receipts.every(receipt => receipt.missing.includes('tsconfig-resolution-search-unobserved'))).toBe(true);
  }, 30_000);

  it('resolution search: cache observations retain original custody and reject forged search completeness', async () => {
    const root = join(fixture, 'resolution-cache'), directory = join(root, 'sub');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'input.ts'), sibling = join(directory, 'sibling.ts');
    const config = JSON.stringify({ compilerOptions: { useDefineForClassFields: true } });
    writeFileSync(file, 'export const value: number = 1;');
    writeFileSync(sibling, 'export const value: number = 1;');
    writeFileSync(join(root, 'tsconfig.json'), config);
    const server = await serverFor(root);
    try {
      const environment = server.environments.ssr!;
      await environment.transformRequest(file);
      const original = readAppliedCompilerInputs(environment)!;
      const serialized = JSON.stringify(original);
      writeFileSync(join(directory, 'tsconfig.json'), config);
      await environment.transformRequest(sibling);
      const after = readAppliedCompilerInputs(environment)!;
      expect(JSON.stringify(original)).toBe(serialized);
      expect(after.calls[0]).toEqual(original.calls[0]);
      expect(after.calls[1]!.tsconfigSearch!.cacheHits.length).toBeGreaterThan(0);
      expect(after.calls[1]!.tsconfigSearch!.lookups).toEqual([]);
      expect(after.calls[1]!.tsconfigInputs).toEqual(original.calls[0]!.tsconfigInputs);
      expect(after.missing).toContain('tsconfig-resolution-search-unobserved');
      const call = original.calls[0]!, search = call.tsconfigSearch!;
      for (const changed of [{ ...search, status: 'complete' }, { ...search, truncated: true },
        { ...search, lookups: [] }, { ...search, cacheHits: [{ kind: 'guess', path: file }] },
        { ...search, lookups: [{ path: file, outcome: 'missing', errorCode: null }] },
        { ...search, extends: [{ from: file, request: './x', resolved: file, errorCode: 'ENOENT' }] }])
        expect(parseAppliedCompilerReceipt({ ...original, calls: [{ ...call, tsconfigSearch: changed }] })).toBeUndefined();
      expect(parseAppliedCompilerReceipt({ ...original, missing: original.missing.filter(gap => gap !== 'tsconfig-resolution-search-unobserved') })).toBeUndefined();
    } finally { await server.close(); }
  }, 30_000);
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
