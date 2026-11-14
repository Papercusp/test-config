import postgres from 'postgres';

export interface DropDatabaseWithLockOptions {
  /** How long the caller waits for its own drop before detaching it. */
  waitMs?: number;
  /** Total caller wait spent on janitor sweeps after a completed drop. */
  sweepBudgetMs?: number;
}

export type TestDbDropResult = 'dropped' | 'deferred' | 'detached';
export type SqlExecutor = { unsafe: (query: string) => Promise<unknown> };
export type TestDbDropSweep = (admin: SqlExecutor, deadline: number) => Promise<boolean>;

export const TEST_DB_DROP_LOCK_KEY = 'papercusp-test-drop-database';
export const TEST_DB_DROP_WAIT_MS = 20_000;
export const TEST_DB_DEFERRED_SWEEP_BUDGET_MS = 5_000;
export const TEST_DB_DEFERRED_SWEEP_LIMIT = 3;
export const PG_INVALID_DATABASE_CONNLIMIT = -2;
export const TEST_DB_DEFERRED_MARKER = 'papercusp-test-db-drop-deferred';
const TEST_DB_DEFER_MARK_TIMEOUT_MS = 2_000;

function quoteIdentifier(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

function quoteLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

export function isConnectTimeout(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | null;
  if (!value) return false;
  return value.code === 'CONNECT_TIMEOUT' || /\bCONNECT_TIMEOUT\b/.test(value.message ?? '');
}

export async function withConnectRetry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isConnectTimeout(error) || attempt === attempts) throw error;
      await sleep(attempt * 300);
    }
  }
  throw lastError;
}

function isStatementTimeout(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === '57014' || /statement timeout/i.test(value?.message ?? '');
}

export async function markDatabaseDropDeferred(admin: SqlExecutor, name: string): Promise<void> {
  try {
    await admin.unsafe('SET statement_timeout = ' + quoteLiteral(TEST_DB_DEFER_MARK_TIMEOUT_MS + 'ms'));
    await admin.unsafe(
      'COMMENT ON DATABASE ' + quoteIdentifier(name) + ' IS ' + quoteLiteral(TEST_DB_DEFERRED_MARKER),
    );
  } catch {
    // Best effort: the database may already have disappeared, or the shared
    // catalog may itself be saturated. Teardown must never recreate the hook
    // timeout cascade merely because its deferred-cleanup marker could not land.
  } finally {
    await admin.unsafe("SET statement_timeout = '0'").catch(() => {});
  }
}

export type UncancellableDropOutcome = 'dropped' | 'detached';

/** Issue one forced DROP that no timeout on this side can cancel. */
export async function runUncancellableDrop(
  admin: SqlExecutor,
  name: string,
  waitMs: number,
): Promise<UncancellableDropOutcome> {
  await admin.unsafe("SET statement_timeout = '0'");
  // Pin this so a role override that polls closed client sockets cannot abort a
  // detached DROP while PostgreSQL finishes its file-removal phase.
  await admin.unsafe("SET client_connection_check_interval = '0'").catch(() => {});
  const drop = admin.unsafe('DROP DATABASE IF EXISTS ' + quoteIdentifier(name) + ' WITH (FORCE)');
  // A detached drop may reject when its client closes. That is expected.
  drop.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'detached'>((resolve) => {
    timer = setTimeout(() => resolve('detached'), Math.max(0, waitMs));
  });
  try {
    return await Promise.race([drop.then(() => 'dropped' as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export async function dropDatabaseWithLock(
  admin: SqlExecutor,
  name: string,
  options: DropDatabaseWithLockOptions = {},
  sweep?: TestDbDropSweep,
): Promise<TestDbDropResult> {
  const waitMs = options.waitMs ?? TEST_DB_DROP_WAIT_MS;
  const sweepBudgetMs = options.sweepBudgetMs ?? TEST_DB_DEFERRED_SWEEP_BUDGET_MS;
  let lockHeld = false;
  let connectionBusy = false;
  try {
    const rows = (await admin.unsafe(
      "SELECT pg_try_advisory_lock(hashtext('" + TEST_DB_DROP_LOCK_KEY + "')) AS acquired",
    )) as Array<{ acquired?: boolean }>;
    if (rows[0]?.acquired !== true) {
      await markDatabaseDropDeferred(admin, name);
      return 'deferred';
    }
    lockHeld = true;

    try {
      if (await runUncancellableDrop(admin, name, waitMs) === 'detached') {
        connectionBusy = true;
        return 'detached';
      }
    } catch (error) {
      if (!isStatementTimeout(error)) throw error;
      await markDatabaseDropDeferred(admin, name);
      return 'deferred';
    }

    if (sweep) {
      const sweepDeadline = Date.now() + sweepBudgetMs;
      if (!await sweep(admin, sweepDeadline)) {
        connectionBusy = true;
        return 'detached';
      }
    }
    return 'dropped';
  } finally {
    // A detached drop still occupies this connection; its backend releases the
    // session advisory lock when it exits.
    if (lockHeld && !connectionBusy) {
      await admin.unsafe("SET statement_timeout = '0'").catch(() => {});
      await admin.unsafe(
        "SELECT pg_advisory_unlock(hashtext('" + TEST_DB_DROP_LOCK_KEY + "'))",
      ).catch(() => {});
    }
  }
}

export async function dropDatabaseOnDedicatedConnection(
  adminUri: string,
  name: string,
  options: DropDatabaseWithLockOptions = {},
  sweep?: TestDbDropSweep,
): Promise<TestDbDropResult> {
  return withConnectRetry(async () => {
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    let result: TestDbDropResult | undefined;
    try {
      result = await dropDatabaseWithLock(admin, name, options, sweep);
      return result;
    } finally {
      // Closing the connection does not cancel a detached server-side DROP.
      await admin.end({ timeout: result === 'detached' ? 0 : 5 }).catch(() => {});
    }
  });
}
