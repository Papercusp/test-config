/**
 * vitest-config-lightweight-subpath.test.ts — regression guard for EI-13226.
 *
 * Root cause: `@papercusp/test-config`'s barrel (`index.ts`) statically
 * re-exports heavy node-only test infra, INCLUDING `msw` (via `./msw.ts`).
 * `msw`'s `cookieStore.mjs` instantiates a module-scope `CookieStore` that
 * touches `globalThis.localStorage` at IMPORT time — which, in a plain Node
 * context (no jsdom yet), invokes Node's own lazy `localStorage` getter and
 * fires `Warning: --localstorage-file was provided without a valid path` on
 * EVERY vitest run in the monorepo, because every vitest.config.ts that
 * called `defineVitestConfig` imported it from the barrel (`@papercusp/test-
 * config`), pulling in msw whether or not the workspace has any use for it.
 *
 * The fix: `defineVitestConfig` + its path-constant siblings are ALSO
 * available from the lightweight `@papercusp/test-config/vitest-config`
 * subpath (package.json `exports`), which statically imports only
 * `vitest/config` + `vite-tsconfig-paths` + node builtins — never msw,
 * testcontainers, @nestjs/testing, or drizzle-orm. Every vitest.config.ts in
 * the repo was repointed at that subpath (EI-13226).
 *
 * Follow-up (same EI-13226): `.integration.test.ts` files that only need the
 * PG helpers (`getTestPg` / `withTestSchema` / `createFreshTestDb` / …) hit
 * the identical warning by importing those from the barrel too — the barrel
 * import alone pulls in msw regardless of which named export is used. Those
 * helpers are ALSO available from the lightweight `@papercusp/test-config/pg`
 * subpath (`pg.ts`), which statically imports only `@testcontainers/postgresql`
 * + `postgres` + node builtins — never msw. apps/operator's integration tests
 * were repointed at that subpath.
 *
 * This test spawns a real child `node` process (a fresh V8/Node realm, so
 * nothing from THIS test file's own vitest process — which already imported
 * msw transitively elsewhere — can mask the check). The child instruments the
 * global `localStorage` getter and counts accesses while importing ONLY
 * `vitest-config.ts`, `pg.ts`, or the full barrel. Counting the side effect is
 * deterministic across Node versions; asserting Node's warning text was not,
 * because some Node builds expose localStorage without printing the warning.
 * The full barrel remains the positive control that proves this test would
 * catch a lightweight subpath regressing back to the heavy msw graph.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Import a module in a fresh Node realm and count module-scope localStorage reads. */
function localStorageAccessCountFromFreshNodeImport(repoRelPathFromThisDir: string): number {
  const target = pathToFileURL(resolve(__dirname, repoRelPathFromThisDir)).href;
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `let accesses = 0;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  get() { accesses += 1; return undefined; },
});
import(${JSON.stringify(target)})
  .then(() => process.stdout.write('__LOCALSTORAGE_ACCESSES__=' + accesses))
  .catch((e) => { console.error(e); process.exit(1); });`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(`fresh-node import of ${repoRelPathFromThisDir} failed:\n${result.stderr}`);
  }
  const marker = /__LOCALSTORAGE_ACCESSES__=(\d+)/.exec(result.stdout ?? '');
  if (!marker) {
    throw new Error(`fresh-node import of ${repoRelPathFromThisDir} returned no access marker:\n${result.stdout}`);
  }
  return Number(marker[1]);
}

describe('the lightweight @papercusp/test-config/vitest-config subpath never triggers the msw/localStorage warning (EI-13226)', () => {
  it('importing vitest-config.ts alone never touches localStorage', () => {
    expect(localStorageAccessCountFromFreshNodeImport('./vitest-config.ts')).toBe(0);
  });

  it('control: importing the full barrel (index.ts) still touches localStorage', () => {
    // Proves the check above is meaningful — it would fail if vitest-config.ts
    // regressed to (transitively) importing msw again.
    expect(localStorageAccessCountFromFreshNodeImport('./index.ts')).toBeGreaterThan(0);
  });

  it('importing pg.ts alone never touches localStorage', () => {
    expect(localStorageAccessCountFromFreshNodeImport('./pg.ts')).toBe(0);
  });
});
