import { describe, expect, it } from 'vitest';

import { mockSqlThrowOnUnmatched, renderQueryText } from './mock-sql.ts';

/** Invoke the double the way a tagged template does, from a plain string. */
function q(sql: ReturnType<typeof mockSqlThrowOnUnmatched>, text: string, ...values: unknown[]) {
  return sql([text] as unknown as TemplateStringsArray, ...values);
}

/**
 * PERMANENT CONTROL — the catch-all shape this helper replaces, kept verbatim so
 * the suite can prove it DISCRIMINATES rather than merely passing.
 *
 * A static `import` makes copy-out mutation probing impossible (the test would
 * keep resolving the real module and report MUTANT SURVIVED — EI-21895874556326443),
 * so the repo's prescribed tier for an imported subject applies: keep a
 * deliberately-wrong implementation in the file and assert the contrast.
 */
function legacyCatchAllSql(rows: readonly unknown[]) {
  return Object.assign(async (..._args: unknown[]) => rows, {
    json: (x: unknown) => ({ __json: x }),
  });
}

describe('mockSqlThrowOnUnmatched', () => {
  describe('THE REGRESSION IT EXISTS FOR (EI-14882)', () => {
    it('refuses a newly-added query path instead of feeding it another route’s rows', async () => {
      // Exactly the liveness-decoration shape: a presence fixture, and then the
      // module grows an adv_sessions query nobody routed. A catch-all answered
      // that with the presence rows, leaking the fixture owner into the
      // recorded-live set — wrong, but plausible enough to survive review.
      const presenceRows = [{ owner_id: 'su-fixture' }];
      const sql = mockSqlThrowOnUnmatched([
        { match: /FROM coord_presence/, rows: () => presenceRows },
      ]);

      await expect(q(sql, 'SELECT owner_id FROM coord_presence')).resolves.toEqual(presenceRows);

      // The new path must fail ABOUT ITSELF...
      await expect(q(sql, 'SELECT owner_id FROM adv_sessions WHERE ended_at IS NULL')).rejects.toThrow(
        /no route matched/i,
      );
      // ...and must never quietly return the other query's fixture.
      await expect(
        q(sql, 'SELECT owner_id FROM adv_sessions WHERE ended_at IS NULL'),
      ).rejects.not.toEqual(presenceRows);
    });

    it('CONTROL: the catch-all it replaces fails this very scenario', async () => {
      // Calibration for the test above. If this control ever starts behaving like
      // the real helper, the scenario has stopped discriminating and the passing
      // test above is worthless — a green suite and a broken guard are perfectly
      // compatible states unless something pins the contrast.
      const presenceRows = [{ owner_id: 'su-fixture' }];
      const legacy = legacyCatchAllSql(presenceRows);

      // The bug, reproduced: an unrouted query is answered with the OTHER
      // query's fixture rows, silently and plausibly.
      await expect(
        legacy(['SELECT owner_id FROM adv_sessions'] as unknown as TemplateStringsArray),
      ).resolves.toEqual(presenceRows);

      // The real helper refuses the identical query.
      const guarded = mockSqlThrowOnUnmatched([
        { match: /FROM coord_presence/, rows: () => presenceRows },
      ]);
      await expect(q(guarded, 'SELECT owner_id FROM adv_sessions')).rejects.toThrow(
        /no route matched/i,
      );
    });

    it('names the offending query and the registered routes, so the fix is obvious', async () => {
      const sql = mockSqlThrowOnUnmatched(
        [
          { match: /FROM coord_presence/, rows: [], label: 'presence' },
          { match: /FROM harness_plans/, rows: [] },
        ],
        { name: 'dbOrgMock' },
      );

      // `then(onOk, onErr)` rather than `.catch`: it also asserts the call
      // actually REJECTED, instead of silently passing if it started resolving.
      const err = await q(sql, 'SELECT 1 FROM adv_sessions').then(
        () => null,
        (e: unknown) => e as Error,
      );

      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toContain('dbOrgMock'); // WHICH mock refused
      expect(err?.message).toContain('adv_sessions'); // WHICH query
      expect(err?.message).toContain('presence'); // what WAS routed
      expect(err?.message).toContain('harness_plans');
      expect(err?.message).toContain('fallback'); // the deliberate escape
    });
  });

  describe('routing', () => {
    it('matches on a RegExp and on a plain substring', async () => {
      const sql = mockSqlThrowOnUnmatched([
        { match: /FROM a\b/, rows: [{ from: 'regexp' }] },
        { match: 'FROM b', rows: [{ from: 'substring' }] },
      ]);

      await expect(q(sql, 'SELECT * FROM a')).resolves.toEqual([{ from: 'regexp' }]);
      await expect(q(sql, 'SELECT * FROM b')).resolves.toEqual([{ from: 'substring' }]);
    });

    it('takes the FIRST matching route when several match', async () => {
      const sql = mockSqlThrowOnUnmatched([
        { match: /FROM/, rows: [{ n: 1 }] },
        { match: /FROM/, rows: [{ n: 2 }] },
      ]);
      await expect(q(sql, 'SELECT * FROM t')).resolves.toEqual([{ n: 1 }]);
    });

    it('renders interpolated values as $1, $2 so routes can match around them', async () => {
      expect(renderQueryText(['SELECT * FROM t WHERE a=', ' AND b=', ''], ['x', 'y'])).toBe(
        'SELECT * FROM t WHERE a=$1 AND b=$2',
      );

      const sql = mockSqlThrowOnUnmatched([{ match: /WHERE a=\$1 AND b=\$2/, rows: [{ ok: true }] }]);
      await expect(
        sql(['SELECT * FROM t WHERE a=', ' AND b=', ''] as unknown as TemplateStringsArray, 'x', 'y'),
      ).resolves.toEqual([{ ok: true }]);
    });
  });

  describe('rows are resolved PER CALL, not captured at construction', () => {
    it('reads a fixture reassigned after the mock was built', async () => {
      // Load-bearing: the catch-alls being replaced close over `H.state.x`, which
      // beforeEach reassigns. An eager helper would freeze test 1's fixture and
      // silently pass stale rows to every later test.
      const H = { rows: [{ v: 'first' }] };
      const sql = mockSqlThrowOnUnmatched([{ match: 'FROM t', rows: () => H.rows }]);

      await expect(q(sql, 'SELECT * FROM t')).resolves.toEqual([{ v: 'first' }]);
      H.rows = [{ v: 'second' }];
      await expect(q(sql, 'SELECT * FROM t')).resolves.toEqual([{ v: 'second' }]);
    });

    it('propagates a throwing thunk, which is how failures are injected', async () => {
      const H = { sqlError: false };
      const sql = mockSqlThrowOnUnmatched([
        {
          match: 'FROM t',
          rows: () => {
            if (H.sqlError) throw new Error('pg unavailable');
            return [{ ok: true }];
          },
        },
      ]);

      await expect(q(sql, 'SELECT * FROM t')).resolves.toEqual([{ ok: true }]);
      H.sqlError = true;
      await expect(q(sql, 'SELECT * FROM t')).rejects.toThrow('pg unavailable');
    });

    it('awaits an async thunk', async () => {
      const sql = mockSqlThrowOnUnmatched([
        { match: 'FROM t', rows: async () => [{ async: true }] },
      ]);
      await expect(q(sql, 'SELECT * FROM t')).resolves.toEqual([{ async: true }]);
    });

    it('returns a copy, so a caller mutating the result cannot corrupt the fixture', async () => {
      const fixture = [{ v: 1 }];
      const sql = mockSqlThrowOnUnmatched([{ match: 'FROM t', rows: () => fixture }]);

      const rows = await q(sql, 'SELECT * FROM t');
      rows.push({ v: 2 });

      expect(fixture).toHaveLength(1);
      await expect(q(sql, 'SELECT * FROM t')).resolves.toHaveLength(1);
    });
  });

  describe('fallback — catch-all stays possible, but must be asked for', () => {
    it('answers unmatched queries when fallback is given', async () => {
      const sql = mockSqlThrowOnUnmatched([{ match: 'FROM t', rows: [{ routed: true }] }], {
        fallback: [{ fell_back: true }],
      });
      await expect(q(sql, 'SELECT * FROM anything_else')).resolves.toEqual([{ fell_back: true }]);
    });

    it('still prefers a matching route over the fallback', async () => {
      const sql = mockSqlThrowOnUnmatched([{ match: 'FROM t', rows: [{ routed: true }] }], {
        fallback: [{ fell_back: true }],
      });
      await expect(q(sql, 'SELECT * FROM t')).resolves.toEqual([{ routed: true }]);
    });

    it('treats an empty-array fallback as present, not as absent', async () => {
      // `[]` is falsy-adjacent in a careless implementation; it must still count
      // as an explicit opt-in rather than falling through to the throw.
      const sql = mockSqlThrowOnUnmatched([], { fallback: [] });
      await expect(q(sql, 'SELECT 1')).resolves.toEqual([]);
    });
  });

  describe('surface the production code and tests rely on', () => {
    it('exposes sql.json', async () => {
      const sql = mockSqlThrowOnUnmatched([]);
      expect(sql.json({ a: 1 })).toEqual({ __json: { a: 1 } });
    });

    it('records every query with the route that answered it', async () => {
      const sql = mockSqlThrowOnUnmatched([{ match: 'FROM t', rows: [], label: 'tee' }], {
        fallback: [],
      });

      await q(sql, 'SELECT * FROM t WHERE id=', 7);
      await q(sql, 'SELECT * FROM other');

      expect(sql.calls).toHaveLength(2);
      expect(sql.calls[0]?.matched).toBe('tee');
      expect(sql.calls[0]?.values).toEqual([7]);
      expect(sql.calls[1]?.matched).toBeNull();
    });

    it('records a query even when it is refused, so the failure is inspectable', async () => {
      const sql = mockSqlThrowOnUnmatched([]);
      await q(sql, 'SELECT * FROM nope').catch(() => undefined);
      expect(sql.calls).toHaveLength(1);
      expect(sql.calls[0]?.matched).toBeNull();
    });

    it('reports routes that never matched — a stale route is a stale mental model', async () => {
      const sql = mockSqlThrowOnUnmatched([
        { match: 'FROM used', rows: [] },
        { match: 'FROM never', rows: [], label: 'never-used' },
      ]);

      expect(sql.unusedRoutes()).toEqual(['FROM used', 'never-used']);
      await q(sql, 'SELECT * FROM used');
      expect(sql.unusedRoutes()).toEqual(['never-used']);
    });
  });
});
