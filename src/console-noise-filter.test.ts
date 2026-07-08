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
