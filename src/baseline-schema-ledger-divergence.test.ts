/**
 * EI-18779962385972529 — regression guard for the ledger-vs-reality probe.
 *
 * The bug this exists to stop recurring: a reused baseline container whose
 * `harness_shared.schema_migrations` ledger records a migration whose objects are
 * ABSENT. `applyPendingMigrations` skips anything already in the ledger, so the
 * missing migration is never re-applied and every later migration depending on it
 * fails on EVERY run, permanently, with no self-heal — surfacing as an unrelated
 * `schema "x" does not exist` during COLLECT of an innocent test. That took out
 * the whole operator-core integration tier on 2026-07-27.
 *
 * These cover the two PURE halves (parser + fold/diff) so the guard runs with no
 * database and no Docker. The IO wrapper is exercised for real every time a
 * reused container is picked up.
 *
 * The rename cases below are the load-bearing ones: a create-only first cut of
 * this probe FIRED ON A HEALTHY CONTAINER, because `000-baseline.sql` creates
 * `papercup_shared` and migration 332 renames it away. A false positive here
 * reprovisions a good container and replays ~476 migrations on every run, so
 * these tests guard the expensive direction, not just the missed-detection one.
 */
import { describe, it, expect } from 'vitest';
import {
  schemaMutationsInMigrationSql,
  diffLedgerAgainstSchemas,
  expectedSchemasAfter,
} from './baseline-schema-global-setup.ts';

describe('schemaMutationsInMigrationSql', () => {
  it('finds an unconditional CREATE SCHEMA, with or without IF NOT EXISTS', () => {
    // The real shape from 650-harness-gym-durable-run-analytics.sql, the
    // migration whose absence caused the outage.
    expect(schemaMutationsInMigrationSql('CREATE SCHEMA IF NOT EXISTS harness_gym_durable;')).toEqual([
      { kind: 'create', name: 'harness_gym_durable' },
    ]);
    expect(schemaMutationsInMigrationSql('CREATE SCHEMA harness_shared;')).toEqual([
      { kind: 'create', name: 'harness_shared' },
    ]);
  });

  it('finds DROP and ALTER ... RENAME TO, not just CREATE', () => {
    expect(schemaMutationsInMigrationSql('DROP SCHEMA IF EXISTS old_thing;')).toEqual([
      { kind: 'drop', name: 'old_thing' },
    ]);
    // The real 332-rename-papercup-shared-to-papercusp-shared.sql shape.
    expect(
      schemaMutationsInMigrationSql('ALTER SCHEMA papercup_shared RENAME TO papercusp_shared;'),
    ).toEqual([{ kind: 'rename', name: 'papercup_shared', to: 'papercusp_shared' }]);
  });

  it('preserves STATEMENT ORDER within a file (create-then-drop ≠ drop-then-create)', () => {
    expect(
      schemaMutationsInMigrationSql('CREATE SCHEMA a;\nDROP SCHEMA a;\nCREATE SCHEMA b;'),
    ).toEqual([
      { kind: 'create', name: 'a' },
      { kind: 'drop', name: 'a' },
      { kind: 'create', name: 'b' },
    ]);
  });

  it('is case- and quote-insensitive', () => {
    expect(schemaMutationsInMigrationSql('create schema if not exists "Harness_Gym_Durable";')).toEqual(
      [{ kind: 'create', name: 'harness_gym_durable' }],
    );
  });

  it('ignores a COMMENTED-OUT statement (a false positive reprovisions a healthy container)', () => {
    expect(schemaMutationsInMigrationSql('-- CREATE SCHEMA IF NOT EXISTS never_real;')).toEqual([]);
    expect(schemaMutationsInMigrationSql('ALTER TABLE x ADD COLUMN c int; -- DROP SCHEMA ghost;')).toEqual(
      [],
    );
  });

  it('does NOT claim a schema created inside a plpgsql block — its guard may legitimately not fire', () => {
    expect(
      schemaMutationsInMigrationSql(
        'DO $pg$ BEGIN\n  IF something THEN CREATE SCHEMA conditional_one; END IF;\nEND $pg$;',
      ),
    ).toEqual([]);
  });

  it('does not match a mere mention in prose', () => {
    expect(schemaMutationsInMigrationSql("SELECT 'CREATE SCHEMA' AS note;")).toEqual([]);
  });
});

