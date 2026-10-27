/**
 * WI-6554700010018532 — the reporter must load and record rows in a hive that does
 * not ship @papercusp/verification-harness (SideStage has no libs/generic).
 *
 * A static `import { defaultEvidenceRoot } from '@papercusp/verification-harness'`
 * made the whole reporter module unloadable there, so every router run in that hive
 * returned `no_report`. Here the package is made unresolvable for this file's module
 * graph. A static import fails the dynamic `import()` of the reporter below. The lazy
 * load in onInit must turn the same failure into "no isolated-runtime receipts".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
// Type-only: erased at compile time, so it does not load the reporter before vi.mock applies.
import type { TestRunRow } from './admin-test-runs-reporter.ts';

vi.mock('@papercusp/verification-harness', () => {
  throw Object.assign(new Error("Cannot find package '@papercusp/verification-harness'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
});
// The reporter loads the evidence-root SUBPATH; vi.mock matches specifiers exactly, so an
// absent package must make that entry unresolvable too (it is what a hive without the
// package would see).
vi.mock('@papercusp/verification-harness/evidence-root', () => {
  throw Object.assign(new Error("Cannot find package '@papercusp/verification-harness'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
});

const TEST_CONFIG_ROOT = fileURLToPath(new URL('../', import.meta.url));

// The package's setup files (setup-hermetic-env.ts, executed-inputs-capture-setup.ts) import
// the reporter statically, so it is already evaluated, with the real package, before this
// file's vi.mock exists. Without a reset, the import() below returns that cached module, and
// a re-added static import goes unnoticed (measured: mutation probe test_runs 21476286, survived).
beforeEach(() => { vi.resetModules(); });

const RUN_ID = '20261008T000000Z-100';
const passedIsolatedCase = {
  fullName: 'suite > isolated worker',
  result: () => ({ state: 'passed' }),
  meta: () => ({ papercuspIsolatedRuntimeRunId: RUN_ID }),
};

describe('admin-test-runs-reporter without @papercusp/verification-harness', () => {
  it('still loads, and resolves no evidence root', async () => {
    const reporter = await import('./admin-test-runs-reporter.ts');
    const evidenceRoot = await reporter.loadEvidenceRootResolver();
    expect(evidenceRoot).toBeUndefined();
    expect(reporter.collectIsolatedRuntimeReceipts(
      { children: { allTests: () => [passedIsolatedCase] } } as never, evidenceRoot,
    )).toBeUndefined();
  });

  it('records an integration row without isolated-runtime receipts instead of failing', async () => {
    const { default: AdminTestRunsReporter } = await import('./admin-test-runs-reporter.ts');
    const rows: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }),
      async row => { rows.push(row); }, undefined, async () => null);
    await reporter.onInit({ config: { root: TEST_CONFIG_ROOT } } as never);
    reporter.onTestModuleEnd({
      state: () => 'passed',
      project: { config: { provide: { papercuspTestLayer: 'integration' } } },
      children: { allTests: () => [passedIsolatedCase] },
      moduleId: join(TEST_CONFIG_ROOT, 'src/admin-test-runs-reporter.optional-harness.test.ts'),
      diagnostic: () => ({ duration: 1 }), errors: () => [],
    } as never);
    await reporter.onTestRunEnd();
    expect(rows).toHaveLength(1);
    expect(rows[0].executionDetails).toBeTruthy();
    expect(rows[0].executionDetails?.isolatedRuntimeReceipts).toBeUndefined();
  });
});

describe('loadEvidenceRootResolver', () => {
  it('returns the package resolver when it loads, and undefined for a module without one', async () => {
    const { loadEvidenceRootResolver } = await import('./admin-test-runs-reporter.ts');
    const resolver = await loadEvidenceRootResolver(async () => ({ defaultEvidenceRoot: (h: unknown) => `/evidence/${String(h)}` }));
    expect(resolver?.('isolated-integration')).toBe('/evidence/isolated-integration');
    expect(await loadEvidenceRootResolver(async () => ({}))).toBeUndefined();
    expect(await loadEvidenceRootResolver(() => Promise.reject(new Error('boom')))).toBeUndefined();
  });
});
