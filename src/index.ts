import { fileURLToPath } from 'node:url';

export { defineVitestConfig, findMisroutedReproTests, MISROUTED_REPRO_TEST } from './vitest-config.ts';
export type { TestLayer, DefineVitestConfigOptions } from './vitest-config.ts';

/**
 * Absolute path to the shared integration-tier baseline-schema globalSetup
 * (stands up the full harness_shared schema once + exposes inject('baselineSchemaDsn')).
 * Pass to defineVitestConfig({ globalSetup: [BASELINE_SCHEMA_GLOBAL_SETUP_PATH] }).
 */
export const BASELINE_SCHEMA_GLOBAL_SETUP_PATH = fileURLToPath(
  new URL('./baseline-schema-global-setup.ts', import.meta.url),
);

/**
 * Absolute path to the admin test-runs reporter (writes one row per test FILE to
 * harness_shared.test_runs → the /admin/testing status chips). `defineVitestConfig`
 * AUTO-WIRES this; workspaces whose vitest config is hand-rolled (plain
 * `defineConfig`, not `defineVitestConfig`) opt in by appending it to their
 * `reporters`: `reporters: ['default', ADMIN_TEST_RUNS_REPORTER_PATH]`. Fail-soft —
 * a missing DB never changes a test outcome. Opt-out via
 * PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1 (then just pass `['default']`).
 */
export const ADMIN_TEST_RUNS_REPORTER_PATH = fileURLToPath(
  new URL('./admin-test-runs-reporter.ts', import.meta.url),
);

export { getTestPg, teardownTestPg, withTestSchema, TEST_PG_IMAGE } from './pg-container.ts';
export type { TestSchemaHandle } from './pg-container.ts';
export { createFreshTestDb, createMigratedTestDb, provisionRestartTestDb, getOrBuildTemplate } from './pg-migrate.ts';
export type { MigratedTestDb, CreateFreshTestDbOptions } from './pg-migrate.ts';
export { getTestRedis, teardownTestRedis } from './redis-container.ts';
export { getTestTypesense, teardownTestTypesense } from './typesense-container.ts';
export type { TestTypesense } from './typesense-container.ts';
export { setupMsw, msw } from './msw.ts';
export { makeFixture, makeFixtures, _resetFixtureCounters } from './make-fixture.ts';
export { resolveRepoFile, readRepoFile } from './repo-file.ts';
export { honoTestClient } from './hono-test-client.ts';
export type { HonoTestClient, HonoTestResponse, HonoTestClientOptions, RequestableApp } from './hono-test-client.ts';
// NOTE: bootNestTestApp is intentionally NOT re-exported here — import it from
// '@papercusp/test-config/nest' so projects without NestJS never load @nestjs/*.

// Type the value provided by the baseline-schema globalSetup so every consumer
// package (apps/operator, packages/operator-core, …) sees inject('baselineSchemaDsn')
// without importing the heavy globalSetup module itself. (Declaration-merges with
// the same augmentation in baseline-schema-global-setup.ts.)
declare module 'vitest' {
  interface ProvidedContext {
    baselineSchemaDsn: string;
  }
}
