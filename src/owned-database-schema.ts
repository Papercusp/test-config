/** Actual owned-database inputs at provision/drop, never a complete connection
 * census. Only digests leave the worker; dump SQL and migration rows can contain
 * secrets. This observation alone must not fill proofContext.components.schema. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { resolveNativePgBinDir } from './dedicated-native-pg.ts';
import { OWNED_DATABASE_SCHEMA_GAPS, ownedDatabaseSchemaFingerprint, parseOwnedDatabaseSchemaSnapshot,
  type OwnedDatabaseSchemaSnapshot } from './configuration-snapshot.ts';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(['owned-database-schema-v1', value]));

/** Public for focused failure controls. Production always uses the maintained
 * native pg_dump; a missing/old binary or a nonzero exit stays unknown. Passwords
 * ride the child's environment, never argv or a failure message. */
export function dumpOwnedDatabaseSchema(binary: string, url: string, snapshot: string): Promise<string> {
  const connection = new URL(url);
  return new Promise((resolve, reject) => {
    execFile(binary, ['--schema-only', '--quote-all-identifiers', '--restrict-key=PapercuspSchemaInputsV1',
      `--snapshot=${snapshot}`], { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PGHOST: connection.hostname, PGPORT: connection.port || '5432',
        PGUSER: decodeURIComponent(connection.username), PGPASSWORD: decodeURIComponent(connection.password),
        PGDATABASE: decodeURIComponent(connection.pathname.slice(1)), PGCONNECT_TIMEOUT: '5' } },
    (error, stdout) => error ? reject(new Error('owned database schema dump unavailable')) : resolve(stdout));
  });
}

/** One exported MVCC snapshot joins the actual dump, applied ledger and extension
 * versions. Unsupported metadata, output bounds or a changing dump binary fail
 * closed. No template key, source migration list or later checkout substitutes. */
export async function captureOwnedDatabaseSchema(url: string): Promise<OwnedDatabaseSchemaSnapshot | null> {
  let sql: ReturnType<typeof postgres> | undefined;
  try {
    const binary = join(resolveNativePgBinDir(), 'pg_dump');
    const binaryBefore = hash(readFileSync(binary));
    sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {},
      connection: { statement_timeout: 10000, idle_in_transaction_session_timeout: 15000 } });
    return await sql.begin('isolation level repeatable read read only', async tx => {
      const [row] = await tx`SELECT pg_export_snapshot() AS snapshot,
        current_setting('server_version_num') AS version,
        to_regclass('harness_shared.schema_migrations') IS NOT NULL AS ledger`;
      const migrations = row!.ledger
        ? await tx.unsafe('SELECT to_jsonb(m)::text AS value FROM harness_shared.schema_migrations m ORDER BY to_jsonb(m)::text LIMIT 10001')
        : null;
      if (migrations && (migrations.length > 10_000 || JSON.stringify(migrations).length > 1_048_576)) return null;
      const extensions = await tx`SELECT e.extname, e.extversion, n.nspname
        FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY e.extname`;
      const dump = await dumpOwnedDatabaseSchema(binary, url, row!.snapshot);
      if (!dump.startsWith('--\n-- PostgreSQL database dump\n--\n')
        || !dump.includes('-- PostgreSQL database dump complete') || hash(readFileSync(binary)) !== binaryBefore) return null;
      const body: Omit<OwnedDatabaseSchemaSnapshot, 'fingerprint'> = {
        schemaVersion: 'owned-database-schema-v1', scope: 'pg-dump-and-baseline-migration-ledger',
        populationStatus: 'unknown', schemaSha256: hash(dump), appliedMigrationsSha256: digest(migrations),
        extensionsSha256: digest(extensions), dumpExecutableSha256: binaryBefore,
        serverVersionNum: row!.version, missing: [...OWNED_DATABASE_SCHEMA_GAPS],
      };
      return parseOwnedDatabaseSchemaSnapshot({ ...body, fingerprint: ownedDatabaseSchemaFingerprint(body) }) ?? null;
    });
  } catch { return null; }
  finally { await sql?.end({ timeout: 2 }).catch(() => {}); }
}
