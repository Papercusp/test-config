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
import { readFileSync, existsSync } from 'node:fs';
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

/**
 * True iff `e` is a postgres-js connect-phase timeout (`CONNECT_TIMEOUT`).
 * Mirrors `isRetriablePgConnectError` (operator-core's pg-transient-retry.ts) /
 * `isRetriableConnectionSetupError` (libs/db's connect-retry.ts) — this package
 * can't import either (libs/papercusp/libs/db depends on @papercusp/test-config
 * for its own integration tests, so the reverse import would cycle).
 */
export function isConnectTimeout(e: unknown): boolean {
  const x = e as { code?: string; message?: string } | null;
  if (!x) return false;
  return x.code === 'CONNECT_TIMEOUT' || /\bCONNECT_TIMEOUT\b/.test(x.message ?? '');
}

/**
 * Bounded retry for a fresh postgres-js connect against `getTestPg()`'s shared,
 * `.withReuse()`d container (EI-10571). That ONE container is hammered by every
 * concurrent vitest process on the box (all forks, all packages, ~30+ fleet
 * agents at once) — a brand-new client's very first query can transiently
 * `CONNECT_TIMEOUT` purely from connect-queue/CPU pressure, not a real outage
 * (the same class pg-container.ts already retries for "in recovery mode", and
 * production code already retries via connect-retry.ts's
 * `retryBeforeCallbackStarts` — this is the test-infra-side mirror of that
 * same resilience, previously missing here). `attempt` recreates the client +
 * re-runs `fn` from scratch each time: safe because CONNECT_TIMEOUT fires
 * strictly BEFORE any statement reaches the server, so nothing can have
 * partially applied.
 */
export async function withConnectRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isConnectTimeout(e) || attempt === attempts) throw e;
      await sleep(attempt * 300);
    }
  }
  throw lastErr;
}

async function createFreshDb(prefix = 'it'): Promise<{ url: string; name: string; adminUri: string }> {
  const adminUri = await getTestPg();
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  await withConnectRetry(async () => {
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });
  return { url: swapDbName(adminUri, name), name, adminUri };
}

/**
 * Every fresh test database lives on one reused PostgreSQL cluster. DROP DATABASE
 * is I/O-heavy, so concurrent Vitest teardowns amplify filesystem contention and
 * can strand every afterAll hook at its timeout. Only one process attempts the
 * destructive statement at a time; contenders defer instead of queueing behind a
 * slow holder, and later holders drain a bounded batch of explicitly-deferred DBs.
 */
export const TEST_DB_DROP_LOCK_KEY = 'papercusp-test-drop-database';
export const TEST_DB_DROP_STATEMENT_TIMEOUT_MS = 20_000;
export const TEST_DB_DEFERRED_SWEEP_TIMEOUT_MS = 5_000;
export const TEST_DB_DEFERRED_SWEEP_LIMIT = 3;
export const TEST_DB_DEFERRED_MARKER = 'papercusp-test-db-drop-deferred';

const TEST_DB_DEFER_MARK_TIMEOUT_MS = 2_000;

type SqlExecutor = { unsafe: (query: string) => Promise<unknown> };

export type TestDbDropResult = 'dropped' | 'deferred';

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function markDatabaseDropDeferred(admin: SqlExecutor, name: string): Promise<void> {
  try {
    await admin.unsafe(`SET statement_timeout = '${TEST_DB_DEFER_MARK_TIMEOUT_MS}ms'`);
    await admin.unsafe(
      `COMMENT ON DATABASE ${quoteIdentifier(name)} IS ${quoteLiteral(TEST_DB_DEFERRED_MARKER)}`,
    );
  } catch {
    // Best effort: the database may already have disappeared, or the shared
    // catalog may itself be saturated. Teardown must never recreate the hook
    // timeout cascade merely because its deferred-cleanup marker could not land.
  } finally {
    await admin.unsafe(`SET statement_timeout = '0'`).catch(() => {});
  }
}

