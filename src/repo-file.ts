/**
 * repo-file.ts — resolve a repo-relative file from a test at ANY nesting depth
 * (DG-6 hermeticity, cross-machine-coord-parity-and-trust-2026-07-01 P-049).
 *
 * THE PROBLEM THIS KILLS: five integration suites (iq-battery corpus/collectors/
 * beekeeper-gen0, hive-eval store-pg/trend-read) each hand-rolled a
 * read-the-migration-DDL helper as a list of guessed `../../..` candidates with
 * a HARDCODED dev-box absolute path (`/home/marsh-office/papercupai-workspace/…`)
 * as the last resort — one of them even pointing at a path that does not exist
 * on the dev box either. Any machine whose checkout lives elsewhere (the whole
 * point of the distributed test gate: run a shard from `(stagingSha, shard)`
 * anywhere) silently leaned on relative-guess luck.
 *
 * THE FIX: walk UP from the caller's directory until `<dir>/<repoRelPath>`
 * exists. Depth-proof (src vs dist, any package nesting), machine-proof (no
 * absolute paths), submodule-proof (keeps walking past nested package roots
 * since it probes for the TARGET path, not for a root marker).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Resolve `repoRelPath` (e.g. `libs/papercusp/libs/db/sql/179-….sql`) by
 * walking up from `startDir` (pass `__dirname` / a file's dir). Throws with a
 * actionable message when no ancestor holds it — a missing input must be LOUD
 * in a gate context, never a silent fallback.
 */
export function resolveRepoFile(startDir: string, repoRelPath: string): string {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, repoRelPath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `resolveRepoFile: no ancestor of ${startDir} contains ${repoRelPath} — ` +
          `is this test running inside a repo checkout?`,
      );
    }
    dir = parent;
  }
}

/** Convenience: resolve + read UTF-8 (the migration-DDL case). */
export function readRepoFile(startDir: string, repoRelPath: string): string {
  return readFileSync(resolveRepoFile(startDir, repoRelPath), 'utf8');
}
