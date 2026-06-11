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
import AdminTestRunsReporter, { buildOutputTail } from './admin-test-runs-reporter';

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