async function sweepDeferredDatabaseDrops(admin: SqlExecutor): Promise<void> {
  let rows: Array<{ datname: string }>;
  try {
    rows = (await admin.unsafe(
      `SELECT d.datname
         FROM pg_database d
         JOIN pg_shdescription c
           ON c.objoid = d.oid
          AND c.classoid = 'pg_database'::regclass
        WHERE c.description = ${quoteLiteral(TEST_DB_DEFERRED_MARKER)}
        ORDER BY d.datname
        LIMIT ${TEST_DB_DEFERRED_SWEEP_LIMIT}`,
    )) as Array<{ datname: string }>;
  } catch {
    return;
  }

  for (const row of rows) {
    try {
      await admin.unsafe(`SET statement_timeout = '${TEST_DB_DEFERRED_SWEEP_TIMEOUT_MS}ms'`);
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(row.datname)} WITH (FORCE)`);
    } catch {
      // Keep its marker for the next holder. Stop after the first slow/failing
      // survivor so a janitor sweep cannot consume the caller's hook budget.
      break;
    }
  }
}

/** Execute or safely defer one forced database drop on the cluster-wide lane. */
export async function dropDatabaseWithLock(admin: SqlExecutor, name: string): Promise<TestDbDropResult> {
  let lockHeld = false;
  try {
    const rows = (await admin.unsafe(
      `SELECT pg_try_advisory_lock(hashtext('${TEST_DB_DROP_LOCK_KEY}')) AS acquired`,
    )) as Array<{ acquired?: boolean }>;
    if (rows[0]?.acquired !== true) {
      await markDatabaseDropDeferred(admin, name);
      return 'deferred';
    }
    lockHeld = true;

    await admin.unsafe(`SET statement_timeout = '${TEST_DB_DROP_STATEMENT_TIMEOUT_MS}ms'`);
    // WITH (FORCE) terminates lingering sessions as part of the same statement,
    // closing the old pg_terminate_backend -> DROP race (WI-4311). A pathological
    // filesystem cleanup is cancelled and marked for a later bounded sweep rather
    // than pinning this holder (and every contender) past the Vitest hook budget.
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
    } catch (e) {
      if (!isStatementTimeout(e)) throw e;
      await markDatabaseDropDeferred(admin, name);
      return 'deferred';
    }

    await sweepDeferredDatabaseDrops(admin);
    return 'dropped';
  } finally {
    if (lockHeld) {
      // The caller closes this connection immediately afterwards; never mask the
      // original drop error with a best-effort unlock failure.
      await admin.unsafe(`SET statement_timeout = '0'`).catch(() => {});
      await admin.unsafe(`SELECT pg_advisory_unlock(hashtext('${TEST_DB_DROP_LOCK_KEY}'))`).catch(() => {});
    }
  }
}

function makeDrop(adminUri: string, name: string): () => Promise<void> {
  return () =>
    // EI-10571: this runs in every integration test file's `afterAll` teardown
    // (default vitest hookTimeout 60_000ms) — a raw connect against the shared,
    // fleet-hammered container with no retry turned a transient CONNECT_TIMEOUT
    // into a hook-timeout failure. The forced drop is idempotent, so retrying the
    // whole block (fresh client each attempt) is safe. dropDatabaseWithLock()
    // serializes the I/O-heavy destructive statement across Vitest processes
    // (WI-42514).
    withConnectRetry(async () => {
      const a = postgres(adminUri, { max: 1, onnotice: () => {} });
      try {
        await dropDatabaseWithLock(a, name);
      } finally {
        await a.end({ timeout: 5 });
      }
    });
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
  template?: {
    key: string;
    provision: (url: string) => Promise<TemplateProvisionResult | void>;
    /**
     * Maximum time to wait for another process to finish building this template.
     * Omit this to wait until the builder finishes (or its backend dies and releases
     * the advisory lock). Pass a positive value only when a caller deliberately wants
     * a bounded, stage-labelled failure instead of waiting for the shared builder.
     */
    lockTimeoutMs?: number;
  };
}

/** Optional metadata returned by a template provisioner for diagnostic logging. */
export interface TemplateProvisionResult {
  migrationCount?: number;
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
// A valid parallel integration suite must join the process already building this
// shared template. A fixed default turned slow-but-progressing builds into 55P03
// failures (EI-22047290364644498), so the default remains deadline-free. The
// builder now publishes a heartbeat on the lock-owning backend, however: a
// stopped/dead JS process can leave that backend alive indefinitely (for example
// when its process group is frozen after a migration statement finishes). A
// waiter may recover only an unchanged heartbeat older than this generous stale
// window; a progressing builder is still joined for as long as it needs.
const DEFAULT_TEMPLATE_LOCK_TIMEOUT_MS: number | null = null;
export const TEMPLATE_BUILDER_APPLICATION_PREFIX = 'pc-template-build';
export const TEMPLATE_BUILDER_HEARTBEAT_INTERVAL_MS = 2_000;
export const TEMPLATE_BUILDER_HEARTBEAT_STALE_MS = 60_000;
const TEMPLATE_LOCK_POLL_INTERVAL_MS = 1_000;

function templateLockTimeoutMs(value?: number): number | null {
  if (value === undefined) return DEFAULT_TEMPLATE_LOCK_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`getOrBuildTemplate: lockTimeoutMs must be a positive finite number (received ${value})`);
  }
  return Math.ceil(value);
}

function templateBuilderKeyToken(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
}

export function templateBuilderApplicationName(
  key: string,
  heartbeatAt = Date.now(),
  pid = process.pid,
): string {
  return `${TEMPLATE_BUILDER_APPLICATION_PREFIX}:${templateBuilderKeyToken(key)}:${pid}:${Math.floor(heartbeatAt)}`;
}

function templateHeartbeatAt(key: string, applicationName: string): number | null {
  const prefix = `${TEMPLATE_BUILDER_APPLICATION_PREFIX}:${templateBuilderKeyToken(key)}:`;
  if (!applicationName.startsWith(prefix)) return null;
  const heartbeatAt = Number(applicationName.slice(applicationName.lastIndexOf(':') + 1));
  return Number.isFinite(heartbeatAt) && heartbeatAt > 0 ? heartbeatAt : null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function templateLockHolder(
  admin: postgres.Sql,
  lock: string,
): Promise<{ pid: number; application_name: string; state: string } | null> {
  const rows = (await admin.unsafe(
    `WITH lock_key AS (SELECT hashtext($1::text)::bigint AS value)
     SELECT a.pid, a.application_name, a.state
       FROM pg_locks l
       JOIN pg_stat_activity a USING (pid)
       CROSS JOIN lock_key k
      WHERE l.locktype = 'advisory'
        AND l.granted
        AND l.objsubid = 1
        AND l.classid::bigint = ((k.value >> 32) & 4294967295)
        AND l.objid::bigint = (k.value & 4294967295)
      LIMIT 1`,
    [lock],
  )) as Array<{ pid: number; application_name: string; state: string }>;
  return rows[0] ?? null;
}

async function templateBuildRecentlyActive(admin: postgres.Sql, key: string): Promise<boolean> {
  const prefix = `tmpl_bld_${key}_`;
  const rows = (await admin.unsafe(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_stat_activity
        WHERE left(datname, length($1::text)) = $1
          AND (
            state <> 'idle'
            OR state_change > clock_timestamp() - ($2::bigint * interval '1 millisecond')
          )
     ) AS active`,
    [prefix, TEMPLATE_BUILDER_HEARTBEAT_STALE_MS],
  )) as Array<{ active: boolean }>;
  return rows[0]?.active === true;
}

