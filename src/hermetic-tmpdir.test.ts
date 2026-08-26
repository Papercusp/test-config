/**
 * Guards for the hermetic-scratch sweeper (WI-38830).
 *
 * The property under test is NOT "old dirs get deleted" — an age-only sweeper
 * satisfies that and is exactly the wrong thing to ship here, because a slow
 * integration run holds its dir for tens of minutes and an age-only rule would
 * delete it out from under a LIVE process. The property is:
 *
 *   a dir is removed when, and only when, its CREATOR IS GONE
 *   (with age as a guard on both sides: too-young is never touched, and
 *    absurdly-old is collected anyway so a recycled pid cannot pin a dir forever).
 *
 * `naiveAgeOnlySweep` below is a permanent CONTROL — the plausible-but-wrong
 * implementation this module exists to not be. It stays in the test file rather
 * than being spliced into the source, so proving falsifiability never mutates the
 * shared tree (see CLAUDE.md § "Proving a guard is falsifiable").
 */
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createHermeticDir,
  creatorIsAlive,
  GENERIC_SCRATCH_SWEEP_EXCLUDE,
  GENERIC_SCRATCH_SWEEP_MAX_AGE_MS,
  HERMETIC_SWEEP_MAX_AGE_MS,
  HERMETIC_SWEEP_MIN_AGE_MS,
  sweepAbandonedHermeticDirs,
  sweepStaleTestScratch,
} from "./hermetic-tmpdir.js";

let root: string;

/** A pid that cannot be running: the kernel never allocates 0 as a user pid. */
const DEAD_PID = 0;
const ALIVE_PID = process.pid;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hermetic-tmpdir-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Create `<pid>-<suffix>` under root, aged `ageMs` into the past. */
function seed(pid: number, suffix: string, ageMs: number): string {
  const path = join(root, `${pid}-${suffix}`);
  mkdirSync(path, { recursive: true });
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(path, when, when);
  return path;
}

/**
 * THE CONTROL — the implementation a reasonable person writes first, and the one
 * this module deliberately is not. If the real sweeper ever collapses into this,
 * the "keeps a live peer's dir" cases below go red.
 */
function naiveAgeOnlySweep(dir: string, olderThanMs: number): number {
  let removed = 0;
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (now - statSync(path).mtimeMs > olderThanMs) {
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

describe("creatorIsAlive", () => {
  it("reports our own pid as alive", () => {
    expect(creatorIsAlive(ALIVE_PID)).toBe(true);
  });

  it("reports a pid whose process is gone (ESRCH) as dead", () => {
    const esrch = Object.assign(new Error("no such process"), {
      code: "ESRCH",
    });
    expect(
      creatorIsAlive(123456, () => {
        throw esrch;
      }),
    ).toBe(false);
  });

  it("treats EPERM as ALIVE — the pid exists, it is just not ours", () => {
    // The safe direction: a dir we decline to reap is collected later by maxAge,
    // but a dir we reap early destroys a running process's state.
    const eperm = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
    });
    expect(
      creatorIsAlive(1, () => {
        throw eperm;
      }),
    ).toBe(true);
  });

  it("rejects a non-pid parsed out of a malformed dir name", () => {
    expect(creatorIsAlive(Number.NaN)).toBe(false);
    expect(creatorIsAlive(-1)).toBe(false);
  });
});

