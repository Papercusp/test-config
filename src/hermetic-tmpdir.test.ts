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
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createHermeticDir,
  creatorIsAlive,
  HERMETIC_SWEEP_MAX_AGE_MS,
  HERMETIC_SWEEP_MIN_AGE_MS,
  sweepAbandonedHermeticDirs,
} from './hermetic-tmpdir.js';

let root: string;

/** A pid that cannot be running: the kernel never allocates 0 as a user pid. */
const DEAD_PID = 0;
const ALIVE_PID = process.pid;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hermetic-tmpdir-test-'));
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

describe('creatorIsAlive', () => {
  it('reports our own pid as alive', () => {
    expect(creatorIsAlive(ALIVE_PID)).toBe(true);
  });

  it('reports a pid whose process is gone (ESRCH) as dead', () => {
    const esrch = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    expect(
      creatorIsAlive(123456, () => {
        throw esrch;
      }),
    ).toBe(false);
  });

  it('treats EPERM as ALIVE — the pid exists, it is just not ours', () => {
    // The safe direction: a dir we decline to reap is collected later by maxAge,
    // but a dir we reap early destroys a running process's state.
    const eperm = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    expect(
      creatorIsAlive(1, () => {
        throw eperm;
      }),
    ).toBe(true);
  });

  it('rejects a non-pid parsed out of a malformed dir name', () => {
    expect(creatorIsAlive(Number.NaN)).toBe(false);
    expect(creatorIsAlive(-1)).toBe(false);
  });
});

describe('sweepAbandonedHermeticDirs', () => {
  it('removes a dir whose creating process is gone', () => {
    const abandoned = seed(DEAD_PID, 'aaaaaa', HERMETIC_SWEEP_MIN_AGE_MS * 2);
    const result = sweepAbandonedHermeticDirs(root);
    expect(result.removed).toBe(1);
    expect(existsSync(abandoned)).toBe(false);
  });

  it('KEEPS a dir whose creating process is still running', () => {
    // The load-bearing case. A long integration run holds its dir for tens of
    // minutes; reaping it is data loss inside a live test, not cleanup.
    const live = seed(ALIVE_PID, 'bbbbbb', HERMETIC_SWEEP_MIN_AGE_MS * 2);
    const result = sweepAbandonedHermeticDirs(root);
    expect(result.removed).toBe(0);
    expect(result.keptAlive).toBe(1);
    expect(existsSync(live)).toBe(true);
  });

  it('CONTROL: an age-only sweeper deletes that same live dir', () => {
    // Calibrates the case above: it passes because of the liveness check, not
    // because the fixture happened to be un-deletable.
    const live = seed(ALIVE_PID, 'bbbbbb', HERMETIC_SWEEP_MIN_AGE_MS * 2);
    expect(naiveAgeOnlySweep(root, HERMETIC_SWEEP_MIN_AGE_MS)).toBe(1);
    expect(existsSync(live)).toBe(false);
  });

  it('KEEPS a too-young dir even when its creator is already gone', () => {
    // Guards the mkdtemp/write race: a peer that has just created its dir must be
    // invisible to a concurrent sweeper.
    const fresh = seed(DEAD_PID, 'cccccc', 1_000);
    const result = sweepAbandonedHermeticDirs(root);
    expect(result.removed).toBe(0);
    expect(result.keptYoung).toBe(1);
    expect(existsSync(fresh)).toBe(true);
  });

  it('reaps past maxAge even when the pid still looks alive (recycled-pid backstop)', () => {
    // This host wraps pids ~daily under fleet load, so a dead creator's pid can be
    // reassigned to a live process. Without this backstop such a dir is immortal.
    const ancient = seed(ALIVE_PID, 'dddddd', HERMETIC_SWEEP_MAX_AGE_MS + 60_000);
    const result = sweepAbandonedHermeticDirs(root);
    expect(result.removed).toBe(1);
    expect(existsSync(ancient)).toBe(false);
  });

  it('bounds work with scanCap so test startup cannot pay for a large backlog', () => {
    for (let i = 0; i < 10; i++) seed(DEAD_PID, `e${i}`, HERMETIC_SWEEP_MIN_AGE_MS * 2);
    const result = sweepAbandonedHermeticDirs(root, { scanCap: 3 });
    expect(result.scanned).toBe(3);
    expect(result.removed).toBe(3);
    expect(readdirSync(root)).toHaveLength(7);
  });

  it('reaps an entry whose name carries no parseable pid', () => {
    const junk = join(root, 'not-a-pid-shaped-name');
    mkdirSync(junk);
    const when = (Date.now() - HERMETIC_SWEEP_MIN_AGE_MS * 2) / 1000;
    utimesSync(junk, when, when);
    expect(sweepAbandonedHermeticDirs(root).removed).toBe(1);
    expect(existsSync(junk)).toBe(false);
  });

  it('is a no-op on a root that does not exist, and never throws', () => {
    const missing = join(root, 'nope', 'still-nope');
    expect(() => sweepAbandonedHermeticDirs(missing)).not.toThrow();
    expect(sweepAbandonedHermeticDirs(missing)).toEqual({
      scanned: 0,
      removed: 0,
      keptAlive: 0,
      keptYoung: 0,
    });
  });

  it('survives an entry that vanishes between readdir and stat', () => {
    seed(DEAD_PID, 'ffffff', HERMETIC_SWEEP_MIN_AGE_MS * 2);
    const racer = seed(DEAD_PID, 'gggggg', HERMETIC_SWEEP_MIN_AGE_MS * 2);
    // A racing peer removes one entry after we have listed the directory.
    const isAlive = (pid: number) => {
      rmSync(racer, { recursive: true, force: true });
      return creatorIsAlive(pid);
    };
    expect(() => sweepAbandonedHermeticDirs(root, { isAlive })).not.toThrow();
    expect(readdirSync(root)).toHaveLength(0);
  });
});

describe('createHermeticDir', () => {
  it('creates the root, mints a pid-stamped dir, and sweeps abandoned siblings first', () => {
    const nested = join(root, 'папercusp-voice-ipc-hermetic'.replace(/[^\x20-\x7e]/g, 'p'));
    mkdirSync(nested, { recursive: true });
    const abandoned = seed(DEAD_PID, 'hhhhhh', HERMETIC_SWEEP_MIN_AGE_MS * 2);
    rmSync(abandoned, { recursive: true, force: true });
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

  it('creates a root that does not exist yet', () => {
    const fresh = join(root, 'deep', 'not-created-yet');
    const mine = createHermeticDir(fresh);
    expect(existsSync(mine)).toBe(true);
  });

  it('gives two calls in the same process distinct dirs', () => {
    const a = createHermeticDir(join(root, 'shared'));
    const b = createHermeticDir(join(root, 'shared'));
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });
});
