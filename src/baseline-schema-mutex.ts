/**
 * baseline-schema-mutex.ts — the cross-process mutex for the ONE reused
 * baseline-schema Postgres container (plan review-verification-efficiency-2026-09-09,
 * R-8 "improve expensive fixture isolation").
 *
 * WHY THIS LIVES HERE AND NOT IN A FIXTURE. The lock itself was introduced in
 * `packages/operator-core/lib/_baseline-coord-fixture.ts` for EI-18683737202696167,
 * where it correctly serialized every consumer OF THAT FIXTURE. But the resource it
 * protects is not that fixture — it is the global `harness_shared` tables inside a
 * container that `baseline-schema-global-setup.ts` `.withReuse()`s across every
 * concurrent Vitest process on the box. `apps/operator` and `packages/operator-core`
 * point at the SAME globalSetup, so their integration files run against the SAME
 * database, in parallel, in separate processes — and a consumer that does not import
 * that one fixture module was excluded by nothing.
 *
 * That gap is not theoretical: fixture consumers wipe shared tables UNQUALIFIED
 * (`TRUNCATE harness_shared.adv_sessions`, no WHERE), which destroys every concurrent
 * consumer's rows rather than only their own. Scoping discipline on the other side does
 * not save it — a `DELETE ... WHERE workspace_id = $ws` seed in apps/operator is still
 * annihilated by a bare TRUNCATE of that table in operator-core.
 *
 * So the lock is published here, at the level of the shared resource, for ANY consumer
 * of the baseline container to take. `baseline-schema-mutex-coverage.test.ts` is the
 * recurrence guard: a consumer that mutates a globally-wiped shared table without
 * holding this lock fails that test.
 *
 * ⚠ THE LOCK NAME IS LOAD-BEARING AND MUST NOT BE FORKED. It is the same string the
 * coord fixture has always used, so new callers interoperate with the existing 30+
 * fixture consumers immediately. A second lock name would be a second lock — it would
 * look like isolation and provide none.
 *
 * Session-scoped (not transaction-scoped) on a dedicated single connection: Postgres
 * releases the lock the instant that connection dies, so a killed or OOM'd test process
 * can never wedge the rest of the fleet's test run. The acquire is budget-bounded rather
 * than an unbounded blocking `pg_advisory_lock`, so a genuinely stuck holder surfaces as
 * an actionable timeout instead of hanging forever.
 */
import postgres from 'postgres';

/** The single advisory-lock name guarding the reused baseline-schema container. */
export const BASELINE_SCHEMA_MUTEX_NAME = 'papercusp-baseline-coord-fixture-mutex';
export const BASELINE_SCHEMA_MUTEX_BUDGET_MS = 120_000;
export const BASELINE_SCHEMA_MUTEX_POLL_MS = 250;

export interface AcquireBaselineSchemaMutexOptions {
  /** Total time to wait before giving up (default 120s). */
  budgetMs?: number;
  /** Poll interval between `pg_try_advisory_lock` attempts (default 250ms). */
  pollMs?: number;
  /** Caller name, used only to make a timeout message actionable. */
  label?: string;
}

/**
 * Take the baseline-schema mutex, returning the connection that HOLDS it.
 * Pass that handle to `releaseBaselineSchemaMutex` when the consumer is done.
 */
export async function acquireBaselineSchemaMutex(
  dsn: string,
  opts: AcquireBaselineSchemaMutexOptions = {},
): Promise<postgres.Sql> {
  const budgetMs = opts.budgetMs ?? BASELINE_SCHEMA_MUTEX_BUDGET_MS;
  const pollMs = opts.pollMs ?? BASELINE_SCHEMA_MUTEX_POLL_MS;
  const label = opts.label ?? 'acquireBaselineSchemaMutex';

  // A dedicated max:1 connection: postgres.js guarantees every query on this
  // instance reuses the SAME underlying connection, which is required for a
  // session-scoped advisory lock to mean anything (it is held by the connection,
  // not the logical client).
  const lockClient = postgres(dsn, { max: 1, onnotice: () => {} });
  const startedAt = Date.now();
  try {
    for (;;) {
      const [{ locked }] = await lockClient<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext(${BASELINE_SCHEMA_MUTEX_NAME})) AS locked
      `;
      if (locked) return lockClient;
      if (Date.now() - startedAt >= budgetMs) {
        throw new Error(
          `${label}: timed out after ${budgetMs}ms waiting for the shared baseline-schema ` +
            `mutex (another integration-test file is holding it — see EI-18683737202696167 ` +
            `for why this lock exists, and libs/test-config/src/baseline-schema-mutex.ts for ` +
            `why every consumer of the reused container must take it).`,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } catch (e) {
    await lockClient.end({ timeout: 5 }).catch(() => {});
    throw e;
  }
}

/** Release the mutex and close the connection that held it. Safe to call once. */
export async function releaseBaselineSchemaMutex(lockClient: postgres.Sql): Promise<void> {
  await lockClient`SELECT pg_advisory_unlock(hashtext(${BASELINE_SCHEMA_MUTEX_NAME}))`.catch(() => {});
  await lockClient.end({ timeout: 5 }).catch(() => {});
}
