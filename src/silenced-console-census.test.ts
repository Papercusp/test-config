import { beforeEach, describe, expect, it } from 'vitest';
import { isSilencedConsoleMessage } from './console-noise-filter.ts';
import {
  readSilencedConsoleCensus,
  readSilencedConsoleExemplars,
  recordSilencedMessage,
  resetSilencedConsoleCensus,
  summariseSilencedConsole,
} from './silenced-console-census.ts';

/** The exact text `assertRealPgAllowed` throws (connection.ts), as a call site logs it. */
const RAIL_MESSAGE =
  'A UNIT test tried to open a REAL Postgres connection (pool "orgPg" → postgres://<redacted>@127.0.0.1:5432/papercusp). ' +
  'Unit tests must not touch a live database — inject the module\'s own seam double, or ' +
  'rename the file *.integration.test.ts to run it against a testcontainer. [EI-19311807188719573]';

/**
 * The same rail text as a FAIL-SOFT WRAPPER actually logs it, which is the shape
 * that reaches the console hook in practice. `assertRealPgAllowed` THROWS and never
 * writes to console itself; `inbox-wake.ts` catches that throw and logs its own
 * message with `${e.message}` interpolated — so the subsystem prefix LEADS and the
 * rail's text trails.
 */
const WRAPPED_RAIL_MESSAGE =
  '[inbox-wake] idle-probe roster read failed, reporting no idle recipients: ' + RAIL_MESSAGE;

