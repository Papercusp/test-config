import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestModule } from 'vitest/node';
import * as runtimeProof from './runtime-proof.ts';
import { jsonChunks, jsonSha256, readCompletionJsonSync } from '../../../scripts/lib/completion-snapshot.mjs';
import { executedSourceOriginalsPlugin } from './vitest-config';
// The router stays plain Node; exercise its output routing with the real reporter.
// @ts-expect-error the executable .mjs router has no declaration file
import { perGroupVitestEnv } from '../../../scripts/test-files.mjs';

import AdminTestRunsReporter, { inferWorkspaceRoot, type WorktreeGitSnapshot } from './admin-test-runs-reporter';
import { createSourceByteSnapshot, parseRecordedTestPopulation, parseTestRunExecutionDetails } from './execution-details';
import { observeViteTransformOptions, readViteTransformOptions } from './configuration-snapshot.ts';
import { installAppliedCompilerInputCapture, readAppliedCompilerInputs } from './applied-compiler-inputs.ts';
import { inputsFilePath, PC_EXECUTED_INPUTS_DIR_ENV } from './executed-inputs-capture';
import ExecutedSourceMapReporter, {
  COMPLETION_CHECKPOINT_EVERY_COMPLETION,
  COMPLETION_CHECKPOINT_SPACING,
  EXECUTED_SOURCE_MAP_FLUSH_TIMEOUT_MS,
  appendExecutedSourceMapResult,
  captureConfigSources,
  collectExecutedModules,
  completeModuleImports,
  completeWorkerRuntime,
  executedSourceRunContext,
  executedSourceRunnerIdentity,
  isolatedByConfig,
  normalizeExecutedKey,
  qualifyConfigSources,
  resolveConfigDependencies,
  resolveConfigEntries,
  resolveRecordedGitDir,
  shouldRecordModule,
  writeExecutedSourceMapSnapshot,
  createCompletionJournalWriter,
  type ExecutedSourceFlush,
  type ExecutedSourceMapResult,
} from './executed-source-map-reporter';
import { readCompletionSnapshotSync } from '../../../scripts/lib/completion-journal.mjs';

/** WI-6554700010069681: the reporter's out file is a completion journal; this is its folded snapshot. */
function readOutSnapshot(path: string) {
  const read = readCompletionSnapshotSync(path);
  if (read.format !== 'journal' || read.snapshot === null)
    throw new Error(`no committed completion journal at ${path} (format ${read.format})`);
  return read.snapshot;
}

/** The production journal writer, for tests that wrap it. One journal per path; each test has its own tmp dir. */
const writeJournal = createCompletionJournalWriter();

