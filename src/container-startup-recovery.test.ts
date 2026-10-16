import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { start, stop } = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));

vi.mock('testcontainers', () => ({
  GenericContainer: class {
    withExposedPorts() { return this; }
    withEnvironment() { return this; }
    withTmpFs() { return this; }
    withWaitStrategy() { return this; }
    withReuse() { return this; }
    start() { return start(); }
  },
  Wait: { forHttp: () => ({ forStatusCode: () => ({}) }) },
}));

let lockRoot: string;
beforeEach(async () => {
  vi.resetModules();
  start.mockReset();
  stop.mockReset();
  lockRoot = await mkdtemp(join(tmpdir(), 'container-startup-recovery-'));
  vi.stubEnv('PAPERCUSP_TESTCONTAINERS_LOCK_DIR', lockRoot);
  vi.stubEnv('PAPERCUSP_DISABLE_TESTCONTAINERS_START_LOCK', undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(lockRoot, { recursive: true, force: true });
});

const helpers = [
  { name: 'Redis', load: async () => {
    const { getTestRedis } = await import('./redis-container.ts');
    return () => getTestRedis();
  } },
  { name: 'Typesense', load: async () => {
    const { getTestTypesense } = await import('./typesense-container.ts');
    return () => getTestTypesense();
  } },
];

describe.each(helpers)('$name startup failure recovery (WI-6554700010015985)', ({ load }) => {
  it('reports the failed startup to its callers, then starts again after Docker recovers', async () => {
    const failure = new Error('socket hang up');
    const started = { getHost: () => '127.0.0.1', getMappedPort: () => 43210, stop };
    start.mockRejectedValueOnce(failure).mockResolvedValue(started);
    const get = await load();

    // Concurrent callers share one attempt and observe its actual failure.
    const failed = await Promise.allSettled([get(), get()]);
    expect(failed.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(start).toHaveBeenCalledOnce();

    // This distinguishes a poisoned process-local cache from Docker staying
    // unavailable: the SAME helper gets a successful start on its next call.
    const recovered = await get();
    if (typeof recovered === 'string') expect(recovered).toBe('redis://127.0.0.1:43210');
    else expect(recovered).toMatchObject({ url: 'http://127.0.0.1:43210' });
    await expect(get()).resolves.toEqual(recovered);
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).not.toHaveBeenCalled();
  });
});