describe("sweepAbandonedHermeticDirs", () => {
  it("removes a dir whose creating process is gone", () => {
    const abandoned = seed(DEAD_PID, "aaaaaa", HERMETIC_SWEEP_MIN_AGE_MS * 2);
    const result = sweepAbandonedHermeticDirs(root);
    expect(result.removed).toBe(1);
    expect(existsSync(abandoned)).toBe(false);
  });

  it("KEEPS a dir whose creating process is still running", () => {
    // The load-bearing case. A long integration run holds its dir for tens of
    // minutes; reaping it is data loss inside a live test, not cleanup.
    const live = seed(ALIVE_PID, "bbbbbb", HERMETIC_SWEEP_MIN_AGE_MS * 2);
    const result = sweepAbandonedHermeticDirs(root);
    expect(result.removed).toBe(0);
    expect(result.keptAlive).toBe(1);
    expect(existsSync(live)).toBe(true);
  });

  it("CONTROL: an age-only sweeper deletes that same live dir", () => {
    // Calibrates the case above: it passes because of the liveness check, not
    // because the fixture happened to be un-deletable.
    const live = seed(ALIVE_PID, "bbbbbb", HERMETIC_SWEEP_MIN_AGE_MS * 2);
    expect(naiveAgeOnlySweep(root, HERMETIC_SWEEP_MIN_AGE_MS)).toBe(1);
    expect(existsSync(live)).toBe(false);
  });

  it("KEEPS a too-young dir even when its creator is already gone", () => {
    // Guards the mkdtemp/write race: a peer that has just created its dir must be
    // invisible to a concurrent sweeper.
    const fresh = seed(DEAD_PID, "cccccc", 1_000);
    const result = sweepAbandonedHermeticDirs(root);
    expect(result.removed).toBe(0);
    expect(result.keptYoung).toBe(1);
    expect(existsSync(fresh)).toBe(true);
  });

  it("reaps past maxAge even when the pid still looks alive (recycled-pid backstop)", () => {
    // This host wraps pids ~daily under fleet load, so a dead creator's pid can be
    // reassigned to a live process. Without this backstop such a dir is immortal.
    const ancient = seed(
      ALIVE_PID,
      "dddddd",
      HERMETIC_SWEEP_MAX_AGE_MS + 60_000,
    );
    const result = sweepAbandonedHermeticDirs(root);
    expect(result.removed).toBe(1);
    expect(existsSync(ancient)).toBe(false);
  });

  it("bounds work with scanCap so test startup cannot pay for a large backlog", () => {
    for (let i = 0; i < 10; i++)
      seed(DEAD_PID, `e${i}`, HERMETIC_SWEEP_MIN_AGE_MS * 2);
    const result = sweepAbandonedHermeticDirs(root, { scanCap: 3 });
    expect(result.scanned).toBe(3);
    expect(result.removed).toBe(3);
    expect(readdirSync(root)).toHaveLength(7);
  });

  it("reaps an entry whose name carries no parseable pid", () => {
    const junk = join(root, "not-a-pid-shaped-name");
    mkdirSync(junk);
    const when = (Date.now() - HERMETIC_SWEEP_MIN_AGE_MS * 2) / 1000;
    utimesSync(junk, when, when);
    expect(sweepAbandonedHermeticDirs(root).removed).toBe(1);
    expect(existsSync(junk)).toBe(false);
  });

  it("is a no-op on a root that does not exist, and never throws", () => {
    const missing = join(root, "nope", "still-nope");
    expect(() => sweepAbandonedHermeticDirs(missing)).not.toThrow();
    expect(sweepAbandonedHermeticDirs(missing)).toEqual({
      scanned: 0,
      removed: 0,
      keptAlive: 0,
      keptYoung: 0,
    });
  });

  it("survives an entry that vanishes between readdir and stat", () => {
    seed(DEAD_PID, "ffffff", HERMETIC_SWEEP_MIN_AGE_MS * 2);
    const racer = seed(DEAD_PID, "gggggg", HERMETIC_SWEEP_MIN_AGE_MS * 2);
    // A racing peer removes one entry after we have listed the directory.
    const isAlive = (pid: number) => {
      rmSync(racer, { recursive: true, force: true });
      return creatorIsAlive(pid);
    };
    expect(() => sweepAbandonedHermeticDirs(root, { isAlive })).not.toThrow();
    expect(readdirSync(root)).toHaveLength(0);
  });
});

/** Create `<name>` (no pid stamp) under root, aged `ageMs` into the past. */
function seedNamed(name: string, ageMs: number): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(path, when, when);
  return path;
}

