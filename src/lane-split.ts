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
 * THE FILTER. A file is STATEFUL if it manipulates state that survives a file boundary in a
 * reused fork: the module registry (`vi.mock`, `vi.doMock`, `vi.resetModules` plus their inverse
 * family), a module-global registry, `process.env`, or Vitest's process-global stubs. Those files
 * keep today's isolated behaviour, untouched. Everything else is PURE-lane eligible. On the falsification run behind
 * D-006, all 8 files that actually failed under `--no-isolate` were excluded by the original
 * module-registry filter (8/8). ⚠ That was a NECESSARY-not-sufficient filter with a clean record
 * on observed failures — NOT proof at scale: an accumulating module-level registry needs no
 * `vi.mock` to break, and a process-environment mutation needs no module-registry call at all.
 * The original residual rate was MEASURED at 4/2809 files = 0.14% (D-013), and every one of those
 * four was a real leak that the WI-38215 handle-leak detector named rather than absorbed (D-029)
 * — which is what unblocked this split.
 *
 * ⚠ THAT RESIDUAL THEN MATERIALISED — the paragraph above is kept verbatim because it called
 * the failure correctly, not because it is still the whole filter. Within minutes of the split
 * going live in the gate entrypoint, three files reddened the gate on module-global registry
 * state, none of them containing a `vi.mock`. A SECOND marker family — {@link STATEFUL_PATTERNS}
 * — now covers them, and the true structural residual measured 121/5891 files (2.1%), ~12× the
 * 0.14% above. The estimate was not wrong so much as differently-scoped: it counted files that
 * HAPPENED to fail one co-execution ordering, not files structurally able to.
 *
 * A THIRD residual then materialised in `design-phase-plugin-dsn.test.ts`: the non-isolated pure
 * lane read the native-PG fallback while an isolated fresh-process re-run on the SAME commit read
 * the discovery file correctly (twice, 66–72 seconds apart in the test-run ledger). The test
 * writes `HOME` and deletes/restores five PG-related environment keys. `process.env` belongs to
 * the reused fork, so even well-intentioned save/restore hooks cannot make a file structurally
 * independent of every co-resident file's setup/teardown. Environment writers therefore belong
 * in the isolated lane. Measured before adoption on operator-core: 162 of 2,730 then-pure files
 * move, leaving 2,568 files in the fast lane rather than trading gate correctness for that tail.
 *
 * A FOURTH residual then materialised in `cross-origin-url.test.ts`: its first test requires
 * `window` to be absent, while later tests call `vi.stubGlobal('window', ...)`. The pure lane ran
 * it after a co-resident file had left a window-shaped global behind, so destructuring
 * `window.location` failed; the same SHA passed 47.8 seconds later in an isolated process.
 * `vi.stubGlobal` mutates the reused fork's `globalThis` just as `vi.stubEnv` mutates its
 * `process.env`, and a local `unstub` hook cannot make the file independent of the state it
 * inherits before its first test. Vitest global-stub users therefore belong in the isolated lane.
 * Measured on operator-core at adoption: 19 of 2,567 then-pure files move, leaving 2,548 in the
 * fast lane.
 *
 * A FIFTH residual then materialised in `stop-fanout-installed.test.ts`: the test asserts a
 * module-global seam is empty, dynamically imports the operator barrel to install it, then
 * asserts the seam is populated. The pure lane ran it after a co-resident file had already
 * imported that barrel, so the BEFORE assertion observed the inherited executor; an isolated
 * run on the SAME SHA passed. An expectation-wrapped dynamic import is a narrow structural
 * signal that module evaluation itself is the subject of the test, so those files belong in
 * the isolated lane. This moves 4 of operator-core's 4,126 enrolled unit files, rather than
 * classifying all 838 tests that happen to use a dynamic import as stateful.
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

import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

/** The lanes. `null`/absent everywhere means "no split" — today's single isolated lane. */
export type TestLane = "pure" | "stateful";

/**
 * Module-registry manipulators. A file containing ANY of these is stateful.
 *
 * `mock`/`doMock`/`resetModules` are the three MEASURED in D-006's falsification run.
 * `unmock`/`doUnmock` are their inverses — same registry surface, and a file using one
 * without also using a forward form is vanishingly rare, so including them costs ~nothing
 * and closes the family properly rather than leaving a member out for sample-fidelity.
 */
