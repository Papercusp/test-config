import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomBytes } from 'node:crypto';

let containerPromise: Promise<StartedPostgreSqlContainer> | null = null;

// Framework roles, ensured CREATE-OR-FIX (login + correct password) once per container.
// The container is shared + REUSED, and roles are cluster-global. Some tests historically
// created harness_app password-less / NOLOGIN (voice-lease, substrate-outbox-trigger),
// which — since most other tests create it only `IF NOT EXISTS` — left a stale unusable
// role that broke every later password-login test ("password authentication failed for
// user harness_app"). Ensuring the roles here (ALTER to fix an existing one) makes the
// shared cluster's roles deterministic regardless of which test ran first.
const FRAMEWORK_ROLES_DDL = `
  DO $$ BEGIN
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
    // pgvector/pgvector:pg16 — a PG16 superset that bundles the `vector`
    // extension. Required because the squashed 000-baseline.sql schema (Papercusp)
    // has vector(N) columns; a plain postgres:16-alpine can't build it. Everything
    // postgres:16-alpine offered is still present (same PG major), so existing
    // Restart integration tests are unaffected.
    containerPromise = (async () => {
      const container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
        .withDatabase('papercusp_test')
        .withReuse()
        .start();
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

export async function teardownTestPg(): Promise<void> {
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

export async function withTestSchema(): Promise<TestSchemaHandle> {
  const connectionUri = await getTestPg();
  const schema = `t_${randomBytes(6).toString('hex')}`;
  return { schema, connectionUri };
}
