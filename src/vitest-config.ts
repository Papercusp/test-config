// Vitest 4 no longer re-exports a plain `UserConfig` symbol from 'vitest/config' (TS2305) —
// it re-exports vite's own `UserConfig` (augmented in-module with the `test` field) under the
// alias `ViteUserConfig`. Import that under our existing local name so nothing else here changes.
import { defineConfig, type ViteUserConfig as UserConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { availableParallelism } from 'node:os';
// Node's native TypeScript config loader requires the real `.ts` runtime
// specifier; neither extensionless nor `.js` resolves here.
import { resolveLaneInclude, type TestLane } from './lane-split.ts';
// EI-20767792192323374: the TMPDIR policy (and the three incidents encoded in it) now lives in its
// own module so the TEST LAUNCHERS can apply it too — which is the only place it can actually
// relocate Vitest's module-cache root. See that file's header for the ordering bug; the call below
// is kept because it still governs every mkdtemp() a test performs at runtime.
import { ensurePapercuspTmpdir } from './tmpdir-guard.ts';

export type TestLayer = 'unit' | 'integration' | 'browser';

export interface DefineVitestConfigOptions {
  layer: TestLayer;
  setupFiles?: string[];
  globalSetup?: string[];
  include?: string[];
  exclude?: string[];
  /** Disable the default vitest-fail-on-console setup. Default: false. */
  allowConsoleNoise?: boolean;
  /**
   * OPT IN to the pure/stateful lane split (unit layer only). Default: false.
   *
   * Opting in changes NOTHING on its own — it only makes this workspace willing to honour
   * the `PC_TEST_LANE` env var. With the var unset (every ordinary run, and every re-run the
   * green-checkpoint gate performs) the config resolves exactly as it does today: the full
   * suite, isolated. See {@link resolveRequestedLane} for why both conditions are required.
   */
  laneSplit?: boolean;
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
// EI-19311807188719573: unit-layer-only rail forbidding a real Postgres connection.
// See the file's own doc comment for why it guards the consequence (a live pool) rather
// than the cause (an un-memoized dynamic import under concurrency).
const NO_REAL_PG_SETUP = resolve(__dirname, 'setup-no-real-pg.ts');
// EI-9990: bumps @testing-library/dom's waitFor/findBy* internal poll timeout
// for shared-box tolerance — a no-op for any package without
// @testing-library/dom on its graph. See the file's own doc comment.
const TESTING_LIBRARY_TIMEOUT_SETUP = resolve(__dirname, 'setup-testing-library-timeout.ts');
// WI-38215 / plan gate-suite-speedup-2026-08-12 D-014+D-016: attributes a leaked
// timer/listener/registry entry to the file that LEFT it, instead of to the file
// that happened to be running when it fired (which is what vitest reports, and it
// sends you to edit an innocent file). Observe-and-report only — it never fails a
// test; see the file's own doc comment for why, and for why it must be registered
// FIRST (outermost bracket, so sibling setups' create/release pairs cancel out).
const HANDLE_LEAK_SETUP = resolve(__dirname, 'setup-handle-leak-detector.ts');
// The monorepo root (libs/test-config/src → up 3 = repo root). Whitelisted in
// Vite's server.fs.allow below so a `vitest run --root <pkg>` invocation can
// still serve this hoisted setup file + other workspace deps. Without it, a
// jsdom/.tsx suite run with --root fails to LOAD with "Cannot find module
// /@fs/.../libs/test-config/src/setup-fail-on-console.ts" — a recurring
// invocation trap that records misleading red rows on the Tests tab even
// though the tests pass when run workspace-locally (2026-06-11).
const MONOREPO_ROOT = resolve(__dirname, '..', '..', '..');

// TMPDIR policy — moved to ./tmpdir-guard.ts (EI-20767792192323374), which carries the full
// rationale: the three incidents that pin the choice of `/tmp/pcv` (EI-5541 sun_path-108 +
// non-git-detection, 2026-06-30 in-repo TMPDIR stranding git-sync, EI-6063 exists≠writable), the
// stray-`/tmp/.git` scrub, and the shared-root clause.
//
// ⚠ THE COMMENT THAT USED TO LIVE HERE WAS FALSE, and it cost a gate-freezing incident. It claimed:
//   "This runs when vitest.config.ts is evaluated, BEFORE the Vitest instance is constructed
//    (which is when the nanoid subdir is first computed)"
// The opposite is true on Vitest 4. `createVitest()` does `new Vitest(...)` as its FIRST statement,
// and Vitest's `_tmpDir = join(tmpdir(), nanoid())` is a CLASS FIELD INITIALIZER evaluated right
// there; `createViteServer()` — which loads THIS file — runs ~12 lines later. So the call below
// CANNOT relocate vitest's module-cache root. That root landed at bare `/tmp/<nanoid>` in every
// workspace until the launchers started setting TMPDIR themselves (see tmpdir-guard.ts).
//
// The call is still correct and still needed: it governs every `mkdtemp()` a TEST performs at
// runtime, which happens long after config evaluation.
export { isWritableDir } from './tmpdir-guard.ts';
ensurePapercuspTmpdir();

// Custom reporter that writes one row per test FILE to harness_shared.test_runs —
// powers the /admin/testing status chips. AUTO-WIRED below so EVERY workspace using
// defineVitestConfig records (not just apps/operator). Self-contained + fail-soft
// (D-007): a missing DB / cold checkout never changes a test outcome. Opt-out via
// PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1 (the reporter's own test sets it).
const ADMIN_TEST_RUNS_REPORTER = resolve(__dirname, 'admin-test-runs-reporter.ts');
const adminReporter: string[] =
  process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1' ? [] : [ADMIN_TEST_RUNS_REPORTER];

// Public path constants, re-exported here (not just from the heavy `index.ts` barrel)
// so a vitest.config.ts that only needs `defineVitestConfig` + these two path strings
// can import from the LIGHTWEIGHT `@papercusp/test-config/vitest-config` subpath and
// never load msw/testcontainers/@nestjs-testing/drizzle at config-resolution time
// (EI-13226: that eager barrel import was the root cause of every vitest run in the
// monorepo — including ones with zero use for msw — printing Node's spurious
// `--localstorage-file` warning, because msw's cookieStore.mjs touches
// `globalThis.localStorage` at MODULE-SCOPE import time; see comment on the barrel
// re-export in index.ts). Kept in sync with index.ts's identically-named exports.
export const ADMIN_TEST_RUNS_REPORTER_PATH = ADMIN_TEST_RUNS_REPORTER;
export const BASELINE_SCHEMA_GLOBAL_SETUP_PATH = resolve(__dirname, 'baseline-schema-global-setup.ts');

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
      `The owning package's ${layer} config is ${config}; from the repository root (not the owning package cwd), run it through the repository test router:\n` +
      `  npm run test:file -- ${misrouted.join(' ')}\n` +
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

/**
 * Env var naming which lane to run. Honoured ONLY by a workspace that passed
 * `laneSplit: true` — see {@link resolveRequestedLane}.
 */
export const PC_TEST_LANE_ENV = 'PC_TEST_LANE';

/**
 * Default deadline for a unit test under the shared Papercusp Vitest contract.
 * Exported so the repository-root direct-file fallback can use the same value
 * instead of silently falling back to Vitest's 5-second default.
 */
export const DEFAULT_UNIT_TEST_TIMEOUT_MS = 60_000;

/**
 * An `include` entry that matches nothing, used when a lane is legitimately EMPTY.
 *
 * Passing `[]` instead would be a silent catastrophe: vitest treats an empty `include` as
 * "use the default include", i.e. the WHOLE suite — so an empty pure lane would run every
 * stateful file NON-ISOLATED, which is precisely the configuration D-006 measured as
 * unadoptable. A path that cannot exist is the honest encoding of "select nothing".
 */
const EMPTY_LANE_INCLUDE = '__pc-empty-lane__/matches-nothing.test.ts';

/**
 * Which lane (if any) this invocation should run.
 *
 * TWO conditions must BOTH hold — the workspace opted in AND the env var names a lane. That
 * conjunction is the whole safety story for the gate:
 *
 *   • `scripts/affected-tests.mjs` sets the env var for the two lane legs it runs;
 *   • the green-checkpoint's isolation + confirming co-execution re-runs go through
 *     `resolveWorkspaceTestInvocation` → `npm run test --workspace <ws> -- <files>`, which
 *     sets NO lane env — so those re-runs resolve the DEFAULT config and stay ISOLATED
 *     BY CONSTRUCTION, with no change to green-checkpoint.ts.
 *
 * That last point is what makes the split safe to adopt. D-009 established that a polluted
 * pure lane must not be able to reach the confirm path non-isolated (WI-6956 classifies
 * "passes alone, fails co-executed" as a REAL concurrency defect and holds the gate red),
 * and D-011 verified by experiment that a forced-isolate confirm keeps exactly that
 * detection power. Here the confirm pass is isolated because it never opts in, rather than
 * because something remembered to force a flag back on.
 *
 * An UNRECOGNISED value throws rather than falling back: a typo'd lane that silently ran the
 * whole suite twice would be a pure waste that looks like a success.
 */
function resolveRequestedLane(layer: TestLayer, laneSplit: boolean): TestLane | null {
  const raw = process.env[PC_TEST_LANE_ENV]?.trim();
  if (!raw) return null;
  // Not opted in ⇒ the env var is INERT here. Keeps a lane leg's inherited environment from
  // silently re-shaping an unrelated workspace's suite.
  if (!laneSplit) return null;
  if (layer !== 'unit') {
    throw new Error(
      `${PC_TEST_LANE_ENV}=${raw} was set for the '${layer}' layer, but the lane split is a UNIT-layer ` +
        `mechanism (it partitions files by module-registry use). Remove laneSplit from this config.`,
    );
  }
  if (raw !== 'pure' && raw !== 'stateful') {
    throw new Error(`${PC_TEST_LANE_ENV} must be 'pure' or 'stateful' (got '${raw}').`);
  }
  return raw;
}

export function defineVitestConfig(opts: DefineVitestConfigOptions): UserConfig {
  const {
    layer,
    setupFiles = [],
    globalSetup = [],
    include,
    exclude = [],
    allowConsoleNoise = false,
    laneSplit = false,
  } = opts;
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
  // EI-19311807188719573: the UNIT layer additionally forbids a real Postgres
  // connection. Unit-only — the integration layer legitimately builds real clients
  // against a testcontainer. Ordered FIRST so the rail is armed before any other
  // setup file can touch the db layer.
  const layerSetup = layer === 'unit' ? [NO_REAL_PG_SETUP] : [];
  // HANDLE_LEAK_SETUP sits immediately after layerSetup: NO_REAL_PG_SETUP keeps its
  // documented first position (it arms a rail at module-eval time, before anything
  // can touch the db layer), while the leak detector still brackets every REMAINING
  // setup's beforeAll/afterAll pair from the outside so those pairs cancel to zero
  // instead of reading as leaks (WI-38215).
  //
  // EXCLUDED FROM THE BROWSER LAYER, for two independent reasons: it imports node:fs
  // / node:os / node:path to write its artifact (unavailable in a real browser), and
  // its whole premise — resources surviving in a REUSED NODE WORKER — does not apply
  // to a browser context in the first place.
  const leakSetup = layer === 'browser' ? [] : [HANDLE_LEAK_SETUP];
  const finalSetup = allowConsoleNoise
    ? [...layerSetup, ...leakSetup, HERMETIC_ENV_SETUP, TESTING_LIBRARY_TIMEOUT_SETUP, ...setupFiles]
    : [
        ...layerSetup,
        ...leakSetup,
        HERMETIC_ENV_SETUP,
        FAIL_ON_CONSOLE_SETUP,
        TESTING_LIBRARY_TIMEOUT_SETUP,
        ...setupFiles,
      ];

  const layerInclude =
    include ??
    (layer === 'integration'
      ? ['**/*.integration.test.ts', '**/*.integration.test.tsx']
      : layer === 'browser'
      ? ['**/*.browser.test.ts', '**/*.browser.test.tsx']
      : ['**/*.test.ts', '**/*.test.tsx']);

  // ── PURE/STATEFUL LANE SPLIT (plan gate-suite-speedup-2026-08-12) ──────────────────────
  // The pure lane drops `isolate`, letting files SHARE a fork's module registry instead of
  // cold-transpiling the operator-core graph once per file (D-004/D-013: -83% accumulated
  // import). Global isolate:false is NOT adoptable (D-006) — only the files that never touch
  // the module registry are eligible, and that membership is decided per file in lane-split.ts.
  const lane = resolveRequestedLane(layer, laneSplit);
  let laneInclude: string[] | null = null;
  if (lane) {
    if (include) {
      // A caller-supplied include and a content-derived lane list are two different answers to
      // "which files run". Refuse rather than silently letting one win.
      throw new Error(
        `laneSplit cannot be combined with an explicit \`include\` — the lane list is derived from ` +
          `file CONTENTS and would silently override it.`,
      );
    }
    // The scan is rooted at the process cwd; `npm run test --workspace <ws>` runs there.
    const selection = resolveLaneInclude(process.cwd(), lane);
    if (selection.total === 0) {
      // FATAL, deliberately. The workspace test script carries --passWithNoTests, so a wrong
      // root would exit 0 and read as a green run of a suite that never executed — the exact
      // silent-zero that invalidated this plan's v1 measurement harness (D-012).
      throw new Error(
        `${PC_TEST_LANE_ENV}=${lane} found ZERO unit test files under ${process.cwd()}. ` +
          `Refusing to run: --passWithNoTests would turn that into a false green.`,
      );
    }
    laneInclude = selection.include;
    process.stderr.write(
      `[lane-split] lane=${lane} files=${laneInclude?.length ?? 0}/${selection.total} ` +
        `isolate=${lane === 'pure' ? 'false' : 'true'} root=${process.cwd()}\n`,
    );
  }

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
      // A lane run enumerates its files EXPLICITLY (content-derived membership); everything
      // else keeps the layer's globs, byte-for-byte as before.
      include: lane ? (laneInclude ?? [EMPTY_LANE_INCLUDE]) : layerInclude,
      // TOP-LEVEL `isolate` — `poolOptions.forks.isolate` was REMOVED in vitest 4 and is
      // ignored SILENTLY (D-029), which would make the split look like it does nothing.
      // Spread conditionally so a non-lane run's config is untouched, not merely undefined.
      ...(lane === 'pure' ? { isolate: false } : {}),
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
          ? Number(process.env.VITEST_UNIT_TIMEOUT_MS) || DEFAULT_UNIT_TEST_TIMEOUT_MS
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
      // EI-21863578695350444 (2026-08-30): `createOrgTestDb`/`getOrBuildTemplate`
      // (~230 *.integration.test.ts consumers) cache a fully-migrated schema in a
      // Postgres TEMPLATE db keyed by the migration-set content hash, so most
      // beforeAll calls just CLONE it (measured: device-store's 9-test suite,
      // clone path, 23.4s total). But that template is invalidated by EVERY new
      // migration (877 files today, growing continuously on this tree), and
      // exactly one process per fleet must then pay the FULL cold rebuild — ~877
      // sequential DDL round-trips against the ONE Postgres container `.withReuse()`d
      // by every concurrent vitest fork fleet-wide (WI-4133: "~30+ fleet agents at
      // once"; the SAME contention class WI-4133's max_connections=500 and
      // WI-5254/5256's widened recovery-mode retry already address for other
      // symptoms). That builder's cost is genuinely load-dependent and can exceed
      // even a generous fixed hookTimeout during a busy window — not a hang, not a
      // bug in the fixture. Same pattern as testTimeout's VITEST_UNIT_TIMEOUT_MS
      // above: keep dev/CI fast-failing by default, let the gate ask for more
      // headroom via env instead of everyone guessing a bigger constant.
      hookTimeout:
        layer === 'integration'
          ? Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 90_000
          : 60_000,
      setupFiles: finalSetup,
      globalSetup,
      reporters: process.env.CI
        ? [['default', { summary: false }], ['junit', { outputFile: './junit.xml' }], ...adminReporter]
        : ['default', ...adminReporter],
      // Per testing-spec §1.9: integration retry=0 (deterministic via testcontainers
      // per worker); unit retry=0; E2E (Playwright config) handles its own retries.
      retry: 0,
      // Coverage is TRACKED, not gated (testing-spec §1.13) — no thresholds here.
      // Inert unless `--coverage` is passed, so it never slows routine
      // `test:affected`. The block below is complete AND functional: verified
      // 2026-09-02 (P-007, design-to-code-coverage-seam-2026-09-02) by running
      // `npx vitest run --coverage src/mock-sql.test.ts` in this workspace,
      // which wrote ./coverage/{coverage-final.json,lcov.info,index.html}.
      //
      // WHERE THE REPORT LANDS, and who asks for it (P-009, decision D-028 —
      // both halves pinned by lib/doc-claims/coverage-wiring.test.ts):
      //   • `scripts/affected-tests.mjs --coverage` forwards the flag to every
      //     task whose script invokes vitest DIRECTLY (a composite script and a
      //     repo-wide lint guard are excluded, and the run prints a
      //     COVERAGE_PASSTHROUGH line naming what it skipped).
      //   • each instrumented workspace writes ./coverage/lcov.info, per
      //     `reportsDirectory` below — relative to the VITEST ROOT, so the `SF:`
      //     paths are workspace-relative and collide across workspaces until
      //     re-anchored.
      //   • `npm run coverage:merge` (scripts/merge-coverage.ts) re-anchors and
      //     merges them into one repo-root-relative coverage/lcov.info.
      //   • `npm run gate:patch-coverage` (scripts/patch-coverage.ts) judges the
      //     lines the current diff ADDS against that report.
      // Still inert unless someone passes the flag: no scheduled job instruments
      // by default, so an ordinary `test:affected` pays nothing for this block.
      // ⚠ Do NOT re-add a CI coverage-upload step without a producer in the same
      // change — that arrangement (each end documenting the other, nothing in the
      // middle) is the exact trap coverage-wiring.test.ts was written to catch.
      coverage: {
        provider: 'v8',
        reporter: ['text-summary', 'json', 'html', 'lcov'],
        reportsDirectory: './coverage',
        // `include` — WI-2142887. By DEFAULT v8 reports only the files a run actually
        // loaded, so a source file that no test imports gets NO lcov record at all,
        // and `scripts/patch-coverage.ts` must then answer `undetermined` (exit 2)
        // for it: resolving a missing record to 100% is the vacuous pass D-028 exists
        // to prevent, and resolving it to 0% would be a false RED for a file nothing
        // instruments. That is the honest answer to a question the report cannot
        // answer — but it is not a useful gate verdict, and it fires on exactly the
        // files a coverage gate most wants to judge. An explicit `include` retires the
        // question instead of answering it: every MATCHING file is instrumented, not
        // just the loaded ones, so a changed file with no test is reported at 0 hits
        // and the gate FAILS it honestly.
        //
        // ⛔ Do NOT "restore" a `coverage.all: true` beside this. `all` was REMOVED in
        // Vitest 4 (this repo is on 4.1.8) — `include` absorbed its job, per the
        // option's own doc comment: "List of files included in coverage as glob
        // patterns. By default only files covered by tests are included." Setting
        // `all` here is not merely redundant, it is an unknown key: it type-errors
        // (TS2769) and does nothing at runtime. It was written that way in the first
        // draft of this change and the identical 263-file result with and without it
        // is what proved `include` alone carries the behaviour.
        //
        // MEASURED 2026-09-03 on apps/operator-vite (a real product workspace, 187
        // tests / 263 source files), complete runs each side, same 7054 covered lines:
        //   no include → 175/263 files in lcov ⇒ 36.9% of the population UNJUDGEABLE
        //   include    → 263/263 files in lcov ⇒  0.0%  (all 97 converted, 0 junk swept)
        // Corroborates the 33.3% P-012 measured on libs/test-config; product code came
        // out slightly worse, so the ~1/3 figure is not a test-helper-lib artifact.
        //
        // ⚠ THE RUNTIME COST IS UNMEASURED — deliberately not quoted here. Four runs of
        // this same suite came in at 1m24.7s and 2m19.2s for the UNCHANGED baseline and
        // 1m48.5s / 1m58.5s with the include. The baseline moved more between two
        // identical runs (+64%) than the include moved from it, so on a box this heavily
        // shared the difference is not separable from load at n=1 — the tempting "+28%"
        // is noise, not a measurement. A real number needs repeated interleaved runs.
        // packages/operator-core is ~21x the files and infeasible to measure at all
        // (5354 test files), so its instrumented cost is likewise unknown.
        // What IS certain is the blast radius: this stays inert unless someone passes
        // `--coverage`, and no scheduled job does, so ordinary `test:affected` pays
        // nothing for any of it.
        //
        // One uniform rule, not a per-workspace source-root list: layouts genuinely
        // vary (`src/` in most, `lib/` in operator-core, `app/` in apps/operator,
        // `packages/`+`libs/`+`plugins/` in libs/papercusp) and a hand-maintained
        // registry of those roots is exactly the code-describing metadata that drifts.
        // Measured tree-wide, this include plus the excludes below sweeps in 0
        // unintended files in operator-core, operator-vite and libs/papercusp.
        include: ['**/*.{ts,tsx}'],
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
          // Build/tooling/story/example code — not product code. `all: true` is what
          // makes these visible at all (without it they were simply never loaded), so
          // they are excluded in the same change that introduces it: 78 files
          // tree-wide, 56 of them in apps/operator. This is what keeps `all: true`
          // from depressing the number with things nobody intends to test — the
          // specific cost WI-2142887 named as the reason to measure before changing.
          '**/bin/**',
          '**/scripts/**',
          '**/.storybook/**',
          '**/examples/**',
          '**/vitest-shims/**',
        ],
      },
    },
  });
}
