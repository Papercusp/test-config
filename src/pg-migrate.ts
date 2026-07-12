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

async function createFreshDb(prefix = 'it'): Promise<{ url: string; name: string; adminUri: string }> {
  const adminUri = await getTestPg();
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
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
      // WI-4311: pg_terminate_backend only SIGNALS other backends — it returns
      // before they've actually disconnected. A plain DROP DATABASE issued right
      // after can then find a not-yet-closed backend and either ERROR ("is being
      // accessed by other users") or, under host I/O contention, sit blocked
      // waiting on the connection to fully tear down before it can proceed with
      // its own (I/O-heavy) file cleanup — observed on the shared dev box as
      // backends parked in `DROP DATABASE` state for 6s-267s+ under heavy fleet
      // load. `WITH (FORCE)` (PG13+) makes DROP DATABASE terminate remaining
      // connections ITSELF as part of the same statement, closing this race
      // instead of racing pg_terminate_backend's async signal against it.
      await a.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
      );
      await a.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
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

export interface CreateFreshTestDbOptions {
  /** Database-name prefix (default `it`). Useful to tag a suite, e.g. `eng`, `cart`. */
  prefix?: string;
  /**
   * Materialize the schema into the fresh database. Receives the connection URL;
   * open your own client / run your own migrations inside. On throw, the fresh
   * database is dropped before the error propagates. Omit for an empty database.
   */
  provision?: (url: string) => Promise<void>;
  /**
   * TEMPLATE-CLONE the schema instead of provisioning per-test. `provision` runs
   * ONCE to build a template database keyed by `key` (cached on the shared,
   * reused container + per-process), and every call `CREATE DATABASE … TEMPLATE`s
   * it — a near-instant Postgres file clone vs replaying the provision (~280
   * migrations) for every integration test file. `key` MUST change whenever the
   * schema would (a content hash of the migration set), or a stale template
   * silently serves the wrong schema. Mutually exclusive with `provision` at the
   * top level (the template carries the schema). See `getOrBuildTemplate`.
   */
  template?: { key: string; provision: (url: string) => Promise<void> };
}

// Per-process cache: a template is built at most once per fork for a given key.
// Across forks (the container is shared + REUSED), the advisory lock + a
// pg_database existence check in `buildTemplate` make the FIRST fork build it and
// the rest reuse — so the heavy provision runs once per container, not per file.
const templateBuilds = new Map<string, Promise<string>>();

/** Comment stamped on a template database AFTER a successful build — the
 *  readiness marker `buildTemplate` requires before serving a template. A
 *  `tmpl_*` row WITHOUT it is a partial from a crashed/killed build and must
 *  never be cloned (WI-1992: a mid-build death used to leave a half-migrated
 *  template under the final name, and the bare `pg_database` existence check
 *  then served it to EVERY later clone — a whole-section mass-fail). */
const TEMPLATE_READY_MARK = 'pc-template-ready';

async function terminateBackends(admin: postgres.Sql, dbName: string): Promise<void> {
  await admin.unsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
  );
}

