/** Actual owned-database inputs at provision/drop, never a complete connection
 * census. Only digests leave the worker; dump SQL and migration rows can contain
 * secrets. This observation alone must not fill proofContext.components.schema. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { resolveNativePgBinDir } from './dedicated-native-pg.ts';
import { OWNED_DATABASE_SCHEMA_V2_GAPS, ownedDatabaseSchemaFingerprint, parseOwnedDatabaseSchemaSnapshot,
  type OwnedDatabaseSchemaSnapshot } from './configuration-snapshot.ts';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(['owned-database-schema-v1', value]));

/** Public for focused failure controls. Production always uses the maintained
 * native pg_dump; a missing/old binary or a nonzero exit stays unknown. Passwords
 * ride the child's environment, never argv or a failure message. */
export function dumpOwnedDatabaseSchema(binary: string, url: string, snapshot: string,
  includeExtensionDefinitions = false): Promise<string> {
  const connection = new URL(url);
  return new Promise((resolve, reject) => {
    execFile(binary, ['--schema-only', '--quote-all-identifiers', '--restrict-key=PapercuspSchemaInputsV1',
      `--snapshot=${snapshot}`, ...(includeExtensionDefinitions ? ['--binary-upgrade'] : [])],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PGHOST: connection.hostname, PGPORT: connection.port || '5432',
        PGUSER: decodeURIComponent(connection.username), PGPASSWORD: decodeURIComponent(connection.password),
        PGDATABASE: decodeURIComponent(connection.pathname.slice(1)), PGCONNECT_TIMEOUT: '5' } },
    (error, stdout) => error ? reject(new Error('owned database schema dump unavailable')) : resolve(stdout));
  });
}

/** One exported MVCC snapshot joins both actual dumps, applied ledger, extension
 * versions and role catalogs. Binary-upgrade schema dumps include extension
 * member definitions that ordinary dumps intentionally omit; they are hashed,
 * never executed. Role credentials/settings stay private; only digests leave.
 * Unreadable catalogs, bounds or binary changes fail closed. This still cannot
 * establish the population of unowned database connections. */
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
      // Names replace catalog OIDs. Permission denial (including pg_authid)
      // remains unknown rather than an empty role population.
      const roles = await tx`SELECT (to_jsonb(r) - 'oid')::text AS value
        FROM pg_authid r ORDER BY r.rolname LIMIT 10001`;
      const memberships = await tx`SELECT jsonb_build_array(parent.rolname, member.rolname, grantor.rolname,
          to_jsonb(m) - 'oid' - 'roleid' - 'member' - 'grantor')::text AS value
        FROM pg_auth_members m JOIN pg_authid parent ON parent.oid = m.roleid
        JOIN pg_authid member ON member.oid = m.member JOIN pg_authid grantor ON grantor.oid = m.grantor
        ORDER BY parent.rolname, member.rolname, grantor.rolname LIMIT 10001`;
      const settings = await tx`SELECT jsonb_build_array(s.setdatabase <> 0, r.rolname, s.setconfig)::text AS value
        FROM pg_db_role_setting s LEFT JOIN pg_authid r ON r.oid = s.setrole
        WHERE s.setdatabase = 0 OR s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
        ORDER BY s.setdatabase <> 0, r.rolname NULLS FIRST LIMIT 10001`;
      if ([roles, memberships, settings, extensions].some(rows => rows.length > 10_000
        || JSON.stringify(rows).length > 1_048_576)) return null;
      const [dump, definitions] = await Promise.all([
        dumpOwnedDatabaseSchema(binary, url, row!.snapshot),
        dumpOwnedDatabaseSchema(binary, url, row!.snapshot, true),
      ]);
      if ([dump, definitions].some(text => !text.startsWith('--\n-- PostgreSQL database dump\n--\n')
        || !text.includes('-- PostgreSQL database dump complete')) || hash(readFileSync(binary)) !== binaryBefore) return null;
      const body: Omit<OwnedDatabaseSchemaSnapshot, 'fingerprint'> = {
        schemaVersion: 'owned-database-schema-v2', scope: 'pg-dump-extension-definitions-migrations-and-roles',
        populationStatus: 'unknown', schemaSha256: hash(dump), appliedMigrationsSha256: digest(migrations),
        extensionsSha256: digest(extensions), extensionDefinitionsSha256: hash(definitions),
        serverRoleStateSha256: digest([roles, memberships, settings]), dumpExecutableSha256: binaryBefore,
        serverVersionNum: row!.version, missing: [...OWNED_DATABASE_SCHEMA_V2_GAPS],
      };
      return parseOwnedDatabaseSchemaSnapshot({ ...body, fingerprint: ownedDatabaseSchemaFingerprint(body) }) ?? null;
    });
  } catch { return null; }
  finally { await sql?.end({ timeout: 2 }).catch(() => {}); }
}
