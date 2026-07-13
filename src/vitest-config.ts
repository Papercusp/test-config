import { defineConfig, type UserConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';

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

// EI-7787/WI-3199: `.papercusp/**` is the agent scratch/tmp/log/state tree
// (canary reports, worker logs, tmp-* vitest sandboxes, test-data-generator
// fixture droppings, ...), and `_retired/**` is preserved history. Neither is
// package source or a real test suite. A broad default-include vitest run
// (`**/*.test.ts` with no narrower `include`) previously glob-matched stray
// fixture files left under `.papercusp` and archived tests under `_retired`,
// recording false red rows unrelated to the package actually under test.
// Exclude both trees so ANY package's default run is immune.
const baseExclude = ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.papercusp/**', '**/_retired/**'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAIL_ON_CONSOLE_SETUP = resolve(__dirname, 'setup-fail-on-console.ts');
const HERMETIC_ENV_SETUP = resolve(__dirname, 'setup-hermetic-env.ts');
// EI-9990: bumps @testing-library/dom's waitFor/findBy* internal poll timeout
// for shared-box tolerance — a no-op for any package without
// @testing-library/dom on its graph. See the file's own doc comment.
const TESTING_LIBRARY_TIMEOUT_SETUP = resolve(__dirname, 'setup-testing-library-timeout.ts');
// The monorepo root (libs/test-config/src → up 3 = repo root). Whitelisted in
// Vite's server.fs.allow below so a `vitest run --root <pkg>` invocation can
// still serve this hoisted setup file + other workspace deps. Without it, a
// jsdom/.tsx suite run with --root fails to LOAD with "Cannot find module
// /@fs/.../libs/test-config/src/setup-fail-on-console.ts" — a recurring
// invocation trap that records misleading red rows on the Tests tab even
// though the tests pass when run workspace-locally (2026-06-11).
const MONOREPO_ROOT = resolve(__dirname, '..', '..', '..');

// Ensure Vitest's internal tmpDir (join(os.tmpdir(), nanoid())) lands in a
// writable directory. On this dev box TMPDIR=/tmp/claude is set but does not
// exist / cannot be created (sandboxed /tmp), so Vitest's ModuleFetcher fails
// to mkdir the 'ssr' subdir before any test file loads (ENOENT). Override
// TMPDIR — but it MUST be SHORT and OUTSIDE the repo. The previous in-repo
// <root>/.vitest-tmp broke two whole test classes and red-pinned the gate
// (gate-greening 2026-06-30 / EI-5541):
//   (1) Unix-domain socket paths under it exceeded the 108-char sun_path limit
//       → `listen EINVAL` for the IPC e2e + wake-executor/wake-resume tests;
//   (2) temp dirs created under it have a .git ancestor (the repo), so the
//       "non-git dir" detection tests (detectPapercupRoot, lockDomainForProjectDir,
//       readCloneDefaultBranch, realGitCommit) wrongly resolved the repo.
// A short /tmp dir (/tmp/pcv) is writable on this box, ~8 chars (socket paths stay
// ~55 chars), and has NO repo-root marker ancestor (.git / package.json) up to / —
// so it fixes both classes at the source WITHOUT tripping findRepoRoot's marker walk
// (a home-rooted dir does trip it, since $HOME carries workspace markers).
// This runs when vitest.config.ts is evaluated, BEFORE the Vitest instance is
// constructed (which is when the nanoid subdir is first computed), so the
// override takes effect for every subsequent tmpdir() call in that process.
/** True if `dir` (or any ancestor up to /) holds a repo-root marker (.git / package.json) — i.e.
 *  TMPDIR points INSIDE a repo. This is the 2026-06-30 root cause of silent git-sync stranding:
 *  when TMPDIR is in-repo, tests that `mkdtemp` a scratch git repo (lockdom-*, flg-repo-*,
 *  realGitCommit, green-checkpoint) leave EMBEDDED repos (a nested .git) in the working tree; a
 *  no-commit one makes `git add -A` FATAL (exit 128) → git-sync stages nothing → the WHOLE tree
 *  strands uncommitted for hours. Forcing TMPDIR out to /tmp keeps those scratch repos out of the
 *  tree entirely (and also fixes the sun_path-108 socket + non-git-detection classes noted above).
 *  Previously the override only fired when TMPDIR was unset/missing — so anything that SET it to an
 *  in-repo path that existed slipped through. */
function tmpdirIsInsideRepo(dir: string): boolean {
  let p = resolve(dir);
  for (;;) {
    if (existsSync(resolve(p, '.git')) || existsSync(resolve(p, 'package.json'))) return true;
    const parent = dirname(p);
    if (parent === p) return false; // reached the filesystem root
    p = parent;
  }
}
{
  const cur = process.env.TMPDIR;
  const needsOverride = !cur || !existsSync(cur) || tmpdirIsInsideRepo(cur);
  if (needsOverride) {
    const shortTmp = '/tmp/pcv';
    mkdirSync(shortTmp, { recursive: true });
    process.env.TMPDIR = shortTmp;
  }
}

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

// ---------------------------------------------------------------------------
// Recurrence guard for the `.repro.test.ts` deploy-gate footgun (WI-1091 / WI-1053).
//
// A `*.repro.test.ts` reproduces an UNFIXED bug and fails BY DESIGN. Named as a
// plain unit `*.test.ts` it lands in the unit suite the green-checkpoint gates
// on, so those fail-by-design tests red-gated EVERY fleet deploy for ~73h
// (WI-1053). `guardLayeredTestPathUnderUnit` above only catches the REVERSE
// direction (a correctly-named integration test run by path under the unit
// config). The naming contract for the direction that actually bit us: a repro
// test MUST be `*.repro.integration.test.ts` (kept OUT of the deploy gate).
//
// `MISROUTED_REPRO_TEST` matches `.repro.test.<ext>` but NOT the correct
// `.repro.integration.test.<ext>` (which has `.integration.` before `.test.`).
// The operator-core meta-test `repro-test-naming-guard.test.ts` scans the repo
// with `findMisroutedReproTests` and fails loudly if any misrouted repro test
// reappears — turning a silent deploy-gate red into an actionable unit failure.
export const MISROUTED_REPRO_TEST = /\.repro\.test\.[cm]?[jt]sx?$/;

/** Return the subset of `files` that are repro tests misrouted into the unit
 *  layer (`*.repro.test.ts` instead of `*.repro.integration.test.ts`), sorted. */
export function findMisroutedReproTests(files: readonly string[]): string[] {
  return files.filter((f) => MISROUTED_REPRO_TEST.test(f)).sort();
}

/**
 * The shared-host vitest worker cap (WI-4300) — the `{ maxWorkers, minWorkers }`
 * fragment EVERY vitest config on this box must spread into its `test` block, whether
 * or not it goes through {@link defineVitestConfig} (the reporter-only bypass configs
 * spread it directly).
 *
 * Resolution (per pool: forks reads VITEST_MAX_FORKS, threads VITEST_MAX_THREADS):
 *   • env set to a positive number → that cap (the green-checkpoint's 8 / the affected
 *     gate's 32 keep working unchanged);
 *   • env EXPLICITLY '0' → uncapped (the deliberate escape hatch for a dedicated host);
 *   • env absent or garbage → min(32, max(8, cores/4)) — on a shared box, "unset" must
 *     NEVER mean uncapped: vitest's default pool is ≈ host cores − 1 (~127 forks on the
 *     128-core dev box), and with ~59 live agent sessions concurrent suites are routine
 *     (observed: 5 overlapping uncapped runs ≈ 635 runnable tasks, load1 227; this class
 *     melted the box to load 1000–3000 twice the week of 2026-07-06). Per EI-2590, ~127
 *     forks also serialize on the single transform server, so the cap is typically
 *     FASTER even for a solo run.
 *
 * minWorkers is pinned to 1 alongside any cap: the repo ROOT still runs vitest 2.1.9
 * (`npm test`), whose resolveConfig defaults minForks to the HOST CORE COUNT when
 * minWorkers is unset — 128 min vs a smaller max makes Tinypool throw
 * `options.minThreads and options.maxThreads must not conflict` at pool creation, the
 * suite collects ZERO tests, and the green-checkpoint gate goes permanently red.
 * Pinning minWorkers:1 yields a valid 1..cap pool under BOTH v2.1.9 and v4.
 */
export function sharedHostWorkerCap(pool: 'forks' | 'threads' = 'forks'): {
  maxWorkers?: number;
  minWorkers?: number;
} {
  const raw = pool === 'threads' ? process.env.VITEST_MAX_THREADS : process.env.VITEST_MAX_FORKS;
  const hostSaneCap = Math.min(32, Math.max(8, Math.floor(availableParallelism() / 4)));
  const cap =
    raw === undefined || raw.trim() === ''
      ? hostSaneCap // absent ⇒ host-sane default (WI-4300)
      : raw.trim() === '0'
        ? 0 // explicit 0 ⇒ deliberate uncapped escape hatch
        : Number(raw) > 0
          ? Number(raw)
          : hostSaneCap; // garbage ⇒ safe default, never uncapped
  return cap > 0 ? { maxWorkers: cap, minWorkers: 1 } : {};
}

export function defineVitestConfig(opts: DefineVitestConfigOptions): UserConfig {
  const { layer, setupFiles = [], globalSetup = [], include, exclude = [], allowConsoleNoise = false } = opts;
  // Turn the silent "No test files found" footgun into an actionable error when
  // an integration/browser test is run by path under the unit config.
  if (layer === 'unit') guardLayeredTestPathUnderUnit();
  // EI-6802: on the shared dev box, Docker can leave testcontainers-ryuk
  // containers stuck in Created; subsequent testcontainers sessions then hang
  // before setup reaches user code. Integration helpers use reusable containers
  // and explicit per-test DB/schema cleanup, so default the integration layer to
  // the proven no-Ryuk path while still honoring an explicit caller override.
  if (layer === 'integration' && process.env.TESTCONTAINERS_RYUK_DISABLED == null) {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  }
  const finalSetup = allowConsoleNoise
    ? [HERMETIC_ENV_SETUP, TESTING_LIBRARY_TIMEOUT_SETUP, ...setupFiles]
    : [HERMETIC_ENV_SETUP, FAIL_ON_CONSOLE_SETUP, TESTING_LIBRARY_TIMEOUT_SETUP, ...setupFiles];

  const layerInclude =
    include ??
    (layer === 'integration'
      ? ['**/*.integration.test.ts', '**/*.integration.test.tsx']
      : layer === 'browser'
      ? ['**/*.browser.test.ts', '**/*.browser.test.tsx']
      : ['**/*.test.ts', '**/*.test.tsx']);

  return defineConfig({
    plugins: [tsconfigPaths({ ignoreConfigErrors: true })],
    // Use a project-local Vite cache dir instead of os.tmpdir() (which is
    // TMPDIR=/tmp/claude on this dev box — a read-only path that doesn't
    // exist, causing every vitest run to ENOENT on the ssr/ sub-directory
    // before any test file can load). A local path is also faster (same FS)
    // and survives TMPDIR being absent or readonly.
    cacheDir: '.vitest-tmp',
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
      // EI-2590 + WI-4300: the shared-host worker cap — env wins (the checkpoint's 8
      // / the affected gate's 32), explicit '0' = uncapped escape hatch, ABSENT ⇒ a
      // host-sane default (unset must never mean ~127 forks on the shared box). Full
      // history + semantics on {@link sharedHostWorkerCap} above.
      ...sharedHostWorkerCap(layer === 'browser' ? 'threads' : 'forks'),
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
      // WI-1544 (2026-07-02): ignore ONE benign infra race, nothing else. Under a
      // full parallel run (~2.4k files, forks pool) a worker whose tests ALL passed
      // can emit a final console line while its rpc channel is closing; vitest
      // surfaces that as an unhandled `EnvironmentTeardownError: Closing rpc while
      // "onUserConsoleLog" was pending` attributed to whichever file the worker ran,
      // and the whole run exits 1 with 25k tests green. Not reproducible in
      // isolation (load-dependent), carries no assertion signal — a lost console
      // line at worst. Every other unhandled error still fails the run.
      onUnhandledError: (error) => {
        if (
          error?.name === 'EnvironmentTeardownError' &&
          /Closing rpc while "onUserConsoleLog" was pending/.test(String(error?.message))
        ) {
          return false; // the one benign race above — swallow it, nothing else.
        }
        // EI-10766: every OTHER unhandled error still FAILS the run (return undefined below),
        // but vitest attributes it to whichever test the worker was running — a test whose
        // assertions all passed — so the reader hunts the bug in the wrong place. The WI-4499
        // EPIPE cost ~a day exactly this way. Make the class loud AT THE POINT OF FAILURE.
        // Purely additive: does not change the verdict, only prints a signpost. See fact
        // a-failure-that-fails-no-assertion-2026-07-12.
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        // eslint-disable-next-line no-console
        console.error(
          '\n⚠⚠ UNHANDLED ERROR failed this test file — NOT an assertion.\n' +
            `   name=${error?.name ?? '(unknown)'} code=${code ?? '(none)'}\n` +
            `   message=${String(error?.message ?? error).slice(0, 300)}\n` +
            '   Every `expect` in this file may have PASSED. Look for an unhandled async/stream\n' +
            '   error (EPIPE/ECONNRESET/unhandledRejection/child stdin), not a bad assertion.\n' +
            '   (test-config onUnhandledError · fact a-failure-that-fails-no-assertion-2026-07-12)\n',
        );
        return undefined; // still fail the run — diagnosability, not suppression.
      },
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