describe('expectedSchemasAfter', () => {
  it('cancels a create with a LATER rename — the false positive that bit the first cut', () => {
    const expected = expectedSchemasAfter([
      { migration: '000-baseline.sql', mutations: [{ kind: 'create', name: 'papercup_shared' }] },
      {
        migration: '332-rename.sql',
        mutations: [{ kind: 'rename', name: 'papercup_shared', to: 'papercusp_shared' }],
      },
    ]);
    expect([...expected.keys()]).toEqual(['papercusp_shared']);
    // and it attributes the surviving schema to the migration that established it
    expect(expected.get('papercusp_shared')).toBe('332-rename.sql');
  });

  it('cancels a create with a later drop', () => {
    const expected = expectedSchemasAfter([
      { migration: '100-a.sql', mutations: [{ kind: 'create', name: 'temp_thing' }] },
      { migration: '200-b.sql', mutations: [{ kind: 'drop', name: 'temp_thing' }] },
    ]);
    expect([...expected.keys()]).toEqual([]);
  });

  it('keeps a schema that is dropped and then RE-created later', () => {
    const expected = expectedSchemasAfter([
      { migration: '100-a.sql', mutations: [{ kind: 'create', name: 'x' }] },
      { migration: '200-b.sql', mutations: [{ kind: 'drop', name: 'x' }] },
      { migration: '300-c.sql', mutations: [{ kind: 'create', name: 'x' }] },
    ]);
    expect([...expected.keys()]).toEqual(['x']);
  });
});

describe('diffLedgerAgainstSchemas', () => {
  const mutationsOf = (m: string): ReturnType<typeof schemaMutationsInMigrationSql> =>
    ({
      '000-baseline.sql': [
        { kind: 'create' as const, name: 'harness_shared' },
        { kind: 'create' as const, name: 'papercup_shared' },
      ],
      '332-rename.sql': [
        { kind: 'rename' as const, name: 'papercup_shared', to: 'papercusp_shared' },
      ],
      '650-gym.sql': [{ kind: 'create' as const, name: 'harness_gym_durable' }],
      '684-alter.sql': [],
    })[m] ?? [];

  const recorded = ['000-baseline.sql', '332-rename.sql', '650-gym.sql', '684-alter.sql'];

  it('reports NOTHING on a healthy container — including the renamed-away schema', () => {
    // THE FALSE POSITIVE GUARD: papercup_shared is legitimately absent.
    expect(
      diffLedgerAgainstSchemas({
        recorded,
        mutationsOf,
        existing: new Set(['harness_shared', 'papercusp_shared', 'harness_gym_durable']),
      }),
    ).toEqual([]);
  });

  it('reports the exact (migration, schema) pair when the ledger claims one reality lacks', () => {
    // THE OUTAGE: 650 recorded, harness_gym_durable gone. 684 then fails on every
    // run because it ALTERs a table in that schema, and 650 is never retried.
    expect(
      diffLedgerAgainstSchemas({
        recorded,
        mutationsOf,
        existing: new Set(['harness_shared', 'papercusp_shared']),
      }),
    ).toEqual([{ migration: '650-gym.sql', schema: 'harness_gym_durable' }]);
  });

  it('is silent on an empty ledger (a fresh container has nothing to diverge from)', () => {
    expect(diffLedgerAgainstSchemas({ recorded: [], mutationsOf, existing: new Set() })).toEqual([]);
  });

  it('folds in APPLY order even when the ledger rows arrive unsorted', () => {
    // Rows come back from PG in no guaranteed order; if the fold used that order,
    // the rename could be applied before the create and resurrect a false positive.
    expect(
      diffLedgerAgainstSchemas({
        recorded: ['332-rename.sql', '000-baseline.sql'],
        mutationsOf,
        existing: new Set(['harness_shared', 'papercusp_shared']),
      }),
    ).toEqual([]);
  });
});
