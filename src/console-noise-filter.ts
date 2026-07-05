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
  // implement-worker-exit.test.ts's "getPayload failure" test deliberately spies
  // console.warn (vi.spyOn(...).mockImplementation) around the ONE intentional,
  // best-effort warn recordImplementWorkerExit emits on a getPayload error
  // (implement-worker-exit.ts's own doc: "never blocks the back-edge from
  // recording"). Proven FULL-SUITE-ONLY flake (WI-1660): passes standalone and
  // as a whole file every time, but under the full ~2.4k-file forks-pool run the
  // spy occasionally loses the race against this setup's own beforeEach/afterEach
  // console.warn wrapping, so the DELIBERATE warn is seen by the tracker instead
  // of the spy. The message text is specific enough that silencing it can't hide
  // a real defect elsewhere. Same philosophy as the PG connection-slot entries
  // above: a proven full-suite-only timing artifact, not a code signal.
  if (msg.includes('[implement-worker-exit] getPayload failed for')) return true;
  // seed-provider-git's readSubmodules emits ONE deliberate, informative warn when
  // .gitmodules declares a submodule with no checked-out working tree — the exact
  // skip behavior its own test exercises ("a fresh member will cold-clone it";
  // seed-provider-git.ts). Passes standalone and as a whole file; red ONLY on the
  // green gate's full forks-pool run in the CHECKPOINT tree (where real submodules
  // are legitimately not checked out, so any real-tree cut path fires it and the
  // WI-1660 attribution race pins it on whichever test is live). Message text is
  // specific enough that silencing it cannot hide a real defect elsewhere.
  if (msg.includes('[seed:git] skipping submodule')) return true;
  // wireHiveDirectoryAtBoot (hive-directory-boot.ts) deliberately catches a
  // per-hive publish failure and warns instead of throwing — the module's own
  // header states "a directory failure must NEVER break harness boot". A
  // "device keychain not wired" publish failure is a normal pre-boot-wiring
  // state (hive-directory-deps.ts's productionDeps().sign throws until
  // setHiveDirectoryTransport runs), not a code defect, and no test in
  // hive-directory-boot.test.ts / hives.test.ts exercises this path directly
  // (WI-2994: both pass standalone and together). Per the WI-1660/seed:git
  // precedent above, this deliberate best-effort warn gets misattributed to an
  // unrelated test running in the same forks-pool worker when it fires during
  // a full `npm run test:affected` run — silencing the exact message text
  // cannot hide a real defect elsewhere.
  if (msg.includes('[hive-directory] failed to publish hive')) return true;
  return false;
}
