import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestModule } from 'vitest/node';

import { inferWorkspaceRoot } from './admin-test-runs-reporter';
import { PC_EXECUTED_INPUTS_DIR_ENV } from './executed-inputs-capture';
import ExecutedSourceMapReporter, {
  EXECUTED_SOURCE_MAP_FLUSH_TIMEOUT_MS,
  appendExecutedSourceMapResult,
  captureConfigSources,
  collectExecutedModules,
  executedSourceRunContext,
  executedSourceRunnerIdentity,
  isolatedByConfig,
  normalizeExecutedKey,
  qualifyConfigSources,
  resolveConfigDependencies,
  shouldRecordModule,
  type ExecutedSourceFlush,
  type ExecutedSourceMapResult,
} from './executed-source-map-reporter';

// gate-test-reuse-yield-2026-10-01 P-001: the config that ran a file is one of its proof inputs.
describe('resolveConfigDependencies', () => {
  it('unions the root and per-project configFileDependencies, absolute paths only, sorted', () => {
    const ctx = {
      vite: { config: { configFileDependencies: ['/r/ws/vitest.config.ts', '/r/ws/helper.ts'] } },
      projects: [
        { vite: { config: { configFileDependencies: ['/r/ws/vitest.config.ts', 'relative/ignored.ts'] } } },
        { vite: { config: { configFileDependencies: ['/r/other/vitest.config.ts'] } } },
      ],
    };
    expect(resolveConfigDependencies(ctx)).toEqual(['/r/other/vitest.config.ts', '/r/ws/helper.ts', '/r/ws/vitest.config.ts']);
  });

  it('reports an UNKNOWN config as null — never as "no config input"', () => {
    expect(resolveConfigDependencies({})).toBeNull();
    expect(resolveConfigDependencies(undefined)).toBeNull();
    expect(resolveConfigDependencies({ vite: { config: { configFileDependencies: [] } } })).toBeNull();
    const throwing = {
      get vite(): never {
        throw new Error('server not ready');
      },
    };
    expect(resolveConfigDependencies(throwing)).toBeNull();
  });
});
describe('config dependency disk snapshots', () => {
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');

  it('retains a config helper change after initialization', () => {
    const captured = captureConfigSources(['/repo/config.ts', '/repo/helper.ts'], {
      repoRoot: '/repo', readSource: () => Buffer.from('original'),
    });
    expect(qualifyConfigSources(captured, { repoRoot: '/repo', readSource: path =>
      Buffer.from(path.endsWith('helper.ts') ? 'changed' : 'original') })).toMatchObject({
      basis: 'reporter-init-disk', status: 'changed', reasons: ['config-source-changed:helper.ts'],
      sources: expect.arrayContaining([{ path: 'helper.ts', sha256: digest('original'), currentSha256: digest('changed') }]),
    });
  });

  it('keeps missing dependency discovery unknown', () => {
    expect(qualifyConfigSources(captureConfigSources(null, { repoRoot: '/repo' }), { repoRoot: '/repo' }))
      .toMatchObject({ status: 'unknown', sources: [], reasons: expect.arrayContaining(['config-dependencies-unavailable']) });
  });

  it('keeps an external config unknown even when the repository subset is readable', () => {
    expect(qualifyConfigSources(captureConfigSources(['/repo/config.ts', '/external/helper.ts'], {
      repoRoot: '/repo', readSource: () => Buffer.from('config'),
    }), { repoRoot: '/repo', readSource: () => Buffer.from('config') })).toMatchObject({
      status: 'unknown', reasons: ['config-dependency-outside-repository:/external/helper.ts'],
    });
  });

  it('never fills an unavailable initial snapshot from later bytes', () => {
    const captured = captureConfigSources(['/repo/config.ts'], {
      repoRoot: '/repo', readSource: () => { throw new Error('unreadable'); },
    });
    expect(qualifyConfigSources(captured, { repoRoot: '/repo', readSource: () => Buffer.from('late') }))
      .toMatchObject({ status: 'unknown', sources: [{ path: 'config.ts', sha256: null, currentSha256: digest('late') }] });
  });

  it('keeps a deleted config unknown without losing its initial snapshot', () => {
    const captured = captureConfigSources(['/repo/config.ts'], { repoRoot: '/repo', readSource: () => Buffer.from('original') });
    expect(qualifyConfigSources(captured, { repoRoot: '/repo', readSource: () => { throw new Error('deleted'); } }))
      .toMatchObject({ status: 'unknown', sources: [{ path: 'config.ts', sha256: digest('original'), currentSha256: null }] });
  });
});