async function buildTemplate(key: string, provision: (url: string) => Promise<void>): Promise<string> {
  const adminUri = await getTestPg();
  const name = `tmpl_${key}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  const lock = `pc-test-template-${key}`;
  try {
    // Serialize concurrent forks racing to build the SAME template on the shared
    // container (mirrors the framework-roles advisory lock). Held across provision.
    await admin.unsafe(`SELECT pg_advisory_lock(hashtext('${lock}'))`);
    try {
      // A template is only servable when it carries the readiness mark — stamped
      // strictly AFTER provision + rename succeeded, so a partial build can never
      // satisfy this check.
      const ready = (await admin.unsafe(
        `SELECT 1
           FROM pg_database d
           JOIN pg_shdescription c ON c.objoid = d.oid AND c.classoid = 'pg_database'::regclass
          WHERE d.datname = '${name}' AND c.description = '${TEMPLATE_READY_MARK}'`,
      )) as unknown[];
      if (ready.length === 0) {
        // A final-name row WITHOUT the mark is a partial from a crashed build (or a
        // pre-hardening build) — drop it LOUDLY (terminate any leaked backends first;
        // the old `.catch(() => {})` silent-drop is exactly how partials survived).
        const exists = (await admin.unsafe(`SELECT 1 FROM pg_database WHERE datname = '${name}'`)) as unknown[];
        if (exists.length > 0) {
          await terminateBackends(admin, name);
          // WI-4311: WITH (FORCE) closes the terminate-then-drop race (see makeDrop).
          await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        }
        // Sweep leftovers of OUR key's crashed builds (safe: the advisory lock means
        // no live fork is building this key right now). Other keys' builds are
        // untouched — their names embed their own key.
        const stale = (await admin.unsafe(
          `SELECT datname FROM pg_database WHERE datname LIKE 'tmpl_bld_${key}_%'`,
        )) as Array<{ datname: string }>;
        for (const s of stale) {
          await terminateBackends(admin, s.datname);
          await admin.unsafe(`DROP DATABASE IF EXISTS "${s.datname}" WITH (FORCE)`).catch(() => {});
        }
        // Build under a TEMP name and rename into place only on success — the
        // final name is only ever a COMPLETE schema (rename is atomic in PG).
        const bld = `tmpl_bld_${key}_${randomBytes(4).toString('hex')}`;
        await admin.unsafe(`CREATE DATABASE "${bld}"`);
        try {
          await provision(swapDbName(adminUri, bld)); // opens + CLOSES its own client ⇒ no lingering conn ⇒ renameable
        } catch (err) {
          // Best-effort drop; a survivor under tmpl_bld_* is HARMLESS (never looked
          // up as a template) and the sweep above collects it next build.
          await terminateBackends(admin, bld).catch(() => {});
          await admin.unsafe(`DROP DATABASE IF EXISTS "${bld}" WITH (FORCE)`).catch(() => {});
          throw err;
        }
        // Paranoia: a backend the provision leaked would block the rename.
        await terminateBackends(admin, bld);
        await admin.unsafe(`ALTER DATABASE "${bld}" RENAME TO "${name}"`);
        await admin.unsafe(`COMMENT ON DATABASE "${name}" IS '${TEMPLATE_READY_MARK}'`);
      }
    } finally {
      await admin.unsafe(`SELECT pg_advisory_unlock(hashtext('${lock}'))`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  return name;
}

/**
 * Get (build-once) a migrated TEMPLATE database keyed by `key`. The `provision`
 * runs exactly once per (container, key); every later caller reuses the template.
 * Clone it with `createFreshTestDb({ template: { key, provision } })`.
 */
export async function getOrBuildTemplate(key: string, provision: (url: string) => Promise<void>): Promise<string> {
  let p = templateBuilds.get(key);
  if (!p) {
    p = buildTemplate(key, provision);
    templateBuilds.set(key, p);
    // Do NOT cache a rejection: a transient build failure (container hiccup, a
    // killed sibling fork) would otherwise pin every later caller in this
    // process to the same stale error even after the cause cleared (WI-1992).
    p.catch(() => {
      if (templateBuilds.get(key) === p) templateBuilds.delete(key);
    });
  }
  return p;
}

async function createDbFromTemplate(prefix: string, template: string): Promise<{ url: string; name: string; adminUri: string }> {
  const adminUri = await getTestPg();
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    // The clone needs NO active session on the source; the template's builder closed
    // its connection, and nothing connects to a template directly. Serial integration
    // runs never overlap clones; Postgres serializes them defensively regardless.
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  return { url: swapDbName(adminUri, name), name, adminUri };
}

/**
 * THE generic isolation primitive: create a fresh, empty database on the shared
 * testcontainers Postgres (`getTestPg`), optionally run a caller-supplied
 * `provision(url)` to materialize its schema, and return a handle with `drop()`.
 *
 * This is transport/domain-agnostic — every higher-level helper is a thin wrapper:
 *   - `createMigratedTestDb(sqlFiles)` → provision = apply ordered .sql files
 *   - `provisionRestartTestDb()`       → provision = `drizzle-kit push` + post-migrate.sql
 *   - Papercusp's `createFreshPgDb(prefix)` → provision = its baseline DDL
 *
 * Call once per test file in `beforeAll`; `drop()` in `afterAll`. Requires Docker.
 */
export async function createFreshTestDb(opts: CreateFreshTestDbOptions = {}): Promise<MigratedTestDb> {
  // Template-clone path: build the schema ONCE into a cached template, then clone.
  if (opts.template) {
    const tmpl = await getOrBuildTemplate(opts.template.key, opts.template.provision);
    const { url, name, adminUri } = await createDbFromTemplate(opts.prefix ?? 'it', tmpl);
    return { url, name, drop: makeDrop(adminUri, name) };
  }
  const { url, name, adminUri } = await createFreshDb(opts.prefix);
  if (opts.provision) {
    try {
      await opts.provision(url);
    } catch (err) {
      await makeDrop(adminUri, name)().catch(() => {});
      throw new Error(`createFreshTestDb: provision failed for ${name}: ${(err as Error).message}`);
    }
  }
  return { url, name, drop: makeDrop(adminUri, name) };
}

/**
 * Generic: create a fresh database and apply an ordered list of .sql file paths.
 * (Useful for arbitrary SQL packs; Restart's full schema uses `provisionRestartTestDb`.)
 */
export async function createMigratedTestDb(sqlFilePaths: string[]): Promise<MigratedTestDb> {
  return createFreshTestDb({ provision: (url) => applySqlFiles(url, sqlFilePaths) });
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
  const drizzleKit = path.join(root, 'node_modules', '.bin', 'drizzle-kit');
  return createFreshTestDb({
    provision: async (url) => {
      try {
        execFileSync(drizzleKit, ['push', '--force'], {
          cwd: root,
          env: { ...process.env, MIGRATION_DATABASE_URL: url, DATABASE_URL: url },
          stdio: 'pipe',
        });
      } catch (err) {
        const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
        const detail = e.stderr?.toString() || e.stdout?.toString() || e.message || String(err);
        throw new Error(`drizzle-kit push failed: ${detail}`);
      }
      await applySqlFiles(url, [path.join(root, 'prisma', 'post-migrate.sql')]);
    },
  });
}