export const STATEFUL_MARKERS = [
  "vi.mock(",
  "vi.doMock(",
  "vi.unmock(",
  "vi.doUnmock(",
  "vi.resetModules(",
  // Vitest's env stubs mutate the same process-wide object as a direct process.env write.
  "vi.stubEnv(",
  "vi.unstubAllEnvs(",
  // Vitest's global stubs mutate the reused fork's globalThis object. Even a file that cleans up
  // after each test can inherit a co-resident file's stale global BEFORE its first hook/test.
  "vi.stubGlobal(",
  "vi.unstubAllGlobals(",
  // Fake timers replace globalThis.setTimeout/setInterval/Date on the reused fork — the SAME
  // hazard as vi.stubGlobal directly above, and for the reason stated there: a co-resident file
  // can inherit a stale, FROZEN clock BEFORE its first hook or test runs, so cleaning up after
  // yourself does not protect you from the file that ran before you.
  //
  // This is not hypothetical. It held the gate red repeatedly on 2026-08-13 (candidate 65b3fbd1
  // and siblings) with a ROTATING cast of victims — which is the co-residency signature, since
  // which files share a fork varies with scheduling. Two shapes, both only explicable by a
  // frozen clock:
  //   • metrics.test.ts asserted `elapsed >= 15` after a real `setTimeout(20)` and measured 0.
  //     Under real timers that is impossible; contention makes elapsed LONGER, never zero.
  //   • boot-gate.test.ts / fleet-monitors.test.ts hung the full 180s on tests whose SUBJECT is
  //     "a deadline fires" — with the clock frozen it never does, so vitest's real timeout kills
  //     them. (Host load was ruled out: PSI cpu stall was ~1% on a 128-core box.)
  //
  // The handle-leak detector cannot close this gap — it installs its ledger over the REAL timer
  // API, so fake-timer calls bypass the wrapper entirely (see setup-handle-leak-detector.ts).
  // That makes the lane classifier the only place this can be caught.
  //
  // useRealTimers/setSystemTime are included to close the family, exactly as unmock/doUnmock and
  // unstubAllEnvs/unstubAllGlobals are above: a file that only ever RESTORES timers is still
  // announcing that it manipulates the fork-wide clock.
  "vi.useFakeTimers(",
  "vi.useRealTimers(",
  "vi.setSystemTime(",
] as const;

/**
 * Process-global STATE patterns — the remaining families, closing the gaps this file's header
 * predicted in prose: "an accumulating module-level registry needs no `vi.mock` to break" and
 * a process-environment mutation needs no module-registry call at all.
 *
 * That prediction came true on 2026-08-13, on three files at once, within minutes of the
 * split going live in the gate entrypoint:
 *
 *   • `authority-op-registry.test.ts` — `registerAuthorityOp: kind 'lock.acquire' already
 *     registered`. Its `_handlers` Map is module-scoped, so a CO-RESIDENT file that
 *     registered the same kind at import time makes this file's first registration throw.
 *   • `routine-classification.registry.test.ts` — a CENSUS over the live system-action
 *     registry ("imports the registry for its side effects ... enumerates it"), which sees
 *     whatever a co-resident file also registered.
 *
 * Neither contains a single `vi.mock`, so both were classified PURE and ran non-isolated.
 *
 * The two signals, chosen because they are properties of the TEST rather than of the
 * subject under test (so they need no import graph to evaluate):
 *
 *   1. A `__reset…()` call. The double-underscore prefix is this repo's convention for a
 *      TEST-ONLY escape hatch, and a test-only reset exists for exactly one reason: state
 *      that outlives a single test. Calling one is a file SAYING it depends on module-global
 *      state.
 *   2. A BARE side-effect import (`import 'x';`, no bindings). Importing purely for what a
 *      module does at load time is the definition of depending on module-load side effects
 *      — and under `isolate: false` a module is loaded ONCE PER FORK, so the second file to
 *      rely on it observes an already-populated registry, or never re-runs the effect.
 *
 * MEASURED before adoption (2026-08-13, 5,891 unit files): these two move 121 files
 * (2.1%) out of the pure lane, leaving it at 69.3% of the suite — the D-013 speed win is
 * preserved. They also catch all three files above. Note the residual they reveal is ~12×
 * D-013's estimate of 0.14%, because that estimate counted only files that HAPPENED to
 * fail one co-execution ordering, not files structurally able to.
 */
