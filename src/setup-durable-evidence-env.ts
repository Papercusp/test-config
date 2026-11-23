/**
 * Worker setup: withhold the runner's durable-evidence env from every test FILE, then restore it.
 * Why these keys must not reach code under test: durable-evidence-env.ts (WI-6554700010069310).
 *
 * Why hooks instead of the module-level `delete` that setup-hermetic-env.ts uses: the worker half
 * of the executed-source-map capture (executed-inputs-capture-setup.ts) is an EARLIER setup file
 * and reads PC_EXECUTED_SOURCE_MAP_OUT when each file's setup is evaluated, and vitest's forks pool
 * reuses the worker for later files. A permanent delete would silently drop module capture for
 * every later file in the worker. Timing per file:
 *  - setup files and the test file's module body are evaluated first (the capture reads the env);
 *  - this beforeAll runs before any of the file's own hooks and tests;
 *  - this afterAll runs before the capture's afterAll (vitest's default `sequence.hooks: 'stack'`
 *    runs after-hooks in reverse registration order) and restores the runner's values.
 * The main-process reporters never see this worker's env, so they are untouched.
 *
 * A test that exercises the contract sets or stubs the keys in its own hooks, which run after this
 * beforeAll. Code a test file runs at module top level is not covered.
 */
import { afterAll, beforeAll } from 'vitest';
import { withholdDurableEvidenceEnv } from './durable-evidence-env.js';

let restore: (() => void) | undefined;

beforeAll(() => {
  restore = withholdDurableEvidenceEnv(process.env);
});

afterAll(() => {
  restore?.();
  restore = undefined;
});
