// ⚠ This barrel statically re-exports heavy node-only test infra (testcontainers,
// msw, @nestjs/testing, drizzle-orm). A Vite-side jsdom component test (e.g.
// apps/operator-vite) that imports ANYTHING from '@papercusp/test-config' pulls
// the WHOLE graph into esbuild's transform — which crashes outright with a
// misleading "TextEncoder invariant violation" error that looks like a broken
// Node/jsdom realm, not an import-weight problem (EI-8888). A new lightweight /
// browser-safe export (like ./nuqs-mock, ./nest) belongs behind its OWN
// package.json `exports` subpath, never added to this barrel's re-export list.
//
// `defineVitestConfig` + its path-constant siblings below are ALSO available
// (identical values) from the lightweight `./vitest-config` subpath
// (`@papercusp/test-config/vitest-config`), which does NOT statically import
// msw/testcontainers/@nestjs-testing/drizzle. Every vitest.config.ts that only
// needs config-building (the overwhelming majority) should import from THAT
// subpath, not this barrel — importing the barrel just to call
// `defineVitestConfig` was the root cause of EI-13226 (msw's cookieStore.mjs
// touches `globalThis.localStorage` at module-scope import time, which fires
// Node's spurious `--localstorage-file` warning on every such vitest run).

export {
  defineVitestConfig,
  sharedHostWorkerCap,
  findMisroutedReproTests,
  MISROUTED_REPRO_TEST,
  // Re-exported from vitest-config.ts (single source of truth) so the barrel
  // stays backward-compatible for existing consumers of these two constants.
  ADMIN_TEST_RUNS_REPORTER_PATH,
  BASELINE_SCHEMA_GLOBAL_SETUP_PATH,
} from './vitest-config.ts';
export type { TestLayer, DefineVitestConfigOptions } from './vitest-config.ts';

// getTestPg/withTestSchema/createFreshTestDb/… (re-exported below, identical values) are
// ALSO available from the lightweight `@papercusp/test-config/pg` subpath, which does NOT
// statically import msw — a `.integration.test.ts` that only needs PG helpers should import
// from THAT subpath, not this barrel, to avoid Node's spurious `--localstorage-file` warning
// (EI-13226 follow-up; see the doc comment on `pg.ts`).
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
// NOTE: nuqsParsers/createNuqsMock are intentionally NOT re-exported here either —
// import from '@papercusp/test-config/nuqs-mock'. This barrel statically re-exports
// testcontainers/msw/@nestjs-testing/drizzle, which a Vite/jsdom component-test build
// (apps/operator-vite) has no business transforming; importing the full barrel from
// a component test crashed esbuild outright (EI-8821 follow-up) rather than merely
// bloating the bundle.

// Type the value provided by the baseline-schema globalSetup so every consumer
// package (apps/operator, packages/operator-core, …) sees inject('baselineSchemaDsn')
// without importing the heavy globalSetup module itself. (Declaration-merges with
// the same augmentation in baseline-schema-global-setup.ts.)
declare module 'vitest' {
  interface ProvidedContext {
    baselineSchemaDsn: string;
  }
}
