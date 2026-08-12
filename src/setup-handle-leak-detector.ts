/**
 * Handle/timer LEAK ATTRIBUTION — the runtime half (see handle-leak-delta.ts for
 * the pure logic and the full rationale).
 *
 * Brackets every test file with a `process.getActiveResourcesInfo()` snapshot and
 * records the signed delta, so a resource left behind is attributed to the file
 * that LEFT it rather than to the unlucky file that was running when it fired
 * (plan gate-suite-speedup-2026-08-12 D-014/D-016; WI-38215).
 *
 * ── Three implementation constraints, each learned the hard way ──────────────
 *
 * 1. IT MUST NOT TOUCH `console`. This file is composed into the SAME setup
 *    chain as setup-fail-on-console.ts, which fails a test on console noise. A
 *    detector that logged its findings would red every test file in the repo.
 *    So findings go to a JSONL artifact and nowhere else.
 *
 * 2. IT IS REGISTERED FIRST in the chain, i.e. as the OUTERMOST bracket. Other
 *    setups create resources in their own beforeAll and release them in their
 *    afterAll; bracketing them symmetrically makes those pairs cancel to zero.
 *    Bracketing them from INSIDE would count a sibling setup's not-yet-released
 *    resources as this file's leak. Outermost is correct under either hook
 *    ordering, which is why it is not sensitive to vitest's afterAll order.
 *
 * 3. IT MUST NOT FAIL A TEST — yet. This is an OBSERVE-AND-REPORT instrument on
 *    purpose: it ships enabled so the next full suite run produces the census
 *    for free, and turning that census into an enforced, shrink-only baseline is
 *    a separate step that requires the census to exist first. Failing on a
 *    pre-existing leak population would red the gate on arrival, which D-001
 *    forbids this plan from doing.
 *
 * Disable with PAPERCUSP_LEAK_DETECT=0. Redirect the artifact with
 * PAPERCUSP_LEAK_REPORT_DIR. One `appendFileSync` of a few hundred bytes per test
 * file is the entire runtime cost.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';

import { classifyFile, countResources, type ResourceCounts } from './handle-leak-delta.js';
import { CENSUS_RECORD_VERSION, type PostMortemFireRecord } from './leak-census-aggregate.js';
import { installTimerLedger, type PostMortemFire, type TimerLedger } from './timer-leak-ledger.js';

const ENABLED = process.env.PAPERCUSP_LEAK_DETECT !== '0';
const REPORT_DIR = process.env.PAPERCUSP_LEAK_REPORT_DIR ?? join(tmpdir(), 'papercusp-leak-reports');

/**
 * One artifact per PROCESS, not per file: with `isolate: false` many test files
 * share a worker, and a per-file artifact would lose the ordering that makes a
 * source/victim pair legible. `process.pid` keys it; the aggregator globs them.
 */
const reportPath = join(REPORT_DIR, `leaks-${process.pid}.jsonl`);

function snapshot(): ResourceCounts {
  // getActiveResourcesInfo is the public, stable replacement for the deprecated
  // process._getActiveHandles(); it returns a flat array of resource type names.
  return countResources(process.getActiveResourcesInfo());
}

let before: ResourceCounts = {};
let file = '';
let timers: TimerLedger | null = null;

/**
 * POST-MORTEM FIRES seen in this worker since the last record was written.
 *
 * COLLAPSED BY (armer, landing, kind) rather than kept as an event list, because
 * the volume is unbounded by construction: a leaked interval fires forever, and a
 * single one at 10ms would append ~6,000 events a minute for the rest of the run.
 * A count is the whole signal anyway — "cell-read poisons sse-prime 300 times" and
 * "…once" are the same finding with different loudness.
 */
const postMortem = new Map<string, PostMortemFireRecord>();

/**
 * The file running at the moment a stray timer fires — the file being POISONED.
 *
 * Read at fire time, not at record-write time: the two differ whenever the fire
 * lands between files, and the landing file is half of the attribution D-020 §3
 * asks for. `expect.getState()` outside a test body is a plain global read, but it
 * is the runner's internals, so a throw is treated as "unknown" rather than
 * allowed to escape into a test's timer callback.
 */
function landingFile(): string {
  try {
    return expect.getState().testPath ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function recordPostMortemFire(fire: PostMortemFire): void {
  const landedIn = landingFile();
  // JSON.stringify, not a delimiter join: test paths are arbitrary strings and any
  // literal separator is one someone can put in a filename.
  const key = JSON.stringify([fire.armedIn, landedIn, fire.kind]);
  const seen = postMortem.get(key);
  if (seen) seen.count += 1;
  else postMortem.set(key, { armedIn: fire.armedIn, landedIn, kind: fire.kind, count: 1 });
}

function drainPostMortem(): PostMortemFireRecord[] {
  const drained = [...postMortem.values()];
  postMortem.clear();
  return drained;
}

beforeAll(() => {
  if (!ENABLED) return;
  // expect.getState().testPath is the file currently being run — the only seam that
  // names it from inside a shared setup module. Verified to update per FILE even
  // when the worker (and this module's cache entry) is reused (D-016).
  file = expect.getState().testPath ?? 'unknown';
  before = snapshot();
  // LENS 2 (D-017). Installed here — before any test body can call
  // vi.useFakeTimers() — so fake-timer calls bypass the wrapper entirely and
  // cannot be miscounted as real leaks.
  timers = installTimerLedger(globalThis as never, { file, onPostMortemFire: recordPostMortemFire });
});

afterAll(() => {
  if (!ENABLED) return;
  // Collect ALWAYS, even if nothing else is reported: collect() is what restores
  // the real timer API, and skipping it would leave the wrapper installed for
  // every later file in a reused worker.
  const armed = timers?.collect() ?? {};
  timers = null;
  const after = snapshot();
  const verdict = classifyFile(file, before, after);
  // LENS 2's findings are unbalanced ARMS, which are leaks by construction — there
  // is no "negative" counterpart, so they only ever join `leaked`. Prefixed keys
  // (`timer:setTimeout`) keep them distinguishable from LENS 1's bare Node resource
  // names, which matters because the two lenses have different blind spots: a
  // finding reported by only one of them tells you which instrument saw it.
  for (const [resource, delta] of Object.entries(armed)) {
    if (delta > 0) verdict.leaked.push({ resource, delta });
  }
  // A RECORD FOR EVERY OBSERVED FILE, clean or not — this is what `v: 2` asserts,
  // and it is the entire reason a leak RATE can exist. v1 wrote a line only for a
  // file WITH a finding, which made filesObserved == filesLeaking and any rate
  // computed from it ~100%: a specific, confident, wrong number. The aggregator
  // already keys off the version and flips `denominator.complete` itself, so this
  // is the only edit the change needs.
  //
  // Post-mortem fires ride along on whichever record is written next. The record
  // is their TRANSPORT, not their attribution: each fire names its own armer and
  // landing file, so it is legible no matter which file's line carries it.
  const fires = drainPostMortem();
  const record = {
    ...verdict,
    ...(fires.length > 0 ? { postMortem: fires } : {}),
    pid: process.pid,
    v: CENSUS_RECORD_VERSION,
  };
  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    appendFileSync(reportPath, `${JSON.stringify(record)}\n`);
  } catch {
    // A diagnostic must never be the reason a suite fails. If the artifact cannot
    // be written (read-only tmp, ENOSPC), the observation is dropped silently —
    // the aggregator reports how many files it observed, so a missing artifact
    // shows up there as a smaller denominator rather than as a false clean bill.
  }
});