async function recoverStaleTemplateBuilder(
  admin: postgres.Sql,
  key: string,
  lock: string,
): Promise<boolean> {
  const holder = await templateLockHolder(admin, lock);
  if (!holder) return false;
  const heartbeatAt = templateHeartbeatAt(key, holder.application_name);
  if (
    heartbeatAt === null ||
    holder.state !== 'idle' ||
    Date.now() - heartbeatAt <= TEMPLATE_BUILDER_HEARTBEAT_STALE_MS ||
    await templateBuildRecentlyActive(admin, key)
  ) return false;

  // Compare the exact observed application_name in the terminating statement.
  // A heartbeat that lands between observation and action changes that value,
  // making this a no-op instead of killing a builder that just resumed.
  const rows = (await admin.unsafe(
    `SELECT pg_terminate_backend(a.pid) AS terminated
       FROM pg_stat_activity a
      WHERE a.pid = $1
        AND a.application_name = $2
        AND a.state = 'idle'
        AND NOT EXISTS (
          SELECT 1
            FROM pg_stat_activity build
           WHERE left(build.datname, length($3::text)) = $3
             AND (
               build.state <> 'idle'
               OR build.state_change > clock_timestamp() - ($4::bigint * interval '1 millisecond')
             )
        )`,
    [holder.pid, holder.application_name, `tmpl_bld_${key}_`, TEMPLATE_BUILDER_HEARTBEAT_STALE_MS],
  )) as Array<{ terminated: boolean }>;
  const terminated = rows[0]?.terminated === true;
  if (terminated) {
    // eslint-disable-next-line no-console
    console.error(
      `[getOrBuildTemplate] stage=template-lock-recovery key=${key} ` +
        `holderPid=${holder.pid} staleHeartbeatMs=${Date.now() - heartbeatAt}`,
    );
  }
  return terminated;
}

