import { describe, expect, it, vi } from 'vitest';
import { installTimerLedger, type TimerGlobals } from './timer-leak-ledger.js';

/**
 * A minimal fake of the global timer API, so these tests never mutate the real
 * one (doing so inside a vitest worker would be the exact cross-file corruption
 * the subject exists to detect).
 *
 * `fire(handle)` invokes a pending callback the way the event loop would.
 */
function makeFakeGlobals() {
  const callbacks = new Map<number, (...a: unknown[]) => unknown>();
  let nextId = 1;
  const arm = (cb: unknown) => {
    const id = nextId++;
    if (typeof cb === 'function') callbacks.set(id, cb as (...a: unknown[]) => unknown);
    return id;
  };
  const globals = {
    setTimeout: ((cb: unknown) => arm(cb)) as unknown as TimerGlobals['setTimeout'],
    clearTimeout: (() => {}) as TimerGlobals['clearTimeout'],
    setInterval: ((cb: unknown) => arm(cb)) as unknown as TimerGlobals['setInterval'],
    clearInterval: (() => {}) as TimerGlobals['clearInterval'],
    setImmediate: ((cb: unknown) => arm(cb)) as unknown as TimerGlobals['setImmediate'],
    clearImmediate: (() => {}) as TimerGlobals['clearImmediate'],
  } satisfies TimerGlobals;
  return {
    globals,
    fire: (handle: unknown) => callbacks.get(handle as number)?.(),
    originals: { ...globals },
  };
}

