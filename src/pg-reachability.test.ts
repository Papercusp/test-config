/**
 * pg-reachability.test.ts — EI-2627.
 *
 * `probePgReachable` must ride out a TRANSIENT startup/recovery race with a
 * bounded retry, but fail immediately (no retry) on a genuine staleness/config
 * error like "no such database". `assertPgReachable` must throw an actionable,
 * EI-2627-tagged error on final failure.
 *
 * `postgres` is mocked so no real DB connection is ever opened; fake timers
 * drive the retry backoff deterministically (mirrors pg-notify-bus.test.ts's
 * pattern).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const unsafe = vi.fn();
const end = vi.fn().mockResolvedValue(undefined);
const postgresFactory = vi.fn((_url?: string, _opts?: unknown) => ({ unsafe, end }));

vi.mock('postgres', () => ({
  default: (url?: string, opts?: unknown) => postgresFactory(url, opts),
}));

import { assertPgReachable, probePgReachable, withPgStartupRetry } from './pg-reachability.ts';

describe('probePgReachable — EI-2627', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    unsafe.mockReset();
    end.mockReset().mockResolvedValue(undefined);
    postgresFactory.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns ok:true immediately on a successful SELECT 1, closing the probe client', async () => {
    unsafe.mockResolvedValueOnce(undefined);
    const result = await probePgReachable('postgres://x', 5000);
    expect(result.ok).toBe(true);
    expect(unsafe).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('retries a transient "not yet accepting connections" error, then succeeds', async () => {
    unsafe
      .mockRejectedValueOnce(new Error('the database system is not yet accepting connections'))
      .mockResolvedValueOnce(undefined);
    const resultPromise = probePgReachable('postgres://x', 5000);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(unsafe).toHaveBeenCalledTimes(2);
  });

  it('retries PostgreSQL 57P03 "database system is starting up", then succeeds', async () => {
    unsafe.mockRejectedValueOnce(new Error('the database system is starting up')).mockResolvedValueOnce(undefined);
    const resultPromise = probePgReachable('postgres://x', 5000);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(unsafe).toHaveBeenCalledTimes(2);
  });

  it('retries an "in recovery mode" error and an ECONNREFUSED alike', async () => {
    unsafe
      .mockRejectedValueOnce(new Error('FATAL: the database system is in recovery mode'))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:5432'))
      .mockResolvedValueOnce(undefined);
    const resultPromise = probePgReachable('postgres://x', 5000);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(unsafe).toHaveBeenCalledTimes(3);
  });

  it('fails FAST (no retry) on a genuine staleness error like "no such database"', async () => {
    unsafe.mockRejectedValueOnce(new Error('no such database: papercusp_it'));
    const result = await probePgReachable('postgres://x', 5000);
    expect(result.ok).toBe(false);
    expect(result.lastError).toMatch(/no such database/);
    // Not retryable — must not have waited/retried at all.
    expect(unsafe).toHaveBeenCalledTimes(1);
  });

  it('gives up once the retry budget is exhausted on a persistent transient error', async () => {
    unsafe.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    const resultPromise = probePgReachable('postgres://x', 700);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.lastError).toMatch(/ECONNREFUSED/);
    // Bounded: didn't retry forever.
    expect(unsafe.mock.calls.length).toBeGreaterThan(1);
    expect(unsafe.mock.calls.length).toBeLessThan(20);
  });

  it('always closes the probe client, even on failure', async () => {
    unsafe.mockRejectedValueOnce(new Error('no such database: papercusp_it'));
    await probePgReachable('postgres://x', 5000);
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe('assertPgReachable — EI-2627', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    unsafe.mockReset();
    end.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves silently when reachable', async () => {
    unsafe.mockResolvedValueOnce(undefined);
    await expect(assertPgReachable('postgres://x', 'myFixture', 5000)).resolves.toBeUndefined();
  });

  it('throws an EI-2627-tagged, actionable error naming the caller label on failure', async () => {
    unsafe.mockRejectedValueOnce(new Error('no such database: papercusp_it'));
    await expect(assertPgReachable('postgres://x', 'myFixture', 5000)).rejects.toThrow(
      /myFixture.*EI-2627.*docker ps/s,
    );
  });
});

describe('withPgStartupRetry — EI-10533', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the op result immediately on first-attempt success', async () => {
    const op = vi.fn().mockResolvedValueOnce('ok');
    await expect(withPgStartupRetry(op, 5000)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries a transient "in recovery mode" failure, then succeeds', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('FATAL: the database system is in recovery mode'))
      .mockResolvedValueOnce('ok');
    const resultPromise = withPgStartupRetry(op, 5000);
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('retries PostgreSQL 57P03 "database system is starting up", then succeeds', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('FATAL: the database system is starting up'))
      .mockResolvedValueOnce('ok');
    const resultPromise = withPgStartupRetry(op, 5000);
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-retryable failure on the FIRST attempt (no retry)', async () => {
    const op = vi.fn().mockRejectedValueOnce(new Error('password authentication failed for user "x"'));
    await expect(withPgStartupRetry(op, 5000)).rejects.toThrow(/password authentication failed/);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up and rethrows the LAST error once the retry budget is exhausted', async () => {
    const op = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    const resultPromise = withPgStartupRetry(op, 700);
    // Attach a handler before advancing fake timers — otherwise the eventual
    // rejection can fire (during runAllTimersAsync) before the `await expect`
    // below attaches one, and vitest flags it as an unhandled rejection even
    // though it IS handled a line later (same trap the pattern below avoids).
    resultPromise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(resultPromise).rejects.toThrow(/ECONNREFUSED/);
    expect(op.mock.calls.length).toBeGreaterThan(1);
    expect(op.mock.calls.length).toBeLessThan(20);
  });

  it('surfaces a caller-wrapped error message (op re-throwing its own Error) through retry + final rejection', async () => {
    // Mirrors the pg-container.ts / baseline-schema-global-setup.ts call sites,
    // which catch the raw postgres error and re-throw a friendlier, cause-chained
    // Error naming the infra class — the retryable substring must still be found
    // inside THAT wrapped message for retry to keep working.
    const op = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('getTestPg (no-docker escape hatch): framework-role ensure failed: in recovery mode'),
      )
      .mockResolvedValueOnce('ok');
    const resultPromise = withPgStartupRetry(op, 5000);
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });
});
