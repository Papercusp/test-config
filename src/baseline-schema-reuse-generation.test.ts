import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dropBaselineDatabase,
  readBaselineReuseGeneration,
  replaceInvalidBaselineCandidate,
  rotateBaselineReuseGeneration,
} from './baseline-schema-global-setup.ts';
import { TEST_DB_DEFERRED_MARKER } from './pg-migrate.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('baseline escape-hatch database cleanup', () => {
  type DropMode = 'fast' | 'slow' | 'cancelled';
  function database(lockAvailable = true, dropMode: DropMode = 'fast') {
    const queries: string[] = [];
    let statementTimeout = '0';
    const unsafe = (query: string): Promise<unknown> => {
      queries.push(query);
      if (query.includes('pg_try_advisory_lock')) return Promise.resolve([{ acquired: lockAvailable }]);
      const set = /^SET statement_timeout = '([^']*)'$/.exec(query);
      if (set) statementTimeout = set[1];
      if (query.startsWith('DROP DATABASE')) {
        // WI-10003479: a server-side timeout can cancel a started drop AFTER
        // PostgreSQL has marked the database invalid — the leak itself.
        if (statementTimeout !== '0') return Promise.reject(new Error('cancellable database drop'));
        if (dropMode === 'slow') return new Promise(() => {});
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
    expect(await replaceInvalidBaselineCandidate(old, async () => false, start, rotate)).toBe(fresh);
    expect(old.stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    expect(rotate).toHaveBeenCalledOnce();

    expect(await replaceInvalidBaselineCandidate(fresh, async () => true, start, rotate)).toBe(fresh);
    expect(start).toHaveBeenCalledOnce();
    expect(rotate).toHaveBeenCalledOnce();
  });
});
