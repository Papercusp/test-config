/**
 * pg-migrate buildTemplate hardening (WI-1992) — a PARTIAL template (mid-build
 * death, killed container, leaked provision connection) must be structurally
 * unservable. The old code created the template under its FINAL name and
 * gated reuse on bare `pg_database` existence, so a crashed build left a
 * half-migrated template that every later clone silently inherited (the
 * operator-core integration mass-fail class). The hardened build:
 *
 *   1. builds under a temp `tmpl_bld_<key>_<rand>` name and ATOMICALLY renames
 *      into place only on success;
 *   2. requires a readiness COMMENT mark before serving a template — a markless
 *      final-name DB (pre-hardening partial) is terminated + dropped + rebuilt;
 *   3. terminates leaked provision backends so the rename (and later clones)
 *      cannot be blocked by a connection the provision forgot to close;
 *   4. does NOT cache a rejected build promise, so a transient failure is
 *      retryable within the same process.
 *
 * Requires Docker (shared testcontainers PG). Keys are random per test — they
 * never collide with the real migration-hash templates; every DB this file
 * creates is dropped in cleanup.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createFreshTestDb, getOrBuildTemplate } from './pg-migrate.ts';
import { getTestPg } from './pg-container.ts';

const READY_MARK = 'pc-template-ready';

function freshKey(): string {
  return `zz${randomBytes(7).toString('hex')}`; // 16 chars, same shape as a migration-hash key
}

const cleanupDbs: string[] = [];
const cleanupClients: postgres.Sql[] = [];

async function adminClient(): Promise<postgres.Sql> {
  const uri = await getTestPg();
  const sql = postgres(uri, { max: 1, onnotice: () => {} });
  cleanupClients.push(sql);
  return sql;
}

afterAll(async () => {
  const admin = postgres(await getTestPg(), { max: 1, onnotice: () => {} });
  try {
    for (const name of cleanupDbs) {
      await admin
        .unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
        )
        .catch(() => {});
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`).catch(() => {});
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  for (const c of cleanupClients) await c.end({ timeout: 5 }).catch(() => {});
});

async function templateState(admin: postgres.Sql, name: string): Promise<'absent' | 'unready' | 'ready'> {
  const rows = (await admin.unsafe(
    `SELECT c.description
       FROM pg_database d
       LEFT JOIN pg_shdescription c ON c.objoid = d.oid AND c.classoid = 'pg_database'::regclass
      WHERE d.datname = '${name}'`,
  )) as Array<{ description: string | null }>;
  if (rows.length === 0) return 'absent';
  return rows[0]!.description === READY_MARK ? 'ready' : 'unready';
}

describe('buildTemplate hardening (WI-1992)', () => {
  it('a successful build lands under the final name WITH the readiness mark and is cloneable', async () => {
    const key = freshKey();
    const name = `tmpl_${key}`;
    cleanupDbs.push(name);
    const admin = await adminClient();

    const built = await getOrBuildTemplate(key, async (url) => {
      const c = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await c.unsafe(`CREATE TABLE provisioned_ok (id int)`);
      } finally {
        await c.end({ timeout: 5 });
      }
    });
    expect(built).toBe(name);
    expect(await templateState(admin, name)).toBe('ready');

    // And it clones: the clone carries the provisioned schema.
    const db = await createFreshTestDb({ prefix: 'zzhard', template: { key, provision: async () => {} } });
    cleanupDbs.push(db.name);
    const c = postgres(db.url, { max: 1, onnotice: () => {} });
    try {
      const rows = (await c.unsafe(`SELECT 1 FROM information_schema.tables WHERE table_name = 'provisioned_ok'`)) as unknown[];
      expect(rows.length).toBe(1);
    } finally {
      await c.end({ timeout: 5 });
    }
    await db.drop();
  });

  it('a FAILED provision leaves NO servable template and is retryable in the same process', async () => {
    const key = freshKey();
    const name = `tmpl_${key}`;
    cleanupDbs.push(name);
    const admin = await adminClient();

    await expect(
      getOrBuildTemplate(key, async () => {
        throw new Error('provision exploded mid-migration');
      }),
    ).rejects.toThrow('provision exploded mid-migration');

    // Nothing servable under the final name.
    expect(await templateState(admin, name)).toBe('absent');
    // No orphaned build DBs for this key.
    const orphans = (await admin.unsafe(`SELECT datname FROM pg_database WHERE datname LIKE 'tmpl_bld_${key}_%'`)) as unknown[];
    expect(orphans.length).toBe(0);

    // The rejection was NOT cached: the same key rebuilds with a working provision.
    const built = await getOrBuildTemplate(key, async (url) => {
      const c = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await c.unsafe(`CREATE TABLE retry_ok (id int)`);
      } finally {
        await c.end({ timeout: 5 });
      }
    });
    expect(built).toBe(name);
    expect(await templateState(admin, name)).toBe('ready');
  });

  it('bounds a contended template lock with stage-labelled diagnostics and retries cleanly', async () => {
    const key = freshKey();
    const name = `tmpl_${key}`;
    const lock = `pc-test-template-${key}`;
    cleanupDbs.push(name);
    const holder = await adminClient();

    await holder.unsafe(`SELECT pg_advisory_lock(hashtext('${lock}'))`);
    const startedAt = Date.now();
    try {
      await expect(
        getOrBuildTemplate(key, async () => {}, { lockTimeoutMs: 100 }),
      ).rejects.toThrow(
        `getOrBuildTemplate: stage=template-lock-acquire timed out after 100ms ` +
          `(key=${key}, template=${name}, lock=${lock})`,
      );
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      await holder.unsafe(`SELECT pg_advisory_unlock(hashtext('${lock}'))`);
    }

    // A timed-out lock acquisition is not cached. Once the real builder releases
    // the lock, the same process can build and serve the template normally.
    const built = await getOrBuildTemplate(key, async (url) => {
      const c = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await c.unsafe(`CREATE TABLE after_lock_timeout_ok (id int)`);
      } finally {
        await c.end({ timeout: 5 });
      }
    });
    expect(built).toBe(name);
    expect(await templateState(holder, name)).toBe('ready');
  });

  it('a pre-hardening PARTIAL template (final name, no mark) is dropped and rebuilt, not served', async () => {
    const key = freshKey();
    const name = `tmpl_${key}`;
    cleanupDbs.push(name);
    const admin = await adminClient();

    // Simulate the old failure: a half-built template sitting under the final
    // name with NO readiness mark, containing schema a real build would not.
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    {
      const uri = new URL(await getTestPg());
      uri.pathname = `/${name}`;
      const c = postgres(uri.toString(), { max: 1, onnotice: () => {} });
      try {
        await c.unsafe(`CREATE TABLE half_migrated_sentinel (id int)`);
      } finally {
        await c.end({ timeout: 5 });
      }
    }
    expect(await templateState(admin, name)).toBe('unready');

    const built = await getOrBuildTemplate(key, async (url) => {
      const c = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await c.unsafe(`CREATE TABLE full_build_ok (id int)`);
      } finally {
        await c.end({ timeout: 5 });
      }
    });
    expect(built).toBe(name);
    expect(await templateState(admin, name)).toBe('ready');

    // Clones see the REBUILT schema, not the partial's.
    const db = await createFreshTestDb({ prefix: 'zzhard', template: { key, provision: async () => {} } });
    cleanupDbs.push(db.name);
    const c = postgres(db.url, { max: 1, onnotice: () => {} });
    try {
      const good = (await c.unsafe(`SELECT 1 FROM information_schema.tables WHERE table_name = 'full_build_ok'`)) as unknown[];
      const bad = (await c.unsafe(`SELECT 1 FROM information_schema.tables WHERE table_name = 'half_migrated_sentinel'`)) as unknown[];
      expect(good.length).toBe(1);
      expect(bad.length).toBe(0);
    } finally {
      await c.end({ timeout: 5 });
    }
    await db.drop();
  });

  it('a LEAKED provision connection cannot block the rename or later clones', async () => {
    const key = freshKey();
    const name = `tmpl_${key}`;
    cleanupDbs.push(name);
    const admin = await adminClient();

    let leaked: postgres.Sql | null = null;
    const built = await getOrBuildTemplate(key, async (url) => {
      // Open a client and DON'T close it — the classic way a template became
      // un-cloneable ("source database is being accessed by other users").
      leaked = postgres(url, { max: 1, onnotice: () => {} });
      cleanupClients.push(leaked);
      await leaked.unsafe(`CREATE TABLE leaky_build_ok (id int)`);
    });
    expect(built).toBe(name);
    expect(await templateState(admin, name)).toBe('ready');

    // Clone succeeds because the build terminated the leaked backend.
    const db = await createFreshTestDb({ prefix: 'zzhard', template: { key, provision: async () => {} } });
    cleanupDbs.push(db.name);
    await db.drop();
  });
});