describe('bounded completion JSON', () => {
  it('matches JSON serialization and digest semantics across chunk and UTF-8 boundaries', () => {
    const value = { absent: undefined, arrays: [undefined, null, NaN, Infinity, -0],
      date: new Date('2026-10-24T00:00:00Z'), unicode: '\ud83d\ude42é\ud800',
      many: Array.from({ length: 1000 }, (_, i) => ({ i, text: 'é🙂'.repeat(80) })),
      special: JSON.parse('{"__proto__":{"safe":true},"duplicate":1,"duplicate":2}') };
    const expected = JSON.stringify(value);
    expect([...jsonChunks(value)].join('')).toBe(expected);
    expect(jsonSha256(value)).toBe(createHash('sha256').update(expected).digest('hex'));
    const dir = mkdtempSync(join(tmpdir(), 'completion-json-'));
    try {
      const path = join(dir, 'out.json');
      writeFileSync(path, expected);
      expect(readCompletionJsonSync(path, 7)).toEqual(JSON.parse(expected));
      for (const invalid of ['{"a":', '{"a":1', '{"a":1} trailing', '{"a":1,}', '[1,]']) {
        writeFileSync(path, invalid);
        expect(() => readCompletionJsonSync(path, 7)).toThrow();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([writeExecutedSourceMapSnapshot])(
    'round-trips a large completion population without serializing its aggregate (%#)', async writer => {
      const dir = mkdtempSync(join(tmpdir(), 'completion-population-'));
      const payload = { rows: Array.from({ length: 1000 }, (_, i) => ({
        testFile: `tests/${i}.test.ts`, proof: 'observed-source-🙂'.repeat(100),
      })), completionIntegrity: { schemaVersion: 0, sha256: 'stale' } };
      const expectedHash = createHash('sha256').update(JSON.stringify({ rows: payload.rows })).digest('hex');
      const stringify = JSON.stringify;
      const guard = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
        if (Array.isArray(value) || (value && typeof value === 'object' && 'rows' in value))
          throw new RangeError('Invalid string length: aggregate serialization forbidden');
        return Reflect.apply(stringify, JSON, [value, ...args]);
      }) as typeof JSON.stringify);
      try {
        const path = join(dir, 'out.json');
        await writer(path, payload);
        const saved = readCompletionJsonSync(path);
        expect(saved.rows).toEqual(payload.rows);
        expect(saved.completionIntegrity).toEqual({ schemaVersion: 1, sha256: expectedHash });
        expect(jsonSha256({ rows: saved.rows })).toBe(expectedHash);
      } finally {
        guard.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
});

// gate-test-reuse-yield-2026-10-01 P-001: the config that ran a file is one of its proof inputs.
describe('final worker module handoff', () => {
  const runtime = { name: 'node', version: '25.1.0', executable: '/runtime/node',
    binarySha256: 'a'.repeat(64), platform: 'linux', arch: 'x64',
    nativeDependencyGeneration: 'b'.repeat(64), lockfileSha256: 'c'.repeat(64),
    configurationSha256: 'd'.repeat(64) };

  it('requires actual worker before/after measurements and rejects every changed identity dimension', async () => {
    const { runtimeProofFingerprint } = await import('../../../scripts/lib/runtime-compatibility.mjs');
    const reporterIdentity = `proof-v3 ${runtimeProofFingerprint(runtime)}`;
    const inputs = { testFile: '/repo/test.ts', reads: [], opaque: [],
      runtime: { before: runtime, after: { ...runtime } } };
    expect(completeWorkerRuntime(inputs, reporterIdentity)).toEqual([]);
    for (const field of Object.keys(runtime)) {
      const value = runtime[field as keyof typeof runtime];
      const changed = { ...runtime, [field]: field === 'name' ? 'bun'
        : field === 'executable' ? '/runtime/other' : value.length === 64 ? 'e'.repeat(64) : `${value}-changed` };
      expect(completeWorkerRuntime({ ...inputs, runtime: { before: changed, after: changed } }, reporterIdentity))
        .toContain('worker-runtime-mismatch');
      expect(completeWorkerRuntime({ ...inputs, runtime: { before: runtime, after: changed } }, reporterIdentity))
        .toContain('worker-runtime-changed');
    }
    for (const missing of [null, { ...inputs, runtime: undefined },
      { ...inputs, runtime: { before: runtime, after: null } }]) {
      expect(completeWorkerRuntime(missing, reporterIdentity)).toContain('worker-runtime-unavailable');
    }
    expect(completeWorkerRuntime(inputs, null)).toContain('worker-runtime-unavailable');
  });

  it('unions body imports omitted from collection diagnostics, preserving external flags', () => {
    const collection = { '/repo/static.ts': {} };
    expect(completeModuleImports(collection, { testFile: '/repo/test.ts', reads: [], opaque: [],
      moduleImports: { '/repo/test.ts': { external: false }, '/repo/dynamic.ts': { external: false },
        '/repo/native.cjs': { external: true } },
    })).toEqual({ imports: { ...collection, '/repo/test.ts': { external: false }, '/repo/dynamic.ts': { external: false },
      '/repo/native.cjs': { external: true } }, reasons: [] });
    expect(collection).toEqual({ '/repo/static.ts': {} });
  });

  it('leaves absent or malformed final observations explicitly opaque', () => {
    for (const moduleImports of [undefined, null, [], {}, { '/repo/route.ts': { external: false } },
      { '/repo/test.ts': { external: false }, '/repo/route.ts': { external: 'invalid' } }]) {
      expect(completeModuleImports({ '/repo/static.ts': {} }, { testFile: '/repo/test.ts', reads: [], opaque: [],
        moduleImports } as never).reasons).toEqual(['worker-module-imports-unavailable']);
    }
  });
});

describe('resolveConfigDependencies', () => {
  it('keeps native config entries separate from an unknown dependency population', () => {
    const source = { vite: { config: { configFile: '/repo/config.ts', configFileDependencies: [] } },
      projects: [{ vite: { config: { configFile: '/repo/second.ts' } } },
        { vite: { config: { configFile: false } } }] };
    expect(resolveConfigDependencies(source)).toBeNull();
    expect(resolveConfigEntries(source)).toEqual(['/repo/config.ts', '/repo/second.ts']);
    expect(resolveConfigEntries({ vite: { config: { configFile: 'relative.ts' } } })).toBeNull();
    expect(resolveConfigEntries({ get vite(): never { throw new Error('unavailable'); } })).toBeNull();
  });

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
  const GIT_DIR = '/fake/install/.git';
  const snapshot = (s: WorktreeGitSnapshot) => async () => s;

  function fakeModule(o: { state?: string; isolate?: boolean | undefined; imports?: Record<string, { external?: boolean }> | 'throw'; moduleId?: string; workerImports?: boolean }): TestModule {
    if (o.workerImports) {
      process.env[PC_EXECUTED_INPUTS_DIR_ENV] = tmp;
      writeFileSync(inputsFilePath(tmp, o.moduleId ?? TEST_FILE), JSON.stringify({
        testFile: o.moduleId ?? TEST_FILE, reads: [], opaque: [],
        moduleImports: { [o.moduleId ?? TEST_FILE]: { external: false },
          ...Object.fromEntries(Object.entries(typeof o.imports === 'object' ? o.imports : {})
            .map(([path, info]) => [path, { external: info.external === true }])) },
      }));
    }
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

  function reporter(snap = snapshot(clean), gitDir: string | null = GIT_DIR,
    checkpointOptions?: ConstructorParameters<typeof ExecutedSourceMapReporter>[4]) {
    const flushes: ExecutedSourceFlush[] = [];
    const r = new ExecutedSourceMapReporter(snap, async (flush) => {
      flushes.push(flush);
    }, () => gitDir, undefined, checkpointOptions);
    return { r, flushes };
  }

  beforeEach(() => {
    // Most cases exercise source storage with an unavailable runtime. Runtime
    // binding cases supply independent host and intended-worker measurements.
    vi.spyOn(runtimeProof, 'captureVitestWorkerProofIdentity').mockImplementation(() =>
      runtimeProof.captureCurrentRuntimeProofIdentity({ root: REPO_ROOT }));
    tmp = mkdtempSync(join(tmpdir(), 'esm-reporter-'));
    for (const k of [
      PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV,
      PC_EXECUTED_SOURCE_MAP_OUT_ENV,
      PC_EXECUTED_SOURCE_MAP_RESULT_ENV,
      'PAPERCUSP_TEST_RUN_GROUP',
      'PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID',
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
    process.env.PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID = 'frozen-qualification-attempt';
  });

  const results = (): ExecutedSourceMapResult[] =>
    readFileSync(join(tmp, 'result.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ExecutedSourceMapResult);

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
      recordedGitDir: GIT_DIR,
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
          opaqueReasons: ['worker-module-imports-unavailable', 'worker-runtime-unavailable'],
        },
      ],
    });
    const out = readOutSnapshot(join(tmp, 'out.json'));
    expect(out).toMatchObject({ workspaceName: '@papercusp/test-config', recordedSha: clean.commit, worktreeDirty: false, skipped: 0 });
    expect(out.rows).toHaveLength(1);
  });

  it('keeps the host skip identity while validating a distinct intended worker invocation', async () => {
    const host = { name: 'node', version: '25.1.0', executable: '/runtime/node',
      binarySha256: 'a'.repeat(64), platform: 'linux', arch: 'x64',
      nativeDependencyGeneration: 'b'.repeat(64), lockfileSha256: 'c'.repeat(64),
      configurationSha256: 'd'.repeat(64) };
    const worker = { ...host, configurationSha256: 'e'.repeat(64) };
    vi.spyOn(runtimeProof, 'captureCurrentRuntimeProofIdentity').mockReturnValue(host);
    vi.mocked(runtimeProof.captureVitestWorkerProofIdentity).mockReturnValue(worker);
    const mod = fakeModule({ workerImports: true });
    const path = inputsFilePath(tmp, TEST_FILE);
    const inputs = JSON.parse(readFileSync(path, 'utf8'));
    inputs.runtime = { before: worker, after: worker };
    writeFileSync(path, JSON.stringify(inputs));
    const { r, flushes } = reporter();
    r.onInit({} as never);
    await r.onTestModuleEnd(mod);
    await r.onTestRunEnd();
    expect(flushes[0]!.runnerIdentity).toBe(executedSourceRunnerIdentity());
    expect(flushes[0]!.runnerIdentity).not.toBe(`proof-v3 ${runtimeProof.runtimeProofFingerprint(worker)}`);
    expect(flushes[0]!.rows[0]!.opaqueReasons).not.toContain('worker-runtime-mismatch');
  });

  it('binds persisted passes and failed-file retirement to a stable actual worker runtime', async () => {
    const node = { name: 'node', version: '25.1.0', executable: '/runtime/node',
      binarySha256: 'a'.repeat(64), platform: 'linux', arch: 'x64',
      nativeDependencyGeneration: 'b'.repeat(64), lockfileSha256: 'c'.repeat(64),
      configurationSha256: 'd'.repeat(64) };
    vi.spyOn(runtimeProof, 'captureCurrentRuntimeProofIdentity').mockReturnValue(node);
    const expected = executedSourceRunnerIdentity();
    process.env[PC_EXECUTED_INPUTS_DIR_ENV] = tmp;
    for (const state of ['passed', 'failed']) {
      for (const worker of [node, { ...node, name: 'bun' }, null]) {
        const mod = fakeModule({ state, workerImports: true });
        const recordPath = inputsFilePath(tmp, TEST_FILE);
        const inputs = JSON.parse(readFileSync(recordPath, 'utf8'));
        inputs.runtime = { before: worker, after: worker };
        writeFileSync(recordPath, JSON.stringify(inputs));
        const { r, flushes } = reporter();
        r.onInit({} as never);
        await r.onTestModuleEnd(mod);
        await r.onTestRunEnd();
        expect(flushes).toHaveLength(1);
        expect(flushes[0]!.runnerIdentity).toBe(worker === node ? expected : null);
        if (state === 'passed' && worker !== node) {
          expect(flushes[0]!.rows[0]!.opaqueReasons).toContain(
            worker ? 'worker-runtime-mismatch' : 'worker-runtime-unavailable');
        }
        const out = readOutSnapshot(join(tmp, 'out.json'));
        expect(out.completionCheckpoint.runnerIdentity).toBe(worker === node ? expected : null);
        expect(out.completionCheckpoint.reporterRunnerIdentity).toBe(expected);
      }
    }
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
        recordedGitDir: GIT_DIR,
        runGroupId: 'grp-1',
        workspaceName: '@papercusp/test-config',
        retiredFiles: ['libs/test-config/src/__fake__/thing.test.ts'],
        runContext: executedSourceRunContext(),
        runnerIdentity: executedSourceRunnerIdentity(),
        rows: [],
      },
    ]);
    const out = readOutSnapshot(join(tmp, 'out.json'));
    expect(out.rows).toEqual([]);
    expect(out.skipped).toBe(5);
  });

  it('does not persist from a dirty checkout, or when the tree moved during the run', async () => {
    const dirty = reporter(snapshot({ commit: clean.commit, porcelain: ' M libs/x.ts' }));
    dirty.r.onInit({} as never);
    dirty.r.onTestModuleEnd(fakeModule({}));
    await dirty.r.onTestRunEnd();
    expect(dirty.flushes).toEqual([]);
    const out = readOutSnapshot(join(tmp, 'out.json'));
    expect(out).toMatchObject({ worktreeDirty: true });
    expect(out.rows).toHaveLength(1); // the artifact still says what WOULD have been recorded

    let n = 0;
    const moved = reporter(async () => ({ commit: n++ === 0 ? 'aaaa000' : 'bbbb000', porcelain: '' }));
    moved.r.onInit({} as never);
    moved.r.onTestModuleEnd(fakeModule({}));
    await moved.r.onTestRunEnd();
    expect(moved.flushes).toEqual([]);
  });

  it('does not persist when the git common dir is unresolvable, since its DELETEs could not be scoped (WI-6554700010019324)', async () => {
    const { r, flushes } = reporter(snapshot(clean), null);
    r.onInit({} as never);
    r.onTestModuleEnd(fakeModule({}));
    await r.onTestRunEnd();
    expect(flushes).toEqual([]);
    expect(results()).toEqual([expect.objectContaining({ outcome: 'not-persisted', rows: 1 })]);
  });

  it('resolveRecordedGitDir names the object store, the same from the repo root and from a plain subdirectory', () => {
    const dir = resolveRecordedGitDir(REPO_ROOT);
    expect(dir).toMatch(/\/\.git$/);
    expect(resolveRecordedGitDir(join(REPO_ROOT, 'scripts'))).toBe(dir);
    expect(resolveRecordedGitDir(join(tmp, 'not-a-repo'))).toBeNull();
  });

  it('keeps collected source evidence in OUT across HEAD movement without stamping reusable proof', async () => {
    const self = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.test.ts');
    const source = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.ts');
    const nodes = new Map([self, source].map(id => [id, {
      id, transformResult: { map: { sources: [id], sourcesContent: [readFileSync(id, 'utf8')] } },
    }]));
    const mod = Object.assign(fakeModule({ moduleId: self, imports: { [source]: {} }, workerImports: true }), {
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
    const out = readOutSnapshot(join(tmp, 'out.json'));
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

  it('uses prospective late-transform receipts without reading the final graph or persisting diagnostics', async () => {
    const self = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.test.ts');
    const late = join(REPO_ROOT, 'libs/test-config/src/executed-source-fingerprints.test.ts');
    const unreached = join(REPO_ROOT, 'libs/test-config/src/vitest-config.test.ts');
    const imports = { [self]: {} };
    const environment = { moduleGraph: { idToModuleMap: new Map([[self, {
      id: self, transformResult: { map: { sources: [self], sourcesContent: [readFileSync(self, 'utf8')] } },
    }]]) } };
    const mod = Object.assign(fakeModule({ moduleId: self, imports, workerImports: true }), { viteEnvironment: environment });
    const { r, flushes } = reporter();
    r.onInit({} as never);
    r.onTestModuleCollected(mod);
    const transform = executedSourceOriginalsPlugin().transform as
      (this: { environment: object }, code: string, id: string) => unknown;
    for (const id of [late, unreached]) transform.call({ environment }, readFileSync(id, 'utf8'), id);
    // The worker really reached only late. Another file's transform is not its evidence.
    writeFileSync(inputsFilePath(tmp, self), JSON.stringify({ testFile: self, reads: [], opaque: [],
      moduleImports: { [self]: { external: false }, [late]: { external: false } },
    }));
    Object.defineProperty(environment, 'moduleGraph', { get: () => { throw new Error('final graph is mutable'); } });
    r.onTestModuleEnd(mod);
    await r.onTestRunEnd();
    const out = readOutSnapshot(join(tmp, 'out.json'));
    expect(out.rows[0].sourceEvidence).toMatchObject({ status: 'stable', reasons: [],
      sources: expect.arrayContaining([expect.objectContaining({
        path: 'libs/test-config/src/executed-source-fingerprints.test.ts', basis: 'vite-pre-transform',
        sha256: createHash('sha256').update(readFileSync(late)).digest('hex'),
      })]),
    });
    expect(out.rows[0].sourceEvidence.sources).toHaveLength(2);
    expect(out.rows[0].executedModules).not.toContain('libs/test-config/src/vitest-config.test.ts');
    expect(flushes[0]!.rows[0]).not.toHaveProperty('sourceEvidence');
  });

  it('retains config dependency disk snapshots in OUT without putting them in reusable passes', async () => {
    const config = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.test.ts');
    const hash = createHash('sha256').update(readFileSync(config)).digest('hex');
    const { r, flushes } = reporter();
    r.onInit({ vite: { config: { configFileDependencies: [config] } } } as never);
    r.onTestModuleEnd(fakeModule({}));
    await r.onTestRunEnd();
    const out = readOutSnapshot(join(tmp, 'out.json'));
    expect(out.configSources).toEqual({
      schemaVersion: 'vitest-config-disk-snapshots-v1', scope: 'repository-vite-config-dependencies',
      basis: 'reporter-init-disk', status: 'unchanged', reasons: [],
      sources: [{ path: 'libs/test-config/src/executed-source-map-reporter.test.ts',
        sha256: hash, currentSha256: hash }],
    });
    expect(flushes[0]).not.toHaveProperty('configSources');
  });

  it('passes native config entries to diagnostics without inventing reusable dependencies', async () => {
    const { r, flushes } = reporter();
    r.onInit({ vite: { config: { configFile: '/unobserved/config.mjs', configFileDependencies: [] } } } as never);
    r.onTestModuleEnd(fakeModule({}));
    await r.onTestRunEnd();
    const out = readOutSnapshot(join(tmp, 'out.json'));
    expect(out.configLoadedSources).toMatchObject({ status: 'unknown',
      importPopulation: { basis: 'node-resolve-and-load-observations', status: 'unknown', paths: [] } });
    expect(out.configLoadedSources.importPopulation.unresolved).toContain('config-import-outside-repository');
    expect(flushes[0]).not.toHaveProperty('configLoadedSources');
    expect(flushes[0]).not.toHaveProperty('importPopulation');
  });

  describe('native runner outcomes in OUT', () => {
    function nativeModule(states: string[], state = 'passed', retryCount = 0): TestModule {
      return Object.assign(fakeModule({ state }), {
        children: { allTests: () => states.map(status => ({
          fullName: 'same case title', result: () => ({ state: status }),
          diagnostic: () => ({ duration: 1, retryCount, flaky: retryCount > 0 }),
        })) },
      });
    }

    function nativeOut() {
      return readOutSnapshot(join(tmp, 'out.json')).nativeRun;
    }

    function populationModule(count = 3) {
      const mod = nativeModule(Array.from({ length: count }, () => 'passed'));
      const tests = Array.from(mod.children.allTests()).map((test, index) => Object.assign(test, {
        id: `case-${index}`, module: mod, options: { mode: 'run' },
        fullName: index < 2 ? 'duplicate title' : `case ${index} ${'long title '.repeat(300)}`,
      }));
      Object.assign(mod, { project: { ...mod.project, name: 'population-project' },
        children: { allTests: () => tests } });
      return { mod, tests };
    }

    function selectPopulation(r: ExecutedSourceMapReporter, projectName = 'population-project', copies = 1) {
      r.onTestRunStart(Array.from({ length: copies }, () => ({
        moduleId: TEST_FILE, project: { name: projectName }, pool: 'forks',
      })) as never);
    }

    it.each(['native-first', 'ledger-first'])('retains the same worker dependency, compiler search and source-byte measurement for %s callback order', async order => {
      const worker = { name: 'node', version: '25.1.0', executable: '/qualified/node', platform: 'linux', arch: 'x64',
        binarySha256: '1'.repeat(64), lockfileSha256: '2'.repeat(64), nativeDependencyGeneration: '3'.repeat(64),
        configurationSha256: '4'.repeat(64) };
      const runtime = { before: worker, after: worker };
      const testConfiguration = { schemaVersion: 'vitest-worker-configuration-v1',
        before: '5'.repeat(64), after: '5'.repeat(64) };
      const processIdentity = { pid: 123, threadId: 0, bootId: '01234567-89ab-cdef-0123-456789abcdef', startTicks: '456' };
      const workerExecution = { schemaVersion: 'worker-execution-v1',
        captureId: '12345678-9abc-def0-1234-56789abcdef0', testFile: TEST_FILE,
        before: processIdentity, after: processIdentity };
      const compilerInputs = { schemaVersion: 'worker-compiler-inputs-v1', scope: 'vitest-inlined-vm-calls',
        populationStatus: 'unknown', captureId: workerExecution.captureId, testFile: TEST_FILE,
        inputSha256: '6'.repeat(64), vmCallCount: 1,
        missing: ['transform-pipeline-unobserved', 'vm-options-partially-observed'] };
      const viteEnvironment = {};
      observeViteTransformOptions(viteEnvironment, { root: ROOT, esbuild: { target: 'esnext' } });
      const viteTransformOptions = readViteTransformOptions(viteEnvironment)!;
      const compilerConfig = {};
      expect(installAppliedCompilerInputCapture(compilerConfig)).toBe(true);
      const tsconfigSearch = { schemaVersion: 'tsconfig-resolution-search-v1', status: 'partial',
        lookups: [{ path: join(ROOT, 'tsconfig.json'), outcome: 'file', errorCode: null }],
        extends: [], cacheHits: [{ kind: 'parse', path: join(ROOT, 'tsconfig.json') }], truncated: false };
      const settle = Object.getOwnPropertyDescriptor(compilerConfig, Symbol.for('@papercusp/test-config.applied-compiler-observer-v1'))!.value({
        version: 1, environment: viteEnvironment, moduleId: TEST_FILE, code: 'export const n = 1',
        options: { target: 'es2022' }, tsconfig: { status: 'not-used', inputs: [], search: tsconfigSearch }, implementation: null,
      });
      settle({ status: 'success', result: { code: 'export const n = 1', map: '' } });
      const appliedCompilerInputs = readAppliedCompilerInputs(viteEnvironment)!;
      expect(appliedCompilerInputs).toBeDefined();
      expect(appliedCompilerInputs.calls[0]).toMatchObject({ tsconfigSearch, outcome: { status: 'success' } });
      expect(appliedCompilerInputs.missing).toContain('tsconfig-resolution-search-unobserved');
      expect(appliedCompilerInputs.missing).not.toContain('compiler-outcome-unobserved');
      process.env.PAPERCUSP_TEST_RUN_GROUP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const at = new Date().toISOString();
      const workerDatabaseReset = { schemaVersion: 'worker-database-reset-v1', captureId: workerExecution.captureId,
        testFile: TEST_FILE, runGroupId: process.env.PAPERCUSP_TEST_RUN_GROUP, startedAt: at, finishedAt: at,
        databases: [{ allocationId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', name: 'it_0123456789ab',
          origin: 'empty', startedAt: at, readyAt: at, cleanup: { at, outcome: 'dropped' } }] };
      process.env[PC_EXECUTED_INPUTS_DIR_ENV] = tmp;
      const path = inputsFilePath(tmp, TEST_FILE);
      writeFileSync(path, JSON.stringify({ testFile: TEST_FILE, reads: [], opaque: [], runtime, testConfiguration,
        workerExecution, workerDatabaseReset, compilerInputs }));
      const sourcePin = createSourceByteSnapshot([{ path: 'source.ts', sha256: '1'.repeat(64) }])!;
      const source = { ...clean, sourceBytes: sourcePin,
        submodules: [['libs/observed', 'a'.repeat(40)]] as [string, string][] };
      const { r } = reporter(snapshot(source));
      const { mod, tests } = populationModule();
      Object.assign(mod, { viteEnvironment });
      const rows: Array<{ executionDetails?: unknown }> = [];
      const ledger = new AdminTestRunsReporter(snapshot(source), async row => { rows.push(row); });
      await ledger.onInit({} as never);
      r.onInit({} as never);
      selectPopulation(r);
      ledger.onTestModuleCollected(mod);
      r.onTestModuleCollected(mod);
      for (const test of tests) { ledger.onTestCaseReady(test as never); r.onTestCaseReady(test as never); }
      if (order === 'native-first') { await r.onTestModuleEnd(mod); ledger.onTestModuleEnd(mod); }
      else { ledger.onTestModuleEnd(mod); await r.onTestModuleEnd(mod); }
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8')).compilerInputs).toEqual(compilerInputs);
      const original = nativeOut().files[0];
      await r.onTestRunEnd([mod], [], 'passed');
      expect(existsSync(path)).toBe(false);
      await ledger.onTestRunEnd();
      const details = parseTestRunExecutionDetails(rows[0]?.executionDetails);
      expect(details?.workerRuntime).toEqual(runtime);
      expect(details?.workerTestConfiguration).toEqual(testConfiguration);
      expect(details?.workerExecution).toEqual(workerExecution);
      expect(original.proof.inputs.workerExecution).toEqual(workerExecution);
      expect(details?.workerCompilerInputs).toEqual({ ...compilerInputs, viteTransformOptions, appliedCompilerInputs });
      expect(original.proof.inputs.compilerInputs).toEqual({ ...compilerInputs, viteTransformOptions, appliedCompilerInputs });
      expect(details?.proofContext?.components.compilerConfiguration).toBeNull();
      expect(details?.workerDatabaseReset).toEqual(workerDatabaseReset);
      expect(original.proof.inputs.workerDatabaseReset).toEqual(workerDatabaseReset);
      expect(details?.proofContext?.components.fixtures).toBeNull();
      expect(details?.proofContext?.components.testConfiguration).toMatch(/^[a-f0-9]{64}$/);
      expect(original.proof.inputs.testConfiguration).toEqual(testConfiguration);
      expect(details?.proofContext).toEqual(original.proofContext);
      expect(details?.proofContext?.components.dependencies).toMatch(/^[a-f0-9]{64}$/);
      expect(details?.sourceSubmodules).toEqual(original.sourceSubmodules);
      expect(details?.sourceBytes).toEqual(original.sourceBytes);
      expect(details?.proofContext?.components.source).toBe(sourcePin.sha256);
      expect(nativeOut().files[0].sourceBytes).toEqual(original.sourceBytes);
      expect(details?.proofContext?.components.submodules).toMatch(/^[a-f0-9]{64}$/);
      expect(nativeOut().files[0].sourceSubmodules).toEqual(original.sourceSubmodules);
      expect(details?.proofContext?.components.runtimeCapabilities).toBeNull();
      await ledger.onExit();
    });

    it('binds the full uncapped ledger population to its original native manifest and completion receipt', async () => {
      const { r, flushes } = reporter();
      const { mod, tests } = populationModule(1_300);
      const ledgerRows: Array<{ executionDetails?: unknown }> = [];
      const ledger = new AdminTestRunsReporter(snapshot(clean), async row => { ledgerRows.push(row); });
      await ledger.onInit({ config: {}, vite: { config: {} } } as never);
      r.onInit({} as never);
      selectPopulation(r);
      ledger.onTestModuleCollected(mod);
      r.onTestModuleCollected(mod);
      // Actual event order, including a repeated attempt, is distinct from
      // sorted population order and must survive both producer paths.
      for (const test of [...tests].reverse().concat(tests[0]!)) {
        ledger.onTestCaseReady(test as never);
        r.onTestCaseReady(test as never);
      }
      ledger.onTestModuleEnd(mod);
      await r.onTestModuleEnd(mod);
      const checkpoint = readOutSnapshot(join(tmp, 'out.json'));
      const original = checkpoint.nativeRun.files[0];
      expect(original.populationCaptureStatus).toBe('captured');
      expect(original.population).toBeDefined();
      expect(parseRecordedTestPopulation(original.population)).toEqual(original.population);
      expect(original.population.cases).toHaveLength(1_300);
      expect(original.population.cases.filter((row: { identity: unknown[] }) => row.identity[2] === 'duplicate title')
        .map((row: { identity: unknown[] }) => row.identity[3])).toEqual([1, 2]);
      expect(original.population.cases.some((row: { identity: string[] }) => row.identity[2]!.length > 2_048)).toBe(true);
      expect(original.population.executionOrder).toHaveLength(1_301);
      expect(checkpoint.completionCheckpoint).toMatchObject({ runGroupId: 'grp-1',
        qualificationAttemptId: 'frozen-qualification-attempt' });
      expect(checkpoint.nativeRun.selectedPopulationMatched).toBe(false);
      await ledger.onTestRunEnd();
      const execution = ledgerRows[0]?.executionDetails as { population?: unknown; proofContext?: unknown };
      expect(execution?.population).toEqual(original.population);
      expect(execution?.proofContext).toEqual(original.proofContext);
      await r.onTestRunEnd([mod], [], 'passed');
      expect(nativeOut().selectedPopulationMatched).toBe(true);
      expect(nativeOut().files[0]).toEqual(original);
      expect(flushes[0]!.rows[0]).not.toHaveProperty('population');
      await ledger.onExit();
    });

    it.each(['no-collection', 'missing-ready', 'changed-title', 'unknown-selection', 'duplicate-id',
      'missing-case', 'wrong-project', 'missing-module', 'unselected-module', 'exit-only'] as const)(
      'keeps native population proof ineligible for %s', async damage => {
        const { r } = reporter();
        const { mod, tests } = populationModule();
        r.onInit({} as never);
        selectPopulation(r, damage === 'wrong-project' ? 'another-project' : 'population-project',
          damage === 'missing-module' ? 2 : damage === 'unselected-module' ? 0 : 1);
        if (damage === 'unknown-selection') Object.assign(tests[0]!.options, { mode: 'unknown' });
        if (damage === 'duplicate-id') tests[1]!.id = tests[0]!.id;
        if (damage !== 'no-collection') r.onTestModuleCollected(mod);
        for (const test of damage === 'missing-ready' ? tests.slice(1) : tests) r.onTestCaseReady(test as never);
        if (damage === 'changed-title') tests[0]!.fullName = 'changed after collection';
        if (damage === 'missing-case') tests.pop();
        await r.onTestModuleEnd(mod);
        if (damage === 'exit-only') await r.onExit();
        else await r.onTestRunEnd([mod], [], 'passed');
        const out = nativeOut();
        expect(out.selectedPopulationMatched).toBe(false);
        const collectionIntact = ['wrong-project', 'missing-module', 'unselected-module', 'exit-only'].includes(damage);
        if (collectionIntact) expect(out.files[0].populationCaptureStatus).toBe('captured');
        else {
          expect(out.files[0].populationCaptureStatus).not.toBe('captured');
          expect(out.files[0]).not.toHaveProperty('population');
        }
      });

    it('saves passing, failing and infrastructure outcomes with their proofs before suite end', async () => {
      // Per-completion mode: this pins what each partial write carries. Spaced writes are covered below.
      const { r, flushes } = reporter(snapshot(clean), GIT_DIR, { spacing: COMPLETION_CHECKPOINT_EVERY_COMPLETION });
      r.onInit({} as never);
      for (const state of ['passed', 'failed', 'error']) {
        await r.onTestModuleEnd(nativeModule([state === 'passed' ? 'passed' : 'failed'], state));
        const checkpoint = readOutSnapshot(join(tmp, 'out.json'));
        expect(checkpoint).toMatchObject({ recordedSha: clean.commit, worktreeDirty: false,
          recordedGitDir: GIT_DIR, completionCheckpoint: { schemaVersion: 1, state: 'partial',
            runGroupId: 'grp-1', runnerIdentity: executedSourceRunnerIdentity(),
            runContext: executedSourceRunContext() },
          nativeRun: { terminalHook: null, finishedAtMs: null },
        });
        expect(checkpoint.nativeRun.files.at(-1)).toMatchObject({ state,
          completionId: expect.any(String), proof: { inputs: null,
            sourceEvidence: expect.objectContaining({ status: expect.any(String) }) },
        });
      }
      expect(nativeOut().files.map((file: { state: string }) => file.state)).toEqual(['passed', 'failed', 'error']);
      expect(new Set(nativeOut().files.map((file: { completionId: string }) => file.completionId)).size).toBe(3);
      expect(flushes).toEqual([]);
      await r.onExit();
    });

    it('pins the selected population and filters before completion rather than deriving them from finished files', async () => {
      const { r } = reporter();
      r.onInit({} as never);
      const selected = [{ moduleId: TEST_FILE, project: { name: 'one' }, pool: 'forks',
        testNamePattern: /exact case/, testLines: [12], testIds: ['selected-case'] },
      { moduleId: SOURCE, project: { name: 'two' }, pool: 'forks' }];
      r.onTestRunStart(selected as never);
      selected[0]!.testIds!.push('late-change');
      process.env.PAPERCUSP_TEST_RUN_GROUP = 'different-group-after-start';
      await r.onTestModuleEnd(nativeModule(['passed']));
      const saved = readOutSnapshot(join(tmp, 'out.json'));
      const manifest = saved.nativeRun.selectedManifest;
      expect(manifest.specifications).toHaveLength(2);
      expect(manifest.specifications).toContainEqual(expect.objectContaining({ projectName: 'one',
        testNamePattern: '/exact case/', testLines: [12], testIds: ['selected-case'] }));
      expect(manifest.sha256).toBe(createHash('sha256').update(JSON.stringify(manifest.specifications)).digest('hex'));
      expect(saved.nativeRun.files).toHaveLength(1);
      expect(saved.completionCheckpoint.runGroupId).toBe('grp-1');
      expect(saved.completionCheckpoint.qualificationAttemptId).toBe('frozen-qualification-attempt');
      expect(saved.sourceSnapshot).toEqual(clean);
      await r.onExit();
    });

    it('acknowledges only newly committed IDs, after the matching outcome and proof are readable', async () => {
      const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const savedIds: string[] = [];
        const recorder = new ExecutedSourceMapReporter(snapshot(clean), async () => {}, () => GIT_DIR,
          async (path, payload, writeOptions) => {
            const acknowledged = writes.mock.calls.filter(([line]) => String(line).includes('COMPLETION_ACK')).length;
            expect(acknowledged).toBe(savedIds.length);
            await writeJournal(path, payload, writeOptions);
            const saved = readOutSnapshot(path);
            savedIds.push(saved.nativeRun.files.at(-1).completionId);
          }, { spacing: COMPLETION_CHECKPOINT_EVERY_COMPLETION });
        recorder.onInit({} as never);
        await recorder.onTestModuleEnd(nativeModule(['passed']));
        await recorder.onTestModuleEnd(nativeModule(['failed'], 'failed'));
        const acknowledgments = writes.mock.calls.filter(([line]) => String(line).includes('COMPLETION_ACK'));
        expect(acknowledgments).toHaveLength(2);
        expect(String(acknowledgments[0]![0])).toContain(JSON.stringify([savedIds[0]]));
        expect(String(acknowledgments[1]![0])).toContain(JSON.stringify([savedIds[1]]));
      } finally {
        writes.mockRestore();
      }
    });

    it('does not acknowledge a failed write and retains the prior complete snapshot', async () => {
      const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        let failWrite = false;
        const recorder = new ExecutedSourceMapReporter(snapshot(clean), async () => {}, () => GIT_DIR,
          async (path, payload, writeOptions) => {
            if (failWrite) throw new Error('injected write failure');
            await writeJournal(path, payload, writeOptions);
          }, { spacing: COMPLETION_CHECKPOINT_EVERY_COMPLETION });
        recorder.onInit({} as never);
        await recorder.onTestModuleEnd(nativeModule(['passed']));
        const previous = readFileSync(join(tmp, 'out.json'), 'utf8');
        failWrite = true;
        await expect(recorder.onTestModuleEnd(nativeModule(['failed'], 'failed'))).resolves.toBeUndefined();
        expect(readFileSync(join(tmp, 'out.json'), 'utf8')).toBe(previous);
        expect(writes.mock.calls.filter(([line]) => String(line).includes('COMPLETION_ACK'))).toHaveLength(1);
        failWrite = false;
        await recorder.onTestModuleEnd(nativeModule(['failed'], 'error'));
        const lastAck = writes.mock.calls.filter(([line]) => String(line).includes('COMPLETION_ACK')).at(-1);
        expect(String(lastAck?.[0])).toContain(JSON.stringify(nativeOut().files.slice(1)
          .map((file: { completionId: string }) => file.completionId)));
      } finally {
        writes.mockRestore();
      }
    });

    it('finishes the before census at initialization and remeasures at the partial and terminal boundaries', async () => {
      const bytes = (digit: string) => ({ schemaVersion: 'source-bytes-v1' as const,
        fileCount: 1, sha256: digit.repeat(64) });
      let release!: () => void;
      const before = new Promise<void>(resolve => { release = resolve; });
      const read = vi.fn<() => Promise<WorktreeGitSnapshot>>()
        .mockImplementationOnce(async () => { await before; return { ...clean, sourceBytes: bytes('1') }; })
        .mockResolvedValueOnce({ ...clean, sourceBytes: bytes('2') })
        .mockResolvedValueOnce({ ...clean, sourceBytes: bytes('3') });
      const { r } = reporter(read);
      let initialized = false;
      const init = Promise.resolve(r.onInit({} as never)).then(() => { initialized = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(initialized).toBe(false);
      release();
      await init;
      await r.onTestModuleEnd(nativeModule(['passed']));
      expect(nativeOut().files[0].sourceBytes).toMatchObject({ before: bytes('1'), after: bytes('2') });
      await r.onTestRunEnd();
      expect(nativeOut().files[0].sourceBytes).toMatchObject({ before: bytes('1'), after: bytes('3') });
      expect(read).toHaveBeenCalledTimes(3);
    });

    it('awaits an asynchronous snapshot before acknowledging completion or finishing the run', async () => {
      const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      try {
        const recorder = new ExecutedSourceMapReporter(snapshot(clean), async () => {}, () => GIT_DIR,
          async (path, payload, writeOptions) => {
            entered();
            await ready;
            await writeJournal(path, payload, writeOptions);
          });
        recorder.onInit({} as never);
        let completed = false;
        const pending = recorder.onTestModuleEnd(nativeModule(['passed'])).then(() => { completed = true; });
        await started;
        await new Promise(resolve => setImmediate(resolve));
        expect(completed).toBe(false);
        expect(writes.mock.calls.some(([line]) => String(line).includes('COMPLETION_ACK'))).toBe(false);
        release();
        await pending;
        expect(writes.mock.calls.filter(([line]) => String(line).includes('COMPLETION_ACK'))).toHaveLength(1);
        await recorder.onTestRunEnd();
        expect(readOutSnapshot(join(tmp, 'out.json')).completionCheckpoint.state).toBe('terminal');
      } finally {
        release();
        writes.mockRestore();
      }
    });

    // WI-6554700010069314: a gate lane aborted at the 4 GB heap limit while each completion snapshot
    // was hundreds of MB. Cloning the cumulative payload when a completion was QUEUED kept one full
    // copy per completion that arrived during a slow write; the completions that arrive meanwhile
    // share one later write that carries and acknowledges them.
    // WI-6554700010069671: even ONE deep copy per write in flight duplicated the whole cumulative state
    // (GBs on gate lanes) and was the allocation that killed the lane-stateful Vitest main process
    // (gate run 87f675e2). A write freezes its population by copying containers only: no
    // structuredClone of the payload, and a later write carries the SAME record objects.
    it.each([1, 2, 3])('holds no snapshot copy in flight and coalesces %i completions that arrive during it', async burst => {
      const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const clones = vi.spyOn(globalThis, 'structuredClone');
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const written: string[][] = [];
      const writtenProofs: unknown[][] = [];
      const checkpointCopies = () => clones.mock.calls.filter(([value]) =>
        typeof value === 'object' && value !== null && 'completionCheckpoint' in value).length;
      try {
        const recorder = new ExecutedSourceMapReporter(snapshot(clean), async () => {}, () => GIT_DIR,
          async (path, payload, writeOptions) => {
            const files = (payload as { nativeRun: { files: ReadonlyArray<{ completionId: string; proof?: unknown }> } })
              .nativeRun.files;
            written.push(files.map(file => file.completionId));
            writtenProofs.push(files.map(file => file.proof));
            if (written.length === 1) { entered(); await gate; }
            await writeJournal(path, payload, writeOptions);
          // Per-completion mode pins the one-copy coalescing invariant; spacing is covered below.
          }, { spacing: COMPLETION_CHECKPOINT_EVERY_COMPLETION });
        recorder.onInit({} as never);
        const first = recorder.onTestModuleEnd(nativeModule(['passed']));
        await started;
        const during = Array.from({ length: burst }, () => recorder.onTestModuleEnd(nativeModule(['passed'])));
        await new Promise(resolve => setImmediate(resolve));
        expect(checkpointCopies()).toBe(0);
        expect(written).toHaveLength(1);
        release();
        await Promise.all([first, ...during]);
        const ids: string[] = nativeOut().files.map((file: { completionId: string }) => file.completionId);
        expect(ids).toHaveLength(burst + 1);
        expect(written).toEqual([ids.slice(0, 1), ids]);
        expect(checkpointCopies()).toBe(0);
        // WI-6554700010069681: the first append made completion 0 durable, so the reporter dropped its proof
        // from memory: the second write carries only its light record, and the journal alone keeps the proof.
        expect(writtenProofs).toHaveLength(2);
        expect(writtenProofs[0][0]).toBeTruthy();
        expect(writtenProofs[1][0]).toBeUndefined();
        expect(nativeOut().files[0].proof).toEqual(writtenProofs[0][0]);
        const acknowledged = writes.mock.calls
          .map(([line]) => /COMPLETION_ACK ids=(\[[^\]]*\])/.exec(String(line))?.[1])
          .filter((match): match is string => match !== undefined)
          .map(match => JSON.parse(match) as string[]);
        expect(acknowledged).toEqual([ids.slice(0, 1), ids.slice(1)]);
      } finally {
        release();
        clones.mockRestore();
        writes.mockRestore();
      }
    });

    // WI-6554700010069387: a partial write re-serializes the whole cumulative snapshot (450-900 MB on gate
    // lanes), and Vitest awaits this hook before a worker moves on. After the first completion, partial
    // writes are spaced; completions in between ride the next one and their hooks do not wait for it.
    describe('spaced completion checkpoints', () => {
      const INTERVAL_MS = COMPLETION_CHECKPOINT_SPACING.minIntervalMs;

      function spacedRecorder(options: { writeMs?: number; holdFirstWrite?: Promise<void> } = {}) {
        let clock = 1_000;
        let firstWriteStarted!: () => void;
        const started = new Promise<void>(resolve => { firstWriteStarted = resolve; });
        const waits: Array<{ ms: number; elapse: () => void }> = [];
        const written: string[][] = [];
        const recorder = new ExecutedSourceMapReporter(snapshot(clean), async () => {}, () => GIT_DIR,
          async (path, payload, writeOptions) => {
            written.push((payload as { nativeRun: { files: ReadonlyArray<{ completionId: string }> } })
              .nativeRun.files.map(file => file.completionId));
            if (written.length === 1) { firstWriteStarted(); await options.holdFirstWrite; }
            clock += options.writeMs ?? 2_000; // the measured duration of this write
            await writeJournal(path, payload, writeOptions);
          },
          { spacing: COMPLETION_CHECKPOINT_SPACING, now: () => clock,
            wait: ms => new Promise<void>(resolve => { waits.push({ ms, elapse: resolve }); }) });
        return { recorder, written, waits, started, advance: (ms: number) => { clock += ms; } };
      }
      const ackedIds = (writes: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) => writes.mock.calls
        .map(([line]) => /COMPLETION_ACK ids=(\[[^\]]*\])/.exec(String(line))?.[1])
        .filter((match): match is string => match !== undefined)
        .map(match => JSON.parse(match) as string[]);
      const completionIds = (): string[] => nativeOut().files.map((file: { completionId: string }) => file.completionId);
      const settle = () => new Promise(resolve => setImmediate(resolve));

      it('writes the first completion at once, and its hook waits for that write', async () => {
        const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const { recorder, written, waits } = spacedRecorder();
        await recorder.onInit({} as never);
        await recorder.onTestModuleEnd(nativeModule(['passed']));
        expect(written).toEqual([completionIds()]);
        expect(ackedIds(writes)).toEqual([completionIds()]);
        expect(waits).toEqual([]);
      });

      it.each([
        { offsetMs: -1, deferred: true },
        { offsetMs: 0, deferred: false },
        { offsetMs: 1, deferred: false },
      ])('a completion $offsetMs ms past the interval end is deferred: $deferred', async ({ offsetMs, deferred }) => {
        const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const { recorder, written, waits, advance } = spacedRecorder();
        await recorder.onInit({} as never);
        await recorder.onTestModuleEnd(nativeModule(['passed']));
        advance(INTERVAL_MS + offsetMs);
        let returned = false;
        const second = recorder.onTestModuleEnd(nativeModule(['failed'], 'failed')).then(() => { returned = true; });
        await settle();
        if (deferred) {
          // The hook returned without waiting, nothing is written inside the interval, and the spaced
          // write waits out exactly the rest of it.
          expect(returned).toBe(true);
          expect(written).toHaveLength(1);
          expect(waits.map(wait => wait.ms)).toEqual([-offsetMs]);
          waits[0]!.elapse();
          await vi.waitFor(() => expect(ackedIds(writes)).toHaveLength(2));
        }
        await second;
        const ids = completionIds();
        expect(written).toEqual([ids.slice(0, 1), ids]);
        expect(ackedIds(writes)).toEqual([ids.slice(0, 1), ids.slice(1)]);
        if (!deferred) expect(waits).toEqual([]);
      });

      it.each([1, 2, 3])('%i completions inside one interval ride one spaced write', async count => {
        const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const { recorder, written, waits, advance } = spacedRecorder();
        await recorder.onInit({} as never);
        await recorder.onTestModuleEnd(nativeModule(['passed']));
        advance(5_000);
        for (let index = 0; index < count; index += 1) await recorder.onTestModuleEnd(nativeModule(['passed']));
        await settle();
        // Every hook returned with nothing written: ONE spaced write is queued, not one per completion.
        expect(written).toHaveLength(1);
        expect(waits.map(wait => wait.ms)).toEqual([INTERVAL_MS - 5_000]);
        waits[0]!.elapse();
        await vi.waitFor(() => expect(ackedIds(writes)).toHaveLength(2));
        const ids = completionIds();
        expect(ids).toHaveLength(count + 1);
        expect(written).toEqual([ids.slice(0, 1), ids]);
        expect(ackedIds(writes)).toEqual([ids.slice(0, 1), ids.slice(1)]);
      });

      it('scales the interval with the last write\'s duration', async () => {
        const { recorder, waits, advance } = spacedRecorder({ writeMs: 7_000 });
        await recorder.onInit({} as never);
        await recorder.onTestModuleEnd(nativeModule(['passed']));
        advance(20_000);
        await recorder.onTestModuleEnd(nativeModule(['passed']));
        await settle();
        // max(30 s, 10 x 7 s) = 70 s after the first write ended, of which 20 s have passed.
        expect(waits.map(wait => wait.ms)).toEqual([50_000]);
      });

      it('completions during an in-flight write ride a spaced write after it, and wait for neither', async () => {
        const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        let release!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; });
        const { recorder, written, waits, started } = spacedRecorder({ holdFirstWrite: hold });
        await recorder.onInit({} as never);
        const first = recorder.onTestModuleEnd(nativeModule(['passed']));
        await started;
        await recorder.onTestModuleEnd(nativeModule(['failed'], 'failed'));
        expect(written).toHaveLength(1);
        release();
        await first;
        await settle();
        expect(waits.map(wait => wait.ms)).toEqual([INTERVAL_MS]);
        waits[0]!.elapse();
        await vi.waitFor(() => expect(ackedIds(writes)).toHaveLength(2));
        const ids = completionIds();
        expect(written).toEqual([ids.slice(0, 1), ids]);
        expect(ackedIds(writes)).toEqual([ids.slice(0, 1), ids.slice(1)]);
      });

      it('run end skips the spaced write: the final write carries and acknowledges every completion', async () => {
        const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const { recorder, written, waits } = spacedRecorder();
        await recorder.onInit({} as never);
        await recorder.onTestModuleEnd(nativeModule(['passed']));
        await recorder.onTestModuleEnd(nativeModule(['failed'], 'failed'));
        await recorder.onTestModuleEnd(nativeModule(['passed']));
        await settle();
        expect(waits).toHaveLength(1);
        await recorder.onTestRunEnd(); // never waits out the interval: the wait above is never elapsed
        const final = readOutSnapshot(join(tmp, 'out.json'));
        const ids: string[] = final.nativeRun.files.map((file: { completionId: string }) => file.completionId);
        expect(ids).toHaveLength(3);
        expect(final.completionCheckpoint.state).toBe('terminal');
        // The first partial write and the final write only: no partial write raced the final one.
        expect(written).toEqual([ids.slice(0, 1), ids]);
        expect(ackedIds(writes)).toEqual([ids.slice(0, 1), ids.slice(1)]);
      });

      it('a kill inside the interval leaves the deferred completions off disk and unacknowledged', async () => {
        const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const { recorder, waits } = spacedRecorder();
        await recorder.onInit({} as never);
        await recorder.onTestModuleEnd(nativeModule(['passed']));
        await recorder.onTestModuleEnd(nativeModule(['failed'], 'failed'));
        await settle();
        // The process dies here, before the spaced write: resume re-runs exactly the unacknowledged one.
        expect(waits).toHaveLength(1);
        const onDisk = completionIds();
        expect(onDisk).toHaveLength(1);
        expect(ackedIds(writes)).toEqual([onDisk]);
      });

      it('a new run writes its first completion at once, whatever the previous run last wrote', async () => {
        const { recorder, written, waits } = spacedRecorder();
        await recorder.onInit({} as never);
        await recorder.onTestModuleEnd(nativeModule(['passed']));
        await recorder.onTestRunEnd();
        await recorder.onInit({} as never);
        await recorder.onTestModuleEnd(nativeModule(['passed']));
        expect(waits).toEqual([]);
        expect(written).toHaveLength(3);
        expect(completionIds()).toHaveLength(1);
      });
    });

    it('allows real Vitest fork shutdown during delayed snapshot fsync', async () => {
      const require = createRequire(import.meta.url);
      writeFileSync(join(tmp, 'probe.test.ts'), 'test("tiny fork", () => expect(true).toBe(true));\n');
      const probe = join(tmp, 'snapshot-stop.mjs');
      writeFileSync(probe, `
        import fs from 'node:fs';
        import { open } from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        import { Writable } from 'node:stream';
        import { join } from 'node:path';
        const { createVitest, ForksPoolWorker } = await import(${JSON.stringify(pathToFileURL(require.resolve('vitest/node')).href)});
        // WI-6554700010069681: the production writer is the async completion journal; its sync primitives are the
        // loop-blocking contrast.
        const { createCompletionJournalWriter } = await import(${JSON.stringify(new URL('./executed-source-map-reporter.ts', import.meta.url).href)});
        const { appendCompletionCheckpointSync, closeCompletionJournalSync, createCompletionJournalSync,
          readCompletionSnapshotSync } = await import(${JSON.stringify(new URL('../../../scripts/lib/completion-journal.mjs', import.meta.url).href)});
        const view = { workspaceName: 'snapshot-stop', rows: [{ outcome: 'pass', proof: 'same payload' }], diagnostics: [],
          nativeRun: { files: [], selectedManifest: null }, skipped: 0, configSources: null, configLoadedSources: null,
          mainProcessLoadedSources: null, completionCheckpoint: { state: 'terminal' }, recordedSha: null,
          recordedGitDir: null, worktreeDirty: true, sourceBytes: null, sourceSubmodules: null };
        const [root, mode] = process.argv.slice(2), events = [], logs = [];
        const handle = await open(join(root, 'handle-' + mode), 'wx');
        const prototype = Object.getPrototypeOf(handle), originalSync = prototype.sync;
        await handle.close();
        const sync = fs.fsyncSync;
        fs.fsyncSync = function(fd) {
          events.push('fsync-start');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
          return sync(fd);
        };
        syncBuiltinESMExports();
        // EI-29610214403068136: hold the async fsync until the fork has exited (capped), not for a fixed
        // second. Under load a forked worker can take longer than any fixed window to exit, so the proof
        // is the ORDER: the worker exits while this write is still pending, which only a free event loop
        // allows. A writer that blocks the loop finishes first instead (and the sync arm warns).
        let notifyExited;
        const exited = new Promise(resolve => { notifyExited = resolve; });
        prototype.sync = async function() {
          events.push('fsync-start');
          let cap;
          await Promise.race([exited, new Promise(resolve => { cap = setTimeout(resolve, 10_000); })]);
          // WI-6554700010069703: an uncleared cap holds this process open for the full 10 s after the race.
          clearTimeout(cap);
          return originalSync.call(this);
        };
        let notifyStop;
        const stopped = new Promise(resolve => { notifyStop = resolve; });
        const stream = new Writable({ write(chunk, encoding, done) { logs.push(String(chunk)); done(); } });
        const runner = await createVitest('test', { root, config: false, watch: false,
          globals: true, include: ['probe.test.ts'], maxWorkers: 1,
          // The sync arm blocks the loop for 1000 ms, past a 300 ms teardown; the async arm must never warn.
          teardownTimeout: mode === 'sync' ? 300 : 10_000,
          pool: { name: 'snapshot-forks', createPoolWorker(options) {
            events.push('pool-created');
            const worker = new ForksPoolWorker(options), send = worker.send.bind(worker), stop = worker.stop.bind(worker);
            worker.send = message => {
              send(message);
              if (message.type === 'stop') { events.push('stop-request'); notifyStop(); }
            };
            worker.stop = async () => { await stop(); events.push('worker-exited'); notifyExited(); };
            return worker;
          } },
          reporters: [{ async onTestRunEnd(modules, errors, reason) {
            if (reason !== 'passed' || errors.length || modules.length !== 1) throw new Error('tiny test did not pass');
            await stopped;
            const path = join(root, mode + '.json');
            if (mode === 'sync') {
              const journal = createCompletionJournalSync(path);
              try { appendCompletionCheckpointSync(journal, view, { final: true }); }
              finally { closeCompletionJournalSync(journal); }
            } else await createCompletionJournalWriter()(path, view, { final: true });
            events.push('snapshot-end');
          } }],
        }, undefined, { stdout: stream, stderr: stream });
        // WI-6554700010069703: the fork pool pipes the child's stdio into this stream and ENDS it when the
        // child closes stdio, so a teardown warning logged after that never reaches logs. Record logger.error.
        const loggedErrors = [], logError = runner.logger.error.bind(runner.logger);
        runner.logger.error = (...args) => { loggedErrors.push(args.map(String).join(' ')); return logError(...args); };
        try { await runner.start(); } finally { await runner.close(); }
        const read = readCompletionSnapshotSync(join(root, mode + '.json'));
        const timeoutWarning = 'Timeout terminating snapshot-forks worker';
        console.log(JSON.stringify({ mode, events, format: read.format, rows: read.snapshot?.rows ?? null,
          integrity: read.integrity ?? null, loggedErrors,
          streamWarning: logs.join('').includes(timeoutWarning),
          warning: loggedErrors.some(message => message.includes(timeoutWarning)) }));
      `);
      const results = [];
      for (const mode of ['sync', 'async']) {
        const { stdout } = await promisify(execFile)(process.execPath,
          ['--import', require.resolve('tsx'), probe, tmp, mode],
          { timeout: 20_000, maxBuffer: 1024 * 1024 });
        results.push(JSON.parse(stdout.trim().split('\n').at(-1)!));
      }
      const [sync, async] = results;
      for (const result of results) {
        expect(result.events, JSON.stringify(result)).toContain('pool-created');
        expect(result.events, JSON.stringify(result)).toContain('fsync-start');
        expect(result.format, JSON.stringify(result)).toBe('journal');
        // The probe's view records no runner identity, so the final fold marks the row opaque, as flushPending does.
        expect(result.rows).toEqual([{ outcome: 'pass', proof: 'same payload',
          opaqueReasons: ['worker-runtime-unavailable'] }]);
        expect(result.integrity).toMatchObject({ schemaVersion: 2, journal: 'completion-journal-v1', tailBytes: 0,
          final: true });
      }
      expect(sync.warning, JSON.stringify(sync)).toBe(true);
      expect(sync.events.indexOf('snapshot-end'), JSON.stringify(sync)).toBeLessThan(sync.events.indexOf('worker-exited'));
      expect(async.warning, JSON.stringify(async)).toBe(false);
      expect(async.events.indexOf('worker-exited'), JSON.stringify(async)).toBeLessThan(async.events.indexOf('snapshot-end'));
    }, 45_000);

    it.each([writeExecutedSourceMapSnapshot])(
      'preserves the previous snapshot and removes the temporary file on serialization failure (%#)', async writer => {
      const path = join(tmp, 'atomic.json');
      await writer(path, { outcome: 'pass', proof: { candidate: clean.commit } });
      const previous = readFileSync(path, 'utf8');
      const { completionIntegrity, ...body } = JSON.parse(previous);
      expect(completionIntegrity).toEqual({ schemaVersion: 1,
        sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') });
      body.proof.candidate = 'corrupted';
      expect(createHash('sha256').update(JSON.stringify(body)).digest('hex')).not.toBe(completionIntegrity.sha256);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(Promise.resolve().then(() => writer(path, circular))).rejects.toThrow();
      expect(readFileSync(path, 'utf8')).toBe(previous);
      expect(readdirSync(tmp)).toEqual(['atomic.json']);
    });

    it('retains run-level errors after provisional per-file completion without claiming a complete checkpoint', async () => {
      const { r } = reporter();
      const module = nativeModule(['passed']);
      r.onInit({} as never);
      await r.onTestModuleEnd(module);
      const completed = nativeOut().files[0];
      await r.onTestRunEnd([module], [new Error('late run-level failure')], 'failed');
      const final = readOutSnapshot(join(tmp, 'out.json'));
      expect(final.nativeRun).toMatchObject({ terminalHook: 'onTestRunEnd', reason: 'failed', unhandledErrorCount: 1 });
      expect(final.nativeRun.files[0]).toEqual(completed);
      expect(final).toMatchObject({ recordedGitDir: GIT_DIR,
        completionCheckpoint: { state: 'terminal', runGroupId: 'grp-1',
          runContext: executedSourceRunContext(), runnerIdentity: executedSourceRunnerIdentity() } });
    });

    it.each(['SIGTERM', 'SIGKILL'] as const)('recovers exactly committed outcome/proof pairs after owned %s interruptions', signal => {
      const script = `
        import { readFileSync, writeFileSync, writeSync } from 'node:fs';
        import Reporter, { COMPLETION_CHECKPOINT_EVERY_COMPLETION, createCompletionJournalWriter } from ${JSON.stringify(new URL('./executed-source-map-reporter.ts', import.meta.url).href)};
        const journal = createCompletionJournalWriter();
        const [phase, signal, outPath] = process.argv.slice(1);
        process.env.PC_EXECUTED_SOURCE_MAP_WORKSPACE = '@papercusp/test-config';
        process.env.PC_EXECUTED_SOURCE_MAP_OUT = outPath;
        process.env.PAPERCUSP_TEST_RUN_GROUP = 'crash-window-frozen-group';
        const recorder = new Reporter(async () => ({commit: 'frozen-candidate', porcelain: ''}),
          async () => {}, () => '/frozen/.git', async (path, payload, options) => {
            // WI-6554700010069681: the production journal writer; before-commit stops ahead of the third append.
            if (payload.nativeRun.files.length === 3 && phase === 'before-commit') process.kill(process.pid, signal);
            await journal(path, payload, options);
            if (payload.nativeRun.files.length === 3 && phase === 'committed-before-ack')
              process.kill(process.pid, signal);
          }, { spacing: COMPLETION_CHECKPOINT_EVERY_COMPLETION });
        recorder.onInit({});
        recorder.onTestRunStart(['passed', 'failed', 'error'].map(state => ({
          moduleId: process.cwd() + '/fixtures/' + state + '.test.ts', project: {name: 'crash-window'}, pool: 'forks'
        })));
        for (const state of ['passed', 'failed', 'error']) {
          await recorder.onTestModuleEnd({moduleId: process.cwd() + '/fixtures/' + state + '.test.ts',
            state: () => state, project: {config: {isolate: true}},
            diagnostic: () => ({importDurations: {}}),
            children: {allTests: () => [{fullName: state + ' case',
              result: () => ({state: state === 'passed' ? 'passed' : 'failed'}),
              diagnostic: () => ({duration: 1, retryCount: 0})}]}});
        }
        writeSync(1, 'HOOK_RETURNED\\n');
        process.kill(process.pid, signal);
      `;
      for (const phase of ['before-commit', 'committed-before-ack', 'acknowledged-before-kill']) {
        const outPath = join(tmp, `${signal}-${phase}.json`);
        const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script,
          phase, signal, outPath], { cwd: REPO_ROOT, env: process.env, encoding: 'utf8', timeout: 30_000 });
        expect(child.error, child.stderr).toBeUndefined();
        expect(child.signal, child.stderr).toBe(signal);
        const recovery = spawnSync(process.execPath, ['--input-type=module', '-e',
          `import {readCompletionSnapshotSync} from ${JSON.stringify(new URL('../../../scripts/lib/completion-journal.mjs', import.meta.url).href)};`
            + ' process.stdout.write(JSON.stringify(readCompletionSnapshotSync(process.argv[1])));', outPath],
        { encoding: 'utf8', timeout: 10_000 });
        expect(recovery.status, recovery.stderr).toBe(0);
        const read = JSON.parse(recovery.stdout);
        expect(read.format).toBe('journal');
        const recovered = read.snapshot;
        const expectedStates = phase === 'before-commit' ? ['passed', 'failed'] : ['passed', 'failed', 'error'];
        expect(recovered.nativeRun.files.map((file: { state: string }) => file.state)).toEqual(expectedStates);
        expect(recovered).toMatchObject({ recordedSha: 'frozen-candidate', worktreeDirty: false,
          completionCheckpoint: { state: 'partial', runGroupId: 'crash-window-frozen-group' } });
        expect(recovered.nativeRun.selectedManifest.specifications.map((specification: { testFile: string }) =>
          specification.testFile).sort()).toEqual(['fixtures/error.test.ts', 'fixtures/failed.test.ts', 'fixtures/passed.test.ts']);
        const acknowledgedIds = [...child.stderr.matchAll(/COMPLETION_ACK ids=(\[[^\n]+?\]) path=/g)]
          .flatMap(match => JSON.parse(match[1]!) as string[]);
        expect(acknowledgedIds).toHaveLength(phase === 'acknowledged-before-kill' ? 3 : 2);
        for (const completionId of acknowledgedIds) {
          const unit = recovered.nativeRun.files.find((file: { completionId: string }) => file.completionId === completionId);
          expect(unit).toMatchObject({ completionId, proof: { inputs: null,
            sourceEvidence: expect.objectContaining({ status: expect.any(String) }) },
            execution: unit.state === 'error' ? null : expect.any(Object),
            cases: unit.state === 'error' ? null : expect.any(Array) });
        }
        expect(child.stdout.includes('HOOK_RETURNED')).toBe(phase === 'acknowledged-before-kill');
        expect(recovered.nativeRun.terminalHook).toBeNull();
      }
    }, 120_000);

    it('retains the actual case population, repeated titles, process and callback clocks', async () => {
      const { r, flushes } = reporter();
      const mod = nativeModule(['passed', 'passed']);
      r.onInit({} as never);
      r.onTestModuleEnd(mod);
      await r.onTestRunEnd([mod], [], 'passed');
      await r.onExit();
      const out = nativeOut();
      expect(out).toMatchObject({ schemaVersion: 'native-vitest-run-v1', scope: 'vitest-reporter-callbacks',
        pid: process.pid, ppid: process.ppid, terminalHook: 'onTestRunEnd', reason: 'passed',
        unhandledErrorCount: 0, reportedModulePaths: ['libs/test-config/src/__fake__/thing.test.ts'],
        modulePopulationMatched: true, gaps: [],
      });
      expect(out.files).toHaveLength(1);
      expect(out.files[0]).toMatchObject({ state: 'passed', firstAttemptVerdict: 'pass',
        execution: { passed: 2, failed: 0, skipped: 0, collectionFailed: false },
        cases: [{ caseIndex: 0, caseKey: 'same case title', occurrence: 1, status: 'pass' },
          { caseIndex: 1, caseKey: 'same case title', occurrence: 2, status: 'pass' }],
      });
      expect(out.startedAtMs).toBeLessThanOrEqual(out.files[0].observedAtMs);
      expect(out.files[0].observedAtMs).toBeLessThanOrEqual(out.finishedAtMs);
      expect(flushes).toHaveLength(1);
      expect(flushes[0]).not.toHaveProperty('nativeRun');
      expect(flushes[0]!.rows[0]).not.toHaveProperty('cases');
    });

    it.each([
      ['failed case', ['failed'], 'failed', 0, 'fail', { passed: 0, failed: 1, skipped: 0 }],
      ['skipped case', ['passed', 'skipped'], 'passed', 0, 'unknown', { passed: 1, failed: 0, skipped: 1 }],
      ['pending case', ['pending'], 'passed', 0, 'unknown', null],
      ['collection failure', [], 'failed', 0, 'fail', { passed: 0, failed: 0, skipped: 0, collectionFailed: true }],
      ['inline retry', ['passed'], 'passed', 1, 'fail', { passed: 1, failed: 0, skipped: 0 }],
    ] as const)('preserves %s instead of turning a final module state into a clean pass', async (
      _name, states, state, retryCount, verdict, counts,
    ) => {
      const { r } = reporter();
      const mod = nativeModule([...states], state, retryCount);
      r.onInit({} as never);
      r.onTestModuleEnd(mod);
      await r.onTestRunEnd([mod], [], state === 'failed' ? 'failed' : 'passed');
      const file = nativeOut().files[0];
      expect(file.firstAttemptVerdict).toBe(verdict);
      if (counts === null) {
        expect(file.execution).toBeNull();
        expect(file.cases).toBeNull();
        expect(nativeOut().gaps).toContain('module-cases-unmeasured:libs/test-config/src/__fake__/thing.test.ts');
      } else expect(file.execution).toMatchObject(counts);
    });

    it.each(['failed', 'interrupted'] as const)('retains a %s run even when its file assertions passed', async reason => {
      const { r } = reporter();
      const mod = nativeModule(['passed']);
      r.onInit({} as never);
      r.onTestModuleEnd(mod);
      await r.onTestRunEnd([mod], [new Error('native unhandled error')], reason);
      expect(nativeOut()).toMatchObject({ reason, unhandledErrorCount: 1,
        files: [{ state: 'passed', firstAttemptVerdict: 'pass', execution: { passed: 1 } }],
      });
    });

    it('keeps omitted run errors and reason unknown instead of inventing a clean end', async () => {
      const { r } = reporter();
      const mod = nativeModule(['passed']);
      r.onInit({} as never);
      r.onTestModuleEnd(mod);
      await r.onTestRunEnd([mod]);
      expect(nativeOut()).toMatchObject({ terminalHook: 'onTestRunEnd', reason: null,
        unhandledErrorCount: null, modulePopulationMatched: true,
        gaps: ['run-errors-unobserved', 'run-end-reason-unobserved'],
      });
    });

    it('keeps an exit-only flush explicitly incomplete', async () => {
      const { r } = reporter();
      r.onInit({} as never);
      r.onTestModuleEnd(nativeModule(['passed']));
      await r.onExit();
      expect(nativeOut()).toMatchObject({ terminalHook: 'onExit', reason: null,
        unhandledErrorCount: null, reportedModulePaths: null, modulePopulationMatched: false,
        gaps: ['run-end-unobserved'],
      });
    });

    it('compares complete module occurrences rather than deduplicating repeated paths', async () => {
      const { r } = reporter();
      const mod = nativeModule(['passed']);
      r.onInit({} as never);
      r.onTestModuleEnd(mod);
      await r.onTestRunEnd([mod, mod], [], 'passed');
      expect(nativeOut()).toMatchObject({ modulePopulationMatched: false,
        gaps: ['terminal-module-population-unmatched'],
      });
      expect(nativeOut().reportedModulePaths).toHaveLength(2);
      expect(nativeOut().files).toHaveLength(1);
    });

    it('preserves existing flushes when the terminal population is unreadable', async () => {
      const { r, flushes } = reporter();
      const mod = nativeModule(['passed']);
      r.onInit({} as never);
      r.onTestModuleEnd(mod);
      const unreadable = { get moduleId(): string { throw new Error('unreadable module'); } } as TestModule;
      await r.onTestRunEnd([unreadable], [], 'passed');
      expect(flushes).toHaveLength(1);
      expect(nativeOut()).toMatchObject({ modulePopulationMatched: false,
        gaps: ['terminal-module-population-unreadable', 'terminal-module-population-unmatched'],
      });
    });

    it('retains dirty no-persist run diagnostics without reusable rows', async () => {
      process.env[PC_EXECUTED_SOURCE_MAP_NO_PERSIST_ENV] = '1';
      const { r, flushes } = reporter(snapshot({ ...clean, porcelain: ' M changed.ts' }));
      const mod = nativeModule(['passed']);
      r.onInit({} as never);
      r.onTestModuleEnd(mod);
      await r.onTestRunEnd([mod], [], 'passed');
      expect(flushes).toEqual([]);
      expect(nativeOut()).toMatchObject({ reason: 'passed', modulePopulationMatched: true,
        files: [{ firstAttemptVerdict: 'pass' }],
      });
      expect(readOutSnapshot(join(tmp, 'out.json')).worktreeDirty).toBe(true);
    });
  });

  it('retains failed worker source diagnostics in OUT without creating a reusable pass', async () => {
    const self = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.test.ts');
    const source = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.ts');
    const nodes = new Map([self, source].map(id => [id, {
      id, transformResult: { map: { sources: [id], sourcesContent: [readFileSync(id, 'utf8')] } },
    }]));
    const mod = Object.assign(fakeModule({ state: 'failed', moduleId: self, imports: { [source]: {} }, workerImports: true }), {
      viteEnvironment: { moduleGraph: { idToModuleMap: nodes } },
    });
    const { r, flushes } = reporter();
    r.onInit({} as never);
    r.onTestModuleCollected(mod);
    r.onTestModuleEnd(mod);
    await r.onTestRunEnd();
    const out = readOutSnapshot(join(tmp, 'out.json'));
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

  it('retains original-source evidence from three routed groups including failed diagnostics', async () => {
    const self = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.test.ts');
    const source = join(REPO_ROOT, 'libs/test-config/src/executed-source-map-reporter.ts');
    const parentEnv = { ...process.env };
    const paths: string[] = [];
    for (const [index, state] of ['passed', 'failed', 'passed'].entries()) {
      const env = perGroupVitestEnv(parentEnv, index, 3);
      process.env[PC_EXECUTED_SOURCE_MAP_OUT_ENV] = env.PC_EXECUTED_SOURCE_MAP_OUT;
      paths.push(env.PC_EXECUTED_SOURCE_MAP_OUT);
      const nodes = new Map([self, source].map(id => [id, {
        id, transformResult: { map: { sources: [id], sourcesContent: [readFileSync(id, 'utf8')] } },
      }]));
      const mod = Object.assign(fakeModule({ state, moduleId: self, imports: { [source]: {} }, workerImports: true }), {
        viteEnvironment: { moduleGraph: { idToModuleMap: nodes } },
      });
      const { r } = reporter();
      r.onInit({} as never);
      r.onTestModuleCollected(mod);
      r.onTestModuleEnd(mod);
      await r.onTestRunEnd();
      await r.onExit();
    }
    expect(paths).toEqual([join(tmp, 'out.json'), join(tmp, 'out.1.json'), join(tmp, 'out.2.json')]);
    for (const [index, path] of paths.entries()) {
      const out = readOutSnapshot(path);
      const evidence = index === 1 ? out.diagnostics[0].sourceEvidence : out.rows[0].sourceEvidence;
      expect(evidence).toMatchObject({ status: 'stable', sources: expect.arrayContaining([
        expect.objectContaining({ path: 'libs/test-config/src/executed-source-map-reporter.ts',
          sha256: createHash('sha256').update(readFileSync(source)).digest('hex') }),
      ]) });
      expect(out.rows).toHaveLength(index === 1 ? 0 : 1);
      expect(out.diagnostics[0].state).toBe(index === 1 ? 'failed' : 'passed');
    }
    expect(results()).toHaveLength(3); // RESULT is append-only and still shared across groups.
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
    const mod = Object.assign(fakeModule({ state, moduleId: self, imports: { [source]: {} }, workerImports: true }), {
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
    const out = readOutSnapshot(join(tmp, 'out.json'));
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
    const out = readOutSnapshot(join(tmp, 'out.json'));
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
    const mod = Object.assign(fakeModule({ moduleId: self, imports, workerImports: true }), {
      viteEnvironment: { moduleGraph: { idToModuleMap: nodes } },
    });
    const { r } = reporter();
    r.onInit({} as never);
    r.onTestModuleCollected(mod);
    imports[late] = {};
    r.onTestModuleEnd(mod);
    await r.onTestRunEnd();
    const out = readOutSnapshot(join(tmp, 'out.json'));
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
      let entered!: () => void;
      const writing = new Promise<void>(resolve => { entered = resolve; });
      const r = new ExecutedSourceMapReporter(snapshot(clean), () => {
        entered();
        return new Promise<void>(() => {});
      });
      r.onInit({} as never);
      await r.onTestModuleEnd(fakeModule({}));
      const done = r.onTestRunEnd();
      // Snapshot I/O completes asynchronously before the row-write deadline starts.
      await writing;
      expect(vi.getTimerCount()).toBe(1);
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
