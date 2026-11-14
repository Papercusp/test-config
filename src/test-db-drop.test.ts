import { describe, expect, it } from 'vitest';
import { dropDatabaseWithLock } from './test-db-drop.ts';

function fixture(acquired: boolean, drop?: () => Promise<unknown>) {
  const queries: string[] = [];
  const admin = {
    unsafe: async (query: string): Promise<unknown> => {
      queries.push(query);
      if (query.includes('pg_try_advisory_lock')) return [{ acquired }];
      if (query.startsWith('DROP DATABASE')) return drop ? drop() : [];
      return [];
    },
  };
  return { admin, queries };
}

describe('container-free owned test database drop', () => {
  it('serializes a forced drop without running global janitor sweeps', async () => {
    const { admin, queries } = fixture(true);

    await expect(dropDatabaseWithLock(admin, 'owned_test_deadbeef', { sweepBudgetMs: 0 }))
      .resolves.toBe('dropped');

    expect(queries.some(query => query.startsWith('DROP DATABASE IF EXISTS '))).toBe(true);
    expect(queries.some(query => query.includes('FROM pg_database'))).toBe(false);
    expect(queries.at(-1)).toContain('pg_advisory_unlock');
  });

  it('marks the owned database deferred when another process holds the lane', async () => {
    const { admin, queries } = fixture(false);

    await expect(dropDatabaseWithLock(admin, 'owned_test_deadbeef'))
      .resolves.toBe('deferred');

    expect(queries.some(query => query.startsWith('COMMENT ON DATABASE '))).toBe(true);
    expect(queries.some(query => query.startsWith('DROP DATABASE'))).toBe(false);
    expect(queries.some(query => query.includes('pg_advisory_unlock'))).toBe(false);
  });

  it('leaves a detached server-side drop and its advisory lock running', async () => {
    const pendingDrop = new Promise<unknown>(() => {});
    const { admin, queries } = fixture(true, () => pendingDrop);

    await expect(dropDatabaseWithLock(admin, 'owned_test_deadbeef', { waitMs: 0 }))
      .resolves.toBe('detached');

    expect(queries.some(query => query.startsWith('DROP DATABASE IF EXISTS '))).toBe(true);
    expect(queries.some(query => query.includes('pg_advisory_unlock'))).toBe(false);
  });
});
