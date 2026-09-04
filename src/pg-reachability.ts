/**
 * pg-reachability.ts — a small, bounded-retry Postgres reachability probe.
 *
 * EI-2627: this box runs testcontainers under heavy fleet-wide concurrency
 * (the same class getTestPg() already rides out for the SHARED test-PG
 * container via a bounded retry — WI-3578/WI-5254/WI-5256, see pg-container.ts).
 * The baseline-schema container (baseline-schema-global-setup.ts) previously
 * had no equivalent tolerance: its one-time reuse health-check (EI-2433) and
 * every downstream consumer (the coordination / plans integration-test
 * fixtures) treated ANY connection failure — including a brief, self-resolving
 * "not yet accepting connections" / "in recovery mode" startup race — as fatal
 * staleness, either reprovisioning the container needlessly (adding MORE
 * docker load under an already-loaded box, deepening the exact churn it's
 * meant to avoid) or failing the whole test file on a blip that would have
 * cleared in a second or two.
 *
 * A `beforeAll` fixture can also run MINUTES after globalSetup's own one-time
 * check ran — long enough for the container to hit a transient blip, or
 * (rarer) genuinely be reaped/recycled by external box churn. This probe is
 * shared by both call sites so the retry-vs-fail-fast judgment (and the box's
 * `docker ps`-actionable diagnosis) lives in exactly one place.
 */
import postgres from "postgres";

/**
 * Superset retryable-startup-error signature (EI-10533 / WI-42246):
 * recovery-mode / not-yet-accepting-connections / SQLSTATE 57P03's shorter
 * "database system is starting up" wording, plus the generic connection-drop shapes
 * (ECONNREFUSED/ECONNRESET/ETIMEDOUT/"connection … refused|terminated|closed")
 * that pg-container.ts's shared-test-container retry loop already tolerates.
 * Exported so every bounded-retry call site (this probe, and
 * `withPgStartupRetry` below) shares ONE definition instead of drifting.
 */
export const RETRYABLE_PG_STARTUP_MSG =
  /in recovery mode|not yet accepting connections|database system is starting up|connection.*(refused|terminated|closed)|ECONNREFUSED|ECONNRESET|ETIMEDOUT|connect_timeout|timeout/i;

const RETRYABLE_MSG = RETRYABLE_PG_STARTUP_MSG;

export interface PgReachabilityResult {
  ok: boolean;
  /** Wall-clock time spent probing, in ms. */
  elapsedMs: number;
  /** The last error message seen, when `ok` is false. */
  lastError?: string;
}

/**
 * Probe `dsn` with `SELECT 1`, retrying (capped backoff, 500ms*attempt up to
 * 3s) for up to `budgetMs` total ONLY while the failure looks like a
 * transient startup/recovery race (see RETRYABLE_MSG). Any other failure
 * (auth, "no such database", …) returns immediately — that is a genuine
 * staleness/config signal, not something a retry can ride out.
 */
export async function probePgReachable(
  dsn: string,
  budgetMs = 15_000,
): Promise<PgReachabilityResult> {
  const startedAt = Date.now();
  let lastError: string | undefined;
  for (let attempt = 1; ; attempt++) {
    const probe = postgres(dsn, {
      max: 1,
      onnotice: () => {},
      connect_timeout: 5,
    });
    try {
      await probe.unsafe("SELECT 1");
      return { ok: true, elapsedMs: Date.now() - startedAt };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      const elapsedMs = Date.now() - startedAt;
      if (!RETRYABLE_MSG.test(lastError) || elapsedMs >= budgetMs) {
        return { ok: false, elapsedMs, lastError };
      }
      await new Promise((r) => setTimeout(r, Math.min(attempt * 500, 3000)));
    } finally {
      await probe.end({ timeout: 5 }).catch(() => {});
    }
  }
}

/**
 * `probePgReachable` + throw an ACTIONABLE error naming this as a known
 * local-environment class (EI-2627) rather than surfacing postgres's raw,
 * cryptic error ("no such database: papercusp_it") deep inside a later query.
 * For fixtures that need reachability confirmed before proceeding.
 */
export async function assertPgReachable(
  dsn: string,
  label: string,
  budgetMs = 15_000,
): Promise<void> {
  const result = await probePgReachable(dsn, budgetMs);
  if (result.ok) return;
  throw new Error(
    `${label}: the integration baseline Postgres is unreachable after ${result.elapsedMs}ms of retry ` +
      `(${result.lastError}). This is very likely EI-2627 — local box/testcontainer churn reaped or ` +
      `recycled the shared baseline-schema container (pgvector/pgvector:pg18, db "papercusp_it") — NOT a ` +
      `code regression. Check \`docker ps\` for a live papercusp_it container and re-run; CI is unaffected.`,
  );
}

/**
 * Retry `op` while it fails with a transient Postgres startup/recovery error
 * (see `RETRYABLE_PG_STARTUP_MSG`), capped backoff 500ms*attempt up to 3s,
 * for up to `budgetMs` total. Any non-retryable failure, or exhausting the
 * budget, rethrows the LAST error unchanged — `op` owns its own client
 * lifecycle per attempt (open + close), this only decides retry-vs-rethrow.
 *
 * EI-10533: the shared test-PG container path (`getTestPg` in
 * pg-container.ts) already tolerates this class via its own inline retry
 * loop. This helper generalizes it for the NO-DOCKER escape-hatch call sites
 * (a bare `postgres` admin client against the box's native PG, used when a
 * `capability:bash`-sandboxed cup can't reach docker.sock — EI-13104), which
 * previously had ZERO tolerance: a single transient recovery-mode blip on
 * the shared native cluster (this box's :5432, coordinated through by the
 * whole fleet — a concurrent test's CREATE/DROP DATABASE can trigger it)
 * failed the whole beforeAll/globalSetup outright, and — because the raw
 * postgres error gives no hint the cause is shared-infra churn rather than a
 * real bug — a test file whose afterAll assumes `db` was assigned throws a
 * masking TypeError on top, hiding the actual (transient, self-resolving)
 * cause entirely.
 */
export async function withPgStartupRetry<T>(
  op: () => Promise<T>,
  budgetMs = 30_000,
): Promise<T> {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const elapsedMs = Date.now() - startedAt;
      if (!RETRYABLE_PG_STARTUP_MSG.test(msg) || elapsedMs >= budgetMs) throw e;
      await new Promise((r) => setTimeout(r, Math.min(attempt * 500, 3000)));
    }
  }
}