import {
  EXECUTED_SOURCE_MAP_IMPORT_LIMIT,
  PC_EXECUTED_SOURCE_MAP_NO_PERSIST_ENV,
  PC_EXECUTED_SOURCE_MAP_OUT_ENV,
  PC_EXECUTED_SOURCE_MAP_RESULT_ENV,
  PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV,
  executedSourceMapArmed,
  executedSourceMapConfig,
} from './vitest-config';

/**
 * Executed-source-map reporter (gate-latency-selection-and-retry-policy-2026-09-06, P-002).
 *
 * Every rail here is asserted in the fail-safe direction: the reporter must never write a
 * row the selector could prune on unless the run was clean, isolated and passing, and the
 * config must never arm the reporter without also raising vitest's importDurations limit —
 * an armed reporter at the default limit records an EMPTY map for every file.
 */

const REPO_ROOT = inferWorkspaceRoot();
const ROOT = '/repo';

describe('normalizeExecutedKey', () => {
  it('turns vitest module ids into repo-root-relative POSIX paths', () => {
    expect(normalizeExecutedKey('/repo/pkg/a.ts', ROOT)).toBe('pkg/a.ts');
    expect(normalizeExecutedKey('/repo/pkg/a.ts?v=123', ROOT)).toBe('pkg/a.ts');
    expect(normalizeExecutedKey('file:///repo/pkg/a.ts?import', ROOT)).toBe('pkg/a.ts');
    expect(normalizeExecutedKey('/@fs/repo/pkg/a.ts', ROOT)).toBe('pkg/a.ts');
  });

  it('rejects everything that is not a repo-internal source module', () => {
    expect(normalizeExecutedKey('/repo/node_modules/x/index.js', ROOT)).toBeNull();
    expect(normalizeExecutedKey('/elsewhere/a.ts', ROOT)).toBeNull();
    expect(normalizeExecutedKey('relative/a.ts', ROOT)).toBeNull();
    expect(normalizeExecutedKey('/repo', ROOT)).toBeNull();
  });
});

describe('collectExecutedModules', () => {
  it('keeps internal modules, drops external ones, always includes the test file, sorts and de-dupes', () => {
    const out = collectExecutedModules(
      {
        '/repo/pkg/z.ts': { external: false },
        '/repo/pkg/a.ts': {},
        '/repo/pkg/a.ts?v=1': {},
        '/repo/node_modules/dep/index.js': { external: true },
        '/repo/pkg/unflagged-external/node_modules/y.js': {},
      },
      { repoRoot: ROOT, testFile: '/repo/pkg/t.test.ts' },
    );
    expect(out).toEqual(['pkg/a.ts', 'pkg/t.test.ts', 'pkg/z.ts']);
  });

  it('records the test file alone when there are no imports at all', () => {
    expect(collectExecutedModules(undefined, { repoRoot: ROOT, testFile: '/repo/pkg/t.test.ts' })).toEqual(['pkg/t.test.ts']);
  });
});

describe('recording rails', () => {
  it('only a PASSED module is recorded', () => {
    expect(shouldRecordModule('passed')).toBe(true);
    for (const s of ['failed', 'skipped', 'pending', 'error', '']) expect(shouldRecordModule(s)).toBe(false);
  });

  it('only an explicitly isolated project is recorded — "cannot tell" is not isolated', () => {
    expect(isolatedByConfig({ isolate: true })).toBe(true);
    expect(isolatedByConfig({ isolate: false })).toBe(false);
    expect(isolatedByConfig({})).toBe(false);
    expect(isolatedByConfig(undefined)).toBe(false);
  });
});

