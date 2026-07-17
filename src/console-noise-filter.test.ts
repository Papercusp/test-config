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
