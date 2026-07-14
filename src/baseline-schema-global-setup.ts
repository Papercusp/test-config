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
 */
import type { GlobalSetupContext } from 'vitest/node';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { existsSync } from 'node:fs';
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
  const dsn = container.getConnectionUri();

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
    // Reusable box-level infrastructure: stopping it from one Vitest process
    // invalidates every other integration file attached to this baseline DB.
  };
}

// Type the injected value for consumers.
declare module 'vitest' {
  interface ProvidedContext {
    baselineSchemaDsn: string;
  }
}
