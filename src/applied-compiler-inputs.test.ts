import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import { parseRecordedViteTransformOptions, readViteTransformOptions } from './configuration-snapshot.ts';
import { executedSourceOriginalsPlugin, readExecutedSourceOriginals } from './vitest-config.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** P021 counterexamples, not a complete compiler producer. Exercise Vite's
 * actual pipeline so root-option observations cannot acquire authority merely
 * because source bytes and prospective root options happen to compare equal. */
describe('applied compiler inputs remain unknown outside the root-options observation', () => {
  async function compile(root: string, file: string, plugins: Plugin[] = []) {
    const server = await createServer({ root, configFile: false,
      server: { middlewareMode: true, watch: null }, optimizeDeps: { noDiscovery: true },
      esbuild: { target: 'es2015' }, logLevel: 'silent',
      plugins: [executedSourceOriginalsPlugin(), ...plugins] });
    try {
      const environment = server.environments.ssr!;
      const result = await environment.transformRequest(file);
      expect(result).not.toBeNull();
      const observation = readViteTransformOptions(environment)!;
      expect(observation).toMatchObject({ populationStatus: 'unknown', transformCount: 1, truncated: false });
      expect(observation.optionHashes).toHaveLength(1);
      expect(observation.optionHashes[0]).toMatch(/^[a-f0-9]{64}$/);
      const original = readExecutedSourceOriginals(environment)?.find(entry => entry.id === file);
      expect(original?.sha256).toBe(sha256(readFileSync(file, 'utf8')));
      return { code: result!.code, observation, source: original!.sha256 };
    } finally { await server.close(); }
  }

  it('real inherited per-file tsconfig mutation changes compilation at identical source and root options', async () => {
    const root = mkdtempSync(join(tmpdir(), 'applied-tsconfig-'));
    const file = join(root, 'input.ts');
    const source = 'export class Example { value = 1; }\n';
    try {
      writeFileSync(file, source);
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: './compiler-base.json' }));
      const runs: Awaited<ReturnType<typeof compile>>[] = [];
      for (const useDefineForClassFields of [true, false, true]) {
        writeFileSync(join(root, 'compiler-base.json'), JSON.stringify({ compilerOptions: { useDefineForClassFields } }));
        // A fresh real server has its own Vite tsconfck cache, so this compares
        // applied configurations rather than a stale cached result.
        runs.push(await compile(root, file));
      }
      expect(readFileSync(file, 'utf8')).toBe(source);
      expect(runs.map(run => run.source)).toEqual([sha256(source), sha256(source), sha256(source)]);
      expect(runs[0]!.code).not.toBe(runs[1]!.code);
      expect(runs[0]!.code).toBe(runs[2]!.code);
      expect(runs[0]!.observation.optionHashes).toEqual(runs[1]!.observation.optionHashes);
      expect(runs[0]!.observation.optionHashes).toEqual(runs[2]!.observation.optionHashes);
      expect(runs[0]!.observation.missing).toContain('per-file-tsconfig-unobserved');
      expect(runs[0]!.observation.missing).toContain('config-to-compiler-arguments-unobserved');
      expect(parseRecordedViteTransformOptions({ ...runs[0]!.observation, populationStatus: 'complete', missing: [] }))
        .toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it('real plugin closure mutation changes compilation despite equal hook source and root options', async () => {
    const root = mkdtempSync(join(tmpdir(), 'applied-plugin-closure-'));
    const file = join(root, 'input.ts');
    const source = 'export const value = 1;\n';
    const plugin = (setting: number): Plugin => ({ name: 'private-compiler-setting',
      transform(code, id) {
        if (id === file) return { code: code + '\nexport const compilerSetting = ' + setting + ';\n', map: null };
      } });
    try {
      writeFileSync(file, source);
      const plugins = [plugin(1), plugin(2), plugin(1)];
      expect(String(plugins[0]!.transform)).toBe(String(plugins[1]!.transform));
      const runs: Awaited<ReturnType<typeof compile>>[] = [];
      for (const compilerPlugin of plugins) runs.push(await compile(root, file, [compilerPlugin]));
      expect(runs[0]!.code).toContain('compilerSetting = 1');
      expect(runs[1]!.code).toContain('compilerSetting = 2');
      expect(runs[0]!.code).not.toBe(runs[1]!.code);
      expect(runs[0]!.code).toBe(runs[2]!.code);
      expect(runs.map(run => run.source)).toEqual([sha256(source), sha256(source), sha256(source)]);
      expect(runs[0]!.observation.optionHashes).toEqual(runs[1]!.observation.optionHashes);
      expect(runs[0]!.observation.optionHashes).toEqual(runs[2]!.observation.optionHashes);
      expect(runs[0]!.observation.missing).toContain('plugin-closures-unobserved');
      expect(readFileSync(file, 'utf8')).toBe(source);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it('a real transform cache hit produces no second observation or test-custody receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'applied-compiler-cache-'));
    const file = join(root, 'input.ts');
    writeFileSync(file, 'export const value: number = 1;\n');
    const server = await createServer({ root, configFile: false,
      server: { middlewareMode: true, watch: null }, optimizeDeps: { noDiscovery: true }, logLevel: 'silent',
      plugins: [executedSourceOriginalsPlugin()] });
    try {
      const environment = server.environments.ssr!;
      const first = await environment.transformRequest(file);
      const before = readViteTransformOptions(environment)!;
      const second = await environment.transformRequest(file);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second!.code).toBe(first!.code);
      expect(before.transformCount).toBe(1);
      expect(readViteTransformOptions(environment)).toEqual(before);
      expect(before.populationStatus).toBe('unknown');
      expect(before.missing).toContain('environment-to-test-attribution-unverified');
      expect(readExecutedSourceOriginals(environment)?.filter(entry => entry.id === file)).toHaveLength(1);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
