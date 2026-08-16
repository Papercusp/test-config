import { describe, it, expect } from 'vitest';
import { format } from 'node:util';
import { isSilencedConsoleMessage } from './console-noise-filter.ts';

describe('isSilencedConsoleMessage', () => {
  it('silences React act(...) hydration noise', () => {
    expect(
      isSilencedConsoleMessage('Warning: ... was not wrapped in act(...).'),
    ).toBe(true);
  });

  describe('PostgreSQL connection-pool exhaustion (SQLSTATE 53300) — shared-box load flake', () => {
    // These are the exact console-call shapes that tripped vitest-fail-on-console
    // on the 2026-06-17 green-checkpoint (candidate 02adbc35): all 43 failures
    // across 8 unit files were one of these two PG resource-limit messages,
    // surfaced through best-effort graceful-degradation log lines. They pass in
    // isolation; only the loaded full-suite run exhausts PG slots.
    const exhaustionCalls: Array<[string, unknown[]]> = [
      [
        '[wire-outbox] backfillLocalState failed for %s (continuing — drain still starts):',
        ['ws::shop', 'remaining connection slots are reserved for roles with the SUPERUSER attribute'],
      ],
      [
        '[outbox-drain] drain failed for ws::docs:',
        ['remaining connection slots are reserved for roles with the SUPERUSER attribute'],
      ],
      [
        '[adv-sessions] listPendingWorkbenchLaunches failed:',
        ['sorry, too many clients already'],
      ],
      [
        '[route-telemetry] write failed for GET /prompt-studio/sources:',
        ['remaining connection slots are reserved for roles with the SUPERUSER attribute (further telemetry write failures suppressed)'],
      ],
      [
        '[cross-hive] ask-ledger recordReply failed for corr-9:',
        ['remaining connection slots are reserved for roles with the SUPERUSER attribute'],
      ],
    ];

    it.each(exhaustionCalls)('silences %s', (first, rest) => {
      // Mirror how vitest-fail-on-console builds the silenceMessage arg:
      // util.format(firstArg, ...restArgs).
      expect(isSilencedConsoleMessage(format(first, ...rest))).toBe(true);
    });
  });

  it('silences the implement-worker-exit getPayload-failure deliberate warn (WI-1660 full-suite-only spy-timing flake)', () => {
    expect(
      isSilencedConsoleMessage(
        format('[implement-worker-exit] getPayload failed for %s (treating prior deaths as 0):', 'EI-716', new Error('pg down')),
      ),
    ).toBe(true);
  });

  it('silences the seed:git skipped-submodule deliberate warn (checkpoint-tree full-suite attribution race)', () => {
    expect(
      isSilencedConsoleMessage(
        format(
          "[seed:git] skipping submodule 'libs/retired' (%s) — not checked out in %s; a fresh member will cold-clone it.",
          '/tmp/x/libs/retired',
          '/tmp/x',
        ),
      ),
    ).toBe(true);
  });

  it('silences the hive-directory best-effort publish-failure warn (WI-2994 full-suite attribution race)', () => {
    // wireHiveDirectoryAtBoot (hive-directory-boot.ts) deliberately catches a
    // per-hive publish failure and warns rather than breaking harness boot (its
    // own header: "a directory failure must NEVER break harness boot"). The
    // "device keychain not wired" state is a normal pre-boot-wiring condition,
    // not a code defect — and per the WI-1660/seed:git precedent above, a
    // deliberate best-effort warn like this one gets misattributed to whatever
    // unrelated test is running in the same forks-pool worker when it fires
    // during a full-suite run (it never fires in isolated/whole-file runs of
    // hive-directory-boot.test.ts or hives.test.ts, which is why this only
    // shows up under `npm run test:affected` on the full tree).
    expect(
      isSilencedConsoleMessage(
        format(
          '[hive-directory] failed to publish hive %s: %s',
          'ash',
          'hive-directory: device keychain not wired (call setHiveDirectoryTransport at boot)',
        ),
      ),
    ).toBe(true);
  });

  it('silences the hive-directory boot-join-skipped best-effort warn (WI-1660 full-suite spy-race flake)', () => {
    // wireHiveDirectoryForWorkspace (hive-directory-boot.ts) deliberately catches an
    // identity-resolution failure on the lazy boot-join and warns rather than throwing
    // (its header: a gh-unauthenticated box SKIPS the directory and "must NEVER break
    // harness boot"). hive-directory-ensure.test.ts exercises + asserts this warn via a
    // console.warn spy; it only escapes the spy under the full forks-pool green-checkpoint
    // (the WI-1660/WI-2994 attribution race), so silencing the exact text keeps the gate
    // green without hiding a real defect.
    expect(
      isSilencedConsoleMessage(
        format(
          '[hive-directory] boot-join skipped for workspace %s: %s',
          'ws',
          'gh auth not ready',
        ),
      ),
    ).toBe(true);
  });

  it('silences the hive-directory request-only boot-join-SKIPPED deliberate warn (WI-5251: boot-all.test.ts red under a request-only test env)', () => {
    // wireHiveDirectoryForWorkspace (hive-directory-boot.ts, EI-9534/WI-953) fires a
    // SEPARATE, deliberately loud warn — distinct from the lowercase "skipped" case
    // above — when requestOnlyHost() is true (PAPERCUSP_BACKGROUND_WORKERS=0, or the
    // :3170 staging port). It is intentionally NOT gated behind !VITEST, so any test
    // that boots a harness under a request-only env (bootAllHarnessesForActiveWorkspace's
    // send-side wiring) hits it. Silencing the exact text keeps the gate green without
    // undoing the EI-9534 diagnosability fix or hiding a real defect.
    expect(
      isSilencedConsoleMessage(
        format(
          '[hive-directory] boot-join SKIPPED for workspace %s: requestOnlyHost()===true %s',
          'ws',
          '(PAPERCUSP_BACKGROUND_WORKERS=0, PAPERCUSP_HONO_PORT=<unset>)',
        ),
      ),
    ).toBe(true);
  });

  it('silences the docs-engine MDX-parse-fallback warn (WI-3842: an unrelated doc typo failed the docs-qa retrieval test)', () => {
    // renderMdxToMarkdown (docs-engine/render-mdx.ts) deliberately degrades a single
    // malformed doc to a raw-text fallback rather than throwing (EI-5860). The offending
    // doc already has its own owned detection+repair (content-lint's mdxDetector +
    // autoFixMdxAngles, wired into the git-sync content guard) that self-heals it on the
    // next tick, so this warn is transient box weather for the corpus-wide retrieval
    // test, not a code defect in the test's own subject.
    expect(
      isSilencedConsoleMessage(
        '[docs-engine] MDX parse failed for /abs/path/agent-insights/some-doc.mdx; using raw-text fallback so search/outline still work. ' +
          'Fix the doc (backtick raw <placeholders> / {expressions}). Cause: Unexpected character `5` (U+0035) before name, expected a character that can start a name, such as a letter, `$`, or `_`',
      ),
    ).toBe(true);
  });

  it('silences the harness-registry fire-and-forget sync-invalidate-notify warn (WI-4031 unawaited-promise attribution race)', () => {
    // notifyRegistryChanged (harness-registry.ts) is explicitly fire-and-forget — its
    // own header: "Fire-and-forget — a notify failure never blocks the write" — so the
    // background promise can settle after the triggering test has already finished,
    // landing this warn during whatever OTHER test is live in the same forks-pool
    // worker. Message text is specific enough that silencing it cannot hide a real
    // defect in the registry write path itself (that surfaces as a thrown error /
    // failed assertion, not this incidental best-effort log line).
    expect(
      isSilencedConsoleMessage(
        format(
          '[harness-registry] sync invalidate failed:',
          new TypeError('notifySyncInvalidate is not a function'),
        ),
      ),
    ).toBe(true);
  });

  it('silences the mem0 embedder-unavailable warn (warnOnce misattribution across the forks pool)', () => {
    // Mem0Backend.available() → resolveEmbedder warns once per worker when no embedder is
    // available — in CI ALWAYS an environment condition (no transformers, no OpenAI key),
    // never a code defect. warnOnce fires once per process so it lands on whichever test
    // first touches the memory backend. Silencing the exact prefix cannot hide a real
    // embedder regression (that surfaces as a thrown error / failed assertion in the
    // memory suite's dep-injected tests).
    expect(
      isSilencedConsoleMessage(
        '[mem0] embedder unavailable: harrier_forced_but_transformers_not_installed (set memoryEmbedderMode in /settings/user).',
      ),
    ).toBe(true);
  });

  it('silences the mem0 dynamic-import-callback warn (EI-11975: tryLoad warnOnce leaks across the forks pool under vitest)', () => {
    // Mem0Backend.available() → tryLoad() imports mem0 via a
    // `new Function('return import(specifier)')` trick that has no import callback under
    // vitest's module runner, so Node throws "A dynamic import callback was not specified.".
    // tryLoad's catch reports it via best-effort warnOnce; the async availability probe can
    // resolve during an UNRELATED test's window (it red-ed scheduler/get_next.warning.test.ts
    // via vitest-fail-on-console). A deterministic test-env condition, never a code defect —
    // same misattribution class as the embedder entry above; silencing the exact mem0-scoped
    // phrase cannot hide a real defect (the memory suite drives factories via dep injection
    // and never runs getMemoryClient() under vitest). warnOnce appends a '.', so the emitted
    // line double-periods — the substring match is period-insensitive on purpose.
    expect(
      isSilencedConsoleMessage('[mem0] A dynamic import callback was not specified..'),
    ).toBe(true);
  });

  it('silences the change-ledger best-effort record-failure warn (EI-380: an unrelated suite exercising a decideProposal-adjacent write path failed on this via vitest-fail-on-console)', () => {
    // recordBehaviorChange (change-ledger.ts) deliberately catches a ledger-insert
    // failure and warns instead of throwing — its own doc: "Best-effort: ... or the
    // write failed (warned loudly; the mutation it records proceeds regardless)".
    // Any suite exercising a write path wired to this hook (decideProposal's
    // after-accept FB-02 call, the repo scanner, ablation recording, …) without the
    // real org PG available hits this as an ENVIRONMENT condition (getOrgPg()
    // unreachable), not a code defect — the ledger's own correctness is covered by
    // change-ledger.integration.test.ts against a real testcontainer PG.
    expect(
      isSilencedConsoleMessage(
        format(
          '[change-ledger] FAILED to record %s change on %s — EKG attribution has a hole here:',
          'proposal-accept',
          'F-123',
          'getOrgPg is not configured',
        ),
      ),
    ).toBe(true);
  });

  it('silences the read-merge WI-2003 dead-letter quarantine console.error (EI-18140230738284514: boot.test.ts full-suite-only spy-race flake)', () => {
    // mergeAdmittedLogsIncremental (read-merge.ts) deliberately logs a loud
    // console.error when it dead-letters a persistently-unreadable op instead
    // of wedging the rest of the peer's log forever. boot.test.ts's WI-5340
    // case simulates exactly this and already spies+mocks console.error
    // around it, but — per the WI-1660/WI-2994/WI-3842/WI-4031 misattribution
    // class above — that spy occasionally loses the race against this
    // setup's own console.error wrapping under the full forks-pool run, so
    // the deliberate log escapes to vitest-fail-on-console (the test passed
    // standalone/whole-file 52/52 every time; only the full-suite watchdog
    // run saw this exact message in the failure tail).
    expect(
      isSilencedConsoleMessage(
        "[read-merge] WI-2003 quarantine: unreadable op at a1a1a1a1a1a1#1 after 3 consecutive read failures — advancing past it so the rest of this peer's " +
          'log can keep folding (this position itself never folds; if this is an identity-' +
          'divergence signature-verify rejection, re-grant/re-emit the underlying wraps so the ' +
          'sender re-publishes under a verifiable identity): WI-5340 test: simulated stuck zombie — block fetch never resolves',
      ),
    ).toBe(true);
  });

  it('silences the chat-actions throwing-available() deliberate warn (EI-18679764170567879: registry.test.ts full-suite-only spy-race flake)', () => {
    // listChatActions (chat-actions/registry.ts) deliberately catches a throwing
    // available() and warns instead of letting one broken action take down the
    // whole list. registry.test.ts's "a throwing available() is excluded, not
    // fatal to the whole list" case already spies+mocks console.warn around this
    // exact deliberate warn, but — per the WI-1660/WI-2994/WI-3842/WI-4031
    // misattribution class above — that spy occasionally loses the race against
    // this setup's own console.warn wrapping under the full forks-pool run, so
    // the deliberate warn escapes to vitest-fail-on-console.
    expect(isSilencedConsoleMessage('[chat-actions] broken.available threw')).toBe(true);
    // Keyed off both the tag and the suffix, not the dynamic action id in between.
    expect(isSilencedConsoleMessage('[chat-actions] some-other-id.available threw')).toBe(true);
  });

  it('silences the events:await advisory bounded-timeout degrade warns (EI-18679764170567879: announce.test.ts full-suite-only flake)', () => {
    // events:await's fail-soft near-miss / orphan-key advisory checks each wrap a
    // normally-instant lookup in withBoundedTimeout, which logs
    // `[bounded-timeout] <label> exceeded …ms — degrading to fallback` ONLY when
    // its real setTimeout deadline wins the race against the lookup — a
    // full-suite-only fork-pool scheduling artifact for these advisory,
    // already-fail-soft call sites, not a code defect.
    expect(
      isSilencedConsoleMessage('[bounded-timeout] events-await:nearMiss exceeded 1000ms — degrading to fallback'),
    ).toBe(true);
    expect(
      isSilencedConsoleMessage('[bounded-timeout] events-await:orphanKey exceeded 1500ms — degrading to fallback'),
    ).toBe(true);
    expect(
      isSilencedConsoleMessage(
        '[bounded-timeout] events-await:keyFireEvidence exceeded 1000ms — degrading to fallback',
      ),
    ).toBe(true);
    // Scoped to the events:await advisory labels only — a DIFFERENT bounded-timeout
    // caller (a genuinely slow/regressed read elsewhere) must still fail loudly.
    expect(
      isSilencedConsoleMessage('[bounded-timeout] fleet:status:presence exceeded 5000ms — degrading to fallback'),
    ).toBe(false);
  });

  it('silences the stalled-loops-guard second-source-veto deliberate warn (WI-6639/EI-19362678179163398: full-suite-only spy-race flake)', () => {
    // sweepStalledLoops (stalled-loops-guard.ts) deliberately warns when its
    // second-source veto refuses to disarm a turnsStalled owner that produced a
    // REAL turn inside the floor — the module's own comment: "a non-zero veto
    // count is the live tell that last_turn_at is under-reporting again". Its
    // own test file spies console.warn around the two cases that exercise this
    // path, but under the full forks-pool run the in-test spy occasionally loses
    // the race against this setup's own beforeEach/afterEach wrapping (the same
    // misattribution class as every entry above), so the deliberate warn escapes
    // to vitest-fail-on-console. Observed 2026-08-02: 10/10 standalone, 2/10 red
    // inside a full `npm run test:affected` run, unchanged on a fresh-process retry.
    expect(
      isSilencedConsoleMessage(
        '[stalled-loops-guard] VETO su-live: turnsStalled:true but a real turn landed 120s ago ' +
          '(lastTurnAt=2026-08-02T13:29:47.897Z, lastRealTurnAt=2026-08-02T17:27:47.897Z) — refusing to disarm. ' +
          'A non-zero veto count means last_turn_at is under-reporting (EI-19362678179163398).',
      ),
    ).toBe(true);
    // Message text is specific enough not to swallow an unrelated stalled-loops-guard
    // line that never made it into the exact "VETO" tag.
    expect(isSilencedConsoleMessage('[stalled-loops-guard] disarmed su-dead: no recent activity')).toBe(false);
  });

  it('silences the mem0 credential warn (EI-20299393830613909: unprovisioned-box weather)', () => {
    // The exact shape warnOnce emits (mem0-client.ts: console.warn(`[mem0] ${reason}.`)).
    // Whether it fires depends on how the RUN BOX is provisioned, not on the code
    // under test, so it reds any unit test that transitively reaches the memory
    // seam — work-items-urgent.test.ts failed this way 2× on 2026-08-12 despite
    // never touching memory itself.
    expect(
      isSilencedConsoleMessage(
        '[mem0] no Claude session and no Anthropic or OpenAI API key in operator-credentials ' +
          'or env (add at /settings/api-keys).',
      ),
    ).toBe(true);
    // Message text is specific enough not to swallow an unrelated [mem0] line —
    // a real memory-path defect must still red.
    expect(isSilencedConsoleMessage('[mem0] search failed for owner su-1: connection reset')).toBe(false);
    expect(isSilencedConsoleMessage('[mem0] failed to persist memory')).toBe(false);
  });

  describe('PostgreSQL UNREACHABLE (ECONNREFUSED) — the DOWN twin of the exhaustion entries (EI-13946)', () => {
    // The exact console shapes that tripped vitest-fail-on-console on a run box
    // with no reachable PG on :5432: orient.test.ts (gate-decisions fire-and-forget
    // capture) + boot-all.test.ts (wire-outbox backfill / outbox-drain LISTEN+drain).
    // Same best-effort catch-and-continue paths as the SQLSTATE-53300 exhaustion
    // block above, but the payload is a raw socket `connect ECONNREFUSED …` instead
    // of a PG resource-limit string, so the exhaustion entries never matched them.
    const econnrefused = 'connect ECONNREFUSED 127.0.0.1:5432';
    const downCalls: Array<[string, unknown[]]> = [
      [
        "[gate-decisions] capture failed (3 decision(s), first gate='orient.recall.queen-loop-withhold'); re-warns at most once/5min:",
        [econnrefused],
      ],
      [
        '[wire-outbox] backfillLocalState failed for ws-1::papercup (continuing — drain still starts):',
        [econnrefused],
      ],
      [
        '[outbox-drain] drain failed for ws-1::papercup:',
        [econnrefused],
      ],
      [
        '[outbox-drain] LISTEN setup failed for ws-1::papercup:',
        [econnrefused],
      ],
    ];
    it.each(downCalls)('silences %s', (first, rest) => {
      expect(isSilencedConsoleMessage(format(first, ...rest))).toBe(true);
    });

    it('does NOT silence an ECONNREFUSED that lacks a known best-effort path tag (match is keyed off the tag, not a broad ECONNREFUSED string)', () => {
      expect(
        isSilencedConsoleMessage(format('[some-route] handler error:', econnrefused)),
      ).toBe(false);
    });
  });

  describe('PostgreSQL FORBIDDEN — the unit-layer rail (WI-6869 / EI-19311807188719573)', () => {
    // The rail in setup-no-real-pg.ts makes assertRealPgAllowed throw instead of opening
    // a pool. At the SAME best-effort catch-and-continue call sites the exhaustion and
    // ECONNREFUSED blocks above already cover, that throw is caught and logged, and
    // vitest-fail-on-console then turns the log line into a failure. Verbatim message
    // text from libs/papercusp/libs/db/src/connection.ts, credentials pre-redacted by
    // the guard itself.
    const railError =
      'A UNIT test tried to open a REAL Postgres connection (pool "org-admin" → ' +
      'postgresql://<redacted>@localhost:5432/papercusp). Unit tests must not touch a live ' +
      "database — inject the module's own seam double, or rename the file " +
      '*.integration.test.ts to run it against a testcontainer. [EI-19311807188719573]';

    it('silences the rail message logged bare by a fail-open call site', () => {
      expect(isSilencedConsoleMessage(railError)).toBe(true);
    });

    it('silences it as a trailing console argument (the sync-sse onError shape that broke discord.test.ts)', () => {
      expect(isSilencedConsoleMessage(format('[sync-sse] notify failed:', railError))).toBe(true);
    });

    it('silences it when the pool label differs (match is keyed off the rail sentence, not one pool name)', () => {
      expect(
        isSilencedConsoleMessage(
          format('[adv-sessions] recordedLiveOwnerIds failed:', railError.replace('org-admin', 'harness-app')),
        ),
      ).toBe(true);
    });

    // WHY SILENCING THIS CANNOT HIDE THE HAZARD THE RAIL EXISTS TO CATCH, stated here
    // because it is the whole safety argument and it is NOT expressible as a case below.
    // A test whose ASSERTIONS depend on live DB rows still fails once its connection is
    // blocked — but it fails by THROWING an AssertionError, and a thrown error never
    // reaches this predicate at all. This filter is consulted only by
    // vitest-fail-on-console, i.e. only for console.error/console.warn arguments. So the
    // hazard class reds on its asserted path regardless of anything decided here; that is
    // observable in the WI-6869 split, where 14 of the 47 files fail exactly that way and
    // are deliberately left failing by this change.
    //
    // What the two cases below DO pin down is the blast radius: the match is keyed on the
    // rail's own sentence, so an unrelated failure logged by the very same best-effort
    // call site still fails loudly.
    it('does NOT silence a different error from the same best-effort call site', () => {
      expect(
        isSilencedConsoleMessage(
          format('[sync-sse] notify failed:', 'duplicate key value violates unique constraint "foo_pkey"'),
        ),
      ).toBe(false);
    });

    it('does NOT silence an unrelated error that merely mentions Postgres', () => {
      expect(
        isSilencedConsoleMessage(format('[some-route] handler error:', 'Postgres connection lost mid-query')),
      ).toBe(false);
    });
  });

  it('does NOT silence a genuine application error (e.g. a real PG constraint violation)', () => {
    expect(
      isSilencedConsoleMessage(
        format('[some-route] handler error:', 'duplicate key value violates unique constraint "foo_pkey"'),
      ),
    ).toBe(false);
  });

  it('does NOT silence an unrelated warning', () => {
    expect(isSilencedConsoleMessage('something unexpected happened')).toBe(false);
  });

  it('returns false for non-string input', () => {
    expect(isSilencedConsoleMessage(undefined)).toBe(false);
    expect(isSilencedConsoleMessage({ message: 'too many clients already' })).toBe(false);
  });
});