async function acquireTemplateLock(
  admin: postgres.Sql,
  key: string,
  lock: string,
  lockTimeoutMs: number | null,
): Promise<number> {
  const startedAt = Date.now();
  for (;;) {
    const rows = (await admin.unsafe(
      `SELECT pg_try_advisory_lock(hashtext($1::text)) AS acquired`,
      [lock],
    )) as Array<{ acquired: boolean }>;
    if (rows[0]?.acquired === true) return Date.now() - startedAt;

    // Explicit diagnostic deadlines preserve their historical fail-fast
    // contract and never terminate another builder. The normal/default path is
    // progress-aware instead: only our own stale heartbeat is recoverable.
    if (lockTimeoutMs === null) await recoverStaleTemplateBuilder(admin, key, lock);

    const elapsedMs = Date.now() - startedAt;
    if (lockTimeoutMs !== null && elapsedMs >= lockTimeoutMs) {
      throw new Error(
        `getOrBuildTemplate: stage=template-lock-acquire timed out after ${lockTimeoutMs}ms ` +
          `(key=${key}, template=tmpl_${key}, lock=${lock}); another test process is still building this migration set`,
      );
    }
    const remainingMs = lockTimeoutMs === null ? TEMPLATE_LOCK_POLL_INTERVAL_MS : lockTimeoutMs - elapsedMs;
    await sleep(Math.max(1, Math.min(TEMPLATE_LOCK_POLL_INTERVAL_MS, remainingMs)));
  }
}

async function setTemplateBuilderHeartbeat(admin: postgres.Sql, key: string): Promise<void> {
  await admin.unsafe(`SELECT set_config('application_name', $1, false)`, [templateBuilderApplicationName(key)]);
}

