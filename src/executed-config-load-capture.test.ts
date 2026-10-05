import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configBundleSources, qualifyLoadedConfigSources, qualifyLoadedMainProcessSources } from './executed-config-load-capture.ts';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const prefix = (path: string): string => `const __vite_injected_original_dirname = ${JSON.stringify(dirname(path))};` +
  `const __vite_injected_original_filename = ${JSON.stringify(path)};` +
  `const __vite_injected_original_import_meta_url = ${JSON.stringify(pathToFileURL(path).href)};`;
const bundle = (map: unknown): string => '// loaded code\n//# sourceMappingURL=data:application/json;base64,' +
  Buffer.from(JSON.stringify(map)).toString('base64');

describe('original config load evidence', () => {
  it.each(['stable', 'self-restoring', 'commonjs'] as const)
    ('retains original inputs from a real parent and child command at exit (%s)', kind => {
      const root = mkdtempSync(join(tmpdir(), 'command-original-load-'));
      const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
      const outPath = join(root, 'out.json');
      const extension = kind === 'commonjs' ? 'cjs' : 'mjs';
      const stable = kind === 'commonjs' ? 'exports.value = 1;\n' : 'export const value = 1;\n';
      const helper = join(root, `helper.${extension}`);
      const loaded = kind === 'self-restoring' ? `import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(helper)}, ${JSON.stringify(stable)});
        export const value = 2;\n` : stable;
      try {
        writeFileSync(helper, loaded);
        writeFileSync(join(root, 'child.mjs'), `import { value } from './helper.${extension}';
          console.log(value);\n`);
        writeFileSync(join(root, 'parent.mjs'), `import { spawnSync } from 'node:child_process';
          const child = spawnSync(process.execPath, ['child.mjs'], { stdio: 'inherit', env: process.env });
          process.exit(child.status ?? 1);\n`);
        const env = { ...process.env };
        for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL/.test(key) ||
            key === 'NODE_OPTIONS') delete env[key];
        execFileSync(process.execPath, ['parent.mjs'], { cwd: root, encoding: 'utf8', timeout: 30000,
          env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'command-load-test',
            PC_EXECUTED_SOURCE_MAP_OUT: outPath, PC_EXECUTED_SOURCE_MAP_ROOT: root,
            PC_EXECUTED_SOURCE_MAP_PRELOAD: '1', NODE_OPTIONS: `--import=${pathToFileURL(capture).href}` },
        });
        expect(existsSync(`${outPath}.processes`)).toBe(true);
        const receipts = readdirSync(`${outPath}.processes`).map(file =>
          JSON.parse(readFileSync(join(`${outPath}.processes`, file), 'utf8')));
        expect(receipts.map(receipt => receipt.entrypoint).sort()).toEqual(['child.mjs', 'parent.mjs']);
        const child = receipts.find(receipt => receipt.entrypoint === 'child.mjs');
        expect(child).toMatchObject({ schemaVersion: 'node-loaded-process-sources-v1',
          scope: 'repository-node-process-sources', basis: 'node-load-hook',
          sources: expect.arrayContaining([{ path: `helper.${extension}`,
            sha256: kind === 'commonjs' ? null : digest(loaded), currentSha256: digest(stable) }]),
          unresolved: expect.arrayContaining(['node-process-descendant-population-unmeasured', 'node-preload-self-unmeasured']),
        });
        expect(child.status).toBe(kind === 'stable' ? 'stable' : kind === 'self-restoring' ? 'changed' : 'unknown');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

  it('keeps a missing preload unknown instead of reading the original from disk', () => {
    expect(qualifyLoadedConfigSources(['/repo/config.mjs'], '/repo')).toMatchObject({
      status: 'unknown', sources: [{ path: 'config.mjs', sha256: null, currentSha256: null }],
      reasons: expect.arrayContaining(['config-node-load-capture-unavailable', 'config-original-load-unavailable:config.mjs']),
    });
    expect(qualifyLoadedMainProcessSources(['/repo/config.mjs'], '/repo')).toMatchObject({
      status: 'unknown', sources: [], reasons: expect.arrayContaining(['main-process-node-load-capture-unavailable']),
    });
  });

  it.each(['stable', 'self-restoring', 'commonjs', 'outside', 'reloaded'] as const)
    ('retains actual native main-process inputs separately from config inputs (%s)', kind => {
      const base = mkdtempSync(join(tmpdir(), 'main-original-load-'));
      const root = join(base, 'repo');
      mkdirSync(root);
      const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
      const config = join(root, 'config.mjs');
      const helper = join(kind === 'outside' ? base : root, kind === 'commonjs' ? 'helper.cjs' : 'helper.mjs');
      const stable = kind === 'commonjs' ? 'exports.value = 1;\n' : 'export const value = 1;\n';
      const loaded = kind === 'self-restoring' ? `import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(helper)}, ${JSON.stringify(stable)});
        export const value = 2;\n` : stable;
      try {
        writeFileSync(config, 'export default {};\n');
        writeFileSync(helper, loaded);
        const script = `import { writeFileSync } from 'node:fs';
          await import(${JSON.stringify(pathToFileURL(config).href)});
          await import(${JSON.stringify(pathToFileURL(helper).href)});
          ${kind === 'reloaded' ? `writeFileSync(${JSON.stringify(helper)}, 'export const value = 3;');
            await import(${JSON.stringify(pathToFileURL(helper).href + '?second')});` : ''}
          const { qualifyLoadedMainProcessSources } = await import(${JSON.stringify(pathToFileURL(capture).href)});
          console.log(JSON.stringify(qualifyLoadedMainProcessSources([${JSON.stringify(config)}], ${JSON.stringify(root)})));`;
        const out = execFileSync(process.execPath, ['--import', capture, '--input-type=module', '--eval', script], {
          encoding: 'utf8', timeout: 30000, cwd: root,
          env: { ...process.env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'main-load-test', PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'out.json'),
            PC_EXECUTED_SOURCE_MAP_PRELOAD: '1' },
        });
        const evidence = JSON.parse(out.trim());
        expect(evidence).toMatchObject({ basis: 'node-load-hook', scope: 'repository-node-main-process-sources' });
        expect(evidence.sources.map((source: { path: string }) => source.path)).not.toContain('config.mjs');
        if (kind === 'stable') expect(evidence).toMatchObject({ status: 'stable', reasons: [],
          sources: [{ path: 'helper.mjs', sha256: digest(loaded), currentSha256: digest(stable) }] });
        else if (kind === 'self-restoring') expect(evidence).toMatchObject({ status: 'changed',
          sources: [{ path: 'helper.mjs', sha256: digest(loaded), currentSha256: digest(stable) }] });
        else {
          expect(evidence.status).toBe('unknown');
          if (kind === 'outside') expect(evidence.sources).toEqual([]);
          else expect(evidence.sources[0].sha256).toBeNull();
        }
      } finally { rmSync(base, { recursive: true, force: true }); }
    });

  it.each(['plain', 'shebang'] as const)('uses only embedded originals with exact Vite scope injection (%s)', (mode) => {
    const path = '/repo/config.mjs';
    const original = (mode === 'shebang' ? '#!/usr/bin/env node\n' : '') + 'export default {};\n';
    const at = mode === 'shebang' ? original.indexOf('\n') + 1 : 0;
    expect(configBundleSources(bundle({ sourceRoot: 'file:///repo/', sources: ['config.mjs'],
      sourcesContent: [original.slice(0, at) + prefix(path) + original.slice(at)] })))
      .toEqual([{ path, sha256: digest(original) }]);
  });

  it('keeps null and unsupported compiler input forms unknown', () => {
    expect(configBundleSources(bundle({ sourceRoot: 'file:///repo/', sources: ['config.mjs', 'helper.mjs'],
      sourcesContent: [null, prefix('/repo/helper.mjs') + 'const __vite_injected_original_import_meta_resolve = unknown;code'] })))
      .toEqual([{ path: '/repo/config.mjs', sha256: null }, { path: '/repo/helper.mjs', sha256: null }]);
    expect(configBundleSources(bundle({ sourceRoot: 'file:///repo/', sources: ['config.mjs'],
      sourcesContent: ['unrecognized injection;code'] }))).toEqual([{ path: '/repo/config.mjs', sha256: null }]);
  });

  it.each([{}, { sourceRoot: 'file:///repo/', sources: ['config.mjs'], sourcesContent: [] },
    { sourceRoot: '../relative/', sources: ['config.mjs'], sourcesContent: ['code'] }])
    ('rejects an incomplete source map %j', map => expect(configBundleSources(bundle(map))).toBeNull());

  it.each(['native', 'native-ts', 'bundle', 'runner', 'commonjs-bundle'] as const)('observes actual Vite config evaluation (%s loader)', kind => {
    const root = mkdtempSync(join(tmpdir(), 'config-original-load-'));
    const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
    const vite = import.meta.resolve('vite');
    const loader = kind === 'native-ts' ? 'native' : kind === 'commonjs-bundle' ? 'bundle' : kind;
    const cjs = kind === 'commonjs-bundle';
    const extension = kind === 'native-ts' ? 'ts' : cjs ? 'cjs' : 'mjs';
    const original = cjs ? 'exports.count = 1;\n' : `export const count${kind === 'native-ts' ? ': number' : ''} = 1;\n`;
    const restored = cjs ? 'exports.count = 2;\n' : `export const count${kind === 'native-ts' ? ': number' : ''} = 2;\n`;
    try {
      const helper = join(root, `helper.${extension}`);
      const configPath = join(root, `config.${extension}`);
      writeFileSync(helper, original);
      writeFileSync(configPath, cjs ? `const { count } = require('./helper.cjs');
        require('node:fs').writeFileSync(${JSON.stringify(helper)}, ${JSON.stringify(restored)});
        module.exports = { test: { count } };` : `import { count } from './helper.${extension}';
        import { writeFileSync } from 'node:fs';
        writeFileSync(new URL('./helper.${extension}', import.meta.url), ${JSON.stringify(restored)});
        export default { test: { count } };`);
      const script = `import { loadConfigFromFile } from ${JSON.stringify(vite)};
        const config = await loadConfigFromFile({ command: 'serve', mode: 'test' }, ${JSON.stringify(configPath)}, ${JSON.stringify(root)}, undefined, undefined, ${JSON.stringify(loader)});
        const { qualifyLoadedConfigSources } = await import(${JSON.stringify(pathToFileURL(capture).href)});
        console.log(JSON.stringify({ count: config.config.test.count,
          evidence: qualifyLoadedConfigSources([${JSON.stringify(configPath)}, ${JSON.stringify(helper)}], ${JSON.stringify(root)}) }));`;
      const out = execFileSync(process.execPath, ['--import', capture, '--input-type=module', '--eval', script], {
        encoding: 'utf8', timeout: 30000, cwd: root,
        env: { ...process.env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'load-test', PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'out.json'),
          PC_EXECUTED_SOURCE_MAP_PRELOAD: '1' },
      });
      const result = JSON.parse(out.trim());
      expect(result.count).toBe(1);
      if (loader === 'runner' || cjs) expect(result.evidence.status).toBe('unknown');
      else expect(result.evidence).toMatchObject({ basis: 'node-load-hook', status: 'changed',
        sources: expect.arrayContaining([{ path: `helper.${extension}`, sha256: digest(original), currentSha256: digest(restored) }]),
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
