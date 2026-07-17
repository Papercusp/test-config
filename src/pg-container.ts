import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomBytes } from 'node:crypto';
import { withTestcontainerStartLock } from './testcontainer-start-lock.ts';
import { SubstrateCircuitBreaker } from './substrate-circuit-breaker.ts';

let containerPromise: Promise<StartedPostgreSqlContainer> | null = null;

/**
 * Fail-fast breaker for a PERSISTENTLY-down shared substrate (EI-11530). The
 * per-call retry below rides out a BRIEF recovery window; this breaker catches
 * the OTHER case — the substrate down long enough that file after file exhausts
 * its retries — and latches so the run reports a substrate outage instead of
 * 455 junk test-failures. Threshold is env-tunable; 3 fully-exhausted failures
 * (~30s+ continuous outage) is a strong true positive. Module-scoped, so it
 * dies with the vitest worker and can never leave a stale "down" marker.
 */
function substrateFailfastThreshold(): number {
  const raw = process.env.PAPERCUSP_TEST_SUBSTRATE_FAILFAST_THRESHOLD;
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : 3;
}
const substrateBreaker = new SubstrateCircuitBreaker(
  substrateFailfastThreshold(),
  'getTestPg (shared test Postgres)',
);

/**
 * A stable, human-readable descriptor of WHICH container an error came from
 * (EI-11530 diagnosability). The confusable failure — psql `FATAL: the database
 * system is in recovery mode` — names the CONTAINER'S internal socket
 * `/var/run/postgresql/.s.PGSQL.5432`, byte-identical to the host's native PG
 * socket, so it masqueraded as a live-DB crash and cost real diagnosis time.
 * Naming the container id + mapped host:port makes it unambiguous. Every getter
 * is guarded — a container mid-teardown can throw from these.
 */
