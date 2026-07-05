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
