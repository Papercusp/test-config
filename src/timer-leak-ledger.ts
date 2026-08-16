/**
 * TIMER-API BOOKKEEPING — the detector's second lens (plan
 * gate-suite-speedup-2026-08-12 D-017; WI-38215).
 *
 * WHY A SECOND LENS EXISTS AT ALL. The first lens diffs
 * `process.getActiveResourcesInfo()` across a test file, which is the right
 * instrument for sockets, child processes and registry entries — but it has a
 * blind spot that was proven by experiment, not guessed: IT CANNOT SEE UNREF'D
 * TIMERS. Two probe files identical but for one call:
 *
 *     setTimeout(f, 3000); t.unref()   ->  resource delta {}              INVISIBLE
 *     setTimeout(f, 3000)              ->  resource delta {"Timeout": 1}  visible
 *
 * That is the worst possible blind spot, because `unref()` is exactly what
 * careful library code calls so a pending timer does not hold the process open —
 * and an unref'd timer still FIRES, and still rejects into whatever test file
 * happens to be running when it does. It is why the detector stayed silent on
 * the very case that motivated it (a 5s timer armed by
 * authority-rpc-swarm-transport, which vitest blamed on sse-prime.test.ts).
 *
 * THE FIX IS TO OBSERVE THE CALL, NOT THE HANDLE. This ledger wraps the timer
 * API and counts arm/clear PAIRS, so `unref()` is irrelevant to it — an unref'd
 * timer is armed by the same `setTimeout` call as any other.
 *
 * FOUR BEHAVIOURS WORTH KNOWING, each deliberate:
 *
 *  1. A TIMER THAT FIRED IS NOT A LEAK. The wrapper wraps the CALLBACK too and
 *     retires the entry when it runs. Otherwise every `await sleep(10)` in the
 *     repo would be reported, and the report would be worthless.
 *  2. AN INTERVAL IS NEVER RETIRED BY FIRING — that is what makes it an
 *     interval. Only `clearInterval` retires it, so a surviving interval is
 *     always reported.
 *  3. FAKE TIMERS EXCLUDE THEMSELVES, for free. `vi.useFakeTimers()` REPLACES
 *     globalThis.setTimeout outright, so calls under fake timers never reach
 *     this wrapper and cannot be miscounted as real leaks. Pending fake timers
 *     die with the fake clock and are correctly not our business. (This is why
 *     the ledger must be installed BEFORE a test can install fake timers, and
 *     restored after — install/collect are called from beforeAll/afterAll.)
 *  4. IT NEVER THROWS. A diagnostic that can fail a suite is worse than no
 *     diagnostic: `collect()` restores the originals unconditionally.
 *
 * The `globals` parameter exists so this is unit-testable against a fake global
 * object instead of mutating the real one inside a test run.
 */

/** The subset of the global timer API this ledger brackets. */
export type TimerGlobals = {
  setTimeout: (...args: never[]) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (...args: never[]) => unknown;
  clearInterval: (handle: unknown) => void;
  setImmediate?: (...args: never[]) => unknown;
  clearImmediate?: (handle: unknown) => void;
};

/** Which API armed a still-pending timer. Becomes the resource name in the report. */
export type TimerKind = 'setTimeout' | 'setInterval' | 'setImmediate';

/**
 * A timer that fired AFTER the file that armed it had already finished — the
 * harmful event itself, not the hygiene proxy (D-020 §3).
 *
 * The arm counts this ledger returns from `collect()` measure UNTIDINESS: most of
 * them are guards like `Promise.race` timeouts whose late callback resolves an
 * already-settled promise and does nothing. A post-mortem FIRE is different in
 * kind — it is a file's code running inside a later file's test run, which is
 * exactly the cross-file poisoning that makes a non-isolated lane unsafe. It
 * carries both halves of the attribution, so it answers "which file poisons
 * which" rather than "how untidy is the suite".
 *
 * `landedIn` is deliberately NOT resolved here: this module has no access to the
 * test runner's notion of the current file, and inventing one would couple a
 * pure, unit-testable ledger to vitest. The installer supplies it at fire time.
 */
export type PostMortemFire = {
  /** The file whose `beforeAll` installed the ledger that armed this timer. */
  armedIn: string;
  /** Which API armed it. */
  kind: TimerKind;
};

export type InstallOptions = {
  /** The file being bracketed — reported as `armedIn` on a post-mortem fire. */
  file?: string;
  /**
   * Called when a timer armed under this ledger fires after `collect()`.
   * Invoked BEFORE the original callback runs, so an observer sees the event
   * even if the callback throws. Never called before `collect()`.
   */
  onPostMortemFire?: (fire: PostMortemFire) => void;
};

