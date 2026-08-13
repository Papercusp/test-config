/**
 * The pure/stateful unit-test LANE SPLIT — plan `gate-suite-speedup-2026-08-12`.
 *
 * WHY THIS EXISTS. Vitest's `isolate: true` (the default) TERMINATES the worker after every
 * test file (D-010), so every file cold-transpiles the operator-core module graph again. That
 * import work — not CPU — is what the gate's slowest leg is made of (D-004: the run is
 * transform-serialization-bound). Turning `isolate` off lets files SHARE a fork's module
 * registry and measured -83% accumulated import / -40.5% wall on this lane (D-013).
 *
 * WHY IT IS A SPLIT AND NOT A GLOBAL FLAG. Global `isolate: false` is NOT adoptable and must
 * never be set in the shared config (D-006, measured): at 40 files/fork it broke 8 of 40 files
 * (74 tests) — a module-level PG pool already initialised by an earlier file, leaked identity
 * context, registries accumulating across files, and `vi.fn()` mocks that cannot re-apply to an
 * already-loaded module. Those follow from isolate:false SEMANTICS, so they are not a bug list
 * that can be fixed file-by-file.
 *
 * THE FILTER. A file is STATEFUL if it manipulates the module registry — `vi.mock`, `vi.doMock`,
 * `vi.resetModules` (+ the `unmock` inverses, same family). Those files keep today's isolated
 * behaviour, untouched. Everything else is PURE-lane eligible. On the falsification run behind
 * D-006, all 8 files that actually failed under `--no-isolate` were excluded by this filter
 * (8/8). ⚠ That is a NECESSARY-not-sufficient filter with a clean record on observed failures —
 * NOT proof at scale: an accumulating module-level registry needs no `vi.mock` to break. The
 * residual rate was MEASURED at 4/2809 files = 0.14% (D-013), and every one of those four is a
 * real leak that the WI-38215 handle-leak detector now NAMES rather than absorbs (D-029) — which
 * is what unblocked this split.
 *
 * ERR TOWARD STATEFUL, ALWAYS. Misclassifying a stateful file as pure costs correctness (a
 * polluted co-execution the gate is designed to refuse — D-009); misclassifying a pure file as
 * stateful costs only some speed. So the matcher deliberately does NOT strip comments or
 * strings: a file that merely MENTIONS `vi.mock(` anywhere is treated as stateful.
 *
 * KNOWN LIMIT (documented, not defended): the marker is looked for in the test file's own
 * source, so a file whose `vi.mock` call lives in an imported helper reads as pure. This is
 * narrow in practice — `vi.mock` is hoisted per-FILE by the transform, so a helper-side call
 * does not hoist correctly and is already broken independently of this split.
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The lanes. `null`/absent everywhere means "no split" — today's single isolated lane. */
export type TestLane = 'pure' | 'stateful';

/**
 * Module-registry manipulators. A file containing ANY of these is stateful.
 *
 * `mock`/`doMock`/`resetModules` are the three MEASURED in D-006's falsification run.
 * `unmock`/`doUnmock` are their inverses — same registry surface, and a file using one
 * without also using a forward form is vanishingly rare, so including them costs ~nothing
 * and closes the family properly rather than leaving a member out for sample-fidelity.
 */
export const STATEFUL_MARKERS = [
  'vi.mock(',
  'vi.doMock(',
  'vi.unmock(',
  'vi.doUnmock(',
  'vi.resetModules(',
] as const;

/**
 * Does this test file's SOURCE manipulate the module registry?
 *
 * Substring matching, on purpose: it cannot be defeated by a regex edge case, and every
 * ambiguity resolves toward `true` (isolated), the safe direction.
 */
export function isStatefulTestSource(source: string): boolean {
  return STATEFUL_MARKERS.some((marker) => source.includes(marker));
}

/** Directory names never walked. Mirrors `baseExclude` in vitest-config.ts, plus build/caches. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.papercusp',
  '_retired',
  'coverage',
  '.vitest-tmp',
  '.git',
]);

/** A UNIT test file: `*.test.ts(x)` but NOT the integration/browser layers. */
const UNIT_TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const LAYERED_TEST_FILE = /\.(integration|browser)\.test\.[cm]?[jt]sx?$/;

export function isUnitTestFile(relPath: string): boolean {
  return UNIT_TEST_FILE.test(relPath) && !LAYERED_TEST_FILE.test(relPath);
}

/**
 * Every unit test file under `rootDir`, as paths RELATIVE to it with a leading `./`.
 *
 * Relative is load-bearing: vitest resolves `include` against the project root, and the
 * project root is the WORKSPACE dir (npm sets cwd there). Root-relative paths match zero
 * files from a workspace-scoped run — the trap D-013's harness hit and had to assert against.
 */
export function listUnitTestFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions, race with a concurrent rm) — never fatal to config load
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      // Resolve symlinked entries the same way vitest's glob does: follow to a file, skip a dir.
      if (entry.isSymbolicLink()) {
        try {
          if (statSync(full).isDirectory()) continue;
        } catch {
          continue; // dangling symlink
        }
      }
      const rel = relative(rootDir, full);
      if (isUnitTestFile(rel)) out.push(`./${rel.split(sep).join('/')}`);
    }
  };
  walk(rootDir);
  return out.sort();
}

/** The split of `files` (paths relative to `rootDir`) into the two lanes. */
export interface LaneClassification {
  pure: string[];
  stateful: string[];
  /** Files whose source could not be read; counted as STATEFUL (the safe direction). */
  unreadable: string[];
}

export function classifyLanes(rootDir: string, files: readonly string[]): LaneClassification {
  const pure: string[] = [];
  const stateful: string[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(rootDir, file), 'utf8');
    } catch {
      // Unreadable ⇒ unclassifiable ⇒ isolated. A file must never reach the pure lane by
      // accident: "we could not tell" and "it is pure" are different answers.
      unreadable.push(file);
      stateful.push(file);
      continue;
    }
    (isStatefulTestSource(source) ? stateful : pure).push(file);
  }
  return { pure, stateful, unreadable };
}

export interface LaneSelection {
  /**
   * EXPLICIT relative file paths for the lane — not globs, because lane membership is a
   * property of each file's CONTENTS, which no glob can express.
   *
   * ⚠ `null` when the requested lane is EMPTY. An empty `include` in vitest means "fall back
   * to the default include", i.e. THE WHOLE SUITE — so a lane that legitimately has no files
   * would silently run every file, and in the pure lane that means running the stateful files
   * NON-ISOLATED. Callers must treat `null` as "this lane selects nothing", never as `[]`.
   */
  include: string[] | null;
  /**
   * Total unit test files discovered under `rootDir`.
   *
   * A caller must treat `0` as FATAL, not as an empty lane: the scan is rooted at the
   * process cwd, so zero files means the root is wrong — and because the workspace test
   * script carries `--passWithNoTests`, a wrong root would otherwise exit 0 and read as a
   * green run of a suite that never executed. That silent-zero shape is the exact defect
   * that invalidated the v1 measurement harness on this plan (D-012).
   */
  total: number;
}

/** The `include` selection for one lane of `rootDir`'s unit suite. */
export function resolveLaneInclude(rootDir: string, lane: TestLane): LaneSelection {
  const all = listUnitTestFiles(rootDir);
  const { pure, stateful } = classifyLanes(rootDir, all);
  const selected = lane === 'pure' ? pure : stateful;
  return { include: selected.length > 0 ? selected : null, total: all.length };
}
