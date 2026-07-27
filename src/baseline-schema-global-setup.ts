/**
 * baseline-schema-global-setup.ts — shared integration-tier globalSetup.
 *
 * Plan: self-contained-migration-baseline-2026-06-02 (P-015). Lifted here from
 * apps/operator/test/setup/baseline-schema.globalSetup.ts (2026-06-04) so BOTH
 * apps/operator AND packages/operator-core's integration configs can wire it —
 * the SP1 C4 carve moved several plans/cross_harness integration tests into
 * operator-core but left the globalSetup behind, breaking their
 * `inject('baselineSchemaDsn')` (the DSN came back empty → "Invalid URL").
 *
 * Stands up the COMPLETE harness_shared schema ONCE per reusable baseline
 * container by applying the real migration set (000-baseline.sql + 107/108…)
 * and exposes its DSN via inject('baselineSchemaDsn'). The container is isolated
 * from getTestPg's shared test database, but reused across Vitest processes so a
 * focused file does not replay hundreds of migrations while the checkpoint is
 * active (EI-11788).
 *
 * Owns its OWN reusable container (NOT the shared `getTestPg`): per-file tests
 * call `teardownTestPg()` in afterAll, which would stop/recreate the shared
 * container mid-run and invalidate this DSN. A dedicated container keeps this
 * schema-DB valid + isolated from the shared test database for the whole run.
 *
 * Read the DSN in a test with:
 *   import { inject } from 'vitest';
 *   const dsn = inject('baselineSchemaDsn');
 * Tests needing write-isolation should still make their own schema; this shared
 * DB is for read-heavy tool-suite assertions against the true schema.
 *
 * The path to this file is exported as `BASELINE_SCHEMA_GLOBAL_SETUP_PATH` from
 * the package index; integration configs pass it to `defineVitestConfig({
 * globalSetup: [...] })`.
 *
 * NO-DOCKER ESCAPE HATCH (EI-13104): a `capability:bash`-sandboxed cup (bwrap
 * exec-sandbox, papercusp-capability-exec-sandbox flag) can never reach
 * docker.sock — the sandbox's unprivileged user namespace intentionally does not
 * carry the caller's supplementary groups (including `docker`) into the
 * sandboxed process, and `sg`/`newgrp` group-switching is blocked outright
 * (setgroups denied) inside that namespace. That is the sandbox correctly
 * containing a real privilege-escalation vector — docker.sock access is
 * effectively host-root, so re-granting it would undo the containment this
 * exec-sandbox exists to provide (see exec-sandbox.ts). It is NOT a bug to
 * "fix" on the sandbox side.
 *
 * The actionable fix lives here instead: when `PAPERCUSP_TEST_PG_ADMIN_URL` is
 * set (a connection string for a role with CREATEDB on an ALREADY-RUNNING
 * Postgres server the caller can reach — e.g. the box's native PG — reachable
 * because the exec-sandbox does NOT `--unshare-net` by default), this globalSetup
 * skips `PostgreSqlContainer`/testcontainers entirely: it provisions an isolated
 * throwaway database on that server via `CREATE DATABASE`, applies the same real
 * migration set to it, and `DROP DATABASE`s it on teardown. Nothing shared or
 * persistent is touched — a fresh randomly-named DB per run, isolated exactly
 * like the container path. Purely additive: the env var is unset by default, so
 * every existing Docker-backed run is byte-identical to before this change.
 */
import type { GlobalSetupContext } from 'vitest/node';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withTestcontainerStartLock } from './testcontainer-start-lock.ts';
import { probePgReachable, withPgStartupRetry } from './pg-reachability.ts';

/**
 * The baseline schema owns a dedicated container, so its Docker handshake must
 * not queue behind getTestPg's reused-container startup. Keep baseline runs
 * serialized with one another, while leaving the shared test-PG lane free to
 * start concurrently (EI-11788).
 */
export const BASELINE_SCHEMA_CONTAINER_START_LOCK = 'baseline-schema-container-start';

