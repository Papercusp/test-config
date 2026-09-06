import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestModule } from 'vitest/node';

import { inferWorkspaceRoot } from './admin-test-runs-reporter';
import ExecutedSourceMapReporter, {
  collectExecutedModules,
  isolatedByConfig,
  normalizeExecutedKey,
  shouldRecordModule,
  type ExecutedSourceFlush,
} from './executed-source-map-reporter';
import {
  EXECUTED_SOURCE_MAP_IMPORT_LIMIT,
  PC_EXECUTED_SOURCE_MAP_OUT_ENV,
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
    expect(executedSourceMapConfig({})).toEqual({ reporters: [], experimental: undefined });
  });

  it('arms the reporter AND raises experimental.importDurations.limit in one value', () => {
    const cfg = executedSourceMapConfig({ [PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV]: '@x/w' });
    expect(cfg.reporters).toHaveLength(1);
    expect(cfg.reporters[0]).toMatch(/executed-source-map-reporter\.ts$/);
    expect(cfg.experimental).toEqual({ importDurations: { limit: EXECUTED_SOURCE_MAP_IMPORT_LIMIT, print: false } });
    // vitest 4.1.8 caps the reported map at `limit` and defaults it to 0 (or 10 when printing);
    // anything in that range would silently record a near-empty executed set.
    expect(EXECUTED_SOURCE_MAP_IMPORT_LIMIT).toBeGreaterThanOrEqual(100_000);
    expect(executedSourceMapArmed({ [PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV]: '@x/w', [PC_EXECUTED_SOURCE_MAP_OUT_ENV]: '/tmp/o.json' })).toEqual({
      workspaceName: '@x/w',
      outPath: '/tmp/o.json',
    });
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
    for (const k of [PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV, PC_EXECUTED_SOURCE_MAP_OUT_ENV, 'PAPERCUSP_TEST_RUN_GROUP']) {
      savedEnv[k] = process.env[k];
    }
    process.env[PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV] = '@papercusp/test-config';
    process.env[PC_EXECUTED_SOURCE_MAP_OUT_ENV] = join(tmp, 'out.json');
    process.env.PAPERCUSP_TEST_RUN_GROUP = 'grp-1';
  });

  afterEach(() => {
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
      rows: [
        {
          workspaceName: '@papercusp/test-config',
          testFile: 'libs/test-config/src/__fake__/thing.test.ts',
          executedModules: ['libs/test-config/src/__fake__/thing.test.ts', 'libs/test-config/src/__fake__/thing.ts'],
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
    expect(flushes).toEqual([]);
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
});
