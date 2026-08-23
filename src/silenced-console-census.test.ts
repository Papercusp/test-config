import { beforeEach, describe, expect, it } from 'vitest';
import { isSilencedConsoleMessage } from './console-noise-filter.ts';
import {
  readSilencedConsoleCensus,
  recordSilencedMessage,
  resetSilencedConsoleCensus,
  summariseSilencedConsole,
} from './silenced-console-census.ts';

/** The exact text `assertRealPgAllowed` throws (connection.ts), as a call site logs it. */
const RAIL_MESSAGE =
  'A UNIT test tried to open a REAL Postgres connection (pool "orgPg" → postgres://<redacted>@127.0.0.1:5432/papercusp). ' +
  'Unit tests must not touch a live database — inject the module\'s own seam double, or ' +
  'rename the file *.integration.test.ts to run it against a testcontainer. [EI-19311807188719573]';

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
});