describe('executedSourceMapConfig — the reporter and the raised limit travel together', () => {
  it('is nothing at all when the runner did not name a workspace', () => {
    expect(executedSourceMapArmed({})).toBeNull();
    expect(executedSourceMapArmed({ [PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV]: '  ' })).toBeNull();
    expect(executedSourceMapConfig({})).toEqual({ reporters: [], experimental: undefined, setupFiles: [] });
  });

  it('arms the reporter AND raises experimental.importDurations.limit in one value', () => {
    const cfg = executedSourceMapConfig({ [PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV]: '@x/w' });
    expect(cfg.reporters).toHaveLength(1);
    expect(cfg.reporters[0]).toMatch(/executed-source-map-reporter\.ts$/);
    expect(cfg.experimental).toEqual({ importDurations: { limit: EXECUTED_SOURCE_MAP_IMPORT_LIMIT, print: false } });
    expect(cfg.plugins).toBeUndefined();
    expect(executedSourceMapConfig({
      [PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV]: '@x/w', [PC_EXECUTED_SOURCE_MAP_OUT_ENV]: '/tmp/o.json',
    }).plugins?.map(plugin => plugin.name)).toEqual(['papercusp-executed-source-originals']);
    // vitest 4.1.8 caps the reported map at `limit` and defaults it to 0 (or 10 when printing);
    // anything in that range would silently record a near-empty executed set.
    expect(EXECUTED_SOURCE_MAP_IMPORT_LIMIT).toBeGreaterThanOrEqual(100_000);
    expect(executedSourceMapArmed({ [PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV]: '@x/w', [PC_EXECUTED_SOURCE_MAP_OUT_ENV]: '/tmp/o.json' })).toEqual({
      workspaceName: '@x/w',
      outPath: '/tmp/o.json',
      resultPath: null,
      noPersist: false,
    });
    expect(
      executedSourceMapArmed({ [PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV]: '@x/w', [PC_EXECUTED_SOURCE_MAP_RESULT_ENV]: ' /tmp/r.jsonl ' }),
    ).toEqual({ workspaceName: '@x/w', outPath: null, resultPath: '/tmp/r.jsonl', noPersist: false });
  });

  // EI-24542010215430349: the gate's rescue reruns arm capture but must never persist.
  it('reads no-persist as an explicit truthy flag only — anything else persists as before', () => {
    const armedWith = (v: string | undefined) =>
      executedSourceMapArmed({ [PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV]: '@x/w', [PC_EXECUTED_SOURCE_MAP_NO_PERSIST_ENV]: v })?.noPersist;
    for (const v of ['1', 'true', 'TRUE', ' yes ']) expect(armedWith(v)).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'no']) expect(armedWith(v)).toBe(false);
    // No-persist alone arms nothing: the workspace name is still the arming switch.
    expect(executedSourceMapArmed({ [PC_EXECUTED_SOURCE_MAP_NO_PERSIST_ENV]: '1' })).toBeNull();
  });
});

