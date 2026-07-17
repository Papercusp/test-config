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
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withTestcontainerStartLock } from './testcontainer-start-lock.ts';

/**
 * The baseline schema owns a dedicated container, so its Docker handshake must
 * not queue behind getTestPg's reused-container startup. Keep baseline runs
 * serialized with one another, while leaving the shared test-PG lane free to
 * start concurrently (EI-11788).
 */
export const BASELINE_SCHEMA_CONTAINER_START_LOCK = 'baseline-schema-container-start';

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
    const admin = postgres(existingAdminUrl, { max: 1, onnotice: () => {} });
    try {
      // No reuse/advisory-lock dance here (unlike the container path below):
      // every setup() call under this escape hatch mints its OWN fresh database,
      // so there is nothing to race with itself over.
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end({ timeout: 5 });
    }
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
    const container = await withTestcontainerStartLock(BASELINE_SCHEMA_CONTAINER_START_LOCK, () =>
      new PostgreSqlContainer('pgvector/pgvector:pg18')
        .withDatabase('papercusp_it')
        .withUsername('it_admin')
        .withPassword('it_admin')
        // Reuse the baseline container across Vitest processes. The previous
        // ephemeral container replayed ~476 migrations for every focused file;
        // under checkpoint concurrency that startup alone could consume the test's
        // entire 90s budget. The advisory lock below makes warm migrations safe.
        .withReuse()
        .start(),
    );
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
      const { appliedCount, totalKnown, failed = [] } = await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });
      if (failed.length > 0) {
        throw new Error(`baseline globalSetup: ${failed.length} migration(s) failed (${appliedCount}/${totalKnown} applied)`);
      }
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