function describeContainer(container: StartedPostgreSqlContainer): string {
  const safe = (fn: () => unknown): string => {
    try {
      const v = fn();
      return v == null ? '?' : String(v);
    } catch {
      return '?';
    }
  };
  const id = safe(() => container.getId()).slice(0, 12);
  const host = safe(() => container.getHost());
  const port = safe(() => container.getMappedPort(5432));
  return `[testcontainer ${id} @ ${host}:${port}]`;
}

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
  // Fail-fast: once the breaker has latched (substrate persistently down), throw
  // the distinct TEST SUBSTRATE DOWN error immediately — no container start, no
  // retry — so the rest of the run reports the outage instead of grinding.
  substrateBreaker.check();
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
          // WI-4133: this ONE container is `.withReuse()`d by EVERY vitest
          // process on the box (all forks, all packages, ~30+ fleet agents at
          // once) — each opening its own client pool (createFreshPgDb: max 4;
          // createFreshTestDb/migrated variants similar). The stock PG default
          // `max_connections=100` (sized for a laptop, per the analogous fix
          // for the operator's own DB — see agent-insights
          // pg-connection-exhaustion-too-many-clients) is trivially blown past
          // by fleet-wide concurrency, surfacing as "sorry, too many clients
          // already" in heavy operator-boot integration suites (gym
          // autoloop-cycle, etc.) even though WI-3821's CPU-load admission
          // gate is healthy — that gate staggers *host load*, not *PG
          // connection count*, so it does not prevent this. Raising the
          // ceiling on this test-only container is free (no production data,
          // no persistence to protect) and mirrors the native-PG fix exactly.
          .withCommand(['postgres', '-c', 'max_connections=500'])
          .withReuse()
          .start(),
      );
      // Heal the cluster-global framework roles once per container (see above).
      //
      // RETRY ON "in recovery mode" — this container is `.withReuse()`d across
      // EVERY concurrent vitest process on the box (all forks of this run, other
      // packages' concurrent runs, the green-checkpoint, ~30+ fleet agents at
      // once). Docker's reuse-hash matching isn't perfectly stable under that much
      // concurrent churn, so a fresh `docker ps` regularly shows several
      // short-lived pgvector/pgvector:pg18 containers being created/torn down
      // side-by-side with the long-lived ones — and this process can attach to
      // one that is mid-startup crash-recovery (WAL redo), a normal but BRIEF
      // (sub-second to a few seconds) PG state, not a real outage (WI-3578 live
      // finding, 2026-07-09: 3 consecutive integration-test runs on a healthy,
      // unloaded box each hit `FATAL: the database system is in recovery mode`
      // on the FIRST framework-role-ensure attempt, then succeeded once retried).
      // A bounded retry rides out the window instead of failing every concurrent
      // suite that happens to touch the container during it.
      //
      // TIME-BOUNDED, not attempt-count-bounded (WI-5254/WI-5256, 2026-07-17):
      // the original fixed 6-attempt/~10.5s budget (500ms*attempt backoff) was
      // sized for the "healthy, unloaded box" case above — but under today's much
      // heavier fleet load (50+ concurrent agents) the recovery window regularly
      // outlasts it: harness_shared.test_runs shows curation-state.integration and
      // render-templates.integration each failing on this exact "in recovery mode"
      // message with durations of 8.2-10.0s, i.e. exhausting the full old budget
      // and then failing anyway. Ride out a LONGER window (up to 30s total) with
      // backoff capped at 3s/attempt, so a slower-but-still-transient recovery
      // still resolves instead of flaking the whole suite. This does not weaken
      // the SubstrateCircuitBreaker above it — a genuinely-down substrate still
      // trips that after `threshold` fully-exhausted acquisitions; it just makes
      // each individual exhaustion a truer signal of "actually down" rather than
      // "recovery took longer than an arbitrary 10s".
      //
      // ALSO RETRY ON "not yet accepting connections" (WI-5263, 2026-07-17): an
      // EARLIER point in the same PG startup sequence than "in recovery mode" —
      // `FATAL: the database system is not yet accepting connections / DETAIL:
      // Consistent recovery state has not been yet reached` — observed in
      // engineer-issues-view-dml.integration.test.ts's quarantine history with
      // the identical "attach mid-restart" mechanism as above. Same transient
      // class, same budget.
      const RETRY_BUDGET_MS = 30_000;
      const RETRYABLE_STARTUP_MSG = /in recovery mode|not yet accepting connections/i;
      const retryStartedAt = Date.now();
      let res: Awaited<ReturnType<typeof container.exec>> | undefined;
      let lastErr: unknown;
      for (let attempt = 1; ; attempt++) {
        try {
          res = await container.exec([
            'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'test', '-d', 'papercusp_test', '-c', FRAMEWORK_ROLES_DDL,
          ]);
          if (res.exitCode === 0) break;
          lastErr = new Error(
            `getTestPg: framework-role ensure failed ${describeContainer(container)} ` +
              `(exit ${res.exitCode}): ${res.output}`,
          );
        } catch (e) {
          lastErr = e;
          res = undefined;
        }
        const msg = res ? res.output : lastErr instanceof Error ? lastErr.message : String(lastErr);
        const elapsedMs = Date.now() - retryStartedAt;
        if (!RETRYABLE_STARTUP_MSG.test(msg) || elapsedMs >= RETRY_BUDGET_MS) {
          throw lastErr;
        }
        await new Promise((r) => setTimeout(r, Math.min(attempt * 500, 3000)));
      }
      if (!res || res.exitCode !== 0) {
        throw lastErr ?? new Error('getTestPg: framework-role ensure failed (unknown error)');
      }
      return container;
    })()
      .then((container) => {
        // Substrate reachable — reset the fail-fast streak. Recorded here (once
        // per acquisition), not per awaiter, so the breaker's count reflects
        // distinct acquisition outcomes.
        substrateBreaker.recordSuccess();
        return container;
      })
      .catch((e) => {
        // Don't strand every later caller in this process on a permanently-rejected
        // promise — a fresh call gets a clean shot at (possibly) a different
        // container/state instead of replaying the same failure forever.
        containerPromise = null;
        // Count this distinct acquisition failure toward the fail-fast breaker
        // (EI-11530). Runs once per rejected promise — concurrent awaiters share
        // this single outcome, so the streak isn't inflated by fan-out.
        substrateBreaker.recordFailure(e);
        throw e;
      });
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
