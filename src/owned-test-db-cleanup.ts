/** Durable ownership for the maintained runner's test databases. No PG is started here. */
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
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

/** A nested private cluster must never reap or validate its parent's receipts.
 * Keep its own registry under the retained evidence root, outside private HOME. */
export function createOwnedTestDatabaseScope(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const parent = directory(env);
  if (!parent) return undefined;
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const child = mkdtempSync(join(parent, 'private-pg-'));
  // A nested router may intentionally use a distinct reporting group. Bind
  // that identity in the parent's existing journal before the child can write
  // any database records; its completion receipt cannot choose its own owner.
  recordOwnedTestDbCleanupStage('*', 'scope-created', { scopePath: basename(child) }, env);
  return child;
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
  /** Read-only observations of child owners, never attempts to reopen their servers. */
  scopes?: Array<OwnedTestDbCleanupResult & { path: string }>;
}

function readOwnedDatabase(dir: string, file: string, runId: string): OwnedTestDatabase {
  const path = join(dir, file);
  if (!lstatSync(path).isFile()) throw new Error('database receipt is not an unlinked regular file');
  const record: OwnedTestDatabase = JSON.parse(readFileSync(path, 'utf8'));
  if (record.runId !== runId || registryPath(dir, record.name) !== path) {
    throw new Error('database ownership does not match this run');
  }
  if (typeof record.adminUri !== 'string') throw new Error('missing private database endpoint');
  return record;
}

/** A child cluster cleans its own endpoint before stopping it. The run owner
 * only reads its retained receipts: retrying a child DROP here is too late. */
function observeNestedScopes(dir: string, runId: string, deadlineAtMs: number): NonNullable<OwnedTestDbCleanupResult['scopes']> {
  const scopes: NonNullable<OwnedTestDbCleanupResult['scopes']> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.startsWith('private-pg-')) continue;
    const scope: (typeof scopes)[number] = { path: entry.name, complete: false, databases: [], errors: [] };
    scopes.push(scope);
    try {
      if (!entry.isDirectory()) throw new Error('private database scope is not an unlinked directory');
      if (Date.now() >= deadlineAtMs) throw new Error('nested scope observation exceeded cleanup deadline');
      const child = join(dir, entry.name);
      let childRunId = runId;
      const parentReceipt = join(dir, 'cleanup.jsonl');
      try {
        if (!lstatSync(parentReceipt).isFile()) throw new Error('scope ownership journal is not an unlinked regular file');
        const owners = new Set<string>();
        for (const line of readFileSync(parentReceipt, 'utf8').trim().split('\n').filter(Boolean)) {
          const row = JSON.parse(line);
          if (row.kind !== 'owned-test-db-cleanup' || row.stage !== 'scope-created' || row.scopePath !== entry.name) continue;
          if (typeof row.runId !== 'string' || !row.runId.trim()) throw new Error('missing nested scope owner');
          owners.add(row.runId);
        }
        if (owners.size > 1) throw new Error('ambiguous nested scope owner');
        childRunId = owners.values().next().value ?? runId;
      } catch (cause) {
        // Older retained runs have no scope-creation records. Their existing
        // strict same-group contract remains valid; never infer a foreign group
        // from a child's final receipt or database records.
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
      for (const file of readdirSync(child).filter(name => name.endsWith('.json')).sort()) {
        const record = readOwnedDatabase(child, file, childRunId);
        scope.databases.push({ name: record.name, outcome: record.outcome });
      }
      const receipt = join(child, 'cleanup.jsonl');
      if (!lstatSync(receipt).isFile()) throw new Error('cleanup receipt is not an unlinked regular file');
      const lines = readFileSync(receipt, 'utf8').trim().split('\n');
      const last = JSON.parse(lines.at(-1)!);
      if (last.kind !== 'owned-test-db-cleanup' || last.runId !== childRunId || last.stage !== 'complete'
          || last.complete !== true || !Array.isArray(last.errors) || last.errors.length !== 0
          || !Array.isArray(last.databases) || last.databases.length !== scope.databases.length
          || !scope.databases.every(db => db.outcome === 'dropped'
            && last.databases.some((saved: { name?: string; outcome?: string }) => saved.name === db.name && saved.outcome === 'dropped'))) {
        throw new Error('nested owner has no matching confirmed database cleanup receipt');
      }
      const nested = observeNestedScopes(child, childRunId, deadlineAtMs);
      if (nested.length) scope.scopes = nested;
      scope.complete = nested.every(item => item.complete);
    } catch (cause) {
      scope.errors.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return scopes;
}

/** Reap only this run's recorded databases after its writers have confirmed close.
 * A wait deadline does not cancel a server-side DROP. Its late result remains
 * observed and updates the same retained receipt. Without an endpoint pin this
 * is the run finalizer, which also observes all nested owners without dropping
 * their databases. An endpoint-pinned owner reports only its own cluster. */
export async function cleanupOwnedTestDatabases(options: {
  dir: string; runId: string; deadlineAtMs: number; drop: Drop;
  /** When the owning cluster stops next, refuse records for any other server. */
  adminUri?: string;
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
      record = readOwnedDatabase(options.dir, file, options.runId);
      // Pin every new DROP to this owner. A same-run record already confirmed
      // dropped by a nested dedicated cluster needs no endpoint connection.
      if (options.adminUri && record.outcome !== 'dropped') {
        const expected = new URL(options.adminUri);
        const actual = new URL(record.adminUri);
        if (actual.protocol !== expected.protocol || actual.hostname !== expected.hostname ||
            (actual.port || '5432') !== (expected.port || '5432') || actual.username !== expected.username) {
          throw new Error('database endpoint does not match the owned server');
        }
      }
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
  if (!options.adminUri) {
    const scopes = observeNestedScopes(options.dir, options.runId, options.deadlineAtMs);
    if (scopes.length) {
      result.scopes = scopes;
      result.complete = result.complete && scopes.every(scope => scope.complete);
    }
  }
  observe('*', result.complete ? 'complete' : 'retained', { ...result });
  result.complete = result.complete && result.errors.length === 0;
  return result;
}
