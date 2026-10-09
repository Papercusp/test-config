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
  it('reports duplicate capture modules while sharing one hook and the loaded inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'duplicate-original-load-'));
    const capture = new URL('./executed-config-load-capture.ts', import.meta.url);
    const singleton = new URL('../../generic/module-singleton/src/index.ts', import.meta.url);
    const helper = join(root, 'helper.mjs');
    const source = 'export const value = 3;\n';
    try {
      writeFileSync(helper, source);
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL/.test(key) ||
          key === 'NODE_OPTIONS') delete env[key];
      const script = `const before = process.listenerCount('exit');
        const first = await import(${JSON.stringify(capture.href)});
        await import(${JSON.stringify(`${capture.href}?duplicate`)});
        await import(${JSON.stringify(pathToFileURL(helper).href)});
        const { moduleEvaluationCount, listModuleDuplications } = await import(${JSON.stringify(singleton.href)});
        const key = '@papercusp/test-config.original-config-loads';
        console.log(JSON.stringify({ evaluations: moduleEvaluationCount(key),
          duplicate: listModuleDuplications().find(entry => entry.key === key),
          exitListenersAdded: process.listenerCount('exit') - before,
          evidence: first.qualifyLoadedConfigSources([${JSON.stringify(helper)}], ${JSON.stringify(root)}) }));`;
      const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'duplicate-load-test',
          PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'out.json'), PC_EXECUTED_SOURCE_MAP_ROOT: root,
          PC_EXECUTED_SOURCE_MAP_PRELOAD: '1' },
      });
      expect(JSON.parse(out.trim())).toMatchObject({ evaluations: 2,
        duplicate: { key: '@papercusp/test-config.original-config-loads', evaluations: 2 },
        exitListenersAdded: 1,
        evidence: { status: 'stable', sources: [{ path: 'helper.mjs', sha256: digest(source),
          currentSha256: digest(source) }] },
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps real worker-thread observations separate from the parent with the same PID', () => {
    const root = mkdtempSync(join(tmpdir(), 'thread-original-load-'));
    const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
    const outPath = join(root, 'out.json');
    const source = 'export const value = 1;\n';
    try {
      writeFileSync(join(root, 'helper.mjs'), source);
      writeFileSync(join(root, 'child.mjs'), "import { value } from './helper.mjs'; console.log(value);\n");
      writeFileSync(join(root, 'parent.mjs'), "import { Worker } from 'node:worker_threads'; new Worker(new URL('./child.mjs', import.meta.url));\n");
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL/.test(key) ||
          key === 'NODE_OPTIONS') delete env[key];
      const output = execFileSync(process.execPath, ['parent.mjs'], { cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'thread-load-test', PC_EXECUTED_SOURCE_MAP_OUT: outPath,
          PC_EXECUTED_SOURCE_MAP_ROOT: root, PC_EXECUTED_SOURCE_MAP_PRELOAD: '1',
          NODE_OPTIONS: `--import=${pathToFileURL(capture).href}` },
      });
      expect(output.trim()).toBe('1');
      const receipts = readdirSync(`${outPath}.processes`).map(file =>
        JSON.parse(readFileSync(join(`${outPath}.processes`, file), 'utf8')));
      expect(receipts).toHaveLength(2);
      expect(new Set(receipts.map(receipt => receipt.pid)).size).toBe(1);
      const thread = receipts.find(receipt => receipt.isMainThread === false);
      expect(thread).toMatchObject({ entrypoint: null, status: 'unknown', threadId: expect.any(Number),
        reasons: expect.arrayContaining(['process-worker-thread-entrypoint-unmeasured']),
        sources: expect.arrayContaining([{ path: 'helper.mjs', sha256: digest(source), currentSha256: digest(source) }]),
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['stable', 'self-restoring', 'commonjs', 'overriding-loader', 'mutated-argv'] as const)
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
          ${kind === 'mutated-argv' ? "process.argv[1] = 'helper.mjs';" : ''}
          console.log(value);\n`);
        writeFileSync(join(root, 'parent.mjs'), `import { spawnSync } from 'node:child_process';
          const child = spawnSync(process.execPath, ['child.mjs'], { stdio: 'inherit', env: process.env });
          process.exit(child.status ?? 1);\n`);
        const loader = join(root, 'loader.mjs');
        if (kind === 'overriding-loader') writeFileSync(loader, `import { registerHooks } from 'node:module';
          registerHooks({ load(url, context, nextLoad) {
            const result = nextLoad(url, context);
            return url.endsWith('/helper.mjs') ? { ...result, source: 'export const value = 2;\\n' } : result;
          } });\n`);
        const env = { ...process.env };
        for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL/.test(key) ||
            key === 'NODE_OPTIONS') delete env[key];
        const output = execFileSync(process.execPath, ['parent.mjs'], { cwd: root, encoding: 'utf8', timeout: 30000,
          env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'command-load-test',
            PC_EXECUTED_SOURCE_MAP_OUT: outPath, PC_EXECUTED_SOURCE_MAP_ROOT: root,
            PC_EXECUTED_SOURCE_MAP_PRELOAD: '1', NODE_OPTIONS: `--import=${pathToFileURL(capture).href}` +
              (kind === 'overriding-loader' ? ` --import=${pathToFileURL(loader).href}` : '') },
        });
        expect(output.trim()).toBe(kind === 'self-restoring' || kind === 'overriding-loader' ? '2' : '1');
        expect(existsSync(`${outPath}.processes`)).toBe(true);
        const receipts = readdirSync(`${outPath}.processes`).map(file =>
          JSON.parse(readFileSync(join(`${outPath}.processes`, file), 'utf8')));
        expect(receipts.map(receipt => receipt.entrypoint).sort()).toEqual(['child.mjs', 'parent.mjs']);
        const child = receipts.find(receipt => receipt.entrypoint === 'child.mjs');
        expect(child).toMatchObject({ schemaVersion: 'node-loaded-process-sources-v1',
          scope: 'repository-node-process-sources', basis: 'node-load-hook',
          sources: expect.arrayContaining([{ path: `helper.${extension}`,
            sha256: kind === 'commonjs' || kind === 'overriding-loader' ? null : digest(loaded), currentSha256: digest(stable) }]),
          unresolved: expect.arrayContaining(['node-process-descendant-population-unmeasured', 'node-preload-self-unmeasured']),
        });
        expect(child.status).toBe(kind === 'stable' || kind === 'mutated-argv' ? 'stable' : kind === 'self-restoring' ? 'changed' : 'unknown');
        expect(child.observedSources).toEqual(expect.arrayContaining([{ path: `helper.${extension}`,
          observedSha256: kind === 'commonjs' ? null : digest(loaded) }]));
        if (kind === 'overriding-loader') expect(child.loaderChain).toMatchObject({
          scope: 'declared-node-preloads', status: 'unknown',
          preloads: expect.arrayContaining([expect.objectContaining({
            kind: 'import', path: loader, capture: false,
            observedSha256: digest(readFileSync(loader, 'utf8')),
          })]),
        });
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

  it.each(['before', 'after'] as const)
    ('retains observed preload bytes without closing a harmless loader chain (%s capture)', order => {
      const root = mkdtempSync(join(tmpdir(), 'preload-original-load-'));
      const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
      const preload = join(root, 'preload.mjs');
      const helper = join(root, 'helper.mjs');
      const preloadSource = 'export const preload = true;\n';
      const helperSource = 'export const value = 1;\n';
      try {
        writeFileSync(preload, preloadSource);
        writeFileSync(helper, helperSource);
        const script = `await import(${JSON.stringify(pathToFileURL(helper).href)});
          const { qualifyLoadedConfigSources } = await import(${JSON.stringify(pathToFileURL(capture).href)});
          console.log(JSON.stringify(qualifyLoadedConfigSources([${JSON.stringify(helper)}], ${JSON.stringify(root)})));`;
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        const imports = order === 'before' ? [capture, preload] : [preload, capture];
        const out = execFileSync(process.execPath, [...imports.flatMap(path => ['--import', path]),
          '--input-type=module', '--eval', script], { cwd: root, encoding: 'utf8', timeout: 30000,
          env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'preload-load-test',
            PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'out.json'), PC_EXECUTED_SOURCE_MAP_PRELOAD: '1' },
        });
        expect(JSON.parse(out.trim())).toMatchObject({ status: 'unknown',
          reasons: expect.arrayContaining(['node-loader-chain-unmeasured']),
          sources: [{ path: 'helper.mjs', sha256: null, currentSha256: digest(helperSource) }],
          observedSources: [{ path: 'helper.mjs', observedSha256: digest(helperSource) }],
          loaderChain: { status: 'unknown', scope: 'declared-node-preloads',
            preloads: expect.arrayContaining([
              { kind: 'import', path: capture, capture: true, observedSha256: null },
              { kind: 'import', path: preload, capture: false,
                observedSha256: order === 'before' ? digest(preloadSource) : null },
            ]), unresolved: expect.arrayContaining(['node-loader-chain-not-closed', 'node-preload-self-unmeasured']) },
        });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

  it.each(['before', 'after'] as const)
    ('keeps an overriding preload unknown even when its observed boundary matches disk (%s capture)', order => {
      const root = mkdtempSync(join(tmpdir(), 'overriding-original-load-'));
      const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
      const loader = join(root, 'loader.mjs');
      const helper = join(root, 'helper.mjs');
      const original = 'export const value = 1;\n';
      const replaced = 'export const value = 2;\n';
      try {
        writeFileSync(helper, original);
        writeFileSync(loader, `import { registerHooks } from 'node:module';
          registerHooks({ load(url, context, nextLoad) {
            const result = nextLoad(url, context);
            return url.endsWith('/helper.mjs') ? { ...result, source: ${JSON.stringify(replaced)} } : result;
          } });\n`);
        const script = `const { value } = await import(${JSON.stringify(pathToFileURL(helper).href)});
          const { qualifyLoadedConfigSources } = await import(${JSON.stringify(pathToFileURL(capture).href)});
          console.log(JSON.stringify({ value, evidence:
            qualifyLoadedConfigSources([${JSON.stringify(helper)}], ${JSON.stringify(root)}) }));`;
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        const imports = order === 'before' ? [capture, loader] : [loader, capture];
        const out = execFileSync(process.execPath, [...imports.flatMap(path => ['--import', path]),
          '--input-type=module', '--eval', script], { cwd: root, encoding: 'utf8', timeout: 30000,
          env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'overriding-load-test',
            PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'out.json'), PC_EXECUTED_SOURCE_MAP_PRELOAD: '1' },
        });
        expect(JSON.parse(out.trim())).toMatchObject({ value: 2, evidence: { status: 'unknown',
          reasons: expect.arrayContaining(['node-loader-chain-unmeasured']),
          sources: [{ path: 'helper.mjs', sha256: null, currentSha256: digest(original) }],
          observedSources: [{ path: 'helper.mjs', observedSha256: digest(order === 'before' ? original : replaced) }],
          loaderChain: { status: 'unknown' },
        } });
      } finally { rmSync(root, { recursive: true, force: true }); }
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

  it('retains source and containment receipts with the actual calibration preloads', () => {
    const root = mkdtempSync(join(tmpdir(), 'calibration-original-load-'));
    const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
    const committed = fileURLToPath(new URL('../../../scripts/lib/committed-source-loader.mjs', import.meta.url));
    const containment = fileURLToPath(new URL('../../../scripts/lib/managed-test-cgroup-preload.mjs', import.meta.url));
    const outPath = join(root, 'out.json');
    const cgroups = join(root, 'cgroups.jsonl');
    const entry = join(root, 'entry.mjs');
    const entrySource = 'export const value = 1;\n';
    try {
      writeFileSync(entry, entrySource);
      const cgroupPath = /^0::(.+)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
      expect(cgroupPath).toBeTruthy();
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      const runGroup = 'capture-calibration-test';
      const deadlineEpochMs = Date.now() + 30000;
      execFileSync(process.execPath, ['--import', committed, entry], { cwd: root,
        encoding: 'utf8', timeout: 30000,
        env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'calibration-load-test',
          PC_EXECUTED_SOURCE_MAP_ROOT: root, PC_EXECUTED_SOURCE_MAP_OUT: outPath,
          PC_EXECUTED_SOURCE_MAP_PRELOAD: '1',
          NODE_OPTIONS: `--import=${pathToFileURL(capture).href} --import=${pathToFileURL(containment).href}`,
          PAPERCUSP_COMMITTED_SOURCE_AUDIT: join(root, 'committed.jsonl'),
          PAPERCUSP_TEST_CGROUP_CONTEXT: JSON.stringify({ runGroup, deadlineEpochMs, cgroupPath, evidencePath: cgroups }),
        },
      });
      const receipts = readdirSync(`${outPath}.processes`).map(file =>
        JSON.parse(readFileSync(join(`${outPath}.processes`, file), 'utf8')));
      const receipt = receipts.find(receipt => receipt.entrypoint === 'entry.mjs' && receipt.isMainThread);
      expect(receipt).toMatchObject({ status: 'unknown', exitCode: 0,
        sources: expect.arrayContaining([{ path: 'entry.mjs', sha256: null, currentSha256: digest(entrySource) }]),
        observedSources: expect.arrayContaining([{ path: 'entry.mjs', observedSha256: digest(entrySource) }]),
        loaderChain: { status: 'unknown', preloads: expect.arrayContaining([
          expect.objectContaining({ path: committed, capture: false, observedSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
          expect.objectContaining({ path: containment, capture: false, observedSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        ]) },
        unresolved: expect.arrayContaining(['node-process-descendant-population-unmeasured', 'node-loader-chain-not-closed']),
      });
      const membership = readFileSync(cgroups, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const ownMembership = membership.filter(row => row.pid === receipt.pid && row.isMainThread);
      expect(ownMembership.map(row => row.phase)).toEqual(['preload', 'exit']);
      for (const row of ownMembership) expect(row).toMatchObject({ runGroup, deadlineEpochMs, cgroupPath });
      const committedLoads = readFileSync(join(root, 'committed.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(committedLoads).toEqual(expect.arrayContaining([expect.objectContaining({
        file: entry, returnedSha256: digest(entrySource), boundary: 'node-esm-load-return',
      })]));
    } finally { rmSync(root, { recursive: true, force: true }); }
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
