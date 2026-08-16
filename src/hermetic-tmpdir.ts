/**
 * Per-test-process hermetic scratch dirs that DO NOT leak when the process is killed.
 *
 * ── Why this module exists (the failure it removes) ──────────────────────────
 * `setup-hermetic-env.ts` mints a tmpdir per test process to redirect
 * `PAPERCUSP_VOICE_IPC_DIR` away from the real ~/.papercusp. It cleaned that dir
 * up from a `process.on('exit')` handler — and that handler is the whole bug:
 *
 *   Node runs 'exit' handlers ONLY on a normal exit (empty event loop,
 *   process.exit(), uncaught exception). A process terminated BY A SIGNAL runs
 *   none of them, and `pool: 'forks'` (this repo's unit + integration pool, see
 *   vitest-config.ts) is exactly that case: tinypool terminates each per-file
 *   fork with a signal, so the handler never fires for the processes that
 *   actually create these dirs.
 *
 * Measured 2026-08-14 (WI-38830), and note this is a REGRESSION of the identical
 * leak fixed 2026-07-09 — the earlier fix added the very 'exit' handler above, was
 * never guarded by a test, and quietly stopped working:
 *   - 74,385 `voice-ipc-hermetic-*` dirs in /tmp, oldest 57.5h, newest 0.8h
 *     (i.e. still being minted ~1,300/hour), 71,529 of them created in ONE 24h window;
 *   - /tmp's top level held 102,389 entries, which is the actual harm: it degrades
 *     every mkdir/readdir/stat under the shared TMPDIR — including the
 *     testcontainer start-lock — and the 2026-07-09 incident tied that to spurious
 *     integration-test timeouts and elevated host load fleet-wide.
 *   - Falsified directly: one `npm run test:file` of a single tiny test under an
 *     isolated TMPDIR left one `voice-ipc-hermetic-*` dir behind, while importing
 *     setup-hermetic-env.ts under a plain `tsx -e` (a NORMAL exit) removed it.
 *     Same code, opposite outcome — the handler works, it just never runs.
 *
 * ── The SAME leak, unbounded, from OTHER test files (WI-38869) ────────────────
 * The NEST+SWEEP fix above only covers the one root it owns
 * (`papercusp-voice-ipc-hermetic/`). Measured 2026-08-16: at least 17 OTHER test
 * files each `mkdtempSync(join(tmpdir(), '<own-prefix>-'))` directly at the /tmp/pcv
 * TOP LEVEL with no nest and no sweep of their own — same fork-signal-kill root
 * cause, just uncentralized. /tmp/pcv sat at 49,315 entries (41,525 of them >24h
 * old — dead weight, not live tests) against the 50,000 alarm threshold, most of it
 * from THESE files, not voice-ipc. Migrating 17 call sites one at a time chases the
 * 18th forever; `sweepStaleTestScratch` below sweeps the /tmp/pcv ROOT ITSELF, so it
 * catches every present and future offender without touching each one.
 *
 * It deliberately does NOT reuse the pid-liveness check: none of those 17 files name
 * their dirs `<pid>-<suffix>`, so `pidFromEntryName` never parses on them, and this
 * module's existing "no parseable pid ⇒ treat as abandoned past minAge (60s)" rule
 * would reap a live multi-minute test's scratch dir out from under it. Root-level
 * sweeping instead uses AGE ALONE, with a threshold (4h, see
 * GENERIC_SCRATCH_SWEEP_MAX_AGE_MS) chosen the same way HERMETIC_SWEEP_MAX_AGE_MS
 * was: far longer than any real test run, far shorter than useful. It also excludes
 * the small set of known LONG-LIVED non-scratch subdirs that legitimately live at
 * the /tmp/pcv top level (lock directories, not per-run scratch) — see
 * GENERIC_SCRATCH_SWEEP_EXCLUDE.
 *
 * ── The two-part fix, and why each part is load-bearing ──────────────────────
 * 1. NEST. Every hermetic dir goes under ONE parent (`papercusp-voice-ipc-hermetic/`),
 *    so a leak costs the shared TMPDIR a single top-level entry instead of one per
 *    test process. This bounds the blast radius even while dirs are leaking.
 * 2. SWEEP ON CREATE. Each process reaps siblings whose CREATOR IS GONE before
 *    minting its own. This is the part that actually holds, because it does not
 *    depend on the dying process running anything: a SIGKILLed worker cannot clean
 *    up after itself by construction, no matter which handler you install. Cleanup
 *    that requires the victim to cooperate is not cleanup.
 *
 * The 'exit' handler is KEPT for the clean path — it is correct, it is cheap, and
 * it keeps the steady-state population near zero rather than one sweep-interval deep.
 *
 * ── Why the sweep is safe (it must never delete a LIVE peer's dir) ───────────
 * The dir name carries its creator's pid, so liveness is a `kill(pid, 0)` away.
 * Three guards keep a false reap out of reach:
 *   - MIN_AGE: a dir younger than this is never touched, so a peer that has just
 *     mkdtemp'd but not yet written is invisible to a concurrent sweeper.
 *   - EPERM means the pid EXISTS but belongs to another user ⇒ treated as ALIVE.
 *     The only failure direction we accept is "kept too long", never "deleted too soon".
 *   - PID RECYCLING (this host wraps pids ~daily under fleet load) can make a dead
 *     creator's pid look alive. That merely delays the reap; MAX_AGE is the backstop
 *     that collects it anyway. A recycled pid can never cause an early delete.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Never touch a dir younger than this — a peer may have just created it. */
