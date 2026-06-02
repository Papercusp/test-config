import { describe, it, expect, beforeEach } from 'vitest';
import { pgTable, text, integer, boolean, jsonb, bigint } from 'drizzle-orm/pg-core';
import { makeFixture, makeFixtures, _resetFixtureCounters } from './make-fixture.ts';

/**
 * A local Drizzle table exercising the per-type defaults. Defined inline so
 * the shared lib's test carries NO domain dependency (the prior version
 * imported @papercusp/db-org's generated schema).
 */
const sample = pgTable('sample', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  workspace_id: text('workspace_id').notNull(),
  count: integer('count').notNull(),
  enabled: boolean('enabled').notNull(),
  payload: jsonb('payload').notNull(),
  created_ts: bigint('created_ts', { mode: 'number' }).notNull(),
  note: text('note'),
});

beforeEach(() => _resetFixtureCounters());

describe('makeFixture', () => {
  it('fills NOT NULL columns with per-type defaults', () => {
    const row = makeFixture(sample);
    expect(row.name).toBe('');
    expect(row.status).toBe('pending');
    expect(row.workspace_id).toBe('default');
    expect(row.count).toBe(0);
    expect(row.enabled).toBe(false);
    expect(row.payload).toEqual({});
    expect(typeof row.created_ts).toBe('number'); // *_ts → Date.now()
    expect(row.note).toBeNull(); // nullable, no default
  });

  it('honours overrides (applied last)', () => {
    const row = makeFixture(sample, { name: 'x', count: 7 });
    expect(row.name).toBe('x');
    expect(row.count).toBe(7);
  });

  it('gives id-like columns a unique counter value per row', () => {
    const a = makeFixture(sample);
    const b = makeFixture(sample);
    expect(a.id).toBe('sample-id-1');
    expect(b.id).toBe('sample-id-2');
  });

  it('_resetFixtureCounters resets the counter', () => {
    makeFixture(sample);
    _resetFixtureCounters();
    expect(makeFixture(sample).id).toBe('sample-id-1');
  });
});

describe('makeFixtures', () => {
  it('builds N rows with per-row overrides', () => {
    const rows = makeFixtures(sample, 3, (i) => ({ id: `r-${i}` }));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id)).toEqual(['r-0', 'r-1', 'r-2']);
  });
});