describe('installTimerLedger', () => {
  it('reports a timer that was armed and never cleared', () => {
    const { globals } = makeFakeGlobals();
    const ledger = installTimerLedger(globals);
    globals.setTimeout(...([() => {}, 1000] as never[]));
    expect(ledger.collect()).toEqual({ 'timer:setTimeout': 1 });
  });

  it('does NOT report a timer that FIRED — otherwise every await-sleep in the repo is a "leak"', () => {
    // This is the behaviour that decides whether the report is usable at all.
    const { globals, fire } = makeFakeGlobals();
    const ledger = installTimerLedger(globals);
    const handle = globals.setTimeout(...([() => {}, 10] as never[]));
    fire(handle);
    expect(ledger.collect()).toEqual({});
  });

  it('does NOT report a timer that fired even when its callback THREW', () => {
    // The timer still fired; the throw is a different defect and must not be
    // laundered into a leak report.
    const { globals, fire } = makeFakeGlobals();
    const ledger = installTimerLedger(globals);
    const handle = globals.setTimeout(...([
      () => {
        throw new Error('boom');
      },
      10,
    ] as never[]));
    expect(() => fire(handle)).toThrow('boom');
    expect(ledger.collect()).toEqual({});
  });

  it('does NOT report a cleared timer', () => {
    const { globals } = makeFakeGlobals();
    const ledger = installTimerLedger(globals);
    const handle = globals.setTimeout(...([() => {}, 1000] as never[]));
    globals.clearTimeout(handle);
    expect(ledger.collect()).toEqual({});
  });

  it('STILL reports an interval that fired — firing never retires an interval, only clearInterval does', () => {
    const { globals, fire } = makeFakeGlobals();
    const ledger = installTimerLedger(globals);
    const handle = globals.setInterval(...([() => {}, 10] as never[]));
    fire(handle);
    fire(handle);
    expect(ledger.collect()).toEqual({ 'timer:setInterval': 1 });
  });

  it('does not report an interval that was cleared', () => {
    const { globals } = makeFakeGlobals();
    const ledger = installTimerLedger(globals);
    const handle = globals.setInterval(...([() => {}, 10] as never[]));
    globals.clearInterval(handle);
    expect(ledger.collect()).toEqual({});
  });

  it('counts per KIND and tallies several leaks of the same kind', () => {
    const { globals } = makeFakeGlobals();
    const ledger = installTimerLedger(globals);
    globals.setTimeout(...([() => {}, 1] as never[]));
    globals.setTimeout(...([() => {}, 2] as never[]));
    globals.setInterval(...([() => {}, 3] as never[]));
    globals.setImmediate?.(...([() => {}] as never[]));
    expect(ledger.collect()).toEqual({
      'timer:setTimeout': 2,
      'timer:setInterval': 1,
      'timer:setImmediate': 1,
    });
  });

  it('RESTORES the original timer API on collect — a half-restored global would corrupt every later file', () => {
    const { globals, originals } = makeFakeGlobals();
    const ledger = installTimerLedger(globals);
    expect(globals.setTimeout).not.toBe(originals.setTimeout);
    ledger.collect();
    expect(globals.setTimeout).toBe(originals.setTimeout);
    expect(globals.clearTimeout).toBe(originals.clearTimeout);
    expect(globals.setInterval).toBe(originals.setInterval);
    expect(globals.clearInterval).toBe(originals.clearInterval);
    expect(globals.setImmediate).toBe(originals.setImmediate);
  });

  it('passes the delay and extra args through to the real timer unchanged', () => {
    // A wrapper that dropped args would silently change test behaviour repo-wide.
    const spy = vi.fn(() => 7);
    const globals = {
      setTimeout: spy as unknown as TimerGlobals['setTimeout'],
      clearTimeout: (() => {}) as TimerGlobals['clearTimeout'],
      setInterval: (() => 0) as unknown as TimerGlobals['setInterval'],
      clearInterval: (() => {}) as TimerGlobals['clearInterval'],
    } satisfies TimerGlobals;
    const ledger = installTimerLedger(globals);
    const cb = () => {};
    const handle = globals.setTimeout(...([cb, 1234, 'a', 'b'] as never[]));
    expect(handle).toBe(7);
    expect(spy).toHaveBeenCalledTimes(1);
    const [passedCb, ...rest] = spy.mock.calls[0] as unknown[];
    expect(rest).toEqual([1234, 'a', 'b']);
    // The callback is instrumented (so firing can retire the entry), hence wrapped.
    expect(typeof passedCb).toBe('function');
    ledger.collect();
  });

  it('tolerates a non-function first argument instead of throwing', () => {
    // Node accepts a string in some legacy paths; a diagnostic must never be the
    // reason a suite fails.
    const { globals } = makeFakeGlobals();
    const ledger = installTimerLedger(globals);
    expect(() => globals.setTimeout(...(['not-a-function', 10] as never[]))).not.toThrow();
    expect(ledger.collect()).toEqual({ 'timer:setTimeout': 1 });
  });

  it('works when the environment has no setImmediate (browser-like globals)', () => {
    // Typed as TimerGlobals (not `satisfies` on a narrower literal) so setImmediate
    // stays a declared-but-absent optional — which is the shape a browser-like
    // environment actually presents.
    const globals: TimerGlobals = {
      setTimeout: (() => 1) as unknown as TimerGlobals['setTimeout'],
      clearTimeout: (() => {}) as TimerGlobals['clearTimeout'],
      setInterval: (() => 2) as unknown as TimerGlobals['setInterval'],
      clearInterval: (() => {}) as TimerGlobals['clearInterval'],
    };
    const ledger = installTimerLedger(globals);
    globals.setTimeout(...([() => {}, 1] as never[]));
    expect(ledger.collect()).toEqual({ 'timer:setTimeout': 1 });
    expect(globals.setImmediate).toBeUndefined();
  });

  it('is idempotent enough that a second collect reports nothing', () => {
    const { globals } = makeFakeGlobals();
    const ledger = installTimerLedger(globals);
    globals.setTimeout(...([() => {}, 1] as never[]));
    expect(ledger.collect()).toEqual({ 'timer:setTimeout': 1 });
    expect(ledger.collect()).toEqual({});
  });
});

/**
 * POST-MORTEM FIRE DETECTION (D-020 §3).
 *
 * The arm counts above measure untidiness; these measure the harmful event —
 * one file's callback executing while a LATER file is running. The two must not
 * be conflated, so they are exercised separately.
 */