export const HERMETIC_SWEEP_MIN_AGE_MS = 60_000;
/**
 * Reap on age alone past this, whatever the pid says. This is the backstop for a
 * recycled pid that makes a dead creator look alive. It is deliberately far longer
 * than the slowest legitimate test process (integration suites run tens of minutes)
 * so it can never race a live run, and far shorter than the host's 7d
 * systemd-tmpfiles sweep, which is what was "collecting" these dirs before.
 */
export const HERMETIC_SWEEP_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
/**
 * Cap the per-process scan. This runs at the START of every test file, so it must
 * stay a rounding error: with ~1,300 test processes/hour, a capped sweep still
 * drains a large backlog quickly, while an uncapped readdir+stat over a 70k-entry
 * backlog would tax the very startup path the leak was already slowing down.
 */
export const HERMETIC_SWEEP_SCAN_CAP = 400;

/**
 * For the ROOT-LEVEL, age-only sweep (`sweepStaleTestScratch`) only — entries here
 * are not pid-stamped, so age is the only safe signal (see the module doc's
 * "SAME leak, unbounded" section). 4h is far longer than any real test run
 * (integration suites run tens of minutes) and far shorter than useful.
 */
export const GENERIC_SCRATCH_SWEEP_MAX_AGE_MS = 4 * 60 * 60 * 1_000;
/**
 * Known /tmp/pcv top-level entries that are LONG-LIVED lock directories, not
 * per-run scratch — a root-level age sweep must never reap these regardless of age.
 * (fs-mutex-locks: scripts/lib/fs-mutex.mjs; testcontainers-locks:
 * testcontainer-start-lock.ts; papercusp-voice-ipc-hermetic: this file's own nest,
 * already self-swept on create.)
 */
export const GENERIC_SCRATCH_SWEEP_EXCLUDE: ReadonlySet<string> = new Set([
  'fs-mutex-locks',
  'testcontainers-locks',
  'papercusp-voice-ipc-hermetic',
]);

/** Directory name minted per process: `<pid>-<mkdtemp suffix>`. */
function pidFromEntryName(name: string): number {
  const dash = name.indexOf('-');
  if (dash <= 0) return Number.NaN;
  return Number.parseInt(name.slice(0, dash), 10);
}

/**
 * Is the process that created a dir still around?
 *
 * EPERM ⇒ the pid exists but is not ours ⇒ ALIVE. Erring toward "alive" is the
 * only safe direction: a missed reap is collected by MAX_AGE, an early reap
 * deletes a running test's state.
 */
export function creatorIsAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = (p, s) => {
    process.kill(p, s);
  },
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