describe('ExecutedSourceMapReporter', () => {
  const TEST_FILE = join(REPO_ROOT, 'libs/test-config/src/__fake__/thing.test.ts');
  const SOURCE = join(REPO_ROOT, 'libs/test-config/src/__fake__/thing.ts');
  let tmp: string;
  const savedEnv: Record<string, string | undefined> = {};

  const clean = { commit: 'c0ffee0000000000000000000000000000000000', porcelain: '' };
  const snapshot = (s: { commit: string | null; porcelain: string | null }) => async () => s;

  function fakeModule(o: { state?: string; isolate?: boolean | undefined; imports?: Record<string, { external?: boolean }> | 'throw'; moduleId?: string }): TestModule {
    return {
      moduleId: o.moduleId ?? TEST_FILE,
      state: () => o.state ?? 'passed',
      project: { config: 'isolate' in o ? { isolate: o.isolate } : { isolate: true } },
      diagnostic: () => {
        if (o.imports === 'throw') throw new Error('no diagnostic');
        return { importDurations: o.imports ?? { [SOURCE]: {}, [`${REPO_ROOT}/node_modules/vitest/dist/index.js`]: { external: true } } };
      },
    } as unknown as TestModule;
  }

  function reporter(snap = snapshot(clean)) {
    const flushes: ExecutedSourceFlush[] = [];
    const r = new ExecutedSourceMapReporter(snap, async (flush) => {
      flushes.push(flush);
    });
    return { r, flushes };
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'esm-reporter-'));
    for (const k of [
      PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV,
      PC_EXECUTED_SOURCE_MAP_OUT_ENV,
      PC_EXECUTED_SOURCE_MAP_RESULT_ENV,
      'PAPERCUSP_TEST_RUN_GROUP',
      'PAPERCUSP_MUTATION_PROBE',
      'PAPERCUSP_MUTATION_PHASE',
      PC_EXECUTED_INPUTS_DIR_ENV,
      PC_EXECUTED_SOURCE_MAP_NO_PERSIST_ENV,
    ]) {
      savedEnv[k] = process.env[k];
    }
    // Hermetic against an outer armed run (the gate arms input capture for its own vitest, and
    // arms it no-persist on a rescue rerun of this very file).
    delete process.env[PC_EXECUTED_INPUTS_DIR_ENV];
    delete process.env[PC_EXECUTED_SOURCE_MAP_NO_PERSIST_ENV];
    delete process.env.PAPERCUSP_MUTATION_PROBE;
    delete process.env.PAPERCUSP_MUTATION_PHASE;
    process.env[PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV] = '@papercusp/test-config';
    process.env[PC_EXECUTED_SOURCE_MAP_OUT_ENV] = join(tmp, 'out.json');
    process.env[PC_EXECUTED_SOURCE_MAP_RESULT_ENV] = join(tmp, 'result.jsonl');
    process.env.PAPERCUSP_TEST_RUN_GROUP = 'grp-1';
  });

  const results = (): ExecutedSourceMapResult[] =>
    readFileSync(join(tmp, 'result.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ExecutedSourceMapResult);

  afterEach(() => {
    vi.useRealTimers();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('records a passed, isolated module from a clean checkout — once, with the sha and run group', async () => {
    const { r, flushes } = reporter();
    r.onInit({} as never);
    r.onTestModuleEnd(fakeModule({}));
    await r.onTestRunEnd();
    await r.onExit(); // vitest may call both; the flush happens exactly once
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toEqual({
      recordedSha: clean.commit,
      runGroupId: 'grp-1',
      workspaceName: '@papercusp/test-config',
      retiredFiles: [],
      runContext: executedSourceRunContext(),
      runnerIdentity: executedSourceRunnerIdentity(),
      rows: [
        {
          workspaceName: '@papercusp/test-config',
          testFile: 'libs/test-config/src/__fake__/thing.test.ts',
          executedModules: ['libs/test-config/src/__fake__/thing.test.ts', 'libs/test-config/src/__fake__/thing.ts'],
          // No input record for this module (capture not armed) => never reusable (D-004 rule 2).
          inputsCaptured: false,
          readPaths: [],
          opaqueReasons: [],
        },
      ],
    });
    const out = JSON.parse(readFileSync(join(tmp, 'out.json'), 'utf8'));
    expect(out).toMatchObject({ workspaceName: '@papercusp/test-config', recordedSha: clean.commit, worktreeDirty: false, skipped: 0 });
    expect(out.rows).toHaveLength(1);
  });

  it('records NOTHING for a failed, a non-isolated, an import-less or a foreign module', async () => {
    const { r, flushes } = reporter();
    r.onInit({} as never);
    r.onTestModuleEnd(fakeModule({ state: 'failed' }));
    r.onTestModuleEnd(fakeModule({ isolate: false }));
    r.onTestModuleEnd(fakeModule({ isolate: undefined }));
    r.onTestModuleEnd(fakeModule({ imports: {} }));
    r.onTestModuleEnd(fakeModule({ imports: 'throw' }));
    r.onTestModuleEnd(fakeModule({ moduleId: '/tmp/outside.test.ts' }));
    await r.onTestRunEnd();
    // No pass row — but the FAILED module retires that file's older pass proofs (D-004 rule 5),
    // so an earlier pass can never mask a failure observed since.
    expect(flushes).toEqual([
      {
        recordedSha: clean.commit,
        runGroupId: 'grp-1',
        workspaceName: '@papercusp/test-config',
        retiredFiles: ['libs/test-config/src/__fake__/thing.test.ts'],
        runContext: executedSourceRunContext(),
        runnerIdentity: executedSourceRunnerIdentity(),
        rows: [],
      },
    ]);
    const out = JSON.parse(readFileSync(join(tmp, 'out.json'), 'utf8'));
    expect(out.rows).toEqual([]);
    expect(out.skipped).toBe(5);
  });

  it('does not persist from a dirty checkout, or when the tree moved during the run', async () => {
    const dirty = reporter(snapshot({ commit: clean.commit, porcelain: ' M libs/x.ts' }));
    dirty.r.onInit({} as never);
    dirty.r.onTestModuleEnd(fakeModule({}));
    await dirty.r.onTestRunEnd();
    expect(dirty.flushes).toEqual([]);
    const out = JSON.parse(readFileSync(join(tmp, 'out.json'), 'utf8'));
    expect(out).toMatchObject({ worktreeDirty: true });
    expect(out.rows).toHaveLength(1); // the artifact still says what WOULD have been recorded

    let n = 0;
    const moved = reporter(async () => ({ commit: n++ === 0 ? 'aaaa000' : 'bbbb000', porcelain: '' }));
    moved.r.onInit({} as never);
    moved.r.onTestModuleEnd(fakeModule({}));
    await moved.r.onTestRunEnd();
    expect(moved.flushes).toEqual([]);
  });

  it('keeps collected source evidence in OUT across HEAD movement without stamping reusable proof', async () => {
    const self = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.test.ts');
    const source = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.ts');
    const nodes = new Map([self, source].map(id => [id, {
      id, transformResult: { map: { sources: [id], sourcesContent: [readFileSync(id, 'utf8')] } },
    }]));
    const mod = Object.assign(fakeModule({ moduleId: self, imports: { [source]: {} } }), {
      viteEnvironment: { moduleGraph: { idToModuleMap: nodes } },
    });
    let n = 0;
    const { r, flushes } = reporter(async () => ({ commit: n++ === 0 ? 'aaaa000' : 'bbbb000', porcelain: '' }));
    r.onInit({} as never);
    r.onTestModuleCollected(mod);
    // Replacing the server graph must not replace the originals we already captured.
    nodes.clear();
    r.onTestModuleEnd(mod);
    await r.onTestRunEnd();
    expect(flushes).toEqual([]);
    const out = JSON.parse(readFileSync(join(tmp, 'out.json'), 'utf8'));
    expect(out.worktreeDirty).toBe(true);
    expect(out.rows[0].sourceEvidence).toMatchObject({
      status: 'stable', scope: 'repository-worker-vite-original-sources', reasons: [],
    });
    expect(out.rows[0].sourceEvidence.sources.map((s: { path: string }) => s.path)).toEqual([
      'libs/test-config/src/executed-source-map-reporter.test.ts',
      'libs/test-config/src/executed-source-map-reporter.ts',
    ]);
  });

  it('does no source fingerprint work unless the optional OUT channel requests it', async () => {
    delete process.env[PC_EXECUTED_SOURCE_MAP_OUT_ENV];
    const { r, flushes } = reporter();
    const mod = fakeModule({});
    Object.defineProperty(mod, 'viteEnvironment', { get: () => { throw new Error('must not read graph'); } });
    r.onInit({} as never);
    r.onTestModuleCollected(mod);
    r.onTestModuleEnd(mod);
    await r.onTestRunEnd();
    expect(flushes[0]!.rows[0]).not.toHaveProperty('sourceEvidence');
  });

  it('retains config dependency disk snapshots in OUT without putting them in reusable passes', async () => {
    const config = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.test.ts');
    const hash = createHash('sha256').update(readFileSync(config)).digest('hex');
    const { r, flushes } = reporter();
    r.onInit({ vite: { config: { configFileDependencies: [config] } } } as never);
    r.onTestModuleEnd(fakeModule({}));
    await r.onTestRunEnd();
    const out = JSON.parse(readFileSync(join(tmp, 'out.json'), 'utf8'));
    expect(out.configSources).toEqual({
      schemaVersion: 'vitest-config-disk-snapshots-v1', scope: 'repository-vite-config-dependencies',
      basis: 'reporter-init-disk', status: 'unchanged', reasons: [],
      sources: [{ path: 'libs/test-config/src/executed-source-map-reporter.test.ts',
        sha256: hash, currentSha256: hash }],
    });
    expect(flushes[0]).not.toHaveProperty('configSources');
  });

  it('retains failed worker source diagnostics in OUT without creating a reusable pass', async () => {
    const self = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.test.ts');
    const source = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.ts');
    const nodes = new Map([self, source].map(id => [id, {
      id, transformResult: { map: { sources: [id], sourcesContent: [readFileSync(id, 'utf8')] } },
    }]));
    const mod = Object.assign(fakeModule({ state: 'failed', moduleId: self, imports: { [source]: {} } }), {
      viteEnvironment: { moduleGraph: { idToModuleMap: nodes } },
    });
    const { r, flushes } = reporter();
    r.onInit({} as never);
    r.onTestModuleCollected(mod);
    r.onTestModuleEnd(mod);
    await r.onTestRunEnd();
    const out = JSON.parse(readFileSync(join(tmp, 'out.json'), 'utf8'));
    expect(out.diagnostics).toEqual([expect.objectContaining({
      testFile: 'libs/test-config/src/executed-source-map-reporter.test.ts', state: 'failed',
      sourceEvidence: expect.objectContaining({ status: 'stable', sources: expect.arrayContaining([
        expect.objectContaining({ path: 'libs/test-config/src/executed-source-map-reporter.ts' }),
      ]) }),
    })]);
    expect(out.rows).toEqual([]);
    expect(flushes[0]!.rows).toEqual([]);
    expect(flushes[0]!.retiredFiles).toEqual(['libs/test-config/src/executed-source-map-reporter.test.ts']);
    expect(flushes[0]).not.toHaveProperty('diagnostics');
  });

  it.each([
    ['baseline', 'passed', 'pass'],
    ['copy-baseline', 'passed', 'pass'],
    ['mutant', 'failed', 'fail'],
  ] as const)('captures %s mutation diagnostics without persisting or retiring proof', async (phase, state, verdict) => {
    process.env.PAPERCUSP_MUTATION_PROBE = '1';
    process.env.PAPERCUSP_MUTATION_PHASE = phase;
    const self = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.test.ts');
    const source = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.ts');
    const originals = [self, source].map(id => ({ id, code: readFileSync(id, 'utf8') }));
    const nodes = new Map(originals.map(({ id, code }) => [id, {
      id, transformResult: { map: { sources: [id], sourcesContent: [code] } },
    }]));
    const mod = Object.assign(fakeModule({ state, moduleId: self, imports: { [source]: {} } }), {
      viteEnvironment: { moduleGraph: { idToModuleMap: nodes } },
      children: { allTests: () => [{
        result: () => ({ state }), diagnostic: () => ({ retryCount: 0, flaky: false }),
      }] },
    });
    const { r, flushes } = reporter();
    r.onInit({} as never);
    r.onTestModuleCollected(mod);
    nodes.clear();
    r.onTestModuleEnd(mod);
    await r.onTestRunEnd();
    await r.onExit();
    const out = JSON.parse(readFileSync(join(tmp, 'out.json'), 'utf8'));
    expect(out.rows).toEqual([]);
    expect(out.diagnostics).toEqual([{
      testFile: 'libs/test-config/src/executed-source-map-reporter.test.ts', state,
      sourceEvidence: {
        schemaVersion: 'vite-collected-source-evidence-v1', scope: 'repository-worker-vite-original-sources',
        status: 'stable', reasons: [], sources: originals.map(({ id, code }) => ({
          path: normalizeExecutedKey(id, REPO_ROOT),
          sha256: createHash('sha256').update(code).digest('hex'),
          currentSha256: createHash('sha256').update(code).digest('hex'),
        })),
      },
    }]);
    expect(flushes).toEqual([]);
    expect(results()).toEqual([expect.objectContaining({
      outcome: 'nothing-to-record', rows: 0, retired: 0,
      fileResults: expect.objectContaining({ files: [{
        testFile: 'libs/test-config/src/executed-source-map-reporter.test.ts', verdict,
      }] }),
    })]);
  });

  it('keeps missing mutation source capture unknown instead of inferring loaded bytes', async () => {
    process.env.PAPERCUSP_MUTATION_PROBE = '1';
    const { r, flushes } = reporter();
    r.onInit({} as never);
    const mod = fakeModule({});
    r.onTestModuleCollected(mod);
    r.onTestModuleEnd(mod);
    await r.onTestRunEnd();
    const out = JSON.parse(readFileSync(join(tmp, 'out.json'), 'utf8'));
    expect(out.rows).toEqual([]);
    expect(out.diagnostics).toEqual([expect.objectContaining({
      sourceEvidence: expect.objectContaining({ status: 'unknown', reasons: expect.arrayContaining([
        'collection-graph-unavailable',
      ]) }),
    })]);
    expect(flushes).toEqual([]);
  });

  it('leaves a late import unknown even when another test already populated its server graph entry', async () => {
    const self = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.test.ts');
    const source = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.ts');
    const late = join(REPO_ROOT, 'libs/test-config/src/executed-source-fingerprints.test.ts');
    const nodes = new Map([self, source, late].map(id => [id, {
      id, transformResult: { map: { sources: [id], sourcesContent: [readFileSync(id, 'utf8')] } },
    }]));
    const imports = { [source]: {} };
    const mod = Object.assign(fakeModule({ moduleId: self, imports }), {
      viteEnvironment: { moduleGraph: { idToModuleMap: nodes } },
    });
    const { r } = reporter();
    r.onInit({} as never);
    r.onTestModuleCollected(mod);
    imports[late] = {};
    r.onTestModuleEnd(mod);
    await r.onTestRunEnd();
    const out = JSON.parse(readFileSync(join(tmp, 'out.json'), 'utf8'));
    expect(out.rows[0].sourceEvidence).toMatchObject({
      status: 'unknown',
      reasons: ['module-not-captured-at-collection:libs/test-config/src/executed-source-fingerprints.test.ts'],
    });
  });

  // EI-24542010215430349: a gate rescue rerun runs armed so a capture-caused red reproduces, but
  // nothing it sees may become a proof — not a pass row, and not a retirement either, even from a
  // CLEAN checkout where the ordinary path would write both.
  it('armed no-persist: never calls the writer from a clean checkout, and reports not-persisted', async () => {
    process.env[PC_EXECUTED_SOURCE_MAP_NO_PERSIST_ENV] = '1';
    const { r, flushes } = reporter();
    r.onInit({} as never);
    r.onTestModuleEnd(fakeModule({}));
    r.onTestModuleEnd(fakeModule({ state: 'failed', moduleId: join(REPO_ROOT, 'libs/test-config/src/__fake__/other.test.ts') }));
    await r.onTestRunEnd();
    await r.onExit();
    expect(flushes).toEqual([]);
    expect(results()).toEqual([
      { workspaceName: '@papercusp/test-config', outcome: 'not-persisted', rows: 1, retired: 1, skipped: 1, sha: clean.commit, dirty: false, error: null,
        fileResults: { version: 1, runnerIdentity: executedSourceRunnerIdentity(), runContext: executedSourceRunContext(), runGroupId: 'grp-1', files: [
          { testFile: 'libs/test-config/src/__fake__/thing.test.ts', verdict: 'unknown' },
          { testFile: 'libs/test-config/src/__fake__/other.test.ts', verdict: 'fail' },
        ] } },
    ]);
  });

  it('is inert when unarmed', async () => {
    delete process.env[PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV];
    const { r, flushes } = reporter();
    r.onInit({} as never);
    r.onTestModuleEnd(fakeModule({}));
    await r.onTestRunEnd();
    expect(flushes).toEqual([]);
  });

  it('swallows a failing writer — a recording problem never changes a test outcome', async () => {
    const r = new ExecutedSourceMapReporter(snapshot(clean), async () => {
      throw new Error('db down');
    });
    r.onInit({} as never);
    r.onTestModuleEnd(fakeModule({}));
    await expect(r.onTestRunEnd()).resolves.toBeUndefined();
  });

  // WI-10003603: the stderr log above is discarded by the gate, so a writer that fails on EVERY
  // row (WI-10003597 — 8h of zero pass proofs) was invisible. Each flush now leaves one durable
  // line saying what it did, for the runner to surface.
  describe('result file (PC_EXECUTED_SOURCE_MAP_RESULT)', () => {
    it.each([
      ['fully executed pass', ['passed'], { retryCount: 0, flaky: false }, 'pass'],
      ['passing module with a skipped case', ['passed', 'skipped'], { retryCount: 0, flaky: false }, 'unknown'],
      ['empty module', [], { retryCount: 0, flaky: false }, 'unknown'],
      ['pending case', ['pending'], { retryCount: 0, flaky: false }, 'unknown'],
      ['failed case behind a passing module state', ['failed'], { retryCount: 0, flaky: false }, 'fail'],
      ['pass after an inline retry', ['passed'], { retryCount: 1, flaky: false }, 'fail'],
      ['flaky pass', ['passed'], { retryCount: 0, flaky: true }, 'fail'],
      ['missing retry diagnostic', ['passed'], {}, 'unknown'],
      ['undefined retry diagnostic', ['passed'], undefined, 'unknown'],
      ['negative retry diagnostic', ['passed'], { retryCount: -1, flaky: false }, 'unknown'],
    ] as const)('retains a named first-attempt verdict for %s', async (_name, states, diagnostic, verdict) => {
      const { r } = reporter();
      r.onInit({} as never);
      const mod = Object.assign(fakeModule({}), {
        children: { allTests: () => states.map(state => ({ result: () => ({ state }), diagnostic: () => diagnostic })) },
      });
      r.onTestModuleEnd(mod);
      await r.onTestRunEnd();
      await r.onExit();
      expect(results()).toHaveLength(1);
      expect(results()[0]!.fileResults).toEqual({
        version: 1, runnerIdentity: executedSourceRunnerIdentity(), runContext: executedSourceRunContext(), runGroupId: 'grp-1',
        files: [{ testFile: 'libs/test-config/src/__fake__/thing.test.ts', verdict }],
      });
    });

    it('records pure-lane execution even when isolation prevents a reusable proof', async () => {
      const { r, flushes } = reporter();
      r.onInit({} as never);
      const mod = Object.assign(fakeModule({ isolate: false }), {
        children: { allTests: () => [{ result: () => ({ state: 'passed' }), diagnostic: () => ({ retryCount: 0, flaky: false }) }] },
      });
      r.onTestModuleEnd(mod);
      await r.onTestRunEnd();
      expect(flushes).toEqual([]);
      expect(results()[0]).toMatchObject({ outcome: 'nothing-to-record', rows: 0, fileResults: {
        files: [{ testFile: 'libs/test-config/src/__fake__/thing.test.ts', verdict: 'pass' }],
      } });
    });

    it('preserves a known retry failure after an unknown diagnostic', async () => {
      const { r } = reporter();
      r.onInit({} as never);
      const mod = Object.assign(fakeModule({}), {
        children: { allTests: () => [undefined, { retryCount: 1, flaky: false }].map(diagnostic => ({
          result: () => ({ state: 'passed' }), diagnostic: () => diagnostic,
        })) },
      });
      r.onTestModuleEnd(mod);
      await r.onTestRunEnd();
      await r.onExit();
      expect(results()[0]!.fileResults!.files[0]!.verdict).toBe('fail');
    });

    it('keeps unreadable case diagnostics unknown and an explicit failed module failed', async () => {
      const { r } = reporter();
      r.onInit({} as never);
      r.onTestModuleEnd(Object.assign(fakeModule({}), {
        children: { allTests: () => [{ result: () => ({ state: 'passed' }), diagnostic: () => { throw new Error('unreadable'); } }] },
      }));
      r.onTestModuleEnd(fakeModule({ state: 'failed', moduleId: join(REPO_ROOT, 'libs/test-config/src/__fake__/other.test.ts') }));
      await r.onTestRunEnd();
      expect(results()[0]!.fileResults!.files).toEqual([
        { testFile: 'libs/test-config/src/__fake__/thing.test.ts', verdict: 'unknown' },
        { testFile: 'libs/test-config/src/__fake__/other.test.ts', verdict: 'fail' },
      ]);
    });

    it('reports a landed write as written, with the row count and sha', async () => {
      const { r } = reporter();
      r.onInit({} as never);
      r.onTestModuleEnd(fakeModule({}));
      await r.onTestRunEnd();
      await r.onExit();
      expect(results()).toEqual([
        {
          workspaceName: '@papercusp/test-config',
          outcome: 'written',
          rows: 1,
          retired: 0,
          skipped: 0,
          sha: clean.commit,
          dirty: false,
          error: null,
          fileResults: { version: 1, runnerIdentity: executedSourceRunnerIdentity(), runContext: executedSourceRunContext(), runGroupId: 'grp-1', files: [
            { testFile: 'libs/test-config/src/__fake__/thing.test.ts', verdict: 'unknown' },
          ] },
        },
      ]);
    });

    it('reports a failing writer as failed WITH its error — the WI-10003597 signature', async () => {
      const r = new ExecutedSourceMapReporter(snapshot(clean), async () => {
        throw new Error('cannot cast type boolean to boolean[]');
      });
      r.onInit({} as never);
      r.onTestModuleEnd(fakeModule({}));
      await r.onTestRunEnd();
      expect(results()).toEqual([
        expect.objectContaining({ outcome: 'failed', rows: 1, error: 'cannot cast type boolean to boolean[]' }),
      ]);
    });

    it('reports a writer that never settles as timed-out, and leaves no timer behind', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const r = new ExecutedSourceMapReporter(snapshot(clean), () => new Promise<void>(() => {}));
      r.onInit({} as never);
      r.onTestModuleEnd(fakeModule({}));
      const done = r.onTestRunEnd();
      await vi.advanceTimersByTimeAsync(EXECUTED_SOURCE_MAP_FLUSH_TIMEOUT_MS);
      await done;
      expect(results()).toEqual([expect.objectContaining({ outcome: 'timed-out', rows: 1, error: null })]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('reports a dirty checkout as not-persisted and an empty run as nothing-to-record', async () => {
      const dirty = reporter(snapshot({ commit: clean.commit, porcelain: ' M libs/x.ts' }));
      dirty.r.onInit({} as never);
      dirty.r.onTestModuleEnd(fakeModule({}));
      await dirty.r.onTestRunEnd();

      const empty = reporter();
      empty.r.onInit({} as never);
      empty.r.onTestModuleEnd(fakeModule({ isolate: false }));
      await empty.r.onTestRunEnd();

      // Both flushes APPEND to the one file, so a task that runs vitest more than once keeps
      // every outcome rather than only the last.
      expect(results()).toEqual([
        expect.objectContaining({ outcome: 'not-persisted', rows: 1, dirty: true }),
        expect.objectContaining({ outcome: 'nothing-to-record', rows: 0, skipped: 1, dirty: false }),
      ]);
    });

    it('writes nothing when the runner named no result file, and a bad path never throws', () => {
      const line: ExecutedSourceMapResult = {
        workspaceName: 'w',
        outcome: 'failed',
        rows: 0,
        retired: 0,
        skipped: 0,
        sha: null,
        dirty: false,
        error: 'x'.repeat(2_000),
      };
      expect(() => appendExecutedSourceMapResult(null, line)).not.toThrow();
      expect(() => appendExecutedSourceMapResult(join(tmp, 'missing-dir', 'r.jsonl'), line)).not.toThrow();
      appendExecutedSourceMapResult(join(tmp, 'result.jsonl'), line);
      expect(results()[0]!.error).toHaveLength(500);
    });
  });
});