export type TimerLedger = {
  /** Restore the originals and return the counts of timers still armed, by kind. */
  collect: () => Record<string, number>;
};

const RETIRE_ON_FIRE: Record<TimerKind, boolean> = {
  // A one-shot that ran did its job and is gone.
  setTimeout: true,
  setImmediate: true,
  // An interval that ran is still armed — only clearInterval retires it.
  setInterval: false,
};

/**
 * Install wrappers on `globals` and return a `collect()` that restores them and
 * reports what is still armed.
 *
 * Report keys are prefixed (`timer:setTimeout`) so a reader can tell which LENS
 * produced a finding — the resource lens emits bare Node resource names like
 * `Timeout`. Mixing them under one name would make the two lenses
 * indistinguishable in the artifact, and they have different blind spots.
 */
export function installTimerLedger(globals: TimerGlobals, options: InstallOptions = {}): TimerLedger {
  const pending = new Map<unknown, TimerKind>();
  // Flipped by collect(). Restoring the globals does NOT disarm timers that are
  // already holding an instrumented closure, so those closures outlive the ledger
  // — which is precisely the hook that makes post-mortem detection possible
  // rather than a thing we would have to build separate machinery for.
  let collected = false;

  const originals = {
    setTimeout: globals.setTimeout,
    clearTimeout: globals.clearTimeout,
    setInterval: globals.setInterval,
    clearInterval: globals.clearInterval,
    setImmediate: globals.setImmediate,
    clearImmediate: globals.clearImmediate,
  };

  const wrapArm = (kind: TimerKind, original: (...args: never[]) => unknown) =>
    function armWrapper(this: unknown, ...args: unknown[]) {
      const [callback, ...rest] = args;
      let handle: unknown;
      const instrumented =
        typeof callback === 'function'
          ? function firedWrapper(this: unknown, ...callbackArgs: unknown[]) {
              // Retire BEFORE invoking: if the callback throws, the timer still fired
              // and must not be reported as leaked.
              if (RETIRE_ON_FIRE[kind]) pending.delete(handle);
              // Firing after collect() means the arming file has finished and this
              // callback is now running inside whatever file came next.
              if (collected && options.onPostMortemFire) {
                try {
                  options.onPostMortemFire({ armedIn: options.file ?? 'unknown', kind });
                } catch {
                  // Rail 4: a diagnostic must never be the reason a suite fails. An
                  // observer that throws loses its own event, never the callback.
                }
              }
              return (callback as (...a: unknown[]) => unknown).apply(this, callbackArgs);
            }
          : callback;
      handle = (original as (...a: unknown[]) => unknown).call(this, instrumented, ...rest);
      pending.set(handle, kind);
      return handle;
    };

  const wrapClear = (original: ((handle: unknown) => void) | undefined) =>
    function clearWrapper(this: unknown, handle: unknown) {
      pending.delete(handle);
      return original?.call(this, handle);
    };

  globals.setTimeout = wrapArm('setTimeout', originals.setTimeout) as TimerGlobals['setTimeout'];
  globals.setInterval = wrapArm('setInterval', originals.setInterval) as TimerGlobals['setInterval'];
  globals.clearTimeout = wrapClear(originals.clearTimeout) as TimerGlobals['clearTimeout'];
  globals.clearInterval = wrapClear(originals.clearInterval) as TimerGlobals['clearInterval'];
  if (originals.setImmediate) {
    globals.setImmediate = wrapArm('setImmediate', originals.setImmediate) as TimerGlobals['setImmediate'];
    globals.clearImmediate = wrapClear(originals.clearImmediate) as TimerGlobals['clearImmediate'];
  }

  return {
    collect() {
      // Set BEFORE restoring, so a timer that fires during the restore itself is
      // still classified as post-mortem rather than slipping through as live.
      collected = true;
      // Restore FIRST and unconditionally: a half-restored global timer API would
      // corrupt every later test file in a reused worker, which is precisely the
      // class of damage this detector exists to find.
      globals.setTimeout = originals.setTimeout;
      globals.clearTimeout = originals.clearTimeout;
      globals.setInterval = originals.setInterval;
      globals.clearInterval = originals.clearInterval;
      if (originals.setImmediate) globals.setImmediate = originals.setImmediate;
      if (originals.clearImmediate) globals.clearImmediate = originals.clearImmediate;

      const counts: Record<string, number> = {};
      for (const kind of pending.values()) {
        const key = `timer:${kind}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      pending.clear();
      return counts;
    },
  };
}
