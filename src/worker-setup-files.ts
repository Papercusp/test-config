/**
 * The setup files vitest-config.ts hands to vitest as WORKER `setupFiles`. vitest runs these inside
 * each test worker, never in the main process, so the executed-source-map reporter records them
 * (and what they import) in every proof's executedModules: a change to one is a per-proof input.
 *
 * They live here, not inline in vitest-config.ts, so main-process-closure.ts can exclude exactly
 * these paths without loading vite: WORKER_SETUP_FILE_PATHS is built from the same constants the
 * config wires into setupFiles. A path added here that the config ALSO hands to `globalSetup` or
 * `reporters` would be unsound; main-process-closure.test.ts builds the real config and fails if
 * any of these appears there.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const FAIL_ON_CONSOLE_SETUP = resolve(__dirname, 'setup-fail-on-console.ts');
export const HERMETIC_ENV_SETUP = resolve(__dirname, 'setup-hermetic-env.ts');
// EI-19311807188719573: unit-layer-only rail forbidding a real Postgres connection.
// See the file's own doc comment for why it guards the consequence (a live pool) rather
// than the cause (an un-memoized dynamic import under concurrency).
export const NO_REAL_PG_SETUP = resolve(__dirname, 'setup-no-real-pg.ts');
// WI-10006585: integration-layer-only guard for the captured live database target.
export const NO_LIVE_PG_SETUP = resolve(__dirname, 'setup-no-live-pg.ts');
// EI-9990: bumps @testing-library/dom's waitFor/findBy* internal poll timeout
// for shared-box tolerance — a no-op for any package without
// @testing-library/dom on its graph. See the file's own doc comment.
export const TESTING_LIBRARY_TIMEOUT_SETUP = resolve(__dirname, 'setup-testing-library-timeout.ts');
// WI-38215 / plan gate-suite-speedup-2026-08-12 D-014+D-016: attributes a leaked
// timer/listener/registry entry to the file that LEFT it, instead of to the file
// that happened to be running when it fired (which is what vitest reports, and it
// sends you to edit an innocent file). Observe-and-report only — it never fails a
// test; see the file's own doc comment for why, and for why it must be registered
// FIRST (outermost bracket, so sibling setups' create/release pairs cancel out).
export const HANDLE_LEAK_SETUP = resolve(__dirname, 'setup-handle-leak-detector.ts');
// The worker half of executed-inputs capture (executedSourceMapConfig's setupFiles).
export const EXECUTED_INPUTS_CAPTURE_SETUP = resolve(__dirname, 'executed-inputs-capture-setup.ts');

/** Every absolute path above: what main-process-closure.ts may treat as worker-only. */
export const WORKER_SETUP_FILE_PATHS: readonly string[] = [
  FAIL_ON_CONSOLE_SETUP,
  HERMETIC_ENV_SETUP,
  NO_REAL_PG_SETUP,
  NO_LIVE_PG_SETUP,
  TESTING_LIBRARY_TIMEOUT_SETUP,
  HANDLE_LEAK_SETUP,
  EXECUTED_INPUTS_CAPTURE_SETUP,
];
