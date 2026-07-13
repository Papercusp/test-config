/**
 * P-044: Fail-soft tests for admin-test-runs-reporter.
 *
 * D-007 contract: reporter MUST never throw, never affect exit code,
 * never poison stdout/stderr, even when PG / git / fs are unavailable.
 *
 * Moved here (2026-06-08) when the reporter was lifted into @papercusp/test-config
 * + auto-wired by defineVitestConfig. Vitest 4 API: onTestModuleEnd / onTestRunEnd /
 * onExit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminTestRunsReporter, {
  buildOutputTail,
  captureReporterSaturationSnapshot,
  shouldRecordTestRunPath,
} from './admin-test-runs-reporter';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdminTestRunsReporter fail-soft contract', () => {
  it('constructs without side effects', () => {
    const r = new AdminTestRunsReporter();
    expect(r).toBeDefined();
  });

  it('onInit is a no-op even with a bogus ctx', () => {
    const r = new AdminTestRunsReporter();
    expect(() => r.onInit(null as never)).not.toThrow();
  });

  it('onTestModuleEnd swallows a TestModule whose state() throws', () => {
    const r = new AdminTestRunsReporter();
    const fakeModule = {
      moduleId: '/tmp/fake.test.ts',
      state: () => {
        throw new Error('state-explodes');
      },
      diagnostic: () => ({ duration: 5 }),
      errors: () => [],
    } as unknown as Parameters<typeof r.onTestModuleEnd>[0];
    expect(() => r.onTestModuleEnd(fakeModule)).not.toThrow();
  });

  it('onTestModuleEnd swallows a TestModule with no moduleId', () => {
    const r = new AdminTestRunsReporter();
    const fakeModule = {
      // moduleId: undefined
      state: () => 'passed',
      diagnostic: () => ({ duration: 5 }),
    } as unknown as Parameters<typeof r.onTestModuleEnd>[0];
    expect(() => r.onTestModuleEnd(fakeModule)).not.toThrow();
  });

  it('onTestModuleEnd accepts a realistic passing module without throwing', () => {
    const r = new AdminTestRunsReporter();
    const fakeModule = {
      moduleId: '/tmp/fake.test.ts',
      state: () => 'passed',
      diagnostic: () => ({ duration: 12, environmentSetupDuration: 0, prepareDuration: 0, collectDuration: 0, setupDuration: 0 }),
      errors: () => [],
    } as unknown as Parameters<typeof r.onTestModuleEnd>[0];
    expect(() => r.onTestModuleEnd(fakeModule)).not.toThrow();
  });

  it('captures the reporter saturation fields used by harness_shared.test_runs', () => {
    const snap = captureReporterSaturationSnapshot();
    expect(snap.rssMb).toEqual(expect.any(Number));
    expect(snap.loopLagP95Ms === null || typeof snap.loopLagP95Ms === 'number').toBe(true);
  });

  it('does not record retired, scratch, or sibling-checkout test paths', () => {
    expect(shouldRecordTestRunPath('_retired/snapshot-system/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('libs/papercusp/_retired/orchestrator-run-loop/src/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('.papercusp/scratch/tdg-123/src/x.test.tsx')).toBe(false);
    expect(shouldRecordTestRunPath('apps/operator/.papercusp/scratch/tdg-123/src/x.test.tsx')).toBe(false);
    expect(shouldRecordTestRunPath('papercupai-workspace/papercup-checkpoint/apps/operator/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('papercupai-workspace/papercusp-checkpoint/apps/operator/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('papercupai-workspace/papercup-staging/apps/operator/x.test.ts')).toBe(false);
    // `*.flakeproof.test.{ts,tsx}` — reserved flake-soak self-test scratch fixtures,
    // intended REDs, never committed (EI-10761 — a red-test EI on a non-existent file).
    expect(shouldRecordTestRunPath('apps/operator-vite/src/components/left-sidebar/MugTab.flakeproof.test.tsx')).toBe(false);
    expect(shouldRecordTestRunPath('src/x.flakeproof.test.ts')).toBe(false);
    // Cargo/Tauri BUILD-ARTIFACT copies of template checks — the sidecar build
    // copies `templates/<id>/checks/*.test.ts` (which import
    // `@papercusp/template-kit`) into a gitignored cargo target dir where
    // node_modules are NOT linked, so every copy reds with "Cannot find package
    // '@papercusp/template-kit'". Never a source regression (EI-11176).
    expect(shouldRecordTestRunPath('.wi3388-cargo-target/debug/sidecar/templates/papercusp-webapp/checks/composition-integrity.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('papercusp-desktop/src-tauri/target/debug/sidecar/templates/papercusp-webapp/checks/composition-integrity.test.ts')).toBe(false);
    // …but the real SOURCE copies of those same checks still record.
    expect(shouldRecordTestRunPath('templates/papercusp-webapp/checks/composition-integrity.test.ts')).toBe(true);
    expect(shouldRecordTestRunPath('packages/operator-core/lib/testing-orphan-runs.test.ts')).toBe(true);
  });

  it('buildOutputTail captures failed TEST-CASE errors when the module has no top-level errors', () => {
    const fakeModule = {
      moduleId: '/tmp/fake.test.ts',
      state: () => 'failed',
      errors: () => [],
      children: {
        allTests: () => [
          {
            fullName: 'suite > passes',
            result: () => ({ state: 'passed', errors: [] }),
          },
          {
            fullName: 'suite > fails',
            result: () => ({ state: 'failed', errors: [{ message: 'expected 1 to be 2' }] }),
          },
        ],
      },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    const tail = buildOutputTail(fakeModule, 'fail');
    expect(tail).toBe('suite > fails: expected 1 to be 2');
  });

  it('buildOutputTail prefers module-level errors and stays null for passing modules', () => {
    const withModuleErr = {
      errors: () => [{ message: 'import boom' }],
      children: { allTests: () => [] },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    expect(buildOutputTail(withModuleErr, 'fail')).toBe('import boom');

    const passing = {
      errors: () => [],
      children: {
        allTests: () => [{ fullName: 'x', result: () => ({ state: 'passed', errors: [] }) }],
      },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    expect(buildOutputTail(passing, 'pass')).toBeNull();
  });

  it('buildOutputTail is fail-soft when the test walk throws', () => {
    const explosive = {
      errors: () => [],
      children: {
        allTests: () => {
          throw new Error('walk-explodes');
        },
      },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    expect(buildOutputTail(explosive, 'fail')).toBeNull();
  });

  it('onTestRunEnd resolves cleanly with no pending work', async () => {
    const r = new AdminTestRunsReporter();
    await expect(r.onTestRunEnd()).resolves.toBeUndefined();
  });

  it('onExit resolves cleanly with no pending work', async () => {
    const r = new AdminTestRunsReporter();
    await expect(r.onExit()).resolves.toBeUndefined();
  });
});