export interface SweepOptions {
  now?: number;
  minAgeMs?: number;
  maxAgeMs?: number;
  scanCap?: number;
  isAlive?: (pid: number) => boolean;
  /**
   * Top-level entry names to skip entirely — never stat'd, never counted against
   * scanCap, never removed. For known long-lived non-scratch siblings at a shared
   * root (see GENERIC_SCRATCH_SWEEP_EXCLUDE).
   */
  exclude?: ReadonlySet<string>;
  /**
   * Decide solely by age — never call `isAlive`. Required whenever entries under
   * `root` are NOT pid-stamped (`<pid>-<suffix>`): an unparseable name makes
   * `isAlive` return false immediately, so the liveness path would reap a live
   * process's dir the moment it crosses `minAgeMs` (60s) instead of `maxAgeMs`.
   * See `sweepStaleTestScratch`, the only intended caller.
   */
  ageOnly?: boolean;
}

export interface SweepResult {
  scanned: number;
  removed: number;
  /** Entries left alone because their creator is still running. */
  keptAlive: number;
  /** Entries left alone because they are younger than minAgeMs. */
  keptYoung: number;
}

/**
 * Remove hermetic dirs under `root` whose creating process is gone.
 *
 * Best-effort by contract: every filesystem call is individually guarded, because
 * this runs on the test-startup path in a directory many processes are mutating
 * concurrently. A racing peer that removes an entry between our readdir and our
 * rm is the NORMAL case, not an error, and cleanup must never fail a test run.
 */
export function sweepAbandonedHermeticDirs(root: string, opts: SweepOptions = {}): SweepResult {
  const now = opts.now ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? HERMETIC_SWEEP_MIN_AGE_MS;
  const maxAgeMs = opts.maxAgeMs ?? HERMETIC_SWEEP_MAX_AGE_MS;
  const scanCap = opts.scanCap ?? HERMETIC_SWEEP_SCAN_CAP;
  const isAlive = opts.isAlive ?? ((pid: number) => creatorIsAlive(pid));
  const exclude = opts.exclude;
  const ageOnly = opts.ageOnly ?? false;
  const result: SweepResult = { scanned: 0, removed: 0, keptAlive: 0, keptYoung: 0 };

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return result;
  }

  for (const name of entries) {
    if (exclude?.has(name)) continue;
    if (result.scanned >= scanCap) break;
    result.scanned += 1;
    const path = join(root, name);
    let ageMs: number;
    try {
      ageMs = now - statSync(path).mtimeMs;
    } catch {
      continue; // vanished under us — a peer swept it first
    }
    if (ageMs < minAgeMs) {
      result.keptYoung += 1;
      continue;
    }
    const keep = ageMs <= maxAgeMs && (ageOnly || isAlive(pidFromEntryName(name)));
    if (keep) {
      result.keptAlive += 1;
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: true });
      result.removed += 1;
    } catch {
      /* best-effort — a racing peer may have removed it already */
    }
  }
  return result;
}

/**
 * Sweep STALE test-scratch dirs directly at a shared TMPDIR root (e.g. /tmp/pcv
 * itself), where entries come from many uncoordinated test files and are NOT
 * pid-stamped. Age-only past `GENERIC_SCRATCH_SWEEP_MAX_AGE_MS`, excluding the known
 * long-lived siblings in `GENERIC_SCRATCH_SWEEP_EXCLUDE` — see the module doc's
 * "SAME leak, unbounded" section for why this exists and why it is age-only.
 *
 * Best-effort and cheap by the same contract as `sweepAbandonedHermeticDirs`
 * (scanCap-bounded, every fs call individually guarded); call it unconditionally
 * from a per-test-process hot path, same as that function.
 */
export function sweepStaleTestScratch(
  root: string,
  opts: Omit<SweepOptions, 'ageOnly' | 'isAlive'> = {},
): SweepResult {
  return sweepAbandonedHermeticDirs(root, {
    maxAgeMs: GENERIC_SCRATCH_SWEEP_MAX_AGE_MS,
    exclude: GENERIC_SCRATCH_SWEEP_EXCLUDE,
    ...opts,
    ageOnly: true,
  });
}

/**
 * Mint this process's hermetic dir under `root`, sweeping abandoned siblings first.
 *
 * Returns the new dir. The caller owns registering whatever teardown it wants; the
 * sweep above is what makes the dir safe to abandon when that teardown never runs.
 */
export function createHermeticDir(root: string, opts: SweepOptions = {}): string {
  mkdirSync(root, { recursive: true });
  sweepAbandonedHermeticDirs(root, opts);
  return mkdtempSync(join(root, `${process.pid}-`));
}
