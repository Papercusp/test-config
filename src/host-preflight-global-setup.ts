/**
 * HOST PREFLIGHT — a generic, fail-closed "may this run start?" seam for the repository that
 * hosts a vitest run.
 *
 * test-config carries no host policy. A host repository that needs to veto a run (papercusp:
 * refusing to execute code a network-isolated session wrote — WI-10005724) ships a module at the
 * conventional path `scripts/lib/vitest-host-preflight.mjs`, exporting:
 *
 *   hostPreflight({ root, files, env }) →
 *     { verdict: 'admit', setEnv? } | { verdict: 'skipped', reason } | { verdict: 'refuse', message }
 *
 * WHERE IT RUNS. Vitest calls globalSetup after it has resolved the run's test files
 * (`vitest.state.getPaths()` is already populated by TestRun.start) and before the pool starts any
 * test, so a refusal here means no test file is imported, let alone executed. A globalSetup rather
 * than a reporter: a CLI `--reporter` REPLACES the configured reporters, so a reporter-based gate
 * would disappear under any `--reporter=verbose`; nothing on an ordinary command line replaces
 * globalSetup. It is the FIRST globalSetup, so a refusal also precedes container start-up.
 *
 * HOW THE HOST IS FOUND. Walk up from the project root to the first directory holding the
 * convention module: a papercusp workspace finds the papercusp checkout it lives in (the shared tree,
 * or the gate's isolated checkout), and a repository without the module runs no preflight at all.
 *
 * FAIL-CLOSED. A host module that does not export `hostPreflight`, throws, or returns an
 * unrecognised verdict aborts the run: an unreadable verdict must never read as an admit.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestProject } from 'vitest/node';

export const HOST_PREFLIGHT_MODULE = 'scripts/lib/vitest-host-preflight.mjs';

export type HostPreflightVerdict =
  | { verdict: 'admit'; setEnv?: Record<string, string> }
  | { verdict: 'skipped'; reason: string }
  | { verdict: 'refuse'; message: string };

export interface HostPreflightInput {
  root: string;
  files: string[];
  env: NodeJS.ProcessEnv;
}

export type HostPreflightOutcome = HostPreflightVerdict | { verdict: 'no-host-module' };

/** The nearest ancestor of `from` (inclusive) that holds the convention module, or null. */
export function findHostPreflightRoot(from: string, exists: (path: string) => boolean = existsSync): string | null {
  let dir = resolve(from);
  for (;;) {
    if (exists(join(dir, HOST_PREFLIGHT_MODULE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Locate, load and apply the host preflight. Throws (aborting the vitest run) on a refusal or on
 * any verdict it cannot read; on an admit it applies `setEnv` to `env` (vitest's main-process env,
 * which every worker and every process a test starts inherits).
 */
export async function runHostPreflight(opts: {
  projectRoot: string;
  files: string[];
  env: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  load?: (url: string) => Promise<unknown>;
}): Promise<HostPreflightOutcome> {
  const root = findHostPreflightRoot(opts.projectRoot, opts.exists);
  if (root === null) return { verdict: 'no-host-module' };
  const modulePath = join(root, HOST_PREFLIGHT_MODULE);
  const load = opts.load ?? ((url: string) => import(url));
  const mod = (await load(pathToFileURL(modulePath).href)) as { hostPreflight?: unknown };
  if (typeof mod?.hostPreflight !== 'function') {
    throw new Error(`HOST_PREFLIGHT_INVALID ${modulePath} does not export hostPreflight(); no test was started (fail closed)`);
  }
  const input: HostPreflightInput = { root, files: opts.files, env: opts.env };
  const result = (await (mod.hostPreflight as (input: HostPreflightInput) => unknown)(input)) as HostPreflightVerdict | null;
  switch (result?.verdict) {
    case 'refuse':
      throw new Error(typeof result.message === 'string' && result.message ? result.message : `HOST_PREFLIGHT_REFUSED ${modulePath}`);
    case 'admit':
      for (const [key, value] of Object.entries(result.setEnv ?? {})) opts.env[key] = value;
      return result;
    case 'skipped':
      return result;
    default:
      throw new Error(
        `HOST_PREFLIGHT_INVALID ${modulePath} returned an unrecognised verdict ${JSON.stringify(result)}; no test was started (fail closed)`,
      );
  }
}

export default async function setup(project: TestProject): Promise<void> {
  await runHostPreflight({ projectRoot: project.config.root, files: project.vitest.state.getPaths(), env: process.env });
}
