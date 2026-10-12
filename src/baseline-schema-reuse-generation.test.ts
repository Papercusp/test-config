import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BaselineMigrationApplyError,
  clearBaselineFreshMigrationFailure,
  decideAfterReusedMigrationFailure,
  dropBaselineDatabase,
  markBaselineFreshMigrationFailure,
  readBaselineFreshMigrationFailure,
  readBaselineReuseGeneration,
  recoverFromReusedMigrationFailure,
  replaceInvalidBaselineCandidate,
  rotateBaselineReuseGeneration,
  type ReusedMigrationRecoveryDeps,
} from './baseline-schema-global-setup.ts';
import { TEST_DB_DEFERRED_MARKER } from './pg-migrate.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('baseline escape-hatch database cleanup', () => {
  type DropMode = 'fast' | 'slow' | 'slow-sweep' | 'cancelled';
  function database(lockAvailable = true, dropMode: DropMode = 'fast') {
    const queries: string[] = [];
    let statementTimeout = '0';
    const unsafe = (query: string): Promise<unknown> => {
      queries.push(query);
      if (query.includes('pg_try_advisory_lock')) return Promise.resolve([{ acquired: lockAvailable }]);
      const set = /^SET statement_timeout = '([^']*)'$/.exec(query);
      if (set) statementTimeout = set[1];
      if (dropMode === 'slow-sweep' && query.includes(`c.description = '${TEST_DB_DEFERRED_MARKER}'`)) {
        return Promise.resolve([{ datname: 'papercusp_it_baseline_swept' }]);
      }
      if (query.startsWith('DROP DATABASE')) {
        // WI-10003479: a server-side timeout can cancel a started drop AFTER
        // PostgreSQL has marked the database invalid — the leak itself.
        if (statementTimeout !== '0') return Promise.reject(new Error('cancellable database drop'));
        if (dropMode === 'slow' || (dropMode === 'slow-sweep' && query.includes('papercusp_it_baseline_swept'))) {
          return new Promise(() => {});
        }
        if (dropMode === 'cancelled') {
          return Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
        }
      }
      return Promise.resolve([]);
    };
    return { unsafe, queries };
  }

  it('never runs the drop under a cancellable timeout, and detects the original 20s-timeout implementation', async () => {
    const current = database();
    await expect(dropBaselineDatabase(current, 'papercusp_it_baseline_probe')).resolves.toBeUndefined();
    expect(current.queries).toContain('DROP DATABASE IF EXISTS "papercusp_it_baseline_probe" WITH (FORCE)');
    const legacy = database();
    await legacy.unsafe(`SET statement_timeout = '20000ms'`);
    await expect(legacy.unsafe('DROP DATABASE IF EXISTS "papercusp_it_baseline_probe" WITH (FORCE)'))
      .rejects.toThrow('cancellable database drop');
  });

  it('bounds the caller wait on a slow drop by detaching it, not cancelling it', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cleanup = database(true, 'slow');
      await expect(dropBaselineDatabase(cleanup, 'papercusp_it_baseline_probe', { waitMs: 5 })).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('database cleanup detached: papercusp_it_baseline_probe'));
      expect(cleanup.queries.at(-1)).toBe('DROP DATABASE IF EXISTS "papercusp_it_baseline_probe" WITH (FORCE)');
    } finally {
      warning.mockRestore();
    }
  });

  it('reports a detached sweep even after its requested database was dropped', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cleanup = database(true, 'slow-sweep');
      await expect(dropBaselineDatabase(cleanup, 'papercusp_it_baseline_probe', { sweepBudgetMs: 5 })).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('database cleanup detached: papercusp_it_baseline_probe'));
      expect(cleanup.queries.at(-1)).toBe('DROP DATABASE IF EXISTS "papercusp_it_baseline_swept" WITH (FORCE)');
    } finally {
      warning.mockRestore();
    }
  });

  it.each(['busy', 'cancelled'] as const)('records deferred cleanup after %s instead of hanging a green run', async (reason) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cleanup = database(reason !== 'busy', reason === 'cancelled' ? 'cancelled' : 'fast');
      await expect(dropBaselineDatabase(cleanup, 'papercusp_it_baseline_probe')).resolves.toBeUndefined();
      expect(cleanup.queries.some((query) => query.includes(TEST_DB_DEFERRED_MARKER))).toBe(true);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('database cleanup deferred: papercusp_it_baseline_probe'));
      if (reason === 'busy') expect(cleanup.queries.some((query) => query.startsWith('DROP DATABASE'))).toBe(false);
      else expect(cleanup.queries.some((query) => query.includes('pg_advisory_unlock'))).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });
});

describe('baseline container reuse rotation', () => {
  it('persists a new generation for later Vitest processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baseline-reuse-'));
    roots.push(root);
    expect(await readBaselineReuseGeneration(root)).toBe(0);
    expect(await rotateBaselineReuseGeneration(root)).toBe(1);
    expect(await readBaselineReuseGeneration(root)).toBe(1);
    expect(await rotateBaselineReuseGeneration(root)).toBe(2);
    expect(await readFile(join(root, 'baseline-schema-reuse-generation'), 'utf8')).toBe('2\n');
  });

  it('replaces an invalid candidate without stopping readers attached to it', async () => {
    const old = { stop: vi.fn() };
    const fresh = { stop: vi.fn() };
    const start = vi.fn(async (generation: number) => {
      expect(generation).toBe(1);
      return fresh;
    });
    const rotate = vi.fn(async () => 1);
    expect(await replaceInvalidBaselineCandidate(old, async (candidate) => candidate === fresh, start, rotate)).toBe(fresh);
    expect(old.stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    expect(rotate).toHaveBeenCalledOnce();

    expect(await replaceInvalidBaselineCandidate(fresh, async () => true, start, rotate)).toBe(fresh);
    expect(start).toHaveBeenCalledOnce();
    expect(rotate).toHaveBeenCalledOnce();
  });
});

