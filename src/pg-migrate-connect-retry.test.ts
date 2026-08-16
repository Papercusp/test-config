/**
 * withConnectRetry / isConnectTimeout (EI-10571) — the shared testcontainers
 * Postgres (`getTestPg()`) is `.withReuse()`d across the WHOLE fleet (~30+
 * concurrent vitest processes at once), so a brand-new client's first query
 * can transiently `CONNECT_TIMEOUT` under connect-queue/CPU pressure alone —
 * not a real outage. This mirrors operator-core's pg-transient-retry.test.ts
 * for the test-infra-side classifier/retry pair that createFreshDb /
 * createDbFromTemplate / buildTemplate / makeDrop now use.
 *
 *   npx vitest run libs/test-config/src/pg-migrate-connect-retry.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { isConnectTimeout, withConnectRetry } from './pg-migrate.ts';

/** A postgres-js-shaped connect-timeout error (code is the reliable signal). */
function connectTimeout(): Error & { code: string } {
  const e = new Error('write CONNECT_TIMEOUT localhost:33146') as Error & { code: string };
  e.code = 'CONNECT_TIMEOUT';
  return e;
}

/** A synchronous sleep stub — records the backoff schedule, never actually waits. */
function sleepSpy() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => { delays.push(ms); } };
}

describe('isConnectTimeout', () => {
  it('matches CONNECT_TIMEOUT by code', () => {
    expect(isConnectTimeout(connectTimeout())).toBe(true);
  });

  it('matches CONNECT_TIMEOUT by message when code is absent', () => {
    expect(isConnectTimeout(new Error('write CONNECT_TIMEOUT localhost:33146'))).toBe(true);
  });

  it('does NOT match an unrelated error', () => {
    expect(isConnectTimeout(new Error('relation "x" does not exist'))).toBe(false);
  });

  it('is null/undefined-safe', () => {
    expect(isConnectTimeout(null)).toBe(false);
    expect(isConnectTimeout(undefined)).toBe(false);
  });
});

describe('withConnectRetry', () => {
  it('returns the result on first success without sleeping', async () => {
    const { delays, sleep } = sleepSpy();
    const fn = vi.fn(async () => 'ok');
    await expect(withConnectRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('retries a transient CONNECT_TIMEOUT and succeeds on a later attempt', async () => {
    const { delays, sleep } = sleepSpy();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw connectTimeout();
      return 'connected';
    });
    await expect(withConnectRetry(fn, { sleep })).resolves.toBe('connected');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([300, 600]); // linear backoff: 300*1, then 300*2
  });

  it('exhausts the attempt budget and rethrows the LAST CONNECT_TIMEOUT', async () => {
    const { sleep } = sleepSpy();
    const fn = vi.fn(async () => { throw connectTimeout(); });
    await expect(withConnectRetry(fn, { sleep, attempts: 3 })).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows a NON-connect-timeout error immediately without retrying', async () => {
    const { delays, sleep } = sleepSpy();
    const boom = new Error('CREATE DATABASE "x" failed: already exists');
    const fn = vi.fn(async () => { throw boom; });
    await expect(withConnectRetry(fn, { sleep })).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});
