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
const HERMETIC_ENV_SETUP = resolve(__dirname, 'setup-hermetic-env.ts');
// The monorepo root (libs/test-config/src → up 3 = repo root). Whitelisted in
// Vite's server.fs.allow below so a `vitest run --root <pkg>` invocation can
// still serve this hoisted setup file + other workspace deps. Without it, a
// jsdom/.tsx suite run with --root fails to LOAD with "Cannot find module
// /@fs/.../libs/test-config/src/setup-fail-on-console.ts" — a recurring
// invocation trap that records misleading red rows on the Tests tab even
// though the tests pass when run workspace-locally (2026-06-11).
const MONOREPO_ROOT = resolve(__dirname, '..', '..', '..');
// Custom reporter that writes one row per test FILE to harness_shared.test_runs —
// powers the /admin/testing status chips. AUTO-WIRED below so EVERY workspace using
// defineVitestConfig records (not just apps/operator). Self-contained + fail-soft
// (D-007): a missing DB / cold checkout never changes a test outcome. Opt-out via
// PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1 (the reporter's own test sets it).
const ADMIN_TEST_RUNS_REPORTER = resolve(__dirname, 'admin-test-runs-reporter.ts');
const adminReporter: string[] =
  process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1' ? [] : [ADMIN_TEST_RUNS_REPORTER];

// A positional file filter naming an *.integration.test.* / *.browser.test.*
// file. Under the unit layer these are *excluded* (see the exclude globs
// below), so `vitest run path/to/foo.integration.test.ts` matches the unit
// `include` then gets filtered back out — vitest prints the cryptic
// "No test files found" + exits 1, with no hint that the file IS a test that
// just needs the other config. Detect that exact case and fail with the cure.
const LAYERED_TEST_FILE = /\.(integration|browser)\.test\.[cm]?[jt]sx?$/;

function guardLayeredTestPathUnderUnit(): void {
  // argv after the runner script: `vitest run <…filters/flags…>`. A filter is
  // any non-flag token; we only care about ones that name a layered test file.
  const misrouted = process.argv
    .slice(2)
    .filter((a) => !a.startsWith('-') && LAYERED_TEST_FILE.test(a));
  if (misrouted.length === 0) return;
  const layer = misrouted.some((a) => /\.browser\.test\./.test(a)) ? 'browser' : 'integration';
  const config = layer === 'browser' ? 'vitest.browser.config.ts' : 'vitest.integration.config.ts';
  const article = layer === 'integration' ? 'an' : 'a';
  throw new Error(
    `vitest: ${misrouted.join(', ')} is ${article} ${layer} test, which the default (unit) config excludes — ` +
      `running it by path here matches "No test files found".\n` +
      `Run it with the ${layer} config instead:\n` +
      `  npx vitest run --config ${config} ${misrouted.join(' ')}\n` +
      `(or \`npm run test:affected:integration\` to let the walker route it).`,
  );
}

