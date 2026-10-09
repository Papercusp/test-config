import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configBundleSources, qualifyLoadedConfigSources, qualifyLoadedMainProcessSources,
  writeExecutedCaptureDiagnostic } from './executed-config-load-capture.ts';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const prefix = (path: string): string => `const __vite_injected_original_dirname = ${JSON.stringify(dirname(path))};` +
  `const __vite_injected_original_filename = ${JSON.stringify(path)};` +
  `const __vite_injected_original_import_meta_url = ${JSON.stringify(pathToFileURL(path).href)};`;
const bundle = (map: unknown): string => '// loaded code\n//# sourceMappingURL=data:application/json;base64,' +
  Buffer.from(JSON.stringify(map)).toString('base64');

describe('capture diagnostic evidence retention', () => {
  function fixture(mode: 'exit' | 'SIGTERM' | 'SIGINT' = 'SIGTERM') {
    const root = mkdtempSync(join(tmpdir(), 'capture-diagnostic-'));
    const outPath = join(root, 'sources.json');
    const cgroupsPath = join(root, 'cgroups.jsonl');
    const auditPath = join(root, 'committed.jsonl');
    const parentExitsPath = join(root, 'parents.jsonl');
    const summaryPath = join(root, 'summary.json');
    const entry = '/fixture/node_modules/vitest/dist/workers/forks.js';
    const context = { phase: 'preload', pid: 41, cgroupPath: '/task.scope', runGroup: 'diagnostic', deadlineEpochMs: 1234,
      isMainThread: true, vitestFork: true, argv: [entry] };
    const termination = mode === 'exit' ? { phase: 'exit', exitCode: 0, signal: null } :
      { phase: 'signal', exitCode: null, signal: mode };
    const source = { pid: 41, parentPid: 40, isMainThread: true, ...termination };
    const parent = { pid: 41, parentPid: 40, entry, code: termination.exitCode, signal: termination.signal };
    const reporter = { configLoadedSources: { observedSources: [{ path: 'vitest.config.ts', observedSha256: 'a' }] },
      mainProcessLoadedSources: { observedSources: [{ path: 'runner.mjs', observedSha256: 'b' }] } };
    mkdirSync(outPath + '.processes');
    writeFileSync(outPath, JSON.stringify(reporter));
    writeFileSync(join(outPath + '.processes', '41-0.json'), JSON.stringify(source));
    writeFileSync(cgroupsPath, [context, { ...context, ...termination }].map(row => JSON.stringify(row)).join('\n'));
    writeFileSync(parentExitsPath, JSON.stringify(parent));
    writeFileSync(auditPath, JSON.stringify({ path: 'runner.mjs' }));
    const options = { outPath, cgroupsPath, auditPath, parentExitsPath, summaryPath,
      cgroupPath: context.cgroupPath, runGroup: context.runGroup, deadlineEpochMs: context.deadlineEpochMs,
      verifySource: () => {}, child: { code: 0, signal: null,
        resultLine: 'TEST_FILE_RESULT status=passed requested=1 executed=1 matched=1 skippedTests=0' } };
    return { root, options, context, source, parent };
  }

  it.each(['exit', 'SIGTERM', 'SIGINT'] as const)('accepts independently agreeing %s receipts without closing the loader chain', mode => {
    const f = fixture(mode);
    try {
      const result = writeExecutedCaptureDiagnostic(f.options);
      expect(result.failures).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.forkProcessCoverage).toEqual([expect.objectContaining({ pid: 41, terminationVerified: true })]);
      expect(JSON.parse(readFileSync(f.options.summaryPath, 'utf8'))).toEqual(result);
      expect(result.loaderChainAcceptance).toBe('unknown');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each(['missing-source', 'malformed-source', 'null-source', 'parent-signal', 'parent-pid',
    'duplicate-parent', 'missing-parent', 'containment-context', 'containment-signal', 'test-skips', 'child-signal'] as const)
    ('rejects %s while persisting the complete failed diagnostic', mode => {
      const f = fixture();
      try {
        const sourcePath = join(f.options.outPath + '.processes', '41-0.json');
        if (mode === 'missing-source') rmSync(sourcePath);
        if (mode === 'malformed-source') writeFileSync(sourcePath, '{');
        if (mode === 'null-source') writeFileSync(sourcePath, 'null');
        if (mode === 'parent-signal') writeFileSync(f.options.parentExitsPath, JSON.stringify({ ...f.parent, signal: 'SIGINT' }));
        if (mode === 'parent-pid') writeFileSync(f.options.parentExitsPath, JSON.stringify({ ...f.parent, parentPid: 39 }));
        if (mode === 'duplicate-parent') writeFileSync(f.options.parentExitsPath,
          [f.parent, f.parent].map(row => JSON.stringify(row)).join('\n'));
        if (mode === 'missing-parent') rmSync(f.options.parentExitsPath);
        if (mode === 'containment-context' || mode === 'containment-signal') writeFileSync(f.options.cgroupsPath,
          [f.context, { ...f.context, ...f.source,
            ...(mode === 'containment-context' ? { cgroupPath: '/other.scope' } : { signal: 'SIGINT' }) }]
            .map(row => JSON.stringify(row)).join('\n'));
        if (mode === 'test-skips') f.options.child.resultLine = f.options.child.resultLine.replace('skippedTests=0', 'skippedTests=1');
        const child = mode === 'child-signal' ? { ...f.options.child, code: null, signal: 'SIGTERM' } : f.options.child;
        const result = writeExecutedCaptureDiagnostic({ ...f.options, child });
        expect(result.valid).toBe(false);
        expect(result.failures.length).toBeGreaterThan(0);
        const saved = JSON.parse(readFileSync(f.options.summaryPath, 'utf8'));
        expect(saved).toEqual(result);
        expect(saved.audit).toHaveLength(1);
        expect(saved.reporter.configLoadedSources.observedSources).toHaveLength(1);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });

  it('records all unavailable artifacts, source drift and spawn failure before returning invalid', () => {
    const f = fixture();
    try {
      rmSync(f.options.outPath); rmSync(f.options.cgroupsPath); rmSync(f.options.auditPath);
      rmSync(f.options.parentExitsPath); rmSync(f.options.outPath + '.processes', { recursive: true });
      const result = writeExecutedCaptureDiagnostic({ ...f.options,
        verifySource: () => { throw new Error('source drift'); },
        child: { code: null, signal: null, resultLine: '', spawnFailure: 'ENOENT' } });
      expect(result.valid).toBe(false);
      expect(result.failures.map(row => row.label)).toEqual(expect.arrayContaining([
        'post-run-source-guard', 'child-spawn', 'cgroup-artifact', 'reporter-artifact',
        'process-directory', 'committed-loader-artifact', 'parent-exit-artifact', 'test-result',
      ]));
      expect(JSON.parse(readFileSync(f.options.summaryPath, 'utf8'))).toEqual(result);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe('original config load evidence', () => {
  it.skipIf(process.platform !== 'linux')('retains real Vitest fork termination receipts without changing its SIGTERM exit', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const dir = mkdtempSync(join(tmpdir(), 'vitest-fork-termination-'));
    const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
    const containment = join(root, 'scripts/lib/managed-test-cgroup-preload.mjs');
    const fixture = fileURLToPath(new URL('./__fixtures__/armed-capture/', import.meta.url));
    const bin = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
    const out = join(dir, 'sources.json');
    const cgroups = join(dir, 'cgroups.jsonl');
    const exits = join(dir, 'child-exits.jsonl');
    const parentObserver = join(dir, 'parent-observer.mjs');
    const cgroupPath = readFileSync('/proc/self/cgroup', 'utf8').split('\n')
      .find(line => line.startsWith('0::'))?.slice(3);
    expect(cgroupPath).toBeTruthy();
    try {
      // Observe the actual parent-side exit event independently of child preloads.
      writeFileSync(parentObserver, `import cp from 'node:child_process';
        import { appendFileSync } from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const original = cp.fork;
        cp.fork = (...args) => {
          const child = original(...args);
          child.once('exit', (code, signal) => appendFileSync(${JSON.stringify(exits)},
            JSON.stringify({ pid: child.pid, entry: args[0], code, signal }) + '\\n'));
          return child;
        };
        syncBuiltinESMExports();\n`);
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL/.test(key) ||
          /^(PC_|VITEST|PAPERCUSP_TEST_|PAPERCUSP_MUTATION_|AFFECTED_)/.test(key) || key === 'NODE_OPTIONS') delete env[key];
      execFileSync(process.execPath, ['--import', parentObserver, bin, 'run', '--root', fixture,
        '--config', join(fixture, 'vitest.config.ts'), '--pool=forks', '--maxWorkers=1', '--no-file-parallelism'], {
        cwd: root, encoding: 'utf8', timeout: 90000,
        env: { ...env, NODE_OPTIONS: `--import=${pathToFileURL(capture).href} --import=${pathToFileURL(containment).href}`,
          PC_EXECUTED_SOURCE_MAP_PRELOAD: '1', PC_EXECUTED_SOURCE_MAP_WORKSPACE: '@papercusp/armed-capture-fixture',
          PC_EXECUTED_SOURCE_MAP_ROOT: root, PC_EXECUTED_SOURCE_MAP_OUT: out, PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1',
          HARNESS_ADMIN_DATABASE_URL: 'postgresql://127.0.0.1:1/termination-fixture',
          PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://127.0.0.1:1/termination-fixture',
          PAPERCUSP_TEST_CGROUP_CONTEXT: JSON.stringify({ runGroup: 'fork-termination-regression',
            deadlineEpochMs: Date.now() + 90000, cgroupPath, evidencePath: cgroups }),
        },
      });
      const membership = readFileSync(cgroups, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const forks = membership.filter(row => row.vitestFork && row.phase === 'preload');
      const parentExits = readFileSync(exits, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(forks).toHaveLength(1);
      const pid = forks[0].pid;
      expect(parentExits).toContainEqual(expect.objectContaining({ pid, code: null, signal: 'SIGTERM' }));
      const receipt = join(`${out}.processes`, `${pid}-0.json`);
      expect(existsSync(receipt), `missing worker receipt for ${pid}; parent=${JSON.stringify(parentExits)}`).toBe(true);
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ pid, isMainThread: true,
        phase: 'signal', exitCode: null, signal: 'SIGTERM', observedSources: expect.any(Array),
      });
      expect(membership).toContainEqual(expect.objectContaining({ pid, vitestFork: true,
        phase: 'signal', signal: 'SIGTERM', cgroupPath,
      }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);

  it.each((['SIGTERM', 'SIGINT', 'application-handler', 'observer-failure', 'SIGKILL', 'exit'] as const)
    .flatMap(mode => [false, true].map(keepAlive => ({ mode, keepAlive }))))
    ('preserves process termination semantics and duplicate observer delivery ($mode, keepAlive=$keepAlive)', ({ mode, keepAlive }) => {
      const dir = mkdtempSync(join(tmpdir(), 'termination-semantics-'));
      const events = join(dir, 'events.jsonl');
      const helper = new URL('./process-termination-observer.mjs', import.meta.url).href;
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      for (const key of Object.keys(env)) if (/^PC_/.test(key)) delete env[key];
      try {
        writeFileSync(events, '');
        const script = `import { appendFileSync } from 'node:fs';
          const first = await import(${JSON.stringify(helper)});
          const duplicate = await import(${JSON.stringify(helper + '?duplicate')});
          const record = tag => event => appendFileSync(${JSON.stringify(events)},
            JSON.stringify({ tag, ...event }) + '\\n');
          first.observeProcessTermination(record('first'));
          duplicate.observeProcessTermination(record('duplicate'));
          ${mode === 'observer-failure' ? "first.observeProcessTermination(() => { throw new Error('fixture observer failure'); });" : ''}
          ${mode === 'application-handler' ? "process.once('SIGTERM', () => process.exit(23));" : ''}
          ${mode === 'exit' ? 'process.exitCode = 7;' : `process.kill(process.pid, ${JSON.stringify(mode === 'SIGINT' || mode === 'SIGKILL' ? mode : 'SIGTERM')});
            ${keepAlive ? 'setInterval(() => {}, 1000);' : ''}`}`;
        const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
          env, encoding: 'utf8', timeout: 10000,
        });
        const rows = readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        expect(run.error).toBeUndefined();
        if (mode === 'application-handler' || mode === 'exit') {
          expect(run.signal).toBeNull();
          expect(run.status).toBe(mode === 'exit' ? 7 : 23);
          expect(rows.filter(row => row.phase === 'exit')).toEqual([
            { tag: 'first', phase: 'exit', exitCode: run.status, signal: null },
            { tag: 'duplicate', phase: 'exit', exitCode: run.status, signal: null },
          ]);
        } else {
          expect(run.status).toBeNull();
          expect(run.signal).toBe(mode === 'SIGKILL' || mode === 'SIGINT' ? mode : 'SIGTERM');
          expect(rows).toEqual(mode === 'SIGKILL' ? [] : [
            { tag: 'first', phase: 'signal', exitCode: null, signal: run.signal },
            { tag: 'duplicate', phase: 'signal', exitCode: null, signal: run.signal },
          ]);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

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

  it.each((['stable', 'self-restoring', 'commonjs', 'outside', 'reloaded'] as const)
    .flatMap(kind => [false, true].map(ambientPreload => ({ kind, ambientPreload }))))
    ('retains actual native main-process inputs separately from config inputs ($kind, ambientPreload=$ambientPreload)', ({ kind, ambientPreload }) => {
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
        const preload = join(base, 'ambient-preload.mjs');
        writeFileSync(preload, 'export const ambient = true;\n');
        const env = { ...process.env, ...(ambientPreload ? { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } : {}) };
        // This control measures the plain native loader. Calibration and
        // overriding-preload cases below exercise the instrumented alternatives.
        delete env.NODE_OPTIONS;
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
          env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'main-load-test', PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'out.json'),
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

  it.each((['native', 'native-ts', 'bundle', 'runner', 'commonjs-bundle'] as const)
    .flatMap(kind => [false, true].map(ambientPreload => ({ kind, ambientPreload }))))
    ('observes actual Vite config evaluation ($kind loader, ambientPreload=$ambientPreload)', ({ kind, ambientPreload }) => {
    const root = mkdtempSync(join(tmpdir(), 'config-original-load-'));
    const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
    const vite = import.meta.resolve('vite');
    const loader = kind === 'native-ts' ? 'native' : kind === 'commonjs-bundle' ? 'bundle' : kind;
    const cjs = kind === 'commonjs-bundle';
    const extension = kind === 'native-ts' ? 'ts' : cjs ? 'cjs' : 'mjs';
    const original = cjs ? 'exports.count = 1;\n' : `export const count${kind === 'native-ts' ? ': number' : ''} = 1;\n`;
    const restored = cjs ? 'exports.count = 2;\n' : `export const count${kind === 'native-ts' ? ': number' : ''} = 2;\n`;
    try {
      const preload = join(root, 'ambient-preload.mjs');
      writeFileSync(preload, 'export const ambient = true;\n');
      const env = { ...process.env, ...(ambientPreload ? { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } : {}) };
      delete env.NODE_OPTIONS;
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
        env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'load-test', PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'out.json'),
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