// WI-6554700010008428: migration 1444's twin guard failed on rows earlier runs left in the
// REUSED container, and nothing recovered, so every integration run on the box failed.
describe('baseline migration failure on a reused container', () => {
  async function freshRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'baseline-migration-recovery-'));
    roots.push(root);
    return root;
  }

  interface Candidate { generation: number; empty: boolean; stop: () => void }

  /** Containers by generation; `broken` makes every replay fail (a defective migration). */
  function harness(root: string, opts: { broken?: boolean; nonEmpty?: number[] } = {}) {
    const started: number[] = [];
    const applied: number[] = [];
    const deps: ReusedMigrationRecoveryDeps<Candidate> = {
      failedGeneration: 0,
      root,
      withStartLock: async (action) => action(),
      start: async (generation) => {
        started.push(generation);
        return { generation, empty: !(opts.nonEmpty ?? []).includes(generation), stop: vi.fn() };
      },
      isEmpty: async (candidate) => candidate.empty,
      apply: async (candidate) => {
        applied.push(candidate.generation);
        if (opts.broken) throw new BaselineMigrationApplyError(`1444 FAILED on generation ${candidate.generation}`);
      },
      log: () => {},
    };
    return { deps, started, applied };
  }

  const firstFailure = new BaselineMigrationApplyError('1444: 1 same-workspace work-item twin set(s) remain (e.g. default/WI-zzz-iv-impl)');

  it('rotates to a fresh container and continues when leftover data caused the failure', async () => {
    const root = await freshRoot();
    const { deps, started, applied } = harness(root);
    const recovered = await recoverFromReusedMigrationFailure(firstFailure, deps);
    expect(recovered.generation).toBe(1);
    expect(recovered.candidate.generation).toBe(1);
    expect(started).toEqual([1]);
    expect(applied).toEqual([1]);
    expect(await readBaselineReuseGeneration(root)).toBe(1);
    expect(await readBaselineFreshMigrationFailure(root)).toBeNull();
  });

  it('marks a migration that also fails from EMPTY, and never mints another container for it', async () => {
    const root = await freshRoot();
    const first = harness(root, { broken: true });
    await expect(recoverFromReusedMigrationFailure(firstFailure, first.deps)).rejects.toThrow('1444 FAILED on generation 1');
    expect(await readBaselineFreshMigrationFailure(root)).toBe(1);

    // The next run fails on generation 1 itself: rethrow, without starting a container.
    const next = harness(root, { broken: true });
    const error = await recoverFromReusedMigrationFailure(firstFailure, { ...next.deps, failedGeneration: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BaselineMigrationApplyError);
    expect((error as Error).message).toContain('verified EMPTY and already failed a full replay');
    expect((error as Error).cause).toBe(firstFailure);
    expect(next.started).toEqual([]);
    expect(await readBaselineReuseGeneration(root)).toBe(1);
  });

  it('does not mark a failure on a container that was not empty, so the next run may rotate again', async () => {
    const root = await freshRoot();
    const { deps } = harness(root, { broken: true, nonEmpty: [1] });
    await expect(recoverFromReusedMigrationFailure(firstFailure, deps)).rejects.toThrow('1444 FAILED');
    expect(await readBaselineFreshMigrationFailure(root)).toBeNull();
    expect(await decideAfterReusedMigrationFailure(1, root)).toEqual({ kind: 'rotate' });
  });

  it('adopts a container a peer already rotated to, instead of rotating twice', async () => {
    const root = await freshRoot();
    await rotateBaselineReuseGeneration(root);
    await rotateBaselineReuseGeneration(root);
    const { deps, started } = harness(root, { nonEmpty: [2] });
    const recovered = await recoverFromReusedMigrationFailure(firstFailure, deps);
    expect(recovered.generation).toBe(2);
    expect(started).toEqual([2]);
    expect(await readBaselineReuseGeneration(root)).toBe(2);
  });

  it('clears the marker only for its own generation and ignores a malformed one', async () => {
    const root = await freshRoot();
    await markBaselineFreshMigrationFailure(3, root);
    await clearBaselineFreshMigrationFailure(2, root);
    expect(await readBaselineFreshMigrationFailure(root)).toBe(3);
    await clearBaselineFreshMigrationFailure(3, root);
    expect(await readBaselineFreshMigrationFailure(root)).toBeNull();
    await clearBaselineFreshMigrationFailure(3, root);

    // A corrupt marker must never suppress recovery.
    await writeFile(join(root, 'baseline-schema-fresh-migration-failure'), 'not-a-number\n');
    expect(await readBaselineFreshMigrationFailure(root)).toBeNull();
    expect(await decideAfterReusedMigrationFailure(0, root)).toEqual({ kind: 'rotate' });
  });
});
