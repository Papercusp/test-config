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
  // PostgreSQL UNREACHABLE (ECONNREFUSED) — the DOWN twin of the exhaustion
  // entries above. The exact same best-effort graceful-degradation paths log
  // when the box's native PG isn't running/reachable at all (e.g. a unit-test
  // box with no PG on :5432, or the checkpoint tree booting before PG is up)
  // instead of when its pool is full — a raw socket `connect ECONNREFUSED …`
  // where the exhaustion case carries SQLSTATE 53300. These paths are
  // best-effort by construction (each catches+continues; gate-decisions'
  // own doc: "a telemetry outage must never fail an orientation"; wire-outbox:
  // "continuing — drain still starts"), so ANY failure they log — down OR
  // exhausted — is environment weather, not a code signal (a real regression
  // in one of these paths surfaces as a thrown error / failed assertion on the
  // asserted path, never as this incidental best-effort log line). Keyed off
  // each path's UNIQUE tag (not a generic ECONNREFUSED string) so the match
  // stays exact and cannot silence an unrelated connection error. Without this
  // the ECONNREFUSED variant tripped vitest-fail-on-console on orient.test.ts
  // (gate-decisions capture) + boot-all.test.ts (wire-outbox / outbox-drain)
  // whenever the run box had no reachable PG (EI-13946).
  if (msg.includes('[gate-decisions] capture failed')) return true;
  if (msg.includes('[wire-outbox] backfillLocalState failed for')) return true;
  if (msg.includes('[outbox-drain] drain failed for')) return true;
  if (msg.includes('[outbox-drain] LISTEN setup failed for')) return true;
  // PostgreSQL FORBIDDEN — the third variant of the same condition as the two blocks
  // above (pool exhausted / server unreachable), and the only one that is deliberate:
  // the unit-layer rail in setup-no-real-pg.ts pins PAPERCUSP_FORBID_REAL_PG=1, so
  // assertRealPgAllowed (libs/papercusp/libs/db/src/connection.ts) THROWS at buildClient
  // rather than opening a real pool. The rail is correct and stays — this entry does not
  // weaken it, because the throw still happens and the connection is still never opened.
  // What this silences is only the DOWNSTREAM LOG at the same best-effort call sites the
  // entries above already cover: each catches+continues, so the rail's own message lands
  // as an incidental console.error/warn, and vitest-fail-on-console then converts that log
  // line into a test failure. That is what red-pinned the green-checkpoint on 2026-08-02
  // (WI-6869): 47 unit files failed within 18 minutes of the rail landing, 33 of them via
  // this exact path, every one of which had passed on the run 24 minutes earlier.
  // CRITICALLY, this cannot hide the hazard the rail exists to catch. A test whose
  // ASSERTIONS depend on live DB rows still fails — blocking its connection turns its
  // assertion red on the asserted path (the remaining 14 files of that 47 fail exactly
  // this way, and are deliberately left failing). Only a test that never needed the pool
  // in the first place goes quiet, which is the correct verdict for it. Same philosophy,
  // and the same wording, as the exhaustion/unreachable entries: a real regression on a
  // best-effort path surfaces as a thrown error or a failed assertion, never as this
  // incidental log line.
  if (msg.includes('A UNIT test tried to open a REAL Postgres connection')) return true;
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
  // wireHiveDirectoryForWorkspace (hive-directory-boot.ts, EI-9534/WI-953) fires a
  // SEPARATE, DELIBERATELY LOUD warn (distinct from the lowercase "skipped" entry
  // above, which covers a different catch — an identity-resolution failure) when
  // requestOnlyHost() is true: a request-only host (PAPERCUSP_BACKGROUND_WORKERS=0,
  // or the :3170 staging port) must never join the P2P hive-directory swarm, and
  // this early-return is intentionally NOT gated behind !VITEST (the module's own
  // comment: "a request-only host correctly skipping this is a real, useful fact to
  // see once per process, not spam") so it bites in every process, tests included.
  // bootAllHarnessesForActiveWorkspace's send-side wiring (boot-all.ts) calls this on
  // every workspace it boots, so ANY boot-all test running under a request-only test
  // env hits it (WI-5251: 6 subtests in boot-all.test.ts). Demoting the warn itself
  // would undo the EI-9534 diagnosability fix; the message text is specific enough
  // that silencing it here cannot hide a real defect elsewhere (a genuine directory-
  // wiring regression on a background-workers host surfaces as a thrown error /
  // failed assertion, not this incidental, intentional log line).
  if (msg.includes('[hive-directory] boot-join SKIPPED for workspace')) return true;
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
  // notifyRegistryChanged (harness-registry.ts) fires a FIRE-AND-FORGET background
  // promise after every registry mutation (dynamic-imports sync-sse, then calls
  // notifySyncInvalidate) — the module's own header states "Fire-and-forget — a
  // notify failure never blocks the write". Because it is never awaited by the
  // caller, the promise can settle well after the triggering test has finished,
  // landing its console.warn during whatever OTHER test is live in the same
  // forks-pool worker (WI-4031: federation-all-content-types-sidecar.repro
  // .integration.test.ts's MEMBER→OWNER case intermittently failed on this, having
  // done nothing but run right after an earlier mutateHarnessRegistry call's
  // notify settled late). Same misattribution class as the WI-1660/WI-2994/WI-3842
  // entries above. Message text is specific enough that silencing it cannot hide a
  // real defect elsewhere (a real regression in notifyRegistryChanged's write path
  // surfaces as a thrown error / failed assertion, not this incidental best-effort
  // log line).
  if (msg.includes('[harness-registry] sync invalidate failed')) return true;
  // Mem0Backend.available() → resolveEmbedder() (mem0-client.ts warnOnce) emits ONE
  // best-effort warn when no embedder is available — in the test env ALWAYS an
  // ENVIRONMENT condition, never a code defect: CI has no @huggingface/transformers
  // installed and no OpenAI key, so the default 'harrier'/'gemma'/'local' preference
  // resolves to disabled with a `<mode>_forced_but_transformers_not_installed` /
  // `..._no_key` reason. warnOnce fires ONCE per worker process, so under the full
  // forks-pool run it lands on whichever test FIRST touches the memory backend
  // (work-items-urgent, scheduler:get_next, … — none of which exercise the embedder),
  // exactly the WI-1660 misattribution class as the entries above. A real embedder
  // regression surfaces as a thrown error / failed assertion in the memory suite's own
  // dep-injected tests (configure/resolveEmbedderWith), not this incidental degrade log.
  if (msg.includes('[mem0] embedder unavailable:')) return true;
  // Mem0Backend.available() → getMemoryClient() → tryLoad() (mem0-client.ts) resolves
  // the mem0 package via a `new Function('return import(specifier)')` dynamicImport trick
  // (mem0-client.ts:310). Under vitest's module runner that eval'd function has NO import
  // callback wired in, so Node throws "A dynamic import callback was not specified." — a
  // DETERMINISTIC test-env-only condition, never a code defect (in production the real
  // module context supplies the callback and the import succeeds; a genuine mem0-load
  // failure surfaces as MODULE_NOT_FOUND via the poison-cache rung, a different message).
  // tryLoad's catch reports it via the same best-effort warnOnce, and — like the embedder
  // entry above — that warn fires from an ASYNC availability probe that can resolve during
  // an UNRELATED test's window (seen red-ing scheduler/get_next.warning.test.ts in a full
  // forks-pool `npm run test:affected` run; EI-11975). Same WI-1660 misattribution class:
  // the memory suite's own tests drive the factories via dep injection and never run
  // getMemoryClient() under vitest (mem0-client.test.ts's own header notes this), so
  // silencing this exact mem0-scoped phrase cannot hide a real defect elsewhere.
  if (msg.includes('[mem0] A dynamic import callback was not specified')) return true;
  // notifyOperatorHindsight leg 2 (operator-hindsight.ts) deliberately catches a
  // shared-conversation append failure and warns instead of throwing — the
  // function's own doc: "fail-soft both ways: a thread-append failure never loses
  // the coord notify". In a test env WITHOUT the operator-conversations substrate
  // (delegated-tasks.integration.test.ts wires only the coord fixture; the
  // conversations DB handle is undefined there) the append ALWAYS degrades — an
  // ENVIRONMENT condition, not a code defect (operator-chat-sidebar-revival P-008,
  // 2026-07-13). The leg-1 coord push those tests assert on is unaffected. Message
  // text is specific enough that silencing it cannot hide a real defect elsewhere
  // (a real regression in the append path surfaces as a failed assertion in
  // operator-hindsight.test.ts's dep-mocked two-delivery tests, not this
  // incidental best-effort log line).
  if (msg.includes('[operator-hindsight] shared-thread append failed')) return true;
  // recordBehaviorChange (change-ledger.ts) deliberately catches a ledger-insert
  // failure and warns instead of throwing — the function's own doc: "Best-
  // effort: ... or the write failed (warned loudly; the mutation it records
  // proceeds regardless)". Any suite that exercises a write path wired to this
  // hook (decideProposal's after-accept FB-02 call, the repo scanner, ablation
  // recording, …) WITHOUT the real org PG available (most unit/integration
  // suites don't need it) hits this warn as an ENVIRONMENT condition, not a
  // code defect — getOrgPg() is unreachable, not a broken ledger (EI-380). The
  // ledger's OWN correctness is covered by change-ledger.integration.test.ts,
  // which runs against a real testcontainer PG and asserts on the write itself
  // rather than spying this warn. Message text is specific enough that
  // silencing it cannot hide a real defect elsewhere (a real regression in
  // recordBehaviorChange surfaces as a failed assertion in that suite, not
  // this incidental best-effort log line landing in an unrelated caller).
  if (msg.includes('[change-ledger] FAILED to record')) return true;
  // mergeAdmittedLogsIncremental (read-merge.ts) deliberately logs a loud
  // console.error when it DEAD-LETTERS a persistently-unreadable op (the
  // WI-2003 quarantine path: advance past the position instead of wedging
  // the rest of the peer's log forever) — the module's own comment calls
  // this the fix for "the pre-fix behavior: silent REV fed_event outage
  // class", i.e. it is meant to be LOUD, not silent, in production.
  // boot.test.ts's WI-5340 case ("re-attach that does NOT restore ingest")
  // deliberately simulates this exact quarantine path and already
  // `vi.spyOn(console, 'error').mockImplementation(...)`s around it — but,
  // per the WI-1660/WI-2994/WI-3842/WI-4031 misattribution class documented
  // above, that in-test spy occasionally loses the race against this
  // setup's own beforeEach/afterEach console.error wrapping under the full
  // forks-pool green-checkpoint run, so the deliberate log reaches
  // vitest-fail-on-console instead of the spy (EI-18140230738284514: passed
  // standalone/whole-file every time — 52/52 — but watchdog-flagged red 4×/6h
  // on the full-suite run with this exact message in the failure tail).
  // Message text is specific enough that silencing it cannot hide a real
  // defect elsewhere (a genuine read-merge regression surfaces as a failed
  // assertion in read-merge-read-throw.test.ts's own dedicated coverage of
  // this codepath, not this incidental — and intentionally loud — log line).
  if (msg.includes('[read-merge] WI-2003 quarantine:')) return true;
  // embed-backfill's WI-7327 stale-latch takeover is deliberately LOUD: a sweep
  // that hangs pins the `running` latch and silently disables ALL future backfill
  // (measured 2026-08-03 — 451k rows unembedded, zero log output for ~9.5h), so
  // recovering from it quietly would recreate the invisibility that caused the
  // outage. embed-backfill.test.ts's "takes over a STALE latch" case exercises this
  // exact path; per the WI-1660/WI-2994/WI-3842/WI-4031/EI-18140230738284514
  // misattribution class documented above, an in-test spy does NOT reliably catch
  // it (observed here: the spy recorded '' while the takeover provably ran), so the
  // test asserts the BEHAVIOUR — that the latch is seized and released — and the
  // log is silenced here instead. Message text is specific enough that silencing it
  // cannot mask a real defect: a takeover regression fails that test's own
  // assertions, not this line.
  if (msg.includes('[embed-backfill] STALE LATCH:')) return true;
  // chat-actions registry.ts's listChatActions() deliberately catches a throwing
  // available() and warns instead of letting one broken action take down the
  // whole list — the module's own comment: "logged, not fatal". registry.test.ts's
  // "a throwing available() is excluded, not fatal to the whole list" case
  // deliberately `vi.spyOn(console, 'warn').mockImplementation(...)`s around this
  // exact deliberate warn — the SAME WI-1660/WI-2994/WI-3842/WI-4031/
  // EI-18140230738284514 misattribution class documented above: under the full
  // forks-pool green-checkpoint run the in-test spy occasionally loses the race
  // against this setup's own beforeEach/afterEach console.warn wrapping, so the
  // deliberate warn reaches vitest-fail-on-console instead of the spy (filed as
  // EI-18679764170567879 — "3 named tests flake-absorbed on the release gate";
  // passes standalone and as a whole file every time, per that ticket). Message
  // text is specific enough that silencing it cannot hide a real defect elsewhere
  // (a genuine registry regression surfaces as a failed assertion in
  // registry.test.ts's own listChatActions coverage, not this incidental —
  // intentionally logged — line).
  if (msg.includes('[chat-actions]') && msg.includes('.available threw')) return true;
  // events:await's advisory, fail-soft best-effort checks (event-key-nearmiss-guard
  // P-003/P-005, EI-10870's orphan-key guard) each wrap a normally-instant mocked/
  // cheap lookup in withBoundedTimeout — a real `setTimeout` raced via Promise.race
  // against the lookup, logging `[bounded-timeout] <label> exceeded …ms — degrading
  // to fallback` ONLY when the deadline wins. announce.test.ts's "a LAPSED
  // declaration (fired_reason=expired) is NOT a latch" and "annotates the
  // registration when only a near-identical key is active" cases both hit this code
  // path (no matching *unfired* announcement ⇒ the orphan-key/near-miss checks run)
  // with mocks that resolve in a microtask — under normal load the real timer never
  // wins, but under the shared host's heavy multi-fork contention the event loop can
  // be starved long enough for the deadline to fire first, which is a scheduling
  // artifact of the fork-pool full-suite run, not a code defect (EI-18679764170567879
  // — investigated: reproduces in neither an isolated run nor 24 concurrent copies of
  // this file under a genuinely loaded 112-core host; the callers of
  // withBoundedTimeout here are explicitly fail-soft/advisory and already degrade
  // gracefully on a real timeout — a genuine regression in the underlying lookups
  // surfaces as a failed assertion on their own dedicated coverage, not this
  // incidental best-effort log line). Scoped to the events:await advisory labels
  // only, not `[bounded-timeout]` generally, so a genuinely slow/regressed bounded
  // read elsewhere still fails loudly.
  if (
    msg.includes('[bounded-timeout] events-await:nearMiss') ||
    msg.includes('[bounded-timeout] events-await:orphanKey') ||
    msg.includes('[bounded-timeout] events-await:keyFireEvidence')
  ) {
    return true;
  }
  // sweepStalledLoops (stalled-loops-guard.ts, WI-6639/EI-19362678179163398) deliberately
  // warns on its second-source veto path — the module's own comment: "a non-zero veto
  // count is the live tell that last_turn_at is under-reporting again, and it must reach
  // the operator log rather than vanish". stalled-loops-guard.test.ts's own "REFUSES to
  // disarm a turnsStalled owner that produced a real turn inside the floor" and "sizes the
  // veto window from turnsStalledFloorMs" cases deliberately exercise this path and already
  // `vi.spyOn(console, 'warn').mockImplementation(...)` around it — the SAME WI-1660/
  // WI-2994/WI-3842/WI-4031/EI-18140230738284514/EI-18679764170567879 misattribution class
  // documented above: under the full forks-pool run the in-test spy occasionally loses the
  // race against this setup's own beforeEach/afterEach console.warn wrapping, so the
  // deliberate warn reaches vitest-fail-on-console instead of the spy (observed 2026-08-02:
  // passes standalone and as a whole file every time — 10/10 — but 2/10 failed exactly this
  // way inside a full `npm run test:affected` run, verdict unchanged on a fresh-process
  // HARDEN-GATE retry). Message text is specific enough that silencing it cannot hide a
  // real defect elsewhere (a genuine veto-logic regression surfaces as a failed assertion
  // on `res.vetoedByRecentTurn` / `autoPause` in this file's own dedicated coverage, not
  // this incidental — intentionally loud — log line).
  if (msg.includes('[stalled-loops-guard] VETO')) return true;
  // Same module, same reasoning, second deliberate warn path (EI-19406534159939583): the
  // FIRE-STARVED branch re-arms rather than disarms a loop whose owner answered its last fire
  // and is still reachable, and that finding MUST reach the operator log — it means the
  // loop-firing path stopped serving live agents, which is an infrastructure fault no agent
  // will report on its own. Its dedicated tests spy on console.warn, so this entry covers only
  // the same spy-vs-setup race documented for the VETO line above; a real regression still
  // surfaces as a failed assertion on `res.reArmedFireStarved` / `rearm` / `autoPause`.
  if (msg.includes('[stalled-loops-guard] FIRE-STARVED')) return true;
  // mem0-client's warnOnce credential notice — the CREDENTIAL twin of the
  // MEM0_TELEMETRY pin in setup-hermetic-env.ts, and the same "environment
  // weather, not a code signal" class as the PG entries above. resolveLlm falls
  // back and continues when the box has no Claude session and no Anthropic/OpenAI
  // key (the warn's own text points a human at /settings/api-keys), so whether it
  // fires depends entirely on how the RUN BOX is provisioned — not on the code
  // under test. Any unit test that transitively reaches the memory seam therefore
  // reds on an unprovisioned box and passes on a provisioned one: observed
  // 2026-08-12 on work-items-urgent.test.ts (EI-20299393830613909), which only
  // mocks ./pot/urgent-wake and never touches memory itself, failing 2× at
  // 14:18Z/14:22Z this way while passing on either side. Keyed off the unique
  // `[mem0]` tag + the exact reason text, so it cannot silence an unrelated
  // memory warning; a genuine regression in the LLM-resolution path surfaces as a
  // thrown error / failed assertion in mem0-client's own coverage, never as this
  // incidental once-per-process log line.
  if (msg.includes('[mem0] no Claude session and no Anthropic or OpenAI API key')) return true;
  return false;
}
