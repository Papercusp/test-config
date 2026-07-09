import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomBytes } from 'node:crypto';
import { withTestcontainerStartLock } from './testcontainer-start-lock.ts';

let containerPromise: Promise<StartedPostgreSqlContainer> | null = null;

/**
 * The shared integration-test Postgres image. pgvector/pgvector:pg18 — a PG18
 * superset bundling the `vector` extension the squashed 000-baseline.sql needs,
 * matching the shipped/embedded operator (PostgreSQL 18.3, WI-2942). The gym
 * cycle's own ephemeral provisioning image (`GYM_PROVISION_PG_IMAGE` in
 * packages/operator-core/lib/gym/gym-db-init.ts) MUST equal this — a skew is
 * what stranded the gym on pg16 while the test infra + operator moved to pg18
 * (EI-8784); gym-provision-image.test.ts asserts they stay in lockstep.
 */
export const TEST_PG_IMAGE = 'pgvector/pgvector:pg18';

// Framework roles, ensured CREATE-OR-FIX (login + correct password) once per container.
// The container is shared + REUSED, and roles are cluster-global. Some tests historically
// created harness_app password-less / NOLOGIN (voice-lease, substrate-outbox-trigger),
// which — since most other tests create it only `IF NOT EXISTS` — left a stale unusable
// role that broke every later password-login test ("password authentication failed for
// user harness_app"). Ensuring the roles here (ALTER to fix an existing one) makes the
// shared cluster's roles deterministic regardless of which test ran first.
const FRAMEWORK_ROLES_DDL = `
  DO $$ BEGIN
    -- The container is REUSED across vitest processes, so two runs can execute this
    -- block concurrently; IF NOT EXISTS/CREATE then races to a unique_violation on
    -- pg_authid_rolname_index. The xact-scoped advisory lock serializes them.
    PERFORM pg_advisory_xact_lock(hashtext('papercusp-test-framework-roles'));
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd';
    ELSE ALTER ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    ELSE ALTER ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd';
    ELSE ALTER ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $$;
`;

export async function getTestPg(): Promise<string> {
  if (!containerPromise) {
    // pgvector/pgvector:pg18 — a PG18 superset that bundles the `vector`
    // extension. Required because the squashed 000-baseline.sql schema (Papercusp)
    // has vector(N) columns; a plain postgres:18-alpine can't build it.
    //
    // WI-2942 (2026-07-05): bumped from pg16 -> pg18 to match the shipped/embedded
    // operator, which runs PostgreSQL 18.3 (embedded-postgres 18.3.0-beta.17). PG16
    // silently ALLOWED behavior PG18 REJECTS (e.g. a DELETE against a REPLICA
    // IDENTITY FULL table with a generated column in a delete-publishing
    // publication — WI-2914), so testing against PG16 let a PG18-only bug ship to
    // the packaged desktop uncaught. pgvector/pgvector:pg18 exists on Docker Hub
    // (verified via `docker manifest inspect` + a version pull: reports
    // "PostgreSQL 18.4 (Debian 18.4-1.pgdg12+1)" — same major as the shipped 18.3).
    containerPromise = (async () => {
      const container = await withTestcontainerStartLock('shared-docker-testcontainers-start', () =>
        new PostgreSqlContainer(TEST_PG_IMAGE)
          .withDatabase('papercusp_test')
          .withReuse()
          .start(),
      );
      // Heal the cluster-global framework roles once per container (see above).
      const res = await container.exec([
        'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'test', '-d', 'papercusp_test', '-c', FRAMEWORK_ROLES_DDL,
      ]);
      if (res.exitCode !== 0) {
        throw new Error(`getTestPg: framework-role ensure failed (exit ${res.exitCode}): ${res.output}`);
      }
      return container;
    })();
  }
  const container = await containerPromise;
  return container.getConnectionUri();
}

/**
 * DELIBERATE NO-OP unless `FORCE_TEST_PG_TEARDOWN=1` (WI-1992).
 *
 * The container is `withReuse()` — ONE docker container shared by EVERY vitest
 * process on the box (all forks of this run, other packages' concurrent runs,
 * the green-checkpoint). `stop()` from any single test file's afterAll therefore
 * killed the container out from under every OTHER in-flight suite: the first
 * file to finish nuked the rest into a CONNECTION_CLOSED / ECONNREFUSED /
 * "removal in progress" cascade (the operator-core 233-fail mass-fail class —
 * ~12 apps/operator test files called this in afterAll, gated on a KEEP_TEST_PG
 * env NOTHING ever set). A reused container is box-level infrastructure: its
 * lifecycle belongs to docker/the operator, never to one test's teardown.
 *
 * The escape hatch is for a HUMAN/script deliberately reclaiming the container
 * while nothing is running — never for a suite.
 */
export async function teardownTestPg(): Promise<void> {
  if (process.env.FORCE_TEST_PG_TEARDOWN !== '1') return;
  if (containerPromise) {
    const c = await containerPromise;
    await c.stop();
    containerPromise = null;
  }
}

export interface TestSchemaHandle {
  schema: string;
  connectionUri: string;
}

/**
 * EI-7207 — writing a LISTEN/NOTIFY integration test against this container?
 * The first pg_notify after a fresh LISTEN is fast (~0.5-1.3s) in isolation,
 * but can take 4-8+ SECONDS to arrive when this box is running many other
 * PG-gated test files concurrently (10+ fleet agents' testcontainers/vitest
 * workers competing for CPU/Docker at once) — not a logic bug in your code.
 * Budget generous waitFor/test timeouts (15s+) for a LISTEN/NOTIFY assertion
 * from the start rather than debugging apparent timeouts as a defect.
 */
export async function withTestSchema(): Promise<TestSchemaHandle> {
  const connectionUri = await getTestPg();
  const schema = `t_${randomBytes(6).toString('hex')}`;
  return { schema, connectionUri };
}