describe('installTimerLedger post-mortem fire detection', () => {
  it('reports a timer that fires AFTER collect, naming the file that armed it', () => {
    const { globals, fire } = makeFakeGlobals();
    const fires: unknown[] = [];
    const ledger = installTimerLedger(globals, {
      file: 'armer.test.ts',
      onPostMortemFire: (f) => fires.push(f),
    });
    const handle = globals.setTimeout(...([() => {}, 5000] as never[]));
    ledger.collect();
    fire(handle);
    expect(fires).toEqual([{ armedIn: 'armer.test.ts', kind: 'setTimeout' }]);
  });

  it('does NOT report a timer that fires BEFORE collect — that is the file using its own timer', () => {
    // The control that keeps the signal meaningful: without it every `await
    // sleep(10)` in the repo would be reported as poisoning its own file.
    const { globals, fire } = makeFakeGlobals();
    const fires: unknown[] = [];
    const ledger = installTimerLedger(globals, { file: 'armer.test.ts', onPostMortemFire: (f) => fires.push(f) });
    const handle = globals.setTimeout(...([() => {}, 10] as never[]));
    fire(handle);
    expect(fires).toEqual([]);
    ledger.collect();
  });

  it('still runs the original callback when it fires post-mortem', () => {
    // The detector observes; it must never change what the suite does. A leaked
    // callback that stopped running under the detector would hide the very
    // failure the detector exists to attribute.
    const { globals, fire } = makeFakeGlobals();
    const ran = vi.fn();
    const ledger = installTimerLedger(globals, { file: 'a.test.ts', onPostMortemFire: () => {} });
    const handle = globals.setTimeout(...([ran, 1] as never[]));
    ledger.collect();
    fire(handle);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('reports EVERY fire of a leaked interval, not just the first', () => {
    // An interval is the unbounded case, and each fire is a separate intrusion
    // into whatever file is running at that moment.
    const { globals, fire } = makeFakeGlobals();
    const fires: unknown[] = [];
    const ledger = installTimerLedger(globals, { file: 'ticker.test.ts', onPostMortemFire: (f) => fires.push(f) });
    const handle = globals.setInterval(...([() => {}, 10] as never[]));
    ledger.collect();
    fire(handle);
    fire(handle);
    fire(handle);
    expect(fires).toHaveLength(3);
    expect(fires[2]).toEqual({ armedIn: 'ticker.test.ts', kind: 'setInterval' });
  });

  it('survives an observer that THROWS — the callback still runs and the throw does not escape', () => {
    // Rail 4: a diagnostic must never be the reason a suite fails.
    const { globals, fire } = makeFakeGlobals();
    const ran = vi.fn();
    const ledger = installTimerLedger(globals, {
      file: 'a.test.ts',
      onPostMortemFire: () => {
        throw new Error('observer exploded');
      },
    });
    const handle = globals.setTimeout(...([ran, 1] as never[]));
    ledger.collect();
    expect(() => fire(handle)).not.toThrow();
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('falls back to "unknown" rather than dropping the event when no file was supplied', () => {
    const { globals, fire } = makeFakeGlobals();
    const fires: { armedIn: string }[] = [];
    const ledger = installTimerLedger(globals, { onPostMortemFire: (f) => fires.push(f) });
    const handle = globals.setTimeout(...([() => {}, 1] as never[]));
    ledger.collect();
    fire(handle);
    expect(fires.map((f) => f.armedIn)).toEqual(['unknown']);
  });

  it('is inert when no observer is supplied — the ledger keeps working as a pure counter', () => {
    const { globals, fire } = makeFakeGlobals();
    const ran = vi.fn();
    const ledger = installTimerLedger(globals);
    const handle = globals.setTimeout(...([ran, 1] as never[]));
    expect(ledger.collect()).toEqual({ 'timer:setTimeout': 1 });
    expect(() => fire(handle)).not.toThrow();
    expect(ran).toHaveBeenCalledTimes(1);
  });
});
