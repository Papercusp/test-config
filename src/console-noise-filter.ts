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
  // ensureHiveDirectoryWired/wireHiveDirectoryForWorkspace (hive-directory-boot.ts)
  // deliberately catches an identity-resolution failure on the lazy boot-join and
  // warns instead of throwing — the module's own header: "a gh-unauthenticated box
  // ... SKIPS the directory and returns null — it must NEVER break harness boot".
  // hive-directory-ensure.test.ts EXERCISES this path on purpose (its "force retries
  // after a failed unforced attempt" case spies console.warn and asserts this exact
  // warn was emitted). Passes standalone and whole-file every time; red ONLY on the
  // green gate's full forks-pool run, where — per the WI-1660/WI-2994 precedent above
  // — the test's spy occasionally loses the race against this setup's beforeEach/
  // afterEach console.warn wrapping, so the DELIBERATE warn reaches the tracker
  // instead of the spy and misattributes to whichever test is live in the worker.
  // The message text is specific enough that silencing it cannot hide a real defect
  // elsewhere (a real regression on this path surfaces as a thrown error / a failed
  // assertion, not this incidental best-effort log line).
  if (msg.includes('[hive-directory] boot-join skipped for workspace')) return true;
  // renderMdxToMarkdown (docs-engine/render-mdx.ts) deliberately catches a single
  // doc's MDX compile failure (a raw un-backticked `<digit`/`<word>` placeholder or
  // an unparseable `{expr}`) and degrades to a raw-text fallback so ONE malformed
  // doc can't blind the whole corpus's search/outline (EI-5860) — the module's own
  // header states this must NEVER throw. This exact content-error class already has
  // its OWN owned detection+repair system (packages/operator-core/lib/content-lint's
  // mdxDetector, wired into the git-sync content guard, with a deterministic
  // autoFixMdxAngles pre-pass) that self-heals the offending doc on the next
  // git-sync tick — so the doc gets fixed regardless of this warn. Without silencing,
  // ANY doc anywhere in the ~600-page corpus with this common typo fails the
  // UNRELATED full-corpus retrieveDocsContext test (docs-qa.test.ts) via
  // vitest-fail-on-console (WI-3842), misattributing a content-lint matter to the
  // wrong file. Message text is specific enough that silencing it cannot hide a
  // real defect elsewhere (a real regression in renderMdxToMarkdown itself surfaces
  // as a thrown error / failed assertion in render-mdx.test.ts, not this incidental
  // best-effort log line).
  if (msg.includes('[docs-engine] MDX parse failed for')) return true;
  return false;
}
