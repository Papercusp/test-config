/**
 * makeFixture(table, overrides?) — schema-driven test row builder.
 *
 * Walks a Drizzle table's column metadata via `getTableConfig` and
 * fabricates a row that satisfies every NOT NULL column with a sensible
 * default per type. Overrides take precedence; SQL defaults are
 * respected when present (left undefined so the DB fills them).
 *
 * Replaces ~30 hand-written factories scattered across __tests__. When a
 * column is added to the migration, every test fixture picks up the new
 * column automatically — no factory edits, no drift.
 *
 * Usage:
 *   import { makeFixture } from '@papercusp/test-config';
 *   import { generated } from 'your-app/db-schema';
 *
 *   const row = makeFixture(generated.harness_testsInHarness_shared, {
 *     harness_slug: 'demo',
 *     test_id: 't-1',
 *   });
 *   // → { harness_slug:'demo', phase:'staging', test_id:'t-1',
 *   //     name:'', status:'pending', duration_ms:0, last_run_ts:null,
 *   //     payload:{}, mtime_ms:<now>, workspace_id:'default' }
 *
 * For batches:
 *   const rows = makeFixtures(t, 50, (i) => ({ test_id: `t-${i}` }));
 *
 * Type-level: the return type is `typeof t.$inferInsert` so consumers
 * get full autocomplete + type-checking on overrides.
 */
import type { Table } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

const COUNTERS = new Map<string, number>();

function nextCounter(key: string): number {
  const v = (COUNTERS.get(key) ?? 0) + 1;
  COUNTERS.set(key, v);
  return v;
}

function defaultForColumn(tableName: string, column: { name: string; columnType: string; dataType?: string; notNull: boolean; hasDefault: boolean }): unknown {
  // SQL default present — let the DB fill it.
  if (column.hasDefault) return undefined;
  // Nullable + no default → null.
  if (!column.notNull) return null;
  // Otherwise produce a per-type default.
  const dt = column.dataType ?? column.columnType;
  switch (column.columnType) {
    case 'PgText':
    case 'PgVarchar':
    case 'PgChar':
    case 'PgUUID':
      // Pick a stable shape per column for cross-row uniqueness.
      // The counter is keyed by table.column so each fixture row gets a
      // distinct value where the test relies on PK uniqueness.
      if (column.name === 'id' || column.name.endsWith('_id') || column.name === 'token') {
        return `${tableName}-${column.name}-${nextCounter(`${tableName}.${column.name}`)}`;
      }
      if (column.name === 'workspace_id') return 'default';
      if (column.name === 'harness_slug') return 'demo';
      if (column.name === 'status') return 'pending';
      return '';
    case 'PgInteger':
    case 'PgSmallInt':
    case 'PgSerial':
    case 'PgSmallSerial':
      return 0;
    case 'PgBigInt53':
    case 'PgBigInt64':
    case 'PgBigSerial53':
    case 'PgBigSerial64':
      // Timestamps live in BIGINT columns named `*_ts`, `*_ms`, `*_at` —
      // default to Date.now() so RETURNING + ordering work in tests.
      if (
        column.name.endsWith('_ts') ||
        column.name.endsWith('_ms') ||
        column.name.endsWith('_at') ||
        column.name === 'ts'
      ) {
        return Date.now();
      }
      return 0;
    case 'PgNumeric':
    case 'PgDecimal':
    case 'PgReal':
    case 'PgDoublePrecision':
      return 0;
    case 'PgBoolean':
      return false;
    case 'PgJsonb':
    case 'PgJson':
      return {};
    case 'PgTimestamp':
    case 'PgTimestampTz':
      return new Date(0);
    case 'PgDate':
      return '1970-01-01';
    case 'PgArray':
      return [];
    default:
      // Unknown column type → empty string is the safest non-null
      // placeholder; tests can override.
      if (dt === 'string') return '';
      if (dt === 'number') return 0;
      if (dt === 'boolean') return false;
      return null;
  }
}

/**
 * Build a single insert row for `table` with overrides applied last.
 */
export function makeFixture<T extends Table>(
  table: T,
  overrides: Partial<T['$inferInsert']> = {},
): T['$inferInsert'] {
  const cfg = getTableConfig(table as unknown as PgTable);
  const tableName = cfg.name;
  const out: Record<string, unknown> = {};
  for (const c of cfg.columns) {
    if ((overrides as Record<string, unknown>)[c.name] !== undefined) {
      out[c.name] = (overrides as Record<string, unknown>)[c.name];
      continue;
    }
    const v = defaultForColumn(tableName, c);
    if (v !== undefined) out[c.name] = v;
  }
  return out as T['$inferInsert'];
}

/**
 * Build `count` fixture rows. `overridesFor(i)` returns per-row overrides
 * (typically a unique id) — omit for identical rows.
 */
export function makeFixtures<T extends Table>(
  table: T,
  count: number,
  overridesFor: (i: number) => Partial<T['$inferInsert']> = () => ({}),
): T['$inferInsert'][] {
  const out: T['$inferInsert'][] = [];
  for (let i = 0; i < count; i++) out.push(makeFixture(table, overridesFor(i)));
  return out;
}

/**
 * Reset the per-column uniqueness counter. Useful at the top of a test
 * file when you want makeFixture(t).id to be deterministic across runs.
 */
export function _resetFixtureCounters(): void {
  COUNTERS.clear();
}