describe('silenced-console census (EI-21253580842180372)', () => {
  beforeEach(() => {
    resetSilencedConsoleCensus();
  });

  it('counts a suppressed no-real-PG rail message in its own bucket', () => {
    recordSilencedMessage(RAIL_MESSAGE);
    recordSilencedMessage(RAIL_MESSAGE);
    expect(readSilencedConsoleCensus()['real-pg-blocked']).toBe(2);
  });

  it('names the count in the summary line', () => {
    recordSilencedMessage(RAIL_MESSAGE);
    const summary = summariseSilencedConsole();
    expect(summary).toContain('1 unit-layer real-PG connections blocked');
    expect(summary).toContain('EI-19311807188719573');
  });

  it('stays silent when only ordinary allowlisted noise was suppressed', () => {
    // Ordinary noise is EXPECTED in a healthy run. Emitting a line per file for
    // it would reintroduce exactly the noise the allowlist exists to remove.
    recordSilencedMessage('Warning: something was not wrapped in act(...).');
    expect(readSilencedConsoleCensus().other).toBe(1);
    expect(summariseSilencedConsole()).toBeNull();
  });

  it('reports nothing on a clean run', () => {
    expect(summariseSilencedConsole()).toBeNull();
    expect(readSilencedConsoleCensus()).toEqual({});
  });

  it('ignores non-string input instead of throwing', () => {
    // Runs inside the console hook of every test in the monorepo: it may never
    // be the reason a test fails.
    expect(() => recordSilencedMessage(undefined)).not.toThrow();
    expect(() => recordSilencedMessage({ toString: null } as unknown)).not.toThrow();
    expect(summariseSilencedConsole()).toBeNull();
  });

  it('resets between files, so a reused worker cannot inflate a later file', () => {
    recordSilencedMessage(RAIL_MESSAGE);
    resetSilencedConsoleCensus();
    expect(summariseSilencedConsole()).toBeNull();
  });

  /**
   * DRIFT GUARD. The census bucket matches on the same substring the allowlist
   * silences. Those are two copies of one truth in two files, so reword the
   * allowlist entry and the bucket silently stops counting — the census would
   * then report a confident zero, which is the exact failure it was built to
   * end. Pin them together: the message must be BOTH silenced AND bucketed.
   */
  it('bucket and allowlist entry agree on the rail message', () => {
    expect(isSilencedConsoleMessage(RAIL_MESSAGE)).toBe(true);
    recordSilencedMessage(RAIL_MESSAGE);
    expect(readSilencedConsoleCensus()['real-pg-blocked']).toBe(1);
    expect(readSilencedConsoleCensus().other).toBeUndefined();
  });

  /**
   * Falsifiability control for the guard above: a message the allowlist does
   * NOT silence must not land in the rail bucket. Without this, a bucket that
   * matched everything would pass every assertion here.
   */
  it('does not bucket an unrelated message as a rail violation', () => {
    recordSilencedMessage('some unrelated failure text');
    expect(readSilencedConsoleCensus()['real-pg-blocked']).toBeUndefined();
  });

  /**
   * EI-19417655142979569 — the count says the rail FIRED; these say WHICH
   * subsystem degraded. The wrapper's own prefix is interpolated into the string
   * the console hook receives, and the census used to discard it at the exact
   * moment it held it.
   */
  describe('exemplars', () => {
    it('retains the fail-soft wrapper prefix, which a count alone cannot express', () => {
      // The precise loss behind this item: an agent seeing only a count still
      // cannot tell that the ROSTER READ was the path that degraded.
      recordSilencedMessage(WRAPPED_RAIL_MESSAGE);
      expect(summariseSilencedConsole()).toContain(
        '[inbox-wake] idle-probe roster read failed',
      );
      expect(readSilencedConsoleExemplars()['real-pg-blocked']).toHaveLength(1);
    });

    it('dedupes repeats of one wrapper but keeps DISTINCT wrappers apart', () => {
      recordSilencedMessage(WRAPPED_RAIL_MESSAGE);
      recordSilencedMessage(WRAPPED_RAIL_MESSAGE);
      recordSilencedMessage(`[hive-rekey] boot deps fail-open: ${RAIL_MESSAGE}`);
      expect(readSilencedConsoleExemplars()['real-pg-blocked']).toHaveLength(2);
      // The tally still counts EVERY occurrence — exemplars bound the retained
      // TEXT, never the count. A fix that traded the count away would fail here.
      expect(readSilencedConsoleCensus()['real-pg-blocked']).toBe(3);
    });

    it('caps retained texts so a hot path cannot reintroduce per-occurrence noise', () => {
      for (let i = 0; i < 25; i += 1) {
        recordSilencedMessage(`[wrapper-${i}] read failed: ${RAIL_MESSAGE}`);
      }
      expect(readSilencedConsoleExemplars()['real-pg-blocked']).toHaveLength(3);
      expect(readSilencedConsoleCensus()['real-pg-blocked']).toBe(25);
    });

    it('truncates from the TAIL, keeping the leading subsystem prefix', () => {
      recordSilencedMessage(WRAPPED_RAIL_MESSAGE);
      const [sample] = readSilencedConsoleExemplars()['real-pg-blocked'];
      // The prefix is the diagnostic; the rail's boilerplate trails and is the
      // half worth dropping.
      expect(sample.startsWith('[inbox-wake] idle-probe roster read failed')).toBe(true);
      expect(sample.length).toBeLessThanOrEqual(241);
      expect(WRAPPED_RAIL_MESSAGE.length).toBeGreaterThan(241);
    });

    it('keeps no exemplars for ordinary allowlisted noise', () => {
      // Same reason the summary stays null for `other`: expected noise in a
      // healthy run, and quoting it back is the noise the allowlist removes.
      recordSilencedMessage('Warning: something was not wrapped in act(...).');
      expect(readSilencedConsoleExemplars().other).toBeUndefined();
      expect(summariseSilencedConsole()).toBeNull();
    });

    it('clears exemplars on reset, so a reused worker cannot leak an earlier file text', () => {
      recordSilencedMessage(WRAPPED_RAIL_MESSAGE);
      resetSilencedConsoleCensus();
      expect(readSilencedConsoleExemplars()).toEqual({});
    });

    /**
     * END-TO-END through the REAL console hook, not the module seam. Every other
     * test here calls `recordSilencedMessage` directly, which cannot detect the
     * failure that would matter most: `setup-fail-on-console.ts` no longer
     * routing suppressions into the census, leaving it a confident permanent
     * zero — the exact defect it was built to end.
     *
     * This test is self-falsifying in BOTH directions, which is what makes it
     * worth its cost. `shouldFailOnWarn: true` means an un-silenced
     * `console.warn` FAILS this test outright, so reaching the assertions at all
     * proves the allowlist matched the WRAPPED text (the item's core claim: a
     * fail-soft handler silences its own wrapper log). And the assertions then
     * prove the silenced message was counted rather than merely swallowed.
     */
    it('a real console.warn of a WRAPPED rail message is silenced AND censused', () => {
      console.warn(WRAPPED_RAIL_MESSAGE);
      expect(readSilencedConsoleCensus()['real-pg-blocked']).toBe(1);
      expect(readSilencedConsoleExemplars()['real-pg-blocked']?.[0]).toContain(
        '[inbox-wake] idle-probe roster read failed',
      );
    });
  });
});
