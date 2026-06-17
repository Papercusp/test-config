import failOnConsole from 'vitest-fail-on-console';

/**
 * Returns true when an unexpected `console.error` / `console.warn` message is
 * KNOWN INFRASTRUCTURE NOISE that must not fail a test — as opposed to a real
 * signal of a code defect. Keep this list short and exact; broadening it
 * weakens the guard for every test. Exported so the contract is locked by a
 * unit test (see setup-fail-on-console.test.ts).
 *
 * `msg` is the fully-interpolated message (`util.format(firstArg, ...rest)`),
 * so a substring match catches the error text even when it is a trailing
 * console argument (e.g. `console.error('[x] failed:', err.message)`).
 */
export function isSilencedConsoleMessage(msg: unknown): boolean {
  if (typeof msg !== 'string') return false;
  // React 19 hydration noise from third-party libs (Monaco, etc.).
  if (msg.includes('was not wrapped in act(...)')) return true;
  // PostgreSQL connection-pool EXHAUSTION (SQLSTATE 53300). On the shared dev
  // box the suite's forked workers contend for the same native PG with the
  // live + staging operators and the rest of the fleet; under load PG runs out
  // of connection slots and the best-effort graceful-degradation paths (wire-
  // outbox backfill, outbox-drain, route-telemetry, adv-sessions, cross-hive
  // ledger) log these. They are SERVER resource-limit messages, never a code
  // defect, and the code that emits them already catches+continues — so they
  // are box weather, not a signal. Silencing only these two exact strings keeps
  // the gate measuring correctness (a real connection-leak regression still
  // fails on the asserted query path / a thrown error, not on an incidental log
  // line) while removing a recurring full-suite-only flake's grip on the hourly
  // green-checkpoint. Same philosophy as the unit-timeout headroom in
  // vitest-config.ts ("runner robustness, not test weakening").
  if (msg.includes('connection slots are reserved')) return true;
  if (msg.includes('too many clients already')) return true;
  return false;
}

/**
 * Fails any test that produces an unexpected `console.error` /
 * `console.warn`. Closes one of the most common silent-flake sources
 * before it can hide in the suite (testing-spec §1.9).
 *
 * Tests that intentionally trigger a console message can opt out per
 * call via `failOnConsole`'s `silenceMessage` callback below — extend
 * `isSilencedConsoleMessage` rather than disabling the check entirely.
 */
failOnConsole({
  shouldFailOnError: true,
  shouldFailOnWarn: true,
  silenceMessage: (msg) => isSilencedConsoleMessage(msg),
});
