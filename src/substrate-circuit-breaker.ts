/**
 * SubstrateCircuitBreaker — fail-fast for a persistently-down shared test
 * substrate (EI-11530).
 *
 * THE PROBLEM. The integration suite shares ONE `.withReuse()` Postgres
 * testcontainer across every vitest worker on the box (see pg-container.ts).
 * `getTestPg()` already rides out a BRIEF recovery window with a bounded
 * per-call retry (WI-3578). But when the substrate is PERSISTENTLY unavailable
 * — the shared container torn down + recreated under concurrent reuse-hash
 * churn, so processes keep attaching mid crash-recovery — every one of
 * hundreds of test files independently exhausts its retries and fails in
 * setup. Observed 2026-07-13: `Test Files 455 failed | 146 passed`, ~890
 * substrate-ensure failures, the run burning 500+s to emit a pass/fail verdict
 * that is ~100% environmental noise, not a code signal. A human/agent then has
 * to forensically prove it was the substrate and not a real regression.
 *
 * THE FIX (verdict integrity, not a band-aid). A test run against a dead
 * substrate must REPORT a substrate outage, not masquerade it as test
 * failures. This breaker restructures the verdict to be derived-correct: after
 * N CONSECUTIVE substrate-acquisition failures (each already past its own
 * bounded retries — so N failures ⇒ the substrate was down continuously, not a
 * blip), it LATCHES and makes every subsequent `getTestPg()` throw a distinct
 * `TEST SUBSTRATE DOWN` error IMMEDIATELY. The remaining files fail fast with
 * an unmistakable cause instead of each grinding through its full retry budget,
 * and the run's verdict is dominated by one honest signal: re-run on a healthy
 * substrate.
 *
 * WHY LATCHED (not un-trip on a later success). Once the substrate has proven
 * persistently down mid-run, the run's verdict is already compromised; letting
 * it continue would produce exactly the MIXED real-plus-spurious verdict this
 * exists to prevent. Latching makes the whole run carry the honest
 * "substrate down — re-run" outcome. The threshold is high enough
 * (default 3 fully-exhausted failures ⇒ ~30s+ continuous outage) that tripping
 * is a strong true positive; it is env-tunable if ever too eager.
 *
 * WHY PER-PROCESS (module state, not a shared file). The breaker lives in the
 * vitest worker's module scope and dies with the worker — so it can never
 * leave a STALE "down" marker that wrongly fails a healthy next run (a
 * persisted flag would be a value-that-can-be-wrong needing re-verification —
 * the very thing to avoid). Each worker independently trips after N, bounding
 * the grind to at most N files per worker.
 */

/** How the breaker reports a trip to the run output. Injectable for tests. */
export type BannerSink = (message: string) => void;

const defaultBanner: BannerSink = (message) => {
  // process.stderr.write, NOT console.error: this is diagnostic output, and
  // routing around console keeps it clear of any fail-on-console setup that
  // would otherwise reclassify a substrate outage as a console violation.
  try {
    process.stderr.write(`\n\n🔴 [test-substrate] ${message}\n\n`);
  } catch {
    /* stderr unavailable — the thrown error still carries the message */
  }
};

export class SubstrateCircuitBreaker {
  private consecutiveFailures = 0;
  private trippedError: Error | null = null;
  private readonly threshold: number;
  private readonly label: string;
  private readonly banner: BannerSink;

  /**
   * @param threshold consecutive fully-exhausted failures before the breaker latches (>=1).
   * @param label     what is failing, for the error/banner (e.g. "getTestPg (shared test Postgres)").
   * @param banner    where to emit the one-time trip banner (default: process.stderr).
   */
  constructor(
    threshold: number,
    label: string,
    banner: BannerSink = defaultBanner,
  ) {
    this.threshold = threshold;
    this.label = label;
    this.banner = banner;
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error(`SubstrateCircuitBreaker: threshold must be an integer >= 1, got ${threshold}`);
    }
  }

  /** True once the breaker has latched open. */
  get tripped(): boolean {
    return this.trippedError !== null;
  }

  /** Current consecutive-failure count (diagnostic / test visibility). */
  get failureCount(): number {
    return this.consecutiveFailures;
  }

  /**
   * Fail-fast gate — call at the START of the guarded operation. Once the
   * breaker has latched, throws the distinct `TEST SUBSTRATE DOWN` error
   * immediately (no container start, no retry). No-op while healthy.
   */
  check(): void {
    if (this.trippedError) throw this.trippedError;
  }

  /** A guarded operation succeeded — the substrate is reachable; reset the streak. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * A guarded operation failed (after its own bounded retries). Counts toward
   * the streak; latches the breaker once the threshold is reached and emits a
   * single banner. Idempotent after latching. Call this EXACTLY ONCE per
   * distinct acquisition attempt — not once per concurrent awaiter of the same
   * failed attempt — or the streak inflates.
   */
  recordFailure(cause: unknown): void {
    if (this.trippedError) return; // already latched — don't keep counting/re-bannering
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.threshold) return;

    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    const message =
      `TEST SUBSTRATE DOWN: ${this.label} failed ${this.consecutiveFailures} times in a row ` +
      `(each after its own bounded retries) — the shared test substrate is persistently ` +
      `unavailable, NOT a code regression. Failing fast so this run reports a substrate outage ` +
      `instead of grinding through every remaining file and emitting a junk pass/fail verdict. ` +
      `Re-run once the substrate is healthy. Last cause: ${causeMsg}`;
    this.trippedError = new Error(message);
    this.banner(message);
  }
}