/**
 * EI-18748424931934157 — the schema this file seeds to stand in for a real per-harness
 * schema (`harness_<slug>`), so that migrations are replayed against a schema graph that
 * resembles a live operator instead of a bare `harness_shared`.
 *
 * THE HOLE THIS CLOSES. Every migration test in this repo builds a database containing
 * ONLY `harness_shared`. Real operators additionally carry a per-harness schema per
 * harness, each with a `harness_features` view defined as
 * `SELECT * FROM harness_shared.harness_features_consolidated`. Postgres refuses to DROP
 * a view that has dependents — so a migration that drops or incompatibly redefines a
 * depended-on view is REJECTED on every real operator and ACCEPTED by every test we have.
 * A fresh testcontainer was the one environment where such a migration was safe, and it
 * was the only environment we tested in.
 *
 * That is not hypothetical: migration 678 passed the gate and then crash-looped the
 * operator with "cannot drop view harness_shared.harness_features_consolidated because
 * other objects depend on it". 678 itself was fixed (rewritten to append-only
 * CREATE OR REPLACE); the trap that let it ship is what this closes. The reasoning slip
 * behind it — "nothing has been built on the column yet", true of the COLUMN and
 * irrelevant to the VIEW — is exactly the kind a human reviewer waves through, which is
 * why the guard has to be mechanical rather than a review convention.
 *
 * WHY A VIEW AND NOT A LINT: this tests the actual property (a migration must survive a
 * realistic dependency graph) rather than pattern-matching on SQL text, so it generalizes
 * to dependency breakage nobody has thought of yet. A static "no bare DROP VIEW"
 * assertion over the corpus is a reasonable cheap belt ALONGSIDE this, not instead of it.
 *
 * Deliberately ONE schema, not a replica of the real set: the property is binary — either
 * a dependent exists or it does not — so a second copy would cost container time and
 * catch nothing extra.
 */
export const DEPENDENT_VIEW_PROBE_SCHEMA = 'harness_migration_probe';

/**
 * Create the dependent-view probe, IF its base relation exists yet.
 *
 * Returns false (and writes nothing) on a brand-new database whose migrations have not
 * been replayed yet — `harness_features_consolidated` is itself created by the corpus, so
 * on a fresh container the probe cannot exist until after the first run. That is why the
 * caller invokes this on BOTH sides of the runner: the pre-run call is the one that
 * guards, and the post-run call is what makes the pre-run call effective on every
 * subsequent run against this reused container.
 *
 * Existence is checked rather than catching the error, so a genuine failure to create the
 * probe surfaces loudly instead of being swallowed as "base relation missing".
 */
