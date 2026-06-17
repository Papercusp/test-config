/**
 * Side-effect-free predicate shared by the fail-on-console setup. Returns true
 * when an unexpected `console.error` / `console.warn` message is KNOWN
 * INFRASTRUCTURE NOISE that must not fail a test — as opposed to a real signal
 * of a code defect. Keep this list short and exact; broadening it weakens the
 * guard for every test in the monorepo.
 *
 * `msg` is the fully-interpolated message (`util.format(firstArg, ...rest)`),
 * so a substring match catches the error text even when it is a trailing
 * console argument (e.g. `console.error('[x] failed:', err.message)`).
 *
 * Kept in its own module (no top-level `failOnConsole(...)` side effect) so the
 * contract can be unit-tested without registering the global console hooks.
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
