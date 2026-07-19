// Lightweight `@papercusp/test-config/pg` subpath (EI-13226 follow-up).
//
// The full barrel (`index.ts` / `@papercusp/test-config`) statically re-exports
// `msw` (via `./msw.ts`), whose `cookieStore.mjs` touches `globalThis.localStorage`
// at MODULE-SCOPE import time — firing Node's spurious `Warning: --localstorage-file
// was provided without a valid path` on every process that imports the barrel, even
// when the caller only wants the Postgres test helpers (`getTestPg` / `withTestSchema`
// / `createFreshTestDb` / …) and has no use for msw at all. `vitest-config.ts` already
// got its own lightweight subpath for this reason; `.integration.test.ts` files across
// the repo import ONLY the PG helpers from the barrel, so they hit the same warning on
// every integration run. This subpath statically imports just `@testcontainers/
// postgresql` + `postgres` + node builtins — never msw/testcontainers-ryuk-adjacent
// heavy deps, @nestjs/testing, or drizzle-orm — so importing it alone never triggers
// the warning. See `vitest-config-lightweight-subpath.test.ts` for the regression guard
// (mirrors the same fresh-node-process check used for `./vitest-config.ts`).
//
// Prefer this subpath over the full barrel for any test that only needs PG helpers.
export { getTestPg, teardownTestPg, withTestSchema, TEST_PG_IMAGE } from './pg-container.ts';
export type { TestSchemaHandle } from './pg-container.ts';
export { createFreshTestDb, createMigratedTestDb, provisionRestartTestDb, getOrBuildTemplate } from './pg-migrate.ts';
export type { MigratedTestDb, CreateFreshTestDbOptions } from './pg-migrate.ts';
