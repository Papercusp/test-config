import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupOwnedTestDatabases, registerOwnedTestDatabase } from './owned-test-db-cleanup';

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'owned-db-cleanup-')); dirs.push(dir);
  const env = { PAPERCUSP_TEST_OWNED_DB_DIR: dir, PAPERCUSP_TEST_RUN_GROUP: 'run-a' };
  return { dir, env };
}
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('maintained owned database cleanup', () => {
  it.each(['org', 'admission-recovery', 'mixed_prefix-2', 'a'.repeat(50)])(
    'registers and cleans the exact generated name for safe prefix %s', async prefix => {
      const { dir, env } = fixture();
      const name = `${prefix}_0123456789ab`;
      registerOwnedTestDatabase(name, 'postgres://private@localhost/test', env);
      expect(statSync(join(dir, `${name}.json`)).mode & 0o777).toBe(0o600);
      const drop = vi.fn(async () => 'dropped' as const);
      const result = await cleanupOwnedTestDatabases({ dir, runId: 'run-a', deadlineAtMs: Date.now() + 1000, drop });
      expect(result).toEqual({ complete: true, databases: [{ name, outcome: 'dropped' }], errors: [] });
      expect(drop).toHaveBeenCalledWith('postgres://private@localhost/test', name,
        { waitMs: expect.any(Number), sweepBudgetMs: 0 });
      expect(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')).outcome).toBe('dropped');
    },
  );

  it.each(['../org_0123456789ab', 'org/child_0123456789ab', 'org\\child_0123456789ab',
    'org"; DROP DATABASE postgres; --_0123456789ab', 'org_0123456789ab\n', 'org_0123456789ab\0',
    'Org_0123456789ab', 'org_nohex', 'org_0123456', `${'a'.repeat(51)}_0123456789ab`])(
    'rejects unsafe registry name %j before writing or dropping it', async name => {
      const { dir, env } = fixture();
      expect(() => registerOwnedTestDatabase(name, 'postgres://private@localhost/test', env))
        .toThrow('invalid owned test database name');
      expect(readdirSync(dir)).toEqual([]);
      // A forged receipt must not turn cleanup into a path or SQL identifier escape.
      writeFileSync(join(dir, 'forged.json'), JSON.stringify({ runId: 'run-a', name,
        adminUri: 'postgres://private@localhost/test', outcome: 'owned' }));
      const drop = vi.fn();
      const result = await cleanupOwnedTestDatabases({ dir, runId: 'run-a', deadlineAtMs: Date.now() + 1000, drop });
      expect(result.complete).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(drop).not.toHaveBeenCalled();
    },
  );

  it('retains a private registration and preserves an observed normal drop', async () => {
    const { dir, env } = fixture();
    const record = registerOwnedTestDatabase('org_0123456789ab', 'postgres://private@localhost/test', env);
    expect(statSync(join(dir, 'org_0123456789ab.json')).mode & 0o777).toBe(0o600);
    record('dropped');
    const drop = vi.fn();
    const result = await cleanupOwnedTestDatabases({ dir, runId: 'run-a', deadlineAtMs: Date.now() + 1000, drop });
    expect(result).toMatchObject({ complete: true, databases: [{ outcome: 'dropped' }], errors: [] });
    expect(drop).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'cleanup.jsonl'), 'utf8')).not.toContain('postgres://');
  });

  it.each(['dropped', 'deferred', 'detached'] as const)('reaps a forced-exit registration without relabeling %s', async outcome => {
    const { dir, env } = fixture();
    registerOwnedTestDatabase('org_0123456789ab', 'postgres://private@localhost/test', env);
    const drop = vi.fn(async () => outcome);
    const result = await cleanupOwnedTestDatabases({ dir, runId: 'run-a', deadlineAtMs: Date.now() + 1000, drop });
    expect(result.complete).toBe(outcome === 'dropped');
    expect(result.databases).toEqual([{ name: 'org_0123456789ab', outcome }]);
    expect(drop).toHaveBeenCalledWith('postgres://private@localhost/test', 'org_0123456789ab',
      { waitMs: expect.any(Number), sweepBudgetMs: 0 });
    expect(JSON.parse(readFileSync(join(dir, 'org_0123456789ab.json'), 'utf8')).outcome).toBe(outcome);
  });

  it('keeps a pending drop unconfirmed and retains its later authoritative result', async () => {
    vi.useFakeTimers();
    const { dir, env } = fixture();
    registerOwnedTestDatabase('org_0123456789ab', 'postgres://private@localhost/test', env);
    let finish!: (value: 'dropped') => void;
    const drop = vi.fn(() => new Promise<'dropped'>(resolve => { finish = resolve; }));
    const pending = cleanupOwnedTestDatabases({ dir, runId: 'run-a', deadlineAtMs: Date.now() + 25, drop });
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ complete: false, databases: [{ outcome: 'unconfirmed' }] });
    finish('dropped');
    await Promise.resolve(); await Promise.resolve();
    expect(JSON.parse(readFileSync(join(dir, 'org_0123456789ab.json'), 'utf8')).outcome).toBe('dropped');
  });

  it('does not touch another run or launch a drop beyond the cleanup deadline', async () => {
    const { dir, env } = fixture();
    registerOwnedTestDatabase('org_0123456789ab', 'postgres://private@localhost/test', env);
    const drop = vi.fn();
    const foreign = await cleanupOwnedTestDatabases({ dir, runId: 'run-b', deadlineAtMs: Date.now() + 1000, drop });
    expect(foreign.complete).toBe(false);
    const expired = await cleanupOwnedTestDatabases({ dir, runId: 'run-a', deadlineAtMs: Date.now() - 1, drop });
    expect(expired).toMatchObject({ complete: false, databases: [{ outcome: 'owned' }] });
    expect(drop).not.toHaveBeenCalled();
  });

  it('continues independent drops when a receipt cannot be appended', async () => {
    const { dir, env } = fixture();
    registerOwnedTestDatabase('org_0123456789ab', 'postgres://private@localhost/test', env);
    registerOwnedTestDatabase('org_abcdef012345', 'postgres://private@localhost/test', env);
    rmSync(join(dir, 'cleanup.jsonl')); mkdirSync(join(dir, 'cleanup.jsonl'));
    const drop = vi.fn(async () => 'dropped' as const);
    const result = await cleanupOwnedTestDatabases({ dir, runId: 'run-a', deadlineAtMs: Date.now() + 1000, drop });
    expect(drop).toHaveBeenCalledTimes(2);
    expect(result.complete).toBe(false);
    expect(result.databases.every(db => db.outcome === 'dropped')).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
