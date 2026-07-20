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

import { assertPgReachable, probePgReachable } from './pg-reachability.ts';

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