async function startTemplateBuilderHeartbeat(admin: postgres.Sql, key: string): Promise<() => Promise<void>> {
  await setTemplateBuilderHeartbeat(admin, key);
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const beat = () => {
    if (stopped || inFlight) return;
    inFlight = setTemplateBuilderHeartbeat(admin, key)
      .catch(() => {
        // A recovery waiter may terminate this backend. Publication below must
        // independently prove the advisory lease still belongs to this session.
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = setInterval(beat, TEMPLATE_BUILDER_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}

async function assertTemplateLockHeld(admin: postgres.Sql, lock: string): Promise<void> {
  const rows = (await admin.unsafe(
    `WITH lock_key AS (SELECT hashtext($1::text)::bigint AS value)
     SELECT EXISTS (
       SELECT 1
         FROM pg_locks l
         CROSS JOIN lock_key k
        WHERE l.pid = pg_backend_pid()
          AND l.locktype = 'advisory'
          AND l.granted
          AND l.objsubid = 1
          AND l.classid::bigint = ((k.value >> 32) & 4294967295)
          AND l.objid::bigint = (k.value & 4294967295)
     ) AS held`,
    [lock],
  )) as Array<{ held: boolean }>;
  if (rows[0]?.held !== true) {
    throw new Error(`getOrBuildTemplate: stage=template-publish lease lost for advisory lock ${lock}`);
  }
}

function isStatementTimeout(e: unknown): boolean {
  const x = e as { code?: string; message?: string } | null;
  return x?.code === '57014' || /statement timeout/i.test(x?.message ?? '');
}

async function terminateBackends(admin: postgres.Sql, dbName: string): Promise<void> {
  await admin.unsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
  );
}

async function buildTemplate(
  key: string,
  provision: (url: string) => Promise<TemplateProvisionResult | void>,
  opts: { lockTimeoutMs?: number } = {},
): Promise<string> {
  const adminUri = await getTestPg();
  const name = `tmpl_${key}`;
  const lock = `pc-test-template-${key}`;
  const lockTimeoutMs = templateLockTimeoutMs(opts.lockTimeoutMs);
  // EI-10571: connect + the first query (the advisory-lock acquire) with retry —
  // this is where a fresh connect against the shared, fleet-hammered container
  // can transiently CONNECT_TIMEOUT (see withConnectRetry). Once past it, the
  // rest of this (possibly long-running) build reuses the same live connection,
  // so nothing downstream needs its own retry.
  const admin = await withConnectRetry(async () => {
    const a = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      // Serialize concurrent forks racing to build the SAME template on the shared
      // container (mirrors the framework-roles advisory lock). Held across provision.
      // The normal path waits for the current builder: PostgreSQL releases this
      // session-level advisory lock when that backend exits, including a crash. A
      // caller that supplies lockTimeoutMs gets a bounded acquisition instead.
      const lockWaitMs = await acquireTemplateLock(a, key, lock, lockTimeoutMs);
      if (lockWaitMs > 5_000) {
        // eslint-disable-next-line no-console
        console.error(`[getOrBuildTemplate] stage=template-lock-wait key=${key} elapsedMs=${lockWaitMs}`);
      }
      return a;
    } catch (e) {
      await a.end({ timeout: 5 }).catch(() => {});
      throw e;
    }
  });
  try {
    let stopHeartbeat: (() => Promise<void>) | null = null;
    try {
      // Cover the ENTIRE lease-held critical section, not just provision: a
      // stall while inspecting/dropping partials or creating the build database
      // must be recoverable by later waiters too.
      stopHeartbeat = await startTemplateBuilderHeartbeat(admin, key);
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
        const buildStartedAt = Date.now();
        try {
          const provisionResult = await provision(swapDbName(adminUri, bld)); // opens + CLOSES its own client ⇒ no lingering conn ⇒ renameable
          const buildElapsedMs = Date.now() - buildStartedAt;
          const migrationCount =
            provisionResult && typeof provisionResult === 'object' ? provisionResult.migrationCount : undefined;
          // eslint-disable-next-line no-console
          console.error(
            `[getOrBuildTemplate] stage=template-build key=${key} ` +
              `migrations=${migrationCount ?? 'unknown'} elapsedMs=${buildElapsedMs}`,
          );
          // A stale-holder recovery terminates the lock-owning backend. postgres-js
          // may transparently reconnect, so successful provision alone is not
          // publication authority: the current backend must still own the lease.
          await assertTemplateLockHeld(admin, lock);
          // Paranoia: a backend the provision leaked would block the rename.
          await terminateBackends(admin, bld);
          await assertTemplateLockHeld(admin, lock);
          await admin.unsafe(`ALTER DATABASE "${bld}" RENAME TO "${name}"`);
          await admin.unsafe(`COMMENT ON DATABASE "${name}" IS '${TEMPLATE_READY_MARK}'`);
        } catch (err) {
          // Best-effort drop; a survivor under tmpl_bld_* is HARMLESS (never looked
          // up as a template) and the sweep above collects it next build.
          await terminateBackends(admin, bld).catch(() => {});
          await admin.unsafe(`DROP DATABASE IF EXISTS "${bld}" WITH (FORCE)`).catch(() => {});
          throw err;
        }
      }
    } finally {
      await stopHeartbeat?.();
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
export async function getOrBuildTemplate(
  key: string,
  provision: (url: string) => Promise<TemplateProvisionResult | void>,
  opts: { lockTimeoutMs?: number } = {},
): Promise<string> {
  let p = templateBuilds.get(key);
  if (!p) {
    p = buildTemplate(key, provision, opts);
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
  // EI-10571: this is the HOT path every `createOrgTestDb`-style fixture takes
  // on every integration test file's beforeAll — see withConnectRetry's docstring.
  await withConnectRetry(async () => {
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      // The clone needs NO active session on the source; the template's builder closed
      // its connection, and nothing connects to a template directly. Serial integration
      // runs never overlap clones; Postgres serializes them defensively regardless.
      await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });
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
    const tmpl = await getOrBuildTemplate(opts.template.key, opts.template.provision, {
      lockTimeoutMs: opts.template.lockTimeoutMs,
    });
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
