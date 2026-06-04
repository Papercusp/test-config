import { fileURLToPath } from 'node:url';

export { defineVitestConfig } from './vitest-config.ts';
export type { TestLayer, DefineVitestConfigOptions } from './vitest-config.ts';

/**
 * Absolute path to the shared integration-tier baseline-schema globalSetup
 * (stands up the full harness_shared schema once + exposes inject('baselineSchemaDsn')).
 * Pass to defineVitestConfig({ globalSetup: [BASELINE_SCHEMA_GLOBAL_SETUP_PATH] }).
 */
export const BASELINE_SCHEMA_GLOBAL_SETUP_PATH = fileURLToPath(
  new URL('./baseline-schema-global-setup.ts', import.meta.url),
);

export { getTestPg, teardownTestPg, withTestSchema } from './pg-container.ts';
export type { TestSchemaHandle } from './pg-container.ts';
export { createFreshTestDb, createMigratedTestDb, provisionRestartTestDb } from './pg-migrate.ts';
export type { MigratedTestDb, CreateFreshTestDbOptions } from './pg-migrate.ts';
export { getTestRedis, teardownTestRedis } from './redis-container.ts';
export { getTestTypesense, teardownTestTypesense } from './typesense-container.ts';
export type { TestTypesense } from './typesense-container.ts';
export { setupMsw, msw } from './msw.ts';
export { makeFixture, makeFixtures, _resetFixtureCounters } from './make-fixture.ts';
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
