import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testcontainerStartLockRoot, withTestcontainerStartLock } from "./testcontainer-start-lock.ts";
import { SubstrateCircuitBreaker } from "./substrate-circuit-breaker.ts";
import {
  probePgReachable,
  RETRYABLE_PG_STARTUP_MSG,
  withPgStartupRetry,
} from "./pg-reachability.ts";

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
  "getTestPg (shared test Postgres)",
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
      return v == null ? "?" : String(v);
    } catch {
      return "?";
    }
  };
  const id = safe(() => container.getId()).slice(0, 12);
  const host = safe(() => container.getHost());
  const port = safe(() => container.getMappedPort(5432));
  return `[testcontainer ${id} @ ${host}:${port}]`;
}

/**
 * Re-resolve a reused container after its bounded startup retry is exhausted.
 *
 * `withReuse()` resolves by configuration hash, not by database readiness. A
 * running-but-wedged container therefore keeps being returned to every caller;
 * waiting longer only makes the same dead endpoint fail more slowly. Rotating
 * the reuse generation makes the next resolve provision a fresh container
 * without stopping the old one underneath concurrent readers. The caller owns
 * the bounded retry inside `ensure` and only calls this helper after that retry
 * has actually exhausted.
 */
export async function withContainerRecoveryReResolution<T>(
  resolve: () => Promise<T>,
  ensure: (container: T) => Promise<void>,
  retire: (container: T) => Promise<void>,
  options: {
    maxResolutions?: number;
    slowStageMs?: number;
    onStage?: (event: {
      stage: "resolve" | "ensure" | "retire";
      resolution: number;
      status: "waiting" | "done" | "failed";
      elapsedMs: number;
    }) => void;
  } = {},
): Promise<T> {
  const maxResolutions = options.maxResolutions ?? 2;
  if (!Number.isInteger(maxResolutions) || maxResolutions < 1) {
    throw new Error(
      `withContainerRecoveryReResolution: maxResolutions must be a positive integer`,
    );
  }

  const runStage = async <R>(
    stage: "resolve" | "ensure" | "retire",
    resolution: number,
    action: () => Promise<R>,
  ): Promise<R> => {
    const startedAt = Date.now();
    let reportedWaiting = false;
    const timer = setTimeout(() => {
      reportedWaiting = true;
      options.onStage?.({ stage, resolution, status: "waiting", elapsedMs: Date.now() - startedAt });
    }, options.slowStageMs ?? 5_000);
    timer.unref?.();
    try {
      const result = await action();
      if (reportedWaiting) {
        options.onStage?.({ stage, resolution, status: "done", elapsedMs: Date.now() - startedAt });
      }
      return result;
    } catch (error) {
      options.onStage?.({ stage, resolution, status: "failed", elapsedMs: Date.now() - startedAt });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  let container = await runStage("resolve", 1, resolve);
  for (let resolution = 1; ; resolution++) {
    try {
      await runStage("ensure", resolution, () => ensure(container));
      return container;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !isReprovisionableSharedTestPgFailure(message) ||
        resolution >= maxResolutions
      ) {
        throw error;
      }
      await runStage("retire", resolution, () => retire(container));
      container = await runStage("resolve", resolution + 1, resolve);
    }
  }
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
export const TEST_PG_IMAGE = "pgvector/pgvector:pg18";

/**
 * WI-10004084: the SHARED reused test cluster runs without crash durability.
 * It holds only throwaway per-test databases (hundreds at once), yet with the
 * stock fsync=on every `DROP DATABASE` forces an fsync'd checkpoint across all
 * of them. Measured 2026-09-30: six DROPs waited 1-2 h on IPC/CheckpointStart,
 * the checkpointer sat in IO/DataFileSync, and every suite's commits stalled
 * behind it (lock_timeout 55P03, CONNECT_TIMEOUT, a 50 s SU bootstrap).
 * A postgres crash loses nothing here (the page cache survives it); only a host
 * crash could, and a stopped container is never reused. Dedicated clusters
 * that measure WAL/fsync (`startDedicatedTestPg`) do not use this.
 */
export const SHARED_TEST_PG_DURABILITY_OFF = [
  "-c",
  "fsync=off",
  "-c",
  "synchronous_commit=off",
  "-c",
  "full_page_writes=off",
] as const;

/**
 * Test-only initdb mode for the shared, reused Postgres container.
 *
 * The official image performs a final filesystem-wide sync before creating
 * POSTGRES_DB and appending remote-access pg_hba entries. Under host I/O
 * pressure that sync can exceed testcontainers' startup budget. A timed-out
 * start then leaves PG_VERSION behind but not the database/HBA setup, and a
 * later reuse skips initialization permanently. This database is disposable
 * test infrastructure, so avoiding initdb's redundant pre-start sync removes
 * the interruption window without weakening production durability.
 */
export const TEST_PG_INITDB_ARGS = "--no-sync";

/**
 * Failures for which a reused shared-test container cannot heal in place.
 *
 * Transient startup errors already belonged here. The two additional messages
 * are the fingerprints of an official-image initialization interrupted after
 * initdb wrote PG_VERSION but before docker-entrypoint created POSTGRES_DB and
 * widened pg_hba.conf. Retrying that same reuse candidate can never work; move
 * the generation so the next resolution gets a fresh data volume.
 */
function isReprovisionableSharedTestPgFailure(message: string): boolean {
  return (
    RETRYABLE_PG_STARTUP_MSG.test(message) ||
    /no pg_hba\.conf entry/i.test(message) ||
    /database ["']?papercusp_test["']? does not exist/i.test(message)
  );
}

/**
 * The NON-DESTRUCTIVE Docker health bit for a pgvector test container
 * (EI-21116464706451765).
 *
 * @testcontainers/postgresql's stock healthcheck runs `pg_isready` INSIDE the
 * PID-1-postmaster container. During crash recovery it exits 2 as an unknown
 * postmaster child, which makes Postgres terminate every server process and
 * restart recovery; the stock 250ms interval then repeats the crash
 * indefinitely. This replaces it with a harmless liveness bit.
 *
 * ⚠ THIS CONSTANT IS ONLY SAFE WITH A HOST-SIDE SQL READINESS PROBE, and that
 * is why it is a shared constant rather than something each site inlines.
 * `PostgreSqlContainer` gates startup on
 * `Wait.forAll([Wait.forHealthCheck(), Wait.forListeningPorts()])`
 * (@testcontainers/postgresql/build/postgresql-container.js). Overriding the
 * healthcheck to `exit 0` therefore REMOVES a real startup gate — what remains
 * is only "the TCP port is published", which is NOT "Postgres accepts SQL"
 * (it can still be in crash recovery). Every site using this MUST perform its
 * own host-side readiness wait immediately after `.start()`:
 *   - `getTestPg` below     -> the FRAMEWORK_ROLES_DDL retry loop
 *   - baseline-schema-global-setup -> `isBaselineContainerHealthy` + reprovision
 * A site with no such probe must NOT adopt this constant until it grows one;
 * doing so trades a rare crash-recovery bug for a common startup race.
 *
 * EI-21340200136336953: kept as ONE exported constant, and enforced across call
 * sites by `pg-container.test.ts`'s class-level discovery guard, because the
 * sibling PG-IMAGE constant learned this the expensive way — WI-2942 fixed the
 * image at a single call site and four siblings silently kept a literal string
 * (EI-9497). A per-site inline healthcheck object is the same trap.
 */
export const NON_DESTRUCTIVE_PG_HEALTHCHECK = {
  // Annotated as a MUTABLE tuple rather than written `as const`: testcontainers'
  // `HealthCheck.test` is `["CMD-SHELL", string] | ["CMD", ...string[]]`, so a
  // readonly `as const` array is not assignable to it (TS2345).
  test: ["CMD-SHELL", "exit 0"] as ["CMD-SHELL", string],
  interval: 1000,
  timeout: 1000,
  retries: 1,
};

/**
 * A DEDICATED, per-run Postgres cluster — for a suite that must own its whole
 * cluster (e.g. the P-013 benchmark rigs, whose WAL/fsync counters are
 * cluster-wide). NOT the shared reused container (`getTestPg`).
 *
 * Why this exists instead of `new PostgreSqlContainer(...).start()` at each site
 * (measured 2026-09-27, P-013 workload A, EI-21116464706451765 class): the stock
 * testcontainers healthcheck runs `sh -c 'pg_isready …'` every 250 ms with a 1 s
 * timeout for the container's WHOLE life. Under host load Docker kills the timed-
 * out `sh`, orphaning `pg_isready` to PID 1 — which is postgres. PG treats an
 * untracked child's non-zero exit as a backend crash: the dedicated cluster's own
 * log shows `untracked child process (PID 11810) exited with exit code 2` and, at
 * the same millisecond, `terminating any other active server processes`, after
 * which every rig connection died `write CONNECTION_CLOSED`. The non-destructive
 * healthcheck removes that; because it also removes the startup gate, the host
 * waits for a real `SELECT 1` over TCP (which the entrypoint's socket-only init
 * server cannot answer) before returning.
 */
export async function startDedicatedTestPg(
  opts: { command?: string[]; readyBudgetMs?: number } = {},
): Promise<StartedPostgreSqlContainer> {
  let container = new PostgreSqlContainer(TEST_PG_IMAGE)
    .withHealthCheck({ ...NON_DESTRUCTIVE_PG_HEALTHCHECK });
  if (opts.command) container = container.withCommand(opts.command);
  const started = await container.start();
  const ready = await probePgReachable(started.getConnectionUri(), opts.readyBudgetMs ?? 120_000);
  if (!ready.ok) {
    await started.stop().catch(() => undefined);
    throw new Error(
      `startDedicatedTestPg: the dedicated cluster never answered SELECT 1 over TCP within ` +
        `${ready.elapsedMs}ms (${ready.lastError}); the container was stopped.`,
    );
  }
  return started;
}

/**
 * Docker json-file rotation for the shared, reused test container (WI-10003219).
 *
 * The container lives for weeks and logs every fleet test's PG ERROR/STATEMENT
 * pair. With the daemon's default (no max-size) its log reached 45 GB by
 * 2026-09-26 and put the root disk at 98%. About 1 GiB keeps the last several
 * hours for `docker logs` diagnosis.
 */
export const TEST_PG_LOG_OPTS = { "max-size": "256m", "max-file": "4" } as const;

/**
 * Label that moves the `.withReuse()` hash when the log options change.
 *
 * testcontainers hashes `createOpts` only, and log options are HostConfig. A
 * log-option change on its own would keep reusing the uncapped container
 * forever. Labels are part of `createOpts`, so this one makes the first run
 * after a change provision a fresh, capped container.
 */
export const TEST_PG_LOG_CAP_LABEL = "org.papercusp.test-pg.log-cap";
export const TEST_PG_REUSE_GENERATION_LABEL = "org.papercusp.test-pg.generation";
const TEST_PG_REUSE_GENERATION_FILE = "test-pg-reuse-generation";

/** Called under the shared test-PG startup lock so every process picks one generation. */
export async function readTestPgReuseGeneration(root = testcontainerStartLockRoot()): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(join(root, TEST_PG_REUSE_GENERATION_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const generation = Number(raw.trim());
  if (!Number.isSafeInteger(generation) || generation < 0 || raw.trim() !== String(generation)) {
    throw new Error(`invalid shared test-PG reuse generation: ${raw.trim()}`);
  }
  return generation;
}

/** Retire a failed reuse candidate without stopping a container peers may still use. */
export async function rotateTestPgReuseGeneration(root = testcontainerStartLockRoot()): Promise<number> {
  const generation = (await readTestPgReuseGeneration(root)) + 1;
  const target = join(root, TEST_PG_REUSE_GENERATION_FILE);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${generation}\n`);
  await rename(temporary, target);
  return generation;
}

/** `PostgreSqlContainer` with a capped json-file log (HostConfig is protected). */
export class CappedLogPostgreSqlContainer extends PostgreSqlContainer {
  withCappedJsonLog(): this {
    this.hostConfig.LogConfig = {
      Type: "json-file",
      Config: { ...TEST_PG_LOG_OPTS },
    };
    return this.withLabels({
      [TEST_PG_LOG_CAP_LABEL]: `json-file:${TEST_PG_LOG_OPTS["max-size"]}x${TEST_PG_LOG_OPTS["max-file"]}`,
    });
  }
}

// Framework roles, ensured CREATE-OR-FIX (login + fixed privilege attributes +
// correct password) once per container.
// The container is shared + REUSED, and roles are cluster-global. Some tests historically
// created harness_app password-less / NOLOGIN (voice-lease, substrate-outbox-trigger),
// which — since most other tests create it only `IF NOT EXISTS` — left a stale unusable
// role that broke every later password-login test ("password authentication failed for
// user harness_app"). Ensuring the roles here (ALTER to fix an existing one) makes the
// shared cluster's roles deterministic regardless of which test ran first. In particular,
// harness_zero is the sync role: it needs LOGIN + REPLICATION + BYPASSRLS, but must never
// be SUPERUSER in tests because that would make ACL-denial assertions meaningless.
const FRAMEWORK_ROLES_DDL = `
  DO $$ BEGIN
    -- The container is REUSED across vitest processes, so two runs can execute this
    -- block concurrently; IF NOT EXISTS/CREATE then races to a unique_violation on
    -- pg_authid_rolname_index. The xact-scoped advisory lock serializes them.
    PERFORM pg_advisory_xact_lock(hashtext('papercusp-test-framework-roles'));
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS PASSWORD 'harness_app_pwd';
    ELSE ALTER ROLE harness_app   LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER NOREPLICATION PASSWORD 'harness_admin_pwd';
    ELSE ALTER ROLE harness_admin LOGIN SUPERUSER NOREPLICATION PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION NOSUPERUSER BYPASSRLS PASSWORD 'harness_zero_pwd';
    ELSE ALTER ROLE harness_zero  LOGIN REPLICATION NOSUPERUSER BYPASSRLS PASSWORD 'harness_zero_pwd'; END IF;
  END $$;
`;

/**
 * NO-DOCKER ESCAPE HATCH (EI-13104-class fix; WI-5415 found the gap): a
 * `capability:bash`-sandboxed cup can never reach docker.sock (see the identical
 * escape hatch's doc comment in baseline-schema-global-setup.ts for why that's the
 * sandbox correctly containing a privilege-escalation vector, not a bug to route
 * around). EI-13104 added the escape hatch to the BASELINE-SCHEMA globalSetup's own
 * dedicated container, but this SEPARATE shared-container path (`getTestPg`, used by
 * `createFreshTestDb`/`createFreshDb` — the fixture behind most `.integration.test.ts`
 * files, including this repo's rubric/scorecard suites) still hard-required Docker —
 * the same class of blocker recurring in a sibling code path. Mirrors that exact
 * pattern here: `PAPERCUSP_TEST_PG_ADMIN_URL` (a CREATEDB-capable role on an
 * ALREADY-RUNNING Postgres the sandbox can reach, e.g. the box's native PG) skips
 * `PostgreSqlContainer` entirely and returns that URL directly (after ensuring the
 * same framework roles the container path applies). Purely additive — the env var
 * is unset by default, so every existing Docker-backed run is unaffected.
 */
let noDockerAdminUrlPromise: Promise<string> | null = null;

export async function getTestPg(): Promise<string> {
  const existingAdminUrl = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
  if (existingAdminUrl) {
    if (!noDockerAdminUrlPromise) {
      noDockerAdminUrlPromise = (async () => {
        // EI-10533: this native-PG path previously had ZERO retry tolerance —
        // unlike the container path below, a single transient "in recovery
        // mode" / "not yet accepting connections" FATAL on the box's shared
        // native PG cluster (fleet-wide concurrent test-DB churn) failed
        // outright, with the raw postgres error giving no hint the real
        // cause was shared-infra churn rather than a test/code bug. Ride out
        // the same bounded window the container path already tolerates.
        await withPgStartupRetry(async () => {
          const admin = postgres(existingAdminUrl, {
            max: 1,
            onnotice: () => {},
          });
          try {
            await admin.unsafe(FRAMEWORK_ROLES_DDL);
          } catch (e) {
            throw new Error(
              `getTestPg (no-docker escape hatch): framework-role ensure against ` +
                `PAPERCUSP_TEST_PG_ADMIN_URL failed: ${e instanceof Error ? e.message : String(e)}. If this ` +
                `names a transient recovery-mode / not-yet-accepting-connections FATAL, this is very likely ` +
                `shared-infra churn on the box's native PG cluster (concurrent test-DB creates/drops from ` +
                `other fleet agents) — NOT a real test or code bug. See EI-10533.`,
              { cause: e },
            );
          } finally {
            await admin.end({ timeout: 5 }).catch(() => {});
          }
        });
        return existingAdminUrl;
      })().catch((e) => {
        // Don't strand later callers in this process on a permanently-rejected
        // promise — a fresh call gets a clean shot (e.g. the target PG was briefly
        // unreachable at first use).
        noDockerAdminUrlPromise = null;
        throw e;
      });
    }
    return noDockerAdminUrlPromise;
  }

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
    containerPromise = withTestcontainerStartLock(
      "shared-docker-testcontainers-start",
      () =>
        withContainerRecoveryReResolution(
          async () =>
            new CappedLogPostgreSqlContainer(TEST_PG_IMAGE)
              .withDatabase("papercusp_test")
              .withEnvironment({ POSTGRES_INITDB_ARGS: TEST_PG_INITDB_ARGS })
              .withCappedJsonLog()
              .withLabels({ [TEST_PG_REUSE_GENERATION_LABEL]: String(await readTestPgReuseGeneration()) })
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
              .withCommand([
                "postgres",
                "-c",
                "max_connections=500",
                // WI-41781: POSIX DSM allocates parallel-query segments from the
                // host's shared /dev/shm. Every reused test container on this box
                // contends for that single 64 MiB tmpfs, so an otherwise ordinary
                // 32 MiB segment can fail nondeterministically while fresh-schema
                // migrations are running. mmap stores test-only DSM files in the
                // container's data directory instead, isolating each container
                // from the host-wide /dev/shm burst without changing production.
                "-c",
                "dynamic_shared_memory_type=mmap",
                ...SHARED_TEST_PG_DURABILITY_OFF,
              ])
              // EI-21116464706451765: @testcontainers/postgresql's stock healthcheck
              // runs `pg_isready` INSIDE this PID-1-postmaster container. During
              // crash recovery it exits 2 as an unknown postmaster child, which
              // makes Postgres terminate every server process and restart recovery;
              // the 250ms healthcheck then repeats the crash indefinitely. Keep the
              // Docker health bit non-destructive and let the host-side
              // FRAMEWORK_ROLES_DDL loop below own real SQL readiness. The sibling
              // listening-port wait still prevents returning before the TCP port is
              // published, and the host loop refuses until Postgres is writable.
              .withHealthCheck({ ...NON_DESTRUCTIVE_PG_HEALTHCHECK })
              .withReuse()
              .start(),
          async (container) => {
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
            //
            // HOST-SIDE CLIENT, NOT `container.exec(['psql', ...])` (EI-18680404964770187,
            // 2026-07-26): the old implementation ran psql INSIDE the container, where it
            // is reparented to PID 1 (the postmaster in this image). Postgres reaps
            // UNKNOWN children in HandleChildCrash/CleanupBackend — an in-container psql
            // that exits nonzero (e.g. the exact "in recovery mode" FATAL this loop is
            // retrying) is treated as a crashed backend and makes the postmaster kill
            // every active server process and force a full crash-recovery cycle
            // (observed outage window ~3min, ~6x this loop's own 30s budget). Worse,
            // EVERY retry attempt while recovering is itself another in-container exec
            // that can exit nonzero and re-trigger the same crash — the retry loop was
            // feeding the fault it was trying to ride out, and under fleet load N
            // concurrent agents amplify each other. The container already publishes a
            // host port (`getConnectionUri()`, used two lines below this block anyway),
            // so run the DDL from a normal `postgres` client against that TCP port
            // instead: a failed host-side connection is just a rejected promise — it can
            // never be reaped by the postmaster and can never restart the cluster.
            const RETRY_BUDGET_MS = 30_000;
            const retryStartedAt = Date.now();
            let lastErr: unknown;
            for (let attempt = 1; ; attempt++) {
              const admin = postgres(container.getConnectionUri(), {
                max: 1,
                onnotice: () => {},
                connect_timeout: 10,
              });
              try {
                await admin.unsafe(FRAMEWORK_ROLES_DDL);
                lastErr = undefined;
                break;
              } catch (e) {
                lastErr = new Error(
                  `getTestPg: framework-role ensure failed ${describeContainer(container)}: ` +
                    `${e instanceof Error ? e.message : String(e)}`,
                  { cause: e },
                );
              } finally {
                await admin.end({ timeout: 5 }).catch(() => {});
              }
              const msg =
                lastErr instanceof Error ? lastErr.message : String(lastErr);
              const elapsedMs = Date.now() - retryStartedAt;
              if (
                !RETRYABLE_PG_STARTUP_MSG.test(msg) ||
                elapsedMs >= RETRY_BUDGET_MS
              ) {
                throw lastErr;
              }
              await new Promise((r) =>
                setTimeout(r, Math.min(attempt * 500, 3000)),
              );
            }
          },
          async () => {
            // A reused container may still serve other test processes. Change
            // the reuse hash instead of stopping their database underneath them.
            await rotateTestPgReuseGeneration();
          },
          {
            onStage: ({ stage, resolution, status, elapsedMs }) => {
              process.stderr.write(
                `[getTestPg] stage=${stage} resolution=${resolution} status=${status} elapsedMs=${elapsedMs}\n`,
              );
            },
          },
        ),
    )
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
        // this single outcome, so the streak isn't inflated by fan-out. Re-throw
        // the breaker's diagnosis even before it latches, so a focused one-file
        // run gets the same environmental framing instead of a raw PG error.
        throw substrateBreaker.recordFailure(e);
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
  if (process.env.FORCE_TEST_PG_TEARDOWN !== "1") return;
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
  const schema = `t_${randomBytes(6).toString("hex")}`;
  return { schema, connectionUri };
}
