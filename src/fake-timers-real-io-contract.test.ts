// Contract test for a repo-wide TESTING convention, not for a product defect.
//
// EI-18121952237624498. `vi.useFakeTimers()` replaces the global timer
// functions, which silently disarms EVERY bound built on them — including the
// ones inside libraries we don't own. The concrete case that motivated this:
//
//   buildHiveRekeyBootDeps → potHomeSlugForHarness → loadHarnessRegistry
//     → readOperatorState → PG (postgres.js)
//
// Under bare fake timers the postgres driver's own internal timers are frozen,
// so the query loses its bound and never settles. The test does not fail — it
// HANGS, which reads as an unrelated "hook timed out" much later and sends the
// reader hunting in the wrong file. (The comment in wire-outbox.test.ts blamed
// `getFlag` for exactly this reason; measurement showed `getFlag` returns in 0ms
// and is not involved at all.)
//
// The convention: if a code path under test touches real I/O, use
//   vi.useFakeTimers({ shouldAdvanceTime: true })
// which lets real I/O make progress while still honouring explicit
// `vi.advanceTimersByTimeAsync` control.
//
// These two tests pin the properties that convention depends on. If a Vitest or
// @sinonjs/fake-timers upgrade changes either one, the advice above becomes
// stale and this file is what tells us.
import { describe, it, expect, vi, afterEach } from 'vitest';

// Captured at MODULE LOAD, before any fake-timer install. Capturing it later
// would capture the FAKE timer and make every deadline below vacuous — it would
// never fire, so a hang would present as an infinite hang rather than a failure.
const PRISTINE_SET_TIMEOUT = globalThis.setTimeout;

/**
 * Race `p` against a deadline measured on the PRISTINE timer, so a frozen-clock
 * hang becomes a returned label instead of wedging the suite.
 */
function withPristineDeadline<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => {
      PRISTINE_SET_TIMEOUT(() => resolve(onTimeout), ms);
    }),
  ]);
}

/** A bound built on the global timers — the shape every such guard in the tree uses. */
function boundedByGlobalTimer(ms: number): Promise<'settled'> {
  return new Promise<'settled'>((resolve) => {
    setTimeout(() => resolve('settled'), ms);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fake timers vs. real-I/O bounds (EI-18121952237624498)', () => {
  it('bare useFakeTimers() freezes a global-timer bound — this is WHY the convention exists', async () => {
    vi.useFakeTimers();
    const verdict = await withPristineDeadline(boundedByGlobalTimer(10), 250, 'frozen');
    // Not a defect in our code: it is the documented behaviour of fake timers,
    // and the reason a PG-touching path must not run under BARE fake timers.
    expect(verdict).toBe('frozen');
  });

  it('shouldAdvanceTime:true lets real time progress AND still honours explicit advance', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // (a) Real progress: a global-timer bound settles on its own, so a genuine
    //     I/O path (PG, fs, sockets) is no longer unbounded.
    const verdict = await withPristineDeadline(boundedByGlobalTimer(10), 1000, 'frozen');
    expect(verdict).toBe('settled');

    // (b) Determinism is NOT sacrificed: a long pending timer still does not
    //     fire on its own within the test, and an explicit advance still fires
    //     it. Without (b) the convention would be useless — the whole point of
    //     fake timers is controlling long waits.
    const fired: string[] = [];
    setTimeout(() => fired.push('t60s'), 60_000);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toEqual(['t60s']);
  });
});
