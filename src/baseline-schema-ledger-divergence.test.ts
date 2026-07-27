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
 * These cover the two PURE halves (parser + diff) so the guard runs with no
 * database and no Docker. The IO wrapper is exercised for real every time a
 * reused container is picked up.
 */
import { describe, it, expect } from 'vitest';
import {
  schemasDeclaredByMigrationSql,
  diffLedgerAgainstSchemas,
} from './baseline-schema-global-setup.ts';

describe('schemasDeclaredByMigrationSql', () => {
  it('finds an unconditional CREATE SCHEMA, with or without IF NOT EXISTS', () => {
    // This is the real shape from 650-harness-gym-durable-run-analytics.sql, the
    // migration whose absence caused the outage.
    expect(schemasDeclaredByMigrationSql('CREATE SCHEMA IF NOT EXISTS harness_gym_durable;')).toEqual(
      ['harness_gym_durable'],
    );
    expect(schemasDeclaredByMigrationSql('CREATE SCHEMA harness_shared;')).toEqual(['harness_shared']);
  });

  it('is case- and quote-insensitive, and de-duplicates', () => {
    const found = schemasDeclaredByMigrationSql(
      `create schema if not exists "Harness_Gym_Durable";\nCREATE SCHEMA IF NOT EXISTS harness_gym_durable;`,
    );
    expect(found).toEqual(['harness_gym_durable']);
  });

  it('finds each schema when a migration declares several, across lines', () => {
    const found = schemasDeclaredByMigrationSql(
      `CREATE SCHEMA IF NOT EXISTS alpha;\n\n  CREATE SCHEMA IF NOT EXISTS beta;\nALTER TABLE alpha.t ADD COLUMN c int;`,
    );
    expect(found.sort()).toEqual(['alpha', 'beta']);
  });

  it('ignores a COMMENTED-OUT create (a false positive here reprovisions a healthy container)', () => {
    expect(schemasDeclaredByMigrationSql('-- CREATE SCHEMA IF NOT EXISTS never_real;')).toEqual([]);
    expect(
      schemasDeclaredByMigrationSql('ALTER TABLE x ADD COLUMN c int; -- CREATE SCHEMA ghost;'),
    ).toEqual([]);
  });

  it('does NOT claim a schema created inside a plpgsql block — its guard may legitimately not fire', () => {
    // Conservative by design: we cannot know whether the IF fired, and guessing
    // would reprovision healthy containers, which is worse than missing a case.
    const found = schemasDeclaredByMigrationSql(
      `DO $pg$ BEGIN\n  IF something THEN CREATE SCHEMA conditional_one; END IF;\nEND $pg$;`,
    );
    expect(found).toEqual([]);
  });

  it('does not match a mere mention of the words in prose or an unrelated statement', () => {
    expect(schemasDeclaredByMigrationSql("SELECT 'CREATE SCHEMA' AS note;")).toEqual([]);
    expect(schemasDeclaredByMigrationSql('DROP SCHEMA harness_gym_durable;')).toEqual([]);
  });
});

describe('diffLedgerAgainstSchemas', () => {
  const declaredBy = (m: string) =>
    ({
      '650-gym.sql': ['harness_gym_durable'],
      '000-baseline.sql': ['harness_shared'],
      '684-alter.sql': [],
    })[m] ?? [];

  it('reports NOTHING when every recorded migration’s schema exists', () => {
    expect(
      diffLedgerAgainstSchemas({
        recorded: ['000-baseline.sql', '650-gym.sql', '684-alter.sql'],
        declaredBy,
        existing: new Set(['harness_shared', 'harness_gym_durable']),
      }),
    ).toEqual([]);
  });

  it('reports the exact (migration, schema) pair when the ledger claims one reality lacks', () => {
    // THE OUTAGE: 650 recorded, harness_gym_durable gone. 684 then fails on every
    // run because it ALTERs a table in that schema, and 650 is never retried.
    expect(
      diffLedgerAgainstSchemas({
        recorded: ['000-baseline.sql', '650-gym.sql', '684-alter.sql'],
        declaredBy,
        existing: new Set(['harness_shared']),
      }),
    ).toEqual([{ migration: '650-gym.sql', schema: 'harness_gym_durable' }]);
  });

  it('is silent on an empty ledger (a fresh container has nothing to diverge from)', () => {
    expect(
      diffLedgerAgainstSchemas({ recorded: [], declaredBy, existing: new Set() }),
    ).toEqual([]);
  });

  it('reports every diverged pair, not just the first', () => {
    expect(
      diffLedgerAgainstSchemas({
        recorded: ['000-baseline.sql', '650-gym.sql'],
        declaredBy,
        existing: new Set(),
      }),
    ).toEqual([
      { migration: '000-baseline.sql', schema: 'harness_shared' },
      { migration: '650-gym.sql', schema: 'harness_gym_durable' },
    ]);
  });
});
