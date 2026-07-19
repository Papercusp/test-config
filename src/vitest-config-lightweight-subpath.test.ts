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
 * This test spawns a real child `node` process (a fresh V8/Node realm, so
 * nothing from THIS test file's own vitest process — which already imported
 * msw transitively elsewhere — can mask the check) that imports ONLY
 * `vitest-config.ts` and asserts the warning never fires. It also spawns one
 * importing the full barrel (`index.ts`) and asserts the warning DOES fire
 * there — proving the test would actually catch a regression (e.g. someone
 * re-adding a heavy re-export directly to vitest-config.ts) rather than
 * trivially passing regardless of what's imported.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCALSTORAGE_WARNING = /--localstorage-file/;

/** Import `repoRelPathFromThisDir` in a brand-new `node` process; return its stderr. */
function stderrFromFreshNodeImport(repoRelPathFromThisDir: string): string {
  const target = pathToFileURL(resolve(__dirname, repoRelPathFromThisDir)).href;
  const result = spawnSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(target)}).catch((e) => { console.error(e); process.exit(1); })`],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(`fresh-node import of ${repoRelPathFromThisDir} failed:\n${result.stderr}`);
  }
  return result.stderr ?? '';
}

describe('the lightweight @papercusp/test-config/vitest-config subpath never triggers the msw/localStorage warning (EI-13226)', () => {
  it('importing vitest-config.ts alone prints NO --localstorage-file warning', () => {
    const stderr = stderrFromFreshNodeImport('./vitest-config.ts');
    expect(stderr).not.toMatch(LOCALSTORAGE_WARNING);
  });

  it('control: importing the full barrel (index.ts) STILL prints the warning', () => {
    // Proves the check above is meaningful — it would fail if vitest-config.ts
    // regressed to (transitively) importing msw again.
    const stderr = stderrFromFreshNodeImport('./index.ts');
    expect(stderr).toMatch(LOCALSTORAGE_WARNING);
  });
});
