/**
 * vitest-config.test.ts
 *
 * handoff-coordination-dx-followups-2026-06-04 §A5 — the unit-layer guard that
 * turns the silent "No test files found" footgun into an actionable error when
 * an *.integration.test.* / *.browser.test.* file is run by path under the
 * default (unit) config (which EXCLUDES those globs).
 *
 * The guard inspects process.argv for a positional file filter naming a layered
 * test, so each case overrides argv (then restores it) to drive it
 * deterministically — independent of the ambient vitest invocation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineVitestConfig } from './vitest-config.ts';

let savedArgv: string[];
beforeEach(() => {
  savedArgv = process.argv;
});
afterEach(() => {
  process.argv = savedArgv;
});

/** Simulate `vitest run <…tokens…>`. */
function withArgv(...tokens: string[]): void {
  process.argv = ['node', 'vitest', 'run', ...tokens];
}

describe('defineVitestConfig unit-layer integration-path guard (§A5)', () => {
  it('throws an actionable error (naming the integration config) for an *.integration.test.ts run by path under the unit config', () => {
    withArgv('lib/foo.integration.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).toThrow(/integration test/i);
    withArgv('lib/foo.integration.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).toThrow(/--config vitest\.integration\.config\.ts/);
  });

  it('points an *.browser.test.ts at the browser config', () => {
    withArgv('lib/foo.browser.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).toThrow(/--config vitest\.browser\.config\.ts/);
  });

  it('does NOT fire for a plain unit *.test.ts path', () => {
    withArgv('lib/foo.test.ts');
    expect(() => defineVitestConfig({ layer: 'unit' })).not.toThrow();
  });

  it('does NOT fire when the integration config is already in use (layer != unit)', () => {
    withArgv('lib/foo.integration.test.ts');
    expect(() => defineVitestConfig({ layer: 'integration' })).not.toThrow();
  });

  it('ignores flag tokens — a `-t <pattern>` filter is not mistaken for a misrouted file', () => {
    withArgv('-t', 'some integration test name');
    expect(() => defineVitestConfig({ layer: 'unit' })).not.toThrow();
  });
});