async function seedDependentViewProbe(sql: postgres.Sql): Promise<boolean> {
  const [row] = await sql<{ present: boolean }[]>`
    SELECT to_regclass('harness_shared.harness_features_consolidated') IS NOT NULL AS present`;
  if (!row?.present) return false;
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS ${DEPENDENT_VIEW_PROBE_SCHEMA};
    CREATE OR REPLACE VIEW ${DEPENDENT_VIEW_PROBE_SCHEMA}.harness_features AS
      SELECT * FROM harness_shared.harness_features_consolidated;`);
  return true;
}

/**
 * EI-2433: testcontainers' `.withReuse()` matches an existing container purely by
 * its CONFIG hash (image, env, ports, …) — it never validates that the database
 * inside is actually usable. On this shared dev box a reused container can end up
 * running but missing `papercusp_it` (dropped by an external actor, left over from
 * a since-changed setup, …), which surfaced as every integration test failing with
 * "no such database: papercusp_it" despite the container reporting healthy.
 * Health-check a candidate container's actual DB before trusting its DSN.
 *
 * EI-2627: a single immediate probe conflated that genuine staleness with a
 * brief, self-resolving startup/recovery race (the exact class getTestPg()
 * already tolerates for the SHARED test-PG container via a bounded retry —
 * WI-3578/WI-5254/WI-5256, see pg-container.ts) — under heavy fleet-wide
 * concurrency this container hits that race often enough that reprovisioning
 * on every blip adds MORE docker load, deepening the very churn it's meant to
 * avoid. `probePgReachable` rides out ONLY the transient-looking failures
 * (bounded budget) and still fails fast on a real "no such database"/auth
 * error, so staleness is still caught immediately.
 */
async function isBaselineContainerHealthy(dsn: string): Promise<boolean> {
  return (await probePgReachable(dsn, 15_000)).ok;
}

/**
 * EI-18779962385972529 — the LEDGER-vs-REALITY probe.
 *
 * Reachability (above) proves the container ANSWERS. It does not prove the schema
 * inside matches what that container's own `harness_shared.schema_migrations`
 * ledger CLAIMS is applied. Those can diverge — a schema dropped by an external
 * actor on this shared dev box, a container carried over from a since-changed
 * setup — and the divergence is PERMANENT and SILENT:
 * `applyPendingMigrations` skips any file already in the ledger
 * (`if (applied.has(f)) continue`), so a migration recorded-but-missing is never
 * re-applied, and every LATER migration that depends on it fails on every run,
 * for ever, with no self-heal.
 *
 * Worse, it does not fail where the fault is. It surfaces as an unrelated
 * downstream `ALTER TABLE ... schema "x" does not exist` during COLLECT of some
 * innocent test, which reads as "my own change broke the suite" — that
 * mis-attribution was most of the cost when this took out the whole
 * operator-core integration tier on 2026-07-27.
 *
 * The probe is CLASS-level, not a hardcoded schema name: for every migration the
 * ledger claims is applied, assert the schemas that file DECLARES it creates
 * actually exist. So it catches the next instance of this class, not just the one
 * that bit us.
 *
 * NO FALSE POSITIVES BY CONSTRUCTION: the migration runner applies a file's DDL
 * and its ledger INSERT inside ONE transaction (see migration-runner.js — "Apply +
 * record in one transaction so a partial apply doesn't leave schema_migrations
 * claiming success"), so a concurrently-running migration can never be OBSERVED as
 * recorded-but-missing. A hit therefore means genuine divergence, never a race —
 * which is what makes reprovisioning on it safe rather than churn-inducing.
 */
const CREATE_SCHEMA_RE = /^[^\S\r\n]*CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/gim;
const DROP_SCHEMA_RE = /^[^\S\r\n]*DROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/gim;
const RENAME_SCHEMA_RE =
  /^[^\S\r\n]*ALTER\s+SCHEMA\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?\s+RENAME\s+TO\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?/gim;

/** A schema-level effect declared by one migration file. */
export type SchemaMutation =
  | { kind: 'create'; name: string }
  | { kind: 'drop'; name: string }
  | { kind: 'rename'; name: string; to: string };

/**
 * The schema-level effects a migration file declares. Pure + exported for unit test.
 *
 * CREATE ALONE IS NOT ENOUGH, and getting this wrong is expensive in the SAFE
 * direction. The first cut of this probe looked only at `CREATE SCHEMA` and
 * immediately fired on a healthy container: `000-baseline.sql` creates
 * `papercup_shared`, and `332-rename-papercup-shared-to-papercusp-shared.sql`
 * RENAMES it away — so its absence is CORRECT, not divergence. A create-only
 * probe would have reprovisioned a perfectly good container (replaying ~476
 * migrations) on every single run. So we track drops and renames too and fold
 * them in apply order, and only the NET-expected set is asserted.
 *
 * Deliberately conservative: only unconditional, line-leading statements count. A
 * schema created inside a DO/plpgsql block is NOT matched, because we cannot know
 * whether its guard fired — and a probe that guesses reprovisions healthy
 * containers, which is worse than missing a case.
 */
export function schemaMutationsInMigrationSql(sqlText: string): SchemaMutation[] {
  // Strip line comments so a commented-out statement is never counted.
  const src = sqlText.replace(/--[^\r\n]*/g, '');
  const out: Array<SchemaMutation & { at: number }> = [];
  for (const m of src.matchAll(CREATE_SCHEMA_RE)) {
    if (m[1]) out.push({ kind: 'create', name: m[1].toLowerCase(), at: m.index ?? 0 });
  }
  for (const m of src.matchAll(DROP_SCHEMA_RE)) {
    if (m[1]) out.push({ kind: 'drop', name: m[1].toLowerCase(), at: m.index ?? 0 });
  }
  for (const m of src.matchAll(RENAME_SCHEMA_RE)) {
    if (m[1] && m[2]) {
      out.push({ kind: 'rename', name: m[1].toLowerCase(), to: m[2].toLowerCase(), at: m.index ?? 0 });
    }
  }
  // Within one file, statement ORDER decides the net effect (create-then-drop is
  // not the same as drop-then-create), so restore source order.
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...mut }) => mut);
}

/**
 * Fold every recorded migration's mutations, IN APPLY ORDER, into the set of
 * schemas that should exist now. Apply order is filename sort — the same order
 * `applyPendingMigrations` uses (`readdir().filter(.sql).sort()`).
 */
export function expectedSchemasAfter(
  migrationsInApplyOrder: Array<{ migration: string; mutations: SchemaMutation[] }>,
): Map<string, string> {
  // schema -> the migration that last established it (for a nameable message)
  const present = new Map<string, string>();
  for (const { migration, mutations } of migrationsInApplyOrder) {
    for (const mut of mutations) {
      if (mut.kind === 'create') present.set(mut.name, migration);
      else if (mut.kind === 'drop') present.delete(mut.name);
      else {
        present.delete(mut.name);
        present.set(mut.to, migration);
      }
    }
  }
  return present;
}

/** One recorded-but-missing pair. Pure shape, exported for unit test. */
export interface LedgerSchemaDivergence {
  migration: string;
  schema: string;
}

/**
 * Pure diff: which schemas does the recorded migration set say should exist that
 * reality does not have? Split out from the IO so it is unit-testable without a
 * database.
 *
 * Sorts `recorded` itself rather than trusting the caller to. PG returns ledger
 * rows in no guaranteed order, and folding a rename BEFORE the create it cancels
 * resurrects exactly the false positive this probe exists to avoid — so the
 * ordering guarantee belongs here, not in a comment on the call site.
 */
export function diffLedgerAgainstSchemas(input: {
  recorded: string[];
  mutationsOf: (migration: string) => SchemaMutation[];
  existing: Set<string>;
}): LedgerSchemaDivergence[] {
  const expected = expectedSchemasAfter(
    [...input.recorded]
      .sort()
      .map((migration) => ({ migration, mutations: input.mutationsOf(migration) })),
  );
  const out: LedgerSchemaDivergence[] = [];
  for (const [schema, migration] of expected) {
    if (!input.existing.has(schema)) out.push({ migration, schema });
  }
  return out;
}

/**
 * Run the probe against a live DSN. Returns [] when the ledger and the schema
 * agree — including on a brand-new container, where the ledger table does not
 * exist yet and there is by definition nothing to diverge from.
 */
async function findLedgerSchemaDivergence(
  dsn: string,
  sqlDir: string,
): Promise<LedgerSchemaDivergence[]> {
  const sql = postgres(dsn, { max: 1, onnotice: () => {} });
  try {
    const [ledger] = await sql<{ present: boolean }[]>`
      SELECT to_regclass('harness_shared.schema_migrations') IS NOT NULL AS present`;
    if (!ledger?.present) return []; // fresh container — nothing recorded yet
    const rows = await sql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.schema_migrations`;
    if (rows.length === 0) return [];

    const onDisk = new Set(readdirSync(sqlDir).filter((f) => f.endsWith('.sql')));
    const cache = new Map<string, SchemaMutation[]>();
    const mutationsOf = (migration: string): SchemaMutation[] => {
      // A ledger row whose FILE is gone cannot be checked — skip rather than
      // guess. (Deleting an applied migration is its own problem, not this one.)
      if (!onDisk.has(migration)) return [];
      let d = cache.get(migration);
      if (!d) {
        d = schemaMutationsInMigrationSql(readFileSync(resolve(sqlDir, migration), 'utf8'));
        cache.set(migration, d);
      }
      return d;
    };

    // Apply order, matching the runner's own `readdir().filter(.sql).sort()` — a
    // rename/drop only cancels an earlier create if we fold them in that order.
    const recorded = rows.map((r) => r.filename).sort();
    const wanted = expectedSchemasAfter(
      recorded.map((migration) => ({ migration, mutations: mutationsOf(migration) })),
    );
    if (wanted.size === 0) return [];

    const present = await sql<{ nspname: string }[]>`
      SELECT nspname FROM pg_namespace WHERE nspname = ANY(${[...wanted.keys()]})`;
    return diffLedgerAgainstSchemas({
      recorded,
      mutationsOf,
      existing: new Set(present.map((p) => p.nspname.toLowerCase())),
    });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up from this file until we find the monorepo root — the dir that holds
 * `libs/papercusp/libs/db/sql`. Robust to wherever this shared file is hoisted
 * (its own package's src, a node_modules symlink, …), unlike a fixed `../../..`.
 */
function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, 'libs/papercusp/libs/db/sql'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `baseline-schema globalSetup: could not locate the monorepo root (no libs/papercusp/libs/db/sql found walking up from ${__dirname})`,
  );
}