export const STATEFUL_PATTERNS = [
  /\b__reset[A-Za-z0-9_]*\s*\(/,
  // The older single-underscore convention is equally stateful. In particular,
  // `_resetPlanTemplateRegistryForTests()` clears a module-global Map shared by every
  // file in an `isolate:false` fork. Missing this spelling let one co-resident test
  // erase the built-in rubric registration underneath rubric-template.test.ts.
  /\b_reset[A-Za-z0-9_]*ForTests\s*\(/,
  // ⚠ The trailing-comment branch is LOAD-BEARING, not tidiness. The first version of this
  // pattern ended at `;?\s*$` and therefore missed
  //     import './reconcile-rule'; // registers plan-item-reconcile:done into the global engine
  // — a bare side-effect import whose OWN COMMENT states it populates a global registry. That
  // file then failed the very pure-lane validation run this marker was added to prevent. The
  // more self-documenting the import, the more likely it carries a trailing comment, so the
  // naive anchor systematically missed the clearest cases.
  /^\s*import\s+['"][^'"]+['"]\s*;?\s*(?:\/\/.*|\/\*.*)?$/m,
  // A dynamic import placed directly under an expectation is testing module evaluation itself
  // (usually a before/after installation or a bind-time failure). Under isolate:false that
  // module may already be cached by a co-resident file, so the expectation no longer exercises
  // the transition it claims to guard. Keep ordinary `const mod = await import(...)` callers in
  // the pure lane; this intentionally targets the narrow load-as-subject shape.
  /\bexpect\s*\(\s*import\s*\(/,
  // Direct env assignment. The bracket arm deliberately admits a dynamic key (`process.env[k]`)
  // as well as a string literal: both mutate the same fork-wide object. Equality reads (`===`,
  // `!==`) do not match. Compound/nullish/logical assignment and ++/-- do.
  /\bprocess\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]+\])\s*(?:\?\?=|\|\|=|&&=|[+\-*/%&|^]?=(?!=)|\+\+|--)/,
  // Deletion is the exact shape in design-phase-plugin-dsn.test.ts's save/scrub/restore hooks.
  /\bdelete\s+process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]+\])/,
  // Bulk mutation bypasses the property-assignment pattern but has identical shared-fork scope.
  /\b(?:Object\.assign|Reflect\.set)\s*\(\s*process\.env\b/,
] as const;

/**
 * Does this test file's SOURCE manipulate the module registry, process environment, or other
 * process-global state that survives a file boundary under `isolate: false`?
 *
 * Substring matching for {@link STATEFUL_MARKERS}, on purpose: it cannot be defeated by a
 * regex edge case. {@link STATEFUL_PATTERNS} needs real patterns (a bare import is a
 * SHAPE, not a fixed string), but each is written to over-match rather than under-match.
 * Every ambiguity resolves toward `true` (isolated), the safe direction.
 */
export function isStatefulTestSource(source: string): boolean {
  return (
    STATEFUL_MARKERS.some((marker) => source.includes(marker)) ||
    STATEFUL_PATTERNS.some((pattern) => pattern.test(source))
  );
}

/** Directory names never walked. Mirrors `baseExclude` in vitest-config.ts, plus build/caches. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".papercusp",
  "_retired",
  "coverage",
  ".vitest-tmp",
  ".git",
]);

/**
 * A UNIT test file: `*.test.ts(x)` but NOT the integration/browser layers.
 *
 * ⚠ THE EXTENSION SET MUST MATCH `layerInclude` IN vitest-config.ts, WHICH IS
 * `['**\/*.test.ts', '**\/*.test.tsx']` — TypeScript only.
 *
 * The lane split replaces a GLOB include with an EXPLICIT file list, so any file this
 * regex admits is handed to vitest directly. A regex WIDER than the glob therefore does
 * not just mis-label a file's lane — it ENROLLS a file the suite never ran. That is not
 * hypothetical: `[cm]?[jt]sx?` admitted `.test.js`, which pulled
 * `lib/pot-eval/fixtures/seed-app/test/baseline.test.js` — a `node:test` FIXTURE for the
 * pot-eval Hive, deliberately not a vitest suite — into the pure lane, where vitest
 * failed it with "No test suite found in file" on every gate run.
 *
 * So the narrow direction is the SAFE one here, which is the reverse of the
 * pure-vs-stateful judgement below: admitting too little only forgoes some speed, while
 * admitting too much reds the gate on a file that was never part of the suite.
 */
const UNIT_TEST_FILE = /\.test\.tsx?$/;
/** Kept deliberately WIDER than {@link UNIT_TEST_FILE}: this one only ever EXCLUDES. */
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
      if (isUnitTestFile(rel)) out.push(`./${rel.split(sep).join("/")}`);
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

export function classifyLanes(
  rootDir: string,
  files: readonly string[],
): LaneClassification {
  const pure: string[] = [];
  const stateful: string[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(rootDir, file), "utf8");
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
export function resolveLaneInclude(
  rootDir: string,
  lane: TestLane,
): LaneSelection {
  const all = listUnitTestFiles(rootDir);
  const { pure, stateful } = classifyLanes(rootDir, all);
  const selected = lane === "pure" ? pure : stateful;
  return { include: selected.length > 0 ? selected : null, total: all.length };
}
