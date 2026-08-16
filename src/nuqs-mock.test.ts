/**
 * Recurrence guard for EI-8821: asserts `nuqsParsers` stays COMPLETE against
 * whatever `nuqs` actually exports. If nuqs ever adds a new `parseAsX`, this
 * test reds here — in ONE file — instead of the incompleteness silently
 * surfacing as a mystery failure in whichever of the ~50 consumer suites
 * happens to be the first to render a component using the new parser.
 */
import { describe, expect, it } from 'vitest';
import * as realNuqs from 'nuqs';
import { createNuqsMock, nuqsParsers } from './nuqs-mock.ts';

const realParserNames = Object.keys(realNuqs).filter((name) => name.startsWith('parseAs'));

describe('nuqsParsers completeness', () => {
  it('has never seen zero real parser names (guards against a broken import)', () => {
    expect(realParserNames.length).toBeGreaterThan(0);
  });

  it.each(realParserNames)('mocks every real nuqs export: %s', (name) => {
    expect(nuqsParsers).toHaveProperty(name);
  });

  it('every mocked parser answers a working, non-throwing .withDefault(...)', () => {
    for (const [name, value] of Object.entries(nuqsParsers)) {
      // Bare parsers expose `.withDefault` directly; factory parsers (parseAsStringEnum,
      // parseAsArrayOf, …) must be called first — with plausible dummy args — to get one.
      const parser = typeof value === 'function' ? (value as (...a: unknown[]) => unknown)(['a', 'b'], value) : value;
      expect(parser, `${name} should produce a parser object`).toBeTruthy();
      expect(typeof (parser as { withDefault?: unknown }).withDefault, `${name}.withDefault`).toBe('function');
      expect(() => (parser as { withDefault: (d: unknown) => unknown }).withDefault('x')).not.toThrow();
    }
  });

  it('has no mocked parser name that nuqs itself does not export (stale entry)', () => {
    for (const name of Object.keys(nuqsParsers)) {
      expect(realParserNames, `${name} is mocked but not a real nuqs export`).toContain(name);
    }
  });
});

describe('createNuqsMock', () => {
  it('useQueryState: reads the parser default once, then round-trips a set', async () => {
    const mock = createNuqsMock();
    const useQueryState = mock.useQueryState as (
      key: string,
      parser?: { defaultValue?: unknown },
    ) => [unknown, (v: unknown) => Promise<boolean>];

    const [initial, setTab] = useQueryState('tab', { defaultValue: 'overview' });
    expect(initial).toBe('overview');

    await setTab('settings');
    const [after] = useQueryState('tab', { defaultValue: 'overview' });
    expect(after).toBe('settings');
  });

  it('useQueryState: a functional updater reads the previous value', async () => {
    const mock = createNuqsMock({ initial: { count: 1 } });
    const useQueryState = mock.useQueryState as (
      key: string,
    ) => [unknown, (v: unknown) => Promise<boolean>];

    const [, setCount] = useQueryState('count');
    await setCount((prev: unknown) => (prev as number) + 1);
    const [after] = useQueryState('count');
    expect(after).toBe(2);
  });

  it('useQueryStates: seeds defaults + writes back a batched update', async () => {
    const mock = createNuqsMock();
    const useQueryStates = mock.useQueryStates as (
      parsers: Record<string, { defaultValue?: unknown }>,
    ) => [Record<string, unknown>, (u: Record<string, unknown>) => Promise<boolean>];

    const [values, setAll] = useQueryStates({ a: { defaultValue: 1 }, b: { defaultValue: 2 } });
    expect(values).toEqual({ a: 1, b: 2 });

    await setAll({ a: 9 });
    const [after] = useQueryStates({ a: { defaultValue: 1 }, b: { defaultValue: 2 } });
    expect(after).toEqual({ a: 9, b: 2 });
  });
});