const REPO_ROOT = findRepoRoot();
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

// Boot pre-step (roles + extensions) — mirrors embedded-postgres-server/src/index.js.
const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

export default async function setup({ provide }: GlobalSetupContext) {
  // NO-DOCKER ESCAPE HATCH (EI-13104) — see the module doc comment above. Checked
  // first so a sandboxed caller with no docker.sock access never touches
  // PostgreSqlContainer at all.
  const existingAdminUrl = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
  let dsn: string;
  let dropDb: (() => Promise<void>) | null = null;

  if (existingAdminUrl) {
    const dbName = `papercusp_it_baseline_${randomBytes(6).toString('hex')}`;
    // EI-10533: previously zero retry tolerance here — a single transient
    // "in recovery mode" / "not yet accepting connections" FATAL on the
    // box's shared native PG cluster (fleet-wide concurrent test-DB churn)
    // failed globalSetup outright, with the raw postgres error giving no
    // hint the real cause was shared-infra churn, not a code bug. Ride out
    // the same bounded window the reused-container health-check below (and
    // getTestPg's own container path in pg-container.ts) already tolerates.
    await withPgStartupRetry(async () => {
      const admin = postgres(existingAdminUrl, { max: 1, onnotice: () => {} });
      try {
        // No reuse/advisory-lock dance here (unlike the container path below):
        // every setup() call under this escape hatch mints its OWN fresh database,
        // so there is nothing to race with itself over.
        await admin.unsafe(`CREATE DATABASE "${dbName}"`);
      } catch (e) {
        throw new Error(
          `baseline-schema-global-setup (no-docker escape hatch): CREATE DATABASE against ` +
            `PAPERCUSP_TEST_PG_ADMIN_URL failed: ${e instanceof Error ? e.message : String(e)}. If this names ` +
            `a transient recovery-mode / not-yet-accepting-connections FATAL, this is very likely shared-infra ` +
            `churn on the box's native PG cluster (concurrent test-DB creates/drops from other fleet agents) — ` +
            `NOT a real test or code bug. See EI-10533.`,
          { cause: e },
        );
      } finally {
        await admin.end({ timeout: 5 }).catch(() => {});
      }
    });
    const url = new URL(existingAdminUrl);
    url.pathname = `/${dbName}`;
    dsn = url.toString();
    dropDb = async () => {
      const cleanup = postgres(existingAdminUrl, { max: 1, onnotice: () => {} });
      try {
        // WITH (FORCE) (PG13+; this repo is on pg18) drops even if a lingering
        // connection from a slow-to-close test client is still attached.
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    };
  } else {
    // WI-2942 (2026-07-05): pg16 -> pg18, to match the shipped/embedded operator
    // (PostgreSQL 18.3) — see libs/test-config/src/pg-container.ts for the full
    // rationale (PG16 silently allowed a DELETE PG18 rejects; WI-2914 shipped
    // uncaught because CI tested the wrong major).
    const startBaselineContainer = () =>
      new PostgreSqlContainer('pgvector/pgvector:pg18')
        .withDatabase('papercusp_it')
        .withUsername('it_admin')
        .withPassword('it_admin')
        // Reuse the baseline container across Vitest processes. The previous
        // ephemeral container replayed ~476 migrations for every focused file;
        // under checkpoint concurrency that startup alone could consume the test's
        // entire 90s budget. The advisory lock below makes warm migrations safe.
        .withReuse()
        .start();
    const container = await withTestcontainerStartLock(BASELINE_SCHEMA_CONTAINER_START_LOCK, async () => {
      let c = await startBaselineContainer();
      // EI-2433: validate the (possibly reused) container's DB before trusting it.
      // A reused-but-stale container matches on config alone; stopping it here
      // means testcontainers' reuse lookup (which only matches RUNNING containers)
      // can't find it again, so the retry below provisions a genuinely fresh one.
      if (!(await isBaselineContainerHealthy(c.getConnectionUri()))) {
        console.error(
          '[baseline-schema-global-setup] reused container failed health-check (stale/missing papercusp_it) — stopping + reprovisioning fresh',
        );
        await c.stop().catch(() => {});
        c = await startBaselineContainer();
      }
      // EI-18779962385972529: reachable is not the same as CORRECT. A reused
      // container whose ledger claims a migration whose objects are absent will
      // skip that file for ever and fail every dependent migration on every run,
      // with no self-heal — so treat divergence exactly like the staleness above:
      // stop it (which un-registers it from testcontainers' reuse lookup, since
      // that only matches RUNNING containers) and provision a genuinely fresh one.
      // Fail-soft: a probe that cannot run must never block the tier it protects.
      try {
        const divergence = await findLedgerSchemaDivergence(c.getConnectionUri(), SQL_DIR);
        if (divergence.length > 0) {
          const detail = divergence
            .slice(0, 5)
            .map((d) => `${d.migration} → schema "${d.schema}"`)
            .join(', ');
          console.error(
            `[baseline-schema-global-setup] reused container is DIVERGED: schema_migrations records ` +
              `${divergence.length} migration/schema pair(s) whose schema does NOT exist (${detail}` +
              `${divergence.length > 5 ? ', …' : ''}). The runner skips any migration already in the ` +
              `ledger, so this never self-heals and would surface as an unrelated "schema does not ` +
              `exist" error during COLLECT of some innocent test — stopping + reprovisioning fresh ` +
              `(EI-18779962385972529).`,
          );
          await c.stop().catch(() => {});
          c = await startBaselineContainer();
        }
      } catch (e) {
        console.error(
          '[baseline-schema-global-setup] ledger/schema divergence probe failed (continuing — the ' +
            'probe is a guard, never a gate):',
          e,
        );
      }
      return c;
    });
    dsn = container.getConnectionUri();
  }

  // Exercise the real boot-path migration runner (resolved from the discovered
  // repo root rather than a brittle relative path so this file is location-agnostic).
  const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
    applyPendingMigrations: (opts: {
      client: postgres.Sql;
      sqlDir: string;
      }) => Promise<{ appliedCount: number; totalKnown: number; failed?: Array<unknown> }>;
  };

  // max:1 — the runner applies each migration in an explicit BEGIN/COMMIT block.
  const sql = postgres(dsn, { max: 1, onnotice: () => {} });
  try {
    // Multiple Vitest processes can attach to the reusable baseline container at
    // once. Serialize the migration runner itself, not just Docker startup:
    // otherwise two fresh readers can both observe the same pending file and race
    // on its DDL/ledger insert.
    await sql.unsafe(`SELECT pg_advisory_lock(hashtext('papercusp-baseline-schema-migrations'))`);
    try {
      await sql.unsafe(BOOT_PREREQS_DDL);
      // EI-18748424931934157: seed the dependent-view probe BEFORE the runner, so pending
      // migrations are applied against a REALISTIC schema graph rather than a bare
      // harness_shared. See seedDependentViewProbe — this is the half that actually catches
      // a 678-class regression.
      await seedDependentViewProbe(sql);
      const { appliedCount, totalKnown, failed = [] } = await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });
      if (failed.length > 0) {
        throw new Error(
          `baseline globalSetup: ${failed.length} migration(s) failed (${appliedCount}/${totalKnown} applied). ` +
            `If the failure is "cannot drop ... because other objects depend on it" naming ` +
            `${DEPENDENT_VIEW_PROBE_SCHEMA}.harness_features, that is the EI-18748424931934157 probe doing its job: ` +
            `your migration breaks per-harness dependent views that exist on every real operator. Use ` +
            `CREATE OR REPLACE VIEW (append-only), or DROP ... CASCADE plus an explicit recreate of the dependents.`,
        );
      }
      // And again AFTER, for the fresh-container case: on a brand-new database the base
      // relation did not exist yet above, so the probe could not be created. Seeding it
      // here means the container is guarded from its NEXT run onward — which is when new
      // migrations actually land, since this container is reused across runs.
      await seedDependentViewProbe(sql);
    } finally {
      await sql.unsafe(`SELECT pg_advisory_unlock(hashtext('papercusp-baseline-schema-migrations'))`).catch(() => {});
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  provide('baselineSchemaDsn', dsn);

  return async () => {
    // Container path: reusable box-level infrastructure — stopping it from one
    // Vitest process invalidates every other integration file attached to this
    // baseline DB, so it is deliberately left running.
    //
    // Escape-hatch path: this run minted its OWN throwaway database (not shared
    // with any other process), so it is safe — and correct — to drop it here.
    if (dropDb) {
      // Best-effort: a leaked throwaway `papercusp_it_baseline_*` database (this
      // run's own, uniquely-named) is a harmless cleanup miss, not a correctness
      // issue — but log it so a leak is traceable instead of silently swallowed.
      await dropDb().catch((err) => {
        console.error('[baseline-schema-global-setup] failed to drop the escape-hatch throwaway database:', err);
      });
    }
  };
}

// Type the injected value for consumers.
declare module 'vitest' {
  interface ProvidedContext {
    baselineSchemaDsn: string;
  }
}
