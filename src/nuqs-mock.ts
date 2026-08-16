/**
 * A COMPLETE `vi.mock('nuqs', ...)` mock — every parser nuqs currently
 * exports (verified against the installed `nuqs` package by
 * `nuqs-mock.test.ts` in this same directory, which reds if upstream adds a
 * new one), each with a working, non-throwing `.withDefault()`.
 *
 * Root-cause fix for EI-8821: every one of the ~50 suites across
 * apps/operator + apps/operator-vite that mock `nuqs` hand-rolled their OWN
 * incomplete stub (a bare `parseAsString: {}`, or a parser omitted
 * entirely). A component wiring a NEW `parseAsX(...).withDefault(...)` call
 * into an always-rendered path then silently reds every OTHER suite that
 * happens to render it — even though that suite's own authored behavior has
 * nothing to do with the new call site. (Concrete incident:
 * `AgentsRunningPill.tsx` wiring `parseAsString.withDefault('')` into its
 * top-level render redded 41 tests across two files whose own mocks stubbed
 * `parseAsString` as `{}`.)
 *
 * Usage:
 *   - New suite, no custom setter-spy needs: `vi.mock('nuqs', () =>
 *     createNuqsMock())` — a real per-key keyed store backed by `vi.fn()`
 *     setters that actually write back.
 *   - Existing/custom suite (needs its own `useQueryState` — pinned initial
 *     values, spy assertions on specific setter identities, etc.): spread
 *     `nuqsParsers` for the parser exports and keep your own
 *     `useQueryState`/`useQueryStates`:
 *       `vi.mock('nuqs', () => ({ ...nuqsParsers, useQueryState: ... }))`
 *   - Prefer nuqs's own first-party `NuqsTestingAdapter` (`nuqs/adapters/testing`)
 *     over EITHER of the above when the suite can render through a real
 *     router/adapter tree (see VideoGrid.test.tsx, ToolUsagePanel.test.tsx for
 *     the established in-repo pattern) — it exercises the real parsers, so
 *     this whole incompleteness class cannot occur. Reach for this mock only
 *     when a full adapter tree isn't practical for the suite.
 */
import { vi } from 'vitest';

/** A generic parser: never throws, round-trips its value, and answers `.withDefault()`. */
function genericParser(): {
  withDefault: (defaultValue: unknown) => Record<string, unknown>;
  parse: (v: unknown) => unknown;
  serialize: (v: unknown) => string;
  eq: (a: unknown, b: unknown) => boolean;
} {
  const base = {
    parse: (v: unknown) => v,
    serialize: (v: unknown) => (v === null || v === undefined ? '' : String(v)),
    eq: (a: unknown, b: unknown) => a === b,
  };
  return {
    ...base,
    withDefault: (defaultValue: unknown) => ({ ...base, defaultValue }),
  };
}

/** Every nuqs parser that is a BARE parser object (`.withDefault` accessed directly). */
const bareParsers = {
  parseAsString: genericParser(),
  parseAsBoolean: genericParser(),
  parseAsInteger: genericParser(),
  parseAsFloat: genericParser(),
  parseAsHex: genericParser(),
  parseAsIndex: genericParser(),
  parseAsIsoDate: genericParser(),
  parseAsIsoDateTime: genericParser(),
  parseAsTimestamp: genericParser(),
};

/** Every nuqs parser that is a FACTORY (called with args — enum values, an item parser, a schema, …). */
const factoryParsers = {
  parseAsStringEnum: (..._args: unknown[]) => genericParser(),
  parseAsStringLiteral: (..._args: unknown[]) => genericParser(),
  parseAsNumberLiteral: (..._args: unknown[]) => genericParser(),
  parseAsArrayOf: (..._args: unknown[]) => genericParser(),
  parseAsNativeArrayOf: (..._args: unknown[]) => genericParser(),
  parseAsJson: (..._args: unknown[]) => genericParser(),
};

/** Spread these into a custom `vi.mock('nuqs', () => ({ ...nuqsParsers, useQueryState: ... }))`. */
export const nuqsParsers: Record<string, unknown> = { ...bareParsers, ...factoryParsers };

export interface NuqsMockOptions {
  /** Seed initial per-key values (otherwise a key's parser default, or `null`, is used on first read). */
  initial?: Record<string, unknown>;
}

/**
 * A complete, generic `vi.mock('nuqs', () => createNuqsMock())` factory
 * result: every parser above, PLUS a real keyed-store `useQueryState` /
 * `useQueryStates` (module-level object + `vi.fn()` setters that actually
 * write back, so a set-then-rerender assertion sees the new value).
 */
export function createNuqsMock(options: NuqsMockOptions = {}): Record<string, unknown> {
  const state: Record<string, unknown> = { ...options.initial };
  const setters: Record<string, ReturnType<typeof vi.fn>> = {};

  function setterFor(key: string): ReturnType<typeof vi.fn> {
    return (setters[key] ??= vi.fn(async (v: unknown) => {
      state[key] = typeof v === 'function' ? (v as (prev: unknown) => unknown)(state[key]) : v;
      return true;
    }));
  }

  return {
    ...nuqsParsers,
    useQueryState: (key: string, parser?: { defaultValue?: unknown }) => {
      if (!(key in state)) state[key] = parser?.defaultValue ?? null;
      return [state[key], setterFor(key)];
    },
    useQueryStates: (parsers: Record<string, { defaultValue?: unknown }>) => {
      for (const key of Object.keys(parsers)) {
        if (!(key in state)) state[key] = parsers[key]?.defaultValue ?? null;
      }
      const setAll = vi.fn(async (updates: Record<string, unknown>) => {
        Object.assign(state, updates);
        return true;
      });
      const values = Object.fromEntries(Object.keys(parsers).map((key) => [key, state[key]]));
      return [values, setAll];
    },
    /** Escape hatch for a suite that wants to seed/inspect the keyed store directly. */
    __nuqsMockState: state,
  };
}
