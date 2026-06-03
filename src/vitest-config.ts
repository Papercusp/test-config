import { defineConfig, type UserConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type TestLayer = 'unit' | 'integration' | 'browser';

export interface DefineVitestConfigOptions {
  layer: TestLayer;
  setupFiles?: string[];
  globalSetup?: string[];
  include?: string[];
  exclude?: string[];
  /** Disable the default vitest-fail-on-console setup. Default: false. */
  allowConsoleNoise?: boolean;
}

const baseExclude = ['**/node_modules/**', '**/dist/**', '**/.next/**'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAIL_ON_CONSOLE_SETUP = resolve(__dirname, 'setup-fail-on-console.ts');

export function defineVitestConfig(opts: DefineVitestConfigOptions): UserConfig {
  const { layer, setupFiles = [], globalSetup = [], include, exclude = [], allowConsoleNoise = false } = opts;
  const finalSetup = allowConsoleNoise ? setupFiles : [FAIL_ON_CONSOLE_SETUP, ...setupFiles];

  const layerInclude =
    include ??
    (layer === 'integration'
      ? ['**/*.integration.test.ts', '**/*.integration.test.tsx']
      : layer === 'browser'
      ? ['**/*.browser.test.ts', '**/*.browser.test.tsx']
      : ['**/*.test.ts', '**/*.test.tsx']);

  return defineConfig({
    plugins: [tsconfigPaths({ ignoreConfigErrors: true })],
    test: {
      include: layerInclude,
      exclude: [
        ...baseExclude,
        ...exclude,
        ...(layer === 'unit'
          ? ['**/*.integration.test.*', '**/*.browser.test.*']
          : []),
      ],
      // Use process-forked workers (vitest's own default), NOT worker_threads,
      // for the unit + integration layers. The `threads` pool core-dumps
      // (SIGABRT / "Aborted (core dumped)", exit 134) non-deterministically
      // under Node ≥25 on this libuv/io_uring kernel — worker_threads share a
      // libuv loop that aborts mid-run. `forks` runs each file in its own child
      // process and is stable across Node versions, so the suite no longer
      // depends on which Node the runner's PATH happens to resolve. Browser
      // mode keeps its own pool semantics. See
      // docs/plans/test-affected-coredump-investigation-2026-06-01.md.
      pool: layer === 'browser' ? 'threads' : 'forks',
      // Integration tests share real PG schemas (e.g. harness_shared) — running
      // files in parallel races their `DROP SCHEMA CASCADE` teardown. Serialise.
      fileParallelism: layer === 'integration' ? false : undefined,
      // Unit timeout is 20s, not the vitest 5s default. Many unit tests
      // `vi.resetModules()` + `await import('@/lib/...')` per test, which
      // cold-imports the heavy operator module graph through the vite
      // transform pipeline. With `pool: 'forks'` and no shared transform
      // cache across forks, that first import legitimately costs several
      // seconds — and on the shared dev box (≥6 concurrent agents + dev
      // servers saturating CPU) it routinely exceeded 5s, producing
      // "Test timed out in 5000ms" on ~38 operator files that pass in
      // isolation. 20s gives cold-import headroom under load without
      // masking a genuine hang (integration is already 30s). Assertions
      // are unchanged — this is runner robustness, not test weakening.
      testTimeout: layer === 'unit' ? 20_000 : layer === 'integration' ? 30_000 : 60_000,
      hookTimeout: layer === 'integration' ? 60_000 : 20_000,
      setupFiles: finalSetup,
      globalSetup,
      reporters: process.env.CI
        ? [['default', { summary: false }], ['junit', { outputFile: './junit.xml' }]]
        : ['default'],
      // Per testing-spec §1.9: integration retry=0 (deterministic via testcontainers
      // per worker); unit retry=0; E2E (Playwright config) handles its own retries.
      retry: 0,
      // Coverage is TRACKED, not gated (testing-spec §1.13) — no thresholds here.
      // Inert unless `--coverage` is passed (e.g. the nightly full run), so this
      // never slows routine `test:affected`. Each workspace writes its own
      // ./coverage; the nightly job aggregates them into one report.
      coverage: {
        provider: 'v8',
        reporter: ['text-summary', 'json', 'html', 'lcov'],
        reportsDirectory: './coverage',
        exclude: [
          ...baseExclude,
          '**/*.test.*',
          '**/*.spec.*',
          '**/*.bench.*',
          '**/*.config.*',
          '**/*.d.ts',
          '**/test/**',
          '**/e2e/**',
          '**/__tests__/**',
          '**/__mocks__/**',
        ],
      },
    },
  });
}
