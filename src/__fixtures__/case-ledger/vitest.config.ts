import { defineVitestConfig } from '../../vitest-config.ts';

// Fixture config for test-case-runs.integration.test.ts (test-rubric-unification-2026-10-12
// P-001). defineVitestConfig wires the AdminTestRunsReporter exactly as every workspace gets
// it; the parent test points the reporter at a fresh Postgres through PAPERCUSP_TEST_RUNS_DB_URL
// and reads back the test_runs row and the per-case test_case_runs rows this run produced.
export default defineVitestConfig({
  layer: 'unit',
  include: ['cases.case-fixture.ts'],
});
