/**
 * Real-schema provisioning for integration tests.
 *
 * The existing integration test (apps/shop-api/.../catalog-search.integration.test.ts)
 * hand-rolls a single table from raw DDL. That doesn't scale to testing services
 * (checkout, orders, cart, inventory, returns) that touch the *real* Drizzle schema.
 *
 * This module spins up a FRESH database on the shared testcontainers Postgres
 * (getTestPg) and materializes the production schema into it.
 *
 * Why `drizzle-kit push` and not migration replay: the `drizzle/*.sql` archive is
 * NOT a self-consistent from-scratch history — several tables (e.g.
 * `wholesale_quote_item`) exist only in `libs/db/src/schema/*` and were materialized
 * in production via `drizzle-kit push`, while later migrations reference them. So we
 * push the schema source (the authoritative current shape) and then apply
 * `prisma/post-migrate.sql` for the generated FTS column + GIN index drizzle-kit
 * can't express.
 *
 * Why a fresh DATABASE rather than a schema: migration/post-migrate SQL and triggers
 * hardcode `public.…`, so per-schema search_path isolation leaks. A dedicated database
 * gives each test file its own clean `public`.
 *
 * Requires Docker (testcontainers). `push` takes a couple of seconds; call once per
 * test file in `beforeAll` and `drop()` in `afterAll`.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import postgres from 'postgres';
import { getTestPg } from './pg-container.ts';

export interface MigratedTestDb {
  /** Connection URL for the freshly-provisioned database. Open your own client against it. */
  url: string;
  /** The generated database name (e.g. `it_a1b2c3`). */
  name: string;
  /** Drop the database (terminates other backends first). Call in `afterAll`. */
  drop: () => Promise<void>;
}

function swapDbName(adminUri: string, name: string): string {
  const u = new URL(adminUri);
  u.pathname = `/${name}`;
  return u.toString();
}

async function createFreshDb(): Promise<{ url: string; name: string; adminUri: string }> {
  const adminUri = await getTestPg();
  const name = `it_${randomBytes(6).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  return { url: swapDbName(adminUri, name), name, adminUri };
}

function makeDrop(adminUri: string, name: string): () => Promise<void> {
  return async () => {
    const a = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await a.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
      );
      await a.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    } finally {
      await a.end({ timeout: 5 });
    }
  };
}

/** Split a .sql file into individually-runnable statements on drizzle's breakpoint marker. */
function splitStatements(sqlText: string): string[] {
  const chunks = sqlText.includes('statement-breakpoint')
    ? sqlText.split(/-->\s*statement-breakpoint/g)
    : [sqlText];
  return chunks
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(\s*--[^\n]*\n?)+$/.test(s));
}

/** Apply a list of .sql files to a database, one statement at a time (autocommit). */
async function applySqlFiles(url: string, paths: string[]): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    for (const fp of paths) {
      const content = readFileSync(fp, 'utf8');
      if (content.includes('statement-breakpoint')) {
        for (const stmt of splitStatements(content)) await sql.unsafe(stmt);
      } else {
        await sql.unsafe(content);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Generic: create a fresh database and apply an ordered list of .sql file paths.
 * (Useful for arbitrary SQL packs; Restart's full schema uses `provisionRestartTestDb`.)
 */
export async function createMigratedTestDb(sqlFilePaths: string[]): Promise<MigratedTestDb> {
  const { url, name, adminUri } = await createFreshDb();
  try {
    await applySqlFiles(url, sqlFilePaths);
  } catch (err) {
    await makeDrop(adminUri, name)().catch(() => {});
    throw new Error(`Failed applying SQL to ${name}: ${(err as Error).message}`);
  }
  return { url, name, drop: makeDrop(adminUri, name) };
}

/** Walk up from `start` to find the Restart repo root (has `drizzle.config.ts` + `prisma/post-migrate.sql`). */
function findRepoRoot(start: string = process.cwd()): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(path.join(dir, 'drizzle.config.ts')) &&
      existsSync(path.join(dir, 'prisma', 'post-migrate.sql'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate Restart repo root (drizzle.config.ts + prisma/post-migrate.sql) from ${start}`);
}

/**
 * Provision a fresh database with the full current Restart schema via `drizzle-kit push`
 * (from `libs/db/src/schema/*`) + `prisma/post-migrate.sql`.
 *
 * NOTE: DB-side objects defined ONLY in migrations and absent from the schema source
 * — the `reserved_qty` trigger functions and the `available_stock_mv` materialized view
 * — are NOT created here. Tests that need stock-reservation maintenance must apply those
 * specific migrations on top (see `applyStockReservationDdl`, added when first needed).
 */
export async function provisionRestartTestDb(): Promise<MigratedTestDb> {
  const root = findRepoRoot();
  const { url, name, adminUri } = await createFreshDb();
  const drizzleKit = path.join(root, 'node_modules', '.bin', 'drizzle-kit');
  try {
    execFileSync(drizzleKit, ['push', '--force'], {
      cwd: root,
      env: { ...process.env, MIGRATION_DATABASE_URL: url, DATABASE_URL: url },
      stdio: 'pipe',
    });
    await applySqlFiles(url, [path.join(root, 'prisma', 'post-migrate.sql')]);
  } catch (err) {
    await makeDrop(adminUri, name)().catch(() => {});
    const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
    const detail = e.stderr?.toString() || e.stdout?.toString() || e.message || String(err);
    throw new Error(`provisionRestartTestDb failed for ${name}: ${detail}`);
  }
  return { url, name, drop: makeDrop(adminUri, name) };
}