describe("sweepStaleTestScratch", () => {
  // These dirs are NOT pid-stamped (17 real test files mint their own prefix
  // directly at the TMPDIR root — WI-38869), so every case here is a non-pid name.

  it("KEEPS a non-pid-named dir under the age threshold, however long it has run", () => {
    // The property this function exists to hold: sweepAbandonedHermeticDirs would
    // reap this the moment it crosses 60s (no parseable pid ⇒ not alive). A live
    // multi-minute test must not lose its scratch dir at the 1-minute mark.
    const live = seedNamed("some-test-abc123", HERMETIC_SWEEP_MIN_AGE_MS * 5);
    const result = sweepStaleTestScratch(root);
    expect(result.removed).toBe(0);
    expect(existsSync(live)).toBe(true);
  });

  it("reaps a non-pid-named dir once it is older than GENERIC_SCRATCH_SWEEP_MAX_AGE_MS", () => {
    const stale = seedNamed(
      "some-test-def456",
      GENERIC_SCRATCH_SWEEP_MAX_AGE_MS + 60_000,
    );
    const result = sweepStaleTestScratch(root);
    expect(result.removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
  });

  it("never removes a name in GENERIC_SCRATCH_SWEEP_EXCLUDE, however old", () => {
    // WI-41782: the affected-test log namespace owns its own child-retention
    // policy. If it falls out of this set, the broader /tmp/pcv sweep can remove
    // that entire namespace (and a still-needed full-run log) as one old entry.
    expect(GENERIC_SCRATCH_SWEEP_EXCLUDE).toContain("papercusp-affected-tests");
    for (const name of GENERIC_SCRATCH_SWEEP_EXCLUDE) {
      seedNamed(name, GENERIC_SCRATCH_SWEEP_MAX_AGE_MS * 10);
    }
    const result = sweepStaleTestScratch(root);
    expect(result.removed).toBe(0);
    for (const name of GENERIC_SCRATCH_SWEEP_EXCLUDE) {
      expect(existsSync(join(root, name))).toBe(true);
    }
  });

  it("is a no-op on a root that does not exist, and never throws", () => {
    const missing = join(root, "nope", "still-nope");
    expect(() => sweepStaleTestScratch(missing)).not.toThrow();
  });
});

/**
 * WI-41107: the scan window must ROTATE, or the sweeper is inert.
 *
 * Measured on the real /tmp/pcv: 31,096 entries, 26,051 of them past the 4h
 * threshold, and one faithful sweep pass removed ZERO — because the window always
 * started at readdir index 0, and freed slots at the front of readdir order are
 * immediately reused by the next mkdtemp. The front of the listing therefore
 * refills with fresh dirs as fast as the sweeper clears it, and the backlog behind
 * it is never reached. Every existing test above passes against that defect: none
 * of them overflows scanCap, so none can see it.
 */
describe("sweep window rotation (WI-41107)", () => {
  const CAP = 5;
  const FRESH_MS = HERMETIC_SWEEP_MIN_AGE_MS * 2;
  const STALE_MS = GENERIC_SCRATCH_SWEEP_MAX_AGE_MS + 60_000;

  /** Seed `count` dirs, then age the first `CAP` in READDIR ORDER fresh and the rest stale. */
  function seedFreshFrontStaleBacklog(count: number): void {
    for (let i = 0; i < count; i++) seedNamed(`rot-${i}`, 0);
    readdirSync(root).forEach((name, idx) => {
      const when = (Date.now() - (idx < CAP ? FRESH_MS : STALE_MS)) / 1000;
      utimesSync(join(root, name), when, when);
    });
  }

  it("CONTROL: pinned at index 0, a fresh readdir front hides the entire stale backlog", () => {
    // This is the shipped-but-inert behaviour, reproduced. It is what makes the
    // rotation test below a real guard rather than a restatement of "old dirs go".
    seedFreshFrontStaleBacklog(40);
    const result = sweepStaleTestScratch(root, { scanCap: CAP, startAt: 0 });
    expect(result.scanned).toBe(CAP);
    expect(result.removed).toBe(0);
    expect(readdirSync(root)).toHaveLength(40);
  });

  it("rotating the window reaches the backlog behind that same fresh front", () => {
    seedFreshFrontStaleBacklog(40);
    let removed = 0;
    // Bounded well above the ~7 passes needed to cover 35 stale entries 5 at a
    // time, so a slow-but-working rotation still finishes inside the loop.
    for (let i = 0; i < 200 && readdirSync(root).length > CAP; i++) {
      removed += sweepStaleTestScratch(root, { scanCap: CAP }).removed;
    }
    expect(removed).toBe(35);
    // Only the fresh front survives — nothing under the age threshold was reaped.
    expect(readdirSync(root)).toHaveLength(CAP);
  });

  it("still covers the whole directory in one pass when it fits inside scanCap", () => {
    // The wrap must not cost coverage on a small root — that is every other test
    // in this file, and it is why they keep passing with a random start index.
    for (let i = 0; i < 3; i++) seedNamed(`small-${i}`, STALE_MS);
    const result = sweepStaleTestScratch(root, { scanCap: CAP });
    expect(result.scanned).toBe(3);
    expect(result.removed).toBe(3);
    expect(readdirSync(root)).toHaveLength(0);
  });

  it("accepts a startAt beyond the entry count without skipping work", () => {
    // startAt is normalised modulo the entry count, so a stale caller index (or a
    // directory that shrank under a retry) can never silently scan nothing.
    for (let i = 0; i < 3; i++) seedNamed(`wrap-${i}`, STALE_MS);
    const result = sweepStaleTestScratch(root, { scanCap: CAP, startAt: 999 });
    expect(result.scanned).toBe(3);
    expect(result.removed).toBe(3);
  });

  /**
   * The floor the rotation fix exposed: /tmp/pcv drained to ~5,400 entries and then
   * stuck at 298 that ten full-cap sweeps removed zero of. All 298 were symlinks
   * whose targets this sweep had already deleted — `statSync` follows the link,
   * throws ENOENT, and takes the "a peer swept it first" branch forever.
   */
  it("reaps a stale DANGLING symlink instead of skipping it forever", () => {
    const target = seedNamed("lockdom-abc123", STALE_MS);
    const link = join(root, "lockdom-abc123-link");
    symlinkSync(target, link);
    // Exactly how these arise in the wild: an earlier pass removed the target.
    rmSync(target, { recursive: true, force: true });
    const when = (Date.now() - STALE_MS) / 1000;
    lutimesSync(link, when, when);

    // Precondition — the link is present but un-stat-able, which is the trap.
    expect(readdirSync(root)).toEqual(["lockdom-abc123-link"]);
    expect(() => statSync(link)).toThrow();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    expect(sweepStaleTestScratch(root, { scanCap: CAP }).removed).toBe(1);
    expect(readdirSync(root)).toHaveLength(0);
  });

  it("KEEPS a young dangling symlink — lstat must not turn into an age-blind delete", () => {
    const link = join(root, "lockdom-young-link");
    symlinkSync(join(root, "gone"), link);
    const when = (Date.now() - FRESH_MS) / 1000;
    lutimesSync(link, when, when);
    expect(sweepStaleTestScratch(root, { scanCap: CAP }).removed).toBe(0);
    expect(readdirSync(root)).toEqual(["lockdom-young-link"]);
  });

  it("is a no-op on an empty root — the rotation modulo cannot divide by zero", () => {
    expect(() => sweepStaleTestScratch(root, { scanCap: CAP })).not.toThrow();
    expect(sweepStaleTestScratch(root, { scanCap: CAP })).toEqual({
      scanned: 0,
      removed: 0,
      keptAlive: 0,
      keptYoung: 0,
    });
  });
});

describe("createHermeticDir", () => {
  it("creates the root, mints a pid-stamped dir, and sweeps abandoned siblings first", () => {
    const nested = join(root, "papercusp-voice-ipc-hermetic");
    mkdirSync(nested, { recursive: true });
    const stale = join(nested, `${DEAD_PID}-iiiiii`);
    mkdirSync(stale);
    const when = (Date.now() - HERMETIC_SWEEP_MIN_AGE_MS * 2) / 1000;
    utimesSync(stale, when, when);

    const mine = createHermeticDir(nested);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(mine)).toBe(true);
    // The pid stamp is what makes the sweep possible at all — without it there is
    // no way to ask whether the creator is still running.
    expect(mine.startsWith(join(nested, `${process.pid}-`))).toBe(true);
  });

  it("creates a root that does not exist yet", () => {
    const fresh = join(root, "deep", "not-created-yet");
    const mine = createHermeticDir(fresh);
    expect(existsSync(mine)).toBe(true);
  });

  it("gives two calls in the same process distinct dirs", () => {
    const a = createHermeticDir(join(root, "shared"));
    const b = createHermeticDir(join(root, "shared"));
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });
});
