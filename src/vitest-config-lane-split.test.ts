/**
 * Guards for the LANE SPLIT wiring in defineVitestConfig (plan gate-suite-speedup-2026-08-12).
 *
 * The property that matters most here is INERTNESS. `libs/test-config` is loaded by every
 * workspace's vitest run on this box, and the lane split must change NOTHING for any run that
 * did not explicitly ask for a lane — most importantly the green-checkpoint gate's isolation
 * and confirming co-execution re-runs, which reach the workspace through
 * `resolveWorkspaceTestInvocation` → `npm run test --workspace <ws> -- <files>` and therefore
 * carry NO lane env. Those re-runs staying isolated is what preserves WI-6956's teeth
 * (D-009/D-011): "passes alone, fails co-executed" must remain detectable as a real
 * concurrency defect rather than being absorbed.
 *
 * So the tests below assert the negative space as carefully as the positive: no lane env ⇒ no
 * `isolate` key at all, and an un-opted-in workspace ignores the env var even when it is set.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { defineVitestConfig, PC_TEST_LANE_ENV } from './vitest-config.ts';

/** The `test` block of a resolved config, loosely typed — we only probe two fields. */
function testBlock(config: ReturnType<typeof defineVitestConfig>): Record<string, unknown> {
  return (config as { test?: Record<string, unknown> }).test ?? {};
}

const originalLane = process.env[PC_TEST_LANE_ENV];

afterEach(() => {
  if (originalLane === undefined) delete process.env[PC_TEST_LANE_ENV];
  else process.env[PC_TEST_LANE_ENV] = originalLane;
});

describe('lane split — inertness (the safety property)', () => {
  it('sets NO isolate key when no lane is requested', () => {
    delete process.env[PC_TEST_LANE_ENV];
    const block = testBlock(defineVitestConfig({ layer: 'unit', laneSplit: true }));
    // Not `toBeUndefined()` — the key must be ABSENT, so a non-lane run's config is
    // byte-for-byte what it was before the split existed.
    expect('isolate' in block).toBe(false);
    expect(block.include).toEqual(['**/*.test.ts', '**/*.test.tsx']);
  });

  it('IGNORES the env var in a workspace that did not opt in', () => {
    // The gate runs many workspaces; a lane leg's env must not reshape an unrelated suite.
    process.env[PC_TEST_LANE_ENV] = 'pure';
    const block = testBlock(defineVitestConfig({ layer: 'unit' }));
    expect('isolate' in block).toBe(false);
    expect(block.include).toEqual(['**/*.test.ts', '**/*.test.tsx']);
  });

  it('leaves the integration layer untouched when no lane is requested', () => {
    delete process.env[PC_TEST_LANE_ENV];
    const block = testBlock(defineVitestConfig({ layer: 'integration' }));
    expect('isolate' in block).toBe(false);
  });
});

describe('lane split — active', () => {
  it('pure lane sets TOP-LEVEL isolate:false and an explicit file list', () => {
    process.env[PC_TEST_LANE_ENV] = 'pure';
    const block = testBlock(defineVitestConfig({ layer: 'unit', laneSplit: true }));
    // TOP-LEVEL is load-bearing: `poolOptions.forks.isolate` was REMOVED in vitest 4 and is
    // ignored SILENTLY (D-029), which would make the split look like it does nothing.
    expect(block.isolate).toBe(false);
    const include = block.include as string[];
    expect(Array.isArray(include)).toBe(true);
    expect(include.length).toBeGreaterThan(0);
    // Explicit paths, not the layer globs.
    expect(include.every((f) => f.startsWith('./'))).toBe(true);
    // This file restores PC_TEST_LANE through process.env and therefore belongs in the
    // stateful lane. Use a genuinely pure sibling as the calibration case so an
    // empty/degenerate list still cannot pass this test.
    expect(include).toContain('./src/vitest-config-lightweight-subpath.test.ts');
  });

  it('stateful lane keeps isolation and selects the complement', () => {
    process.env[PC_TEST_LANE_ENV] = 'pure';
    const pure = testBlock(defineVitestConfig({ layer: 'unit', laneSplit: true })).include as string[];
    process.env[PC_TEST_LANE_ENV] = 'stateful';
    const statefulBlock = testBlock(defineVitestConfig({ layer: 'unit', laneSplit: true }));
    const stateful = statefulBlock.include as string[];

    expect('isolate' in statefulBlock).toBe(false); // isolated, exactly as today
    expect(stateful.length).toBeGreaterThan(0);
    // The lanes are disjoint — no file can run in both.
    expect(pure.filter((f) => stateful.includes(f))).toEqual([]);
  });
});

describe('lane split — refusals (a wrong lane must be loud, never silently slow)', () => {
  it('throws on an unrecognised lane value', () => {
    process.env[PC_TEST_LANE_ENV] = 'Pure'; // case matters; a typo must not run the whole suite
    expect(() => defineVitestConfig({ layer: 'unit', laneSplit: true })).toThrow(/must be 'pure' or 'stateful'/);
  });

  it('throws when a lane is requested for a non-unit layer', () => {
    process.env[PC_TEST_LANE_ENV] = 'pure';
    expect(() => defineVitestConfig({ layer: 'integration', laneSplit: true })).toThrow(/UNIT-layer/);
  });

  it('throws when laneSplit is combined with an explicit include', () => {
    // Two different answers to "which files run"; refuse rather than let one silently win.
    process.env[PC_TEST_LANE_ENV] = 'pure';
    expect(() =>
      defineVitestConfig({ layer: 'unit', laneSplit: true, include: ['**/*.test.ts'] }),
    ).toThrow(/cannot be combined with an explicit/);
  });
});
