/**
 * mock-sql.ts — a postgres.js `sql` tag double that FAILS LOUDLY on a query no
 * route claims, instead of silently answering it with some other query's rows.
 *
 * ── WHY THIS EXISTS (EI-14882, measured 2026-07-17) ──────────────────────────
 * The pattern this replaces is the catch-all:
 *
 *     sql: Object.assign(
 *       async (..._args: unknown[]) => H.state.presenceRows,   // ← EVERY query
 *       { json: (x: unknown) => ({ __json: x }) },
 *     )
 *
 * It answers *every* query with one fixture. That is fine exactly until the
 * module under test grows a SECOND query — at which point the new query path
 * silently receives the first query's rows. Nothing throws. Nothing logs. The
 * assertions just go wrong in a semantically plausible direction.
 *
 * That is not hypothetical. Adding ONE export (`recordedLiveOwnerIds`) to
 * adv-sessions broke three test files three different ways; the catch-all was
 * the nasty one: `liveness-decoration.test.ts`'s new adv_sessions query received
 * the coord_presence fixture rows, which leaked the fixture owner into the
 * recorded-live set and rescued ENDED sessions to RECORDED. A wrong verdict that
 * READS LIKE A REAL ONE is far more expensive than a crash — the other two
 * failure modes were loud and cost one diagnose-fix loop each.
 *
 * ── THE DISCRIMINATOR ────────────────────────────────────────────────────────
 * A mock's job is to answer the queries the test knows about. Its OTHER job —
 * the one catch-alls quietly abandon — is to refuse the queries it does not know
 * about, so that a new code path shows up as a failure ABOUT THAT PATH rather
 * than as a puzzling assertion diff somewhere else.
 *
 * So `fallback` exists, but you must ask for it. Catch-all behaviour stays
 * available and becomes VISIBLE at the call site instead of being the default
 * you get by writing the shortest possible mock.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *     const sql = mockSqlThrowOnUnmatched([
 *       // `rows` is called PER QUERY, so fixtures mutated between tests are read
 *       // at call time — capturing `H.state.x` eagerly would freeze test 1's data.
 *       { match: /FROM coord_presence/, rows: () => H.state.presenceRows },
 *       { match: /FROM adv_sessions/, rows: [] },
 *     ]);
 *
 * Error injection needs no extra API — a `rows` thunk may simply throw:
 *
 *     { match: /FROM coord_presence/, rows: () => {
 *         if (H.state.sqlError) throw new Error('pg unavailable');
 *         return H.state.presenceRows;
 *       } }
 */

/** One recorded invocation, passed to `rows` thunks and kept on `.calls`. */
export interface MockSqlCall {
  /** Static SQL with each interpolation rendered as `$1`, `$2`, … */
  readonly text: string;
  /** The interpolated values, in order. */
  readonly values: readonly unknown[];
  /** `label` (or the stringified `match`) of the route that answered, else null. */
  readonly matched: string | null;
}

type RowsSource =
  | readonly unknown[]
  | ((call: MockSqlCall) => readonly unknown[] | Promise<readonly unknown[]>);

export interface MockSqlRoute {
  /** RegExp tested against, or substring searched for in, the rendered query text. */
  readonly match: RegExp | string;
  /**
   * Rows to answer with. Prefer a FUNCTION: it is evaluated per query, so a
   * fixture reassigned in `beforeEach` is read at call time rather than frozen
   * at construction. A thrown error propagates, which is how you inject failures.
   */
  readonly rows: RowsSource;
  /** Human name for error messages and `.calls[].matched`. Defaults to `match`. */
  readonly label?: string;
}

export interface MockSqlOptions {
  /**
   * Deliberate opt-in to catch-all behaviour for unmatched queries. Omit it and
   * an unmatched query throws — which is the entire point of this helper.
   */
  readonly fallback?: RowsSource;
  /** Name used in the thrown message, to identify WHICH mock refused. */
  readonly name?: string;
}

/** The callable double: a `sql` tag plus the surface tests and callers rely on. */
export interface MockSql {
  (strings: TemplateStringsArray | readonly string[], ...values: unknown[]): Promise<unknown[]>;
  /** postgres.js `sql.json()` — preserved because production code calls it. */
  json: (x: unknown) => { __json: unknown };
  /** Every query this mock saw, in order. */
  readonly calls: readonly MockSqlCall[];
  /** Labels of routes that never matched — a stale route is a stale mental model. */
  unusedRoutes: () => string[];
}

const MAX_QUERY_IN_ERROR = 400;

/** Render a tagged-template call as stable, matchable text. */
export function renderQueryText(
  strings: TemplateStringsArray | readonly string[],
  values: readonly unknown[],
): string {
  return strings.reduce<string>(
    (acc, chunk, i) => acc + chunk + (i < values.length ? `$${i + 1}` : ''),
    '',
  );
}

function routeLabel(route: MockSqlRoute): string {
  return route.label ?? String(route.match);
}

function matches(route: MockSqlRoute, text: string): boolean {
  return typeof route.match === 'string' ? text.includes(route.match) : route.match.test(text);
}

async function resolveRows(source: RowsSource, call: MockSqlCall): Promise<unknown[]> {
  const rows = typeof source === 'function' ? await source(call) : source;
  return [...rows];
}

function unmatchedError(name: string, text: string, routes: readonly MockSqlRoute[]): Error {
  const shown =
    text.length > MAX_QUERY_IN_ERROR ? `${text.slice(0, MAX_QUERY_IN_ERROR)}… (truncated)` : text;
  const registered = routes.length
    ? routes.map((r, i) => `    ${i + 1}. ${routeLabel(r)}`).join('\n')
    : '    (none)';
  return new Error(
    `${name}: no route matched this query, so it was NOT answered.\n` +
      `A catch-all mock would have silently returned another query's fixture rows\n` +
      `here, and the assertion would have failed somewhere else entirely (EI-14882).\n\n` +
      `  query:\n    ${shown}\n\n` +
      `  ${routes.length} registered route(s):\n${registered}\n\n` +
      `  Fix: add a route for this query. If a catch-all is genuinely what you want,\n` +
      `  pass { fallback } to say so explicitly at the call site.`,
  );
}

/**
 * Build a `sql` double that answers only the queries you routed, and throws a
 * diagnostic error on any other — so a newly-added query path fails ABOUT ITSELF.
 */
export function mockSqlThrowOnUnmatched(
  routes: readonly MockSqlRoute[],
  options: MockSqlOptions = {},
): MockSql {
  const name = options.name ?? 'mockSql';
  const calls: MockSqlCall[] = [];
  const used = new Set<string>();

  const fn = async (
    strings: TemplateStringsArray | readonly string[],
    ...values: unknown[]
  ): Promise<unknown[]> => {
    const text = renderQueryText(strings, values);
    const route = routes.find((r) => matches(r, text));
    const call: MockSqlCall = {
      text,
      values,
      matched: route ? routeLabel(route) : null,
    };
    calls.push(call);

    if (route) {
      used.add(routeLabel(route));
      return resolveRows(route.rows, call);
    }
    if (options.fallback !== undefined) return resolveRows(options.fallback, call);
    throw unmatchedError(name, text, routes);
  };

  return Object.assign(fn, {
    json: (x: unknown) => ({ __json: x }),
    calls: calls as readonly MockSqlCall[],
    unusedRoutes: () => routes.map(routeLabel).filter((label) => !used.has(label)),
  }) as MockSql;
}
