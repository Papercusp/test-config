/** Durable ownership for the maintained runner's test databases. No PG is started here. */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DropDatabaseWithLockOptions, TestDbDropResult } from './pg-migrate.ts';

export const OWNED_TEST_DB_DIR_ENV = 'PAPERCUSP_TEST_OWNED_DB_DIR';
/** Shared by generated names, private receipts and the unmarked database janitor. */
export const GENERATED_TEST_DB_NAME_PATTERN = '^[a-z][a-z0-9_-]*_[0-9a-f]{8,}$';
const generatedName = new RegExp(GENERATED_TEST_DB_NAME_PATTERN);
export function assertOwnedTestDatabaseName(name: string): void {
  // ASCII only: length is also the PG identifier byte length. Reject truncation,
  // paths, SQL delimiters and trailing newlines (JS $ can match before one).
  if (typeof name !== 'string' || name.length > 63 || generatedName.exec(name)?.[0] !== name) {
    throw new Error('invalid owned test database name');
  }
}
export interface OwnedTestDatabase {
  runId: string;
  name: string;
  /** Private registry only; never copied into a public receipt. */
  adminUri: string;
  outcome: TestDbDropResult | 'owned' | 'error' | 'unconfirmed';
}
type Drop = (adminUri: string, name: string, options?: DropDatabaseWithLockOptions) => Promise<TestDbDropResult>;

function directory(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env[OWNED_TEST_DB_DIR_ENV];
  if (dir && !isAbsolute(dir)) throw new Error('owned test database directory must be absolute');
  return dir;
}
function registryPath(dir: string, name: string): string {
  assertOwnedTestDatabaseName(name);
  return join(dir, `${name}.json`);
}
function save(dir: string, record: OwnedTestDatabase): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = registryPath(dir, record.name);
  const temporary = `${path}.${randomUUID()}.pending`;
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
export function recordOwnedTestDbCleanupStage(
  name: string, stage: string, detail: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = directory(env);
  if (!dir) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, 'cleanup.jsonl'), JSON.stringify({ kind: 'owned-test-db-cleanup',
    runId: env.PAPERCUSP_TEST_RUN_GROUP, name, stage, at: new Date().toISOString(), ...detail }) + '\n', { mode: 0o600 });
}

/** Register before a fixture can hand the database to a test. */
export function registerOwnedTestDatabase(
  name: string, adminUri: string, env: NodeJS.ProcessEnv = process.env,
): (outcome: OwnedTestDatabase['outcome']) => void {
  assertOwnedTestDatabaseName(name);
  const dir = directory(env);
  if (!dir) return () => {};
  const runId = env.PAPERCUSP_TEST_RUN_GROUP;
  if (!runId) throw new Error('owned test database registration requires a run group');
  const update = (outcome: OwnedTestDatabase['outcome']): void => {
    save(dir, { runId, name, adminUri, outcome });
    recordOwnedTestDbCleanupStage(name, outcome === 'owned' ? 'registered' : 'database-drop-result', { outcome }, env);
  };
  update('owned');
  return update;
}

export interface OwnedTestDbCleanupResult {
  complete: boolean;
  databases: Array<{ name: string; outcome: OwnedTestDatabase['outcome'] }>;
  errors: string[];
}

/** Reap only this run's recorded databases after its writers have confirmed close.
 * A wait deadline does not cancel a server-side DROP. Its late result remains
 * observed and updates the same retained receipt. */
export async function cleanupOwnedTestDatabases(options: {
  dir: string; runId: string; deadlineAtMs: number; drop: Drop;
}): Promise<OwnedTestDbCleanupResult> {
  const result: OwnedTestDbCleanupResult = { complete: true, databases: [], errors: [] };
  const env = { [OWNED_TEST_DB_DIR_ENV]: options.dir, PAPERCUSP_TEST_RUN_GROUP: options.runId };
  const observe = (name: string, stage: string, detail: Record<string, unknown>): void => {
    try { recordOwnedTestDbCleanupStage(name, stage, detail, env); }
    catch (cause) { result.errors.push(`${name}: ${stage} receipt: ${String(cause)}`); }
  };
  const persist = (record: OwnedTestDatabase): void => {
    try { save(options.dir, record); }
    catch (cause) { result.errors.push(`${record.name}: registry receipt: ${String(cause)}`); }
  };
  for (const file of readdirSync(options.dir).filter(name => name.endsWith('.json')).sort()) {
    let record: OwnedTestDatabase;
    try {
      record = JSON.parse(readFileSync(join(options.dir, file), 'utf8'));
      if (record.runId !== options.runId || registryPath(options.dir, record.name) !== join(options.dir, file)) {
        throw new Error('database ownership does not match this run');
      }
      if (typeof record.adminUri !== 'string') throw new Error('missing private database endpoint');
    } catch (cause) {
      result.errors.push(`${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    if (record.outcome !== 'dropped') {
      const remaining = Math.max(0, options.deadlineAtMs - Date.now());
      if (!remaining) {
        observe(record.name, 'retained', { outcome: record.outcome, reason: 'cleanup deadline reached' });
      } else {
        observe(record.name, 'database-drop', { priorOutcome: record.outcome });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const drop = Promise.resolve().then(() => options.drop(record.adminUri, record.name,
          { waitMs: remaining, sweepBudgetMs: 0 })).then(outcome => {
          persist({ ...record, outcome });
          observe(record.name, 'database-drop-result', { outcome });
          return outcome;
        }, cause => {
          persist({ ...record, outcome: 'error' });
          observe(record.name, 'database-drop-error', { error: String(cause) });
          throw cause;
        });
        try {
          record.outcome = await Promise.race([drop, new Promise<'unconfirmed'>(resolve => {
            timer = setTimeout(() => resolve('unconfirmed'), remaining);
          })]);
          if (record.outcome === 'unconfirmed') observe(record.name, 'retained',
            { outcome: 'unconfirmed', reason: 'drop still pending at cleanup deadline' });
        } catch (cause) {
          record.outcome = 'error';
          result.errors.push(`${record.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    }
    result.databases.push({ name: record.name, outcome: record.outcome });
  }
  result.complete = result.errors.length === 0 && result.databases.every(db => db.outcome === 'dropped');
  observe('*', result.complete ? 'complete' : 'retained', { ...result });
  result.complete = result.complete && result.errors.length === 0;
  return result;
}