export function defineVitestConfig(opts: DefineVitestConfigOptions): UserConfig {
  const { layer, setupFiles = [], globalSetup = [], include, exclude = [], allowConsoleNoise = false } = opts;
  // Turn the silent "No test files found" footgun into an actionable error when
  // an integration/browser test is run by path under the unit config.
  if (layer === 'unit') guardLayeredTestPathUnderUnit();
  const finalSetup = allowConsoleNoise
    ? [HERMETIC_ENV_SETUP, ...setupFiles]
    : [HERMETIC_ENV_SETUP, FAIL_ON_CONSOLE_SETUP, ...setupFiles];

  const layerInclude =
    include ??
    (layer === 'integration'
      ? ['**/*.integration.test.ts', '**/*.integration.test.tsx']
      : layer === 'browser'
      ? ['**/*.browser.test.ts', '**/*.browser.test.tsx']
      : ['**/*.test.ts', '**/*.test.tsx']);

  return defineConfig({
    plugins: [tsconfigPaths({ ignoreConfigErrors: true })],
    // fs.allow only WIDENS what the transform server may read — adding the
    // monorepo root never breaks a workspace-local run, it just makes a
    // `--root <pkg>` invocation able to serve the hoisted setup file + deps
    // instead of dying on a /@fs/ allow-list miss (see MONOREPO_ROOT above).
    server: { fs: { allow: [MONOREPO_ROOT] } },
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
      // EI-2590: ACTUALLY apply the worker cap the green-checkpoint sets. It
      // exports VITEST_MAX_FORKS/THREADS=8 to bound concurrency when the gate
      // shares the box with the live fleet (buildGreenCheckpointEnv) — but until
      // now NOTHING read those vars, so the gate ran at vitest's DEFAULT pool size
      // (≈ host cores − 1, ~127 on the 128-core dev box). ~127 forks all funnel
      // their cold SRC transforms through the SINGLE main-process transform server,
      // which serializes them — that, not raw CPU, is the real cause of the 74-97s
      // "heavy await import()" timeouts the 180s VITEST_UNIT_TIMEOUT_MS band-aid
      // masks (and a ~60GB peak-RSS OOM risk: 127 forks × ~500MB). Reading the env
      // here realizes the checkpoint's documented intent. Vitest 4 dropped the old
      // `poolOptions.forks.maxForks`; the unified knob is `maxWorkers`. The forks
      // pool (unit/integration) reads VITEST_MAX_FORKS, the threads pool (browser)
      // VITEST_MAX_THREADS. UNSET (dev/CI) ⇒ key omitted ⇒ vitest's default uncapped
      // parallelism, so local runs are unchanged. Tunable per-run via the env vars.
      ...(() => {
        const cap =
          Number(layer === 'browser' ? process.env.VITEST_MAX_THREADS : process.env.VITEST_MAX_FORKS) || 0;
        // MUST pair minWorkers with maxWorkers. The repo ROOT still runs vitest
        // 2.1.9 (`npm test`), whose resolveConfig defaults minThreads/minForks to
        // the HOST CORE COUNT when minWorkers is unset
        // (`minThreads = poolOptions.minForks ?? config.minWorkers ?? threadsCount`).
        // On the 128-core dev box that makes minThreads≈128 while maxWorkers=8, so
        // Tinypool throws `options.minThreads and options.maxThreads must not
        // conflict` at pool creation — the suite collects ZERO tests and the
        // green-checkpoint gate goes permanently red. Pinning minWorkers:1 yields a
        // valid 1..cap pool under BOTH v2.1.9 (root) and v4 (nested workspaces).
        return cap > 0 ? { maxWorkers: cap, minWorkers: 1 } : {};
      })(),
      // Unit timeout is 20s, not the vitest 5s default. Many unit tests
      // `vi.resetModules()` + `await import('@/lib/...')` per test, which
      // cold-imports the heavy operator module graph through the vite
      // transform pipeline. With `pool: 'forks'` and no shared transform
      // cache across forks, that first import legitimately costs several
      // seconds — and on the shared dev box (≥6 concurrent agents + dev
      // servers saturating CPU) it routinely exceeded 5s, producing
      // "Test timed out in 5000ms" on ~38 operator files that pass in
      // isolation. 20s gave cold-import headroom — until 2026-06-07, when
      // the green-checkpoint went red twice purely on 20_000ms timeouts
      // (61 tests across 50 files, ALL ~20s, ALL passing in isolation) with
      // the box at load ~135 (full fleet + Hetzner e2e churn). Same failure
      // mode, next rung: 60s unit / 90s integration. A genuine hang still
      // fails, just slower; the GATE must measure correctness, not box
      // weather. Assertions are unchanged — runner robustness, not test
      // weakening.
      //
      // 2026-06-22: SAME failure mode recurred — the green-checkpoint went red on
      // ~9 operator-core files (create-*, hive/guard, coord-program-workflow.smoke,
      // endpoint routes, generate-blueprint) ALL timing out at 60s, ALL passing in
      // 3-5s in isolation. Root cause: those tests do `await import()` of the
      // heaviest operator-core graphs (transpiled from SRC, no build), and under the
      // gate's 8 concurrent vitest forks the shared transform serializes — a single
      // cold heavy import measured 74-97s (coord-program-workflow's bare import = 80s)
      // even with the box only ~15% loaded. Rather than bump the global unit timeout
      // (dev wants fast-failing hangs), the unit timeout is env-overridable: the
      // green-checkpoint sets VITEST_UNIT_TIMEOUT_MS=180000 (buildGreenCheckpointEnv),
      // everything else keeps 60s. A genuine hang still fails (just slower) ONLY in
      // the gate; correctness over box weather, as before.
      testTimeout:
        layer === 'unit'
          ? Number(process.env.VITEST_UNIT_TIMEOUT_MS) || 60_000
          : layer === 'integration'
            ? 90_000
            : 120_000,
      hookTimeout: layer === 'integration' ? 90_000 : 60_000,
      setupFiles: finalSetup,
      globalSetup,
      reporters: process.env.CI
        ? [['default', { summary: false }], ['junit', { outputFile: './junit.xml' }], ...adminReporter]
        : ['default', ...adminReporter],
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
