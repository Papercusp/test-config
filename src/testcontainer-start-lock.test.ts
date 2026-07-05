import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { withTestcontainerStartLock } from './testcontainer-start-lock.ts';

const originalDir = process.env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR;

afterEach(async () => {
  process.env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR = originalDir;
  delete process.env.PAPERCUSP_DISABLE_TESTCONTAINERS_START_LOCK;
});

describe('withTestcontainerStartLock', () => {
  it('serializes same-host Testcontainers startup work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-testcontainers-lock-'));
    process.env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR = dir;

    let active = 0;
    let maxActive = 0;
    const observed: number[] = [];

    async function lockedWork(id: number): Promise<number> {
      return withTestcontainerStartLock(
        'shared-docker-testcontainers-start',
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          observed.push(id);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return id;
        },
        { timeoutMs: 2_000, retryMs: 5 },
      );
    }

    await Promise.all([lockedWork(1), lockedWork(2), lockedWork(3)]);

    expect(maxActive).toBe(1);
    expect(observed).toHaveLength(3);
    await rm(dir, { recursive: true, force: true });
  });

  it('removes an abandoned stale lock before timing out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-testcontainers-lock-'));
    process.env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR = dir;
    const lockDir = join(dir, 'shared-docker-testcontainers-start.lock');
    await mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);

    const result = await withTestcontainerStartLock(
      'shared-docker-testcontainers-start',
      async () => 'started',
      { timeoutMs: 1_000, staleMs: 1, retryMs: 5 },
    );

    expect(result).toBe('started');
    await rm(dir, { recursive: true, force: true });
  });

  // EI-7818: a crashed holder's lock must reclaim on CONFIRMED-dead-pid evidence
  // alone — not just wait out a staleMs age nobody's own timeoutMs ever reaches.
  // Regression guard for the exact defaults-mismatch this session hit live: under
  // DEFAULT_TIMEOUT_MS (180s) < DEFAULT_STALE_MS (600s), age-based reclaim can
  // NEVER fire, so a dead owner's lock wedges every caller for timeoutMs forever.
  it('reclaims immediately when the recorded owner pid is confirmed dead on this host — even when the lock is FRESH (well under staleMs)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-testcontainers-lock-'));
    process.env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR = dir;
    const lockDir = join(dir, 'shared-docker-testcontainers-start.lock');
    await mkdir(lockDir, { recursive: true });

    // A pid that is guaranteed not to exist: the highest representable pid_t,
    // which no real process will ever hold.
    const deadPid = 2_147_483_647;
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: deadPid, host: hostname(), startedAt: new Date().toISOString(), name: 'x' }),
    );
    // Lock dir just created — its mtime is "now", i.e. FAR under any staleMs
    // threshold. Only the pid-liveness check can reclaim it here.

    const start = Date.now();
    const result = await withTestcontainerStartLock(
      'shared-docker-testcontainers-start',
      async () => 'started',
      { timeoutMs: 5_000, staleMs: 10 * 60_000, retryMs: 5 },
    );
    const elapsed = Date.now() - start;

    expect(result).toBe('started');
    // Reclaimed on (near-)first retry, nowhere close to the 5s timeoutMs ceiling.
    expect(elapsed).toBeLessThan(2_000);
    await rm(dir, { recursive: true, force: true });
  });

  it('does NOT reclaim a lock owned by a live pid on this host, even if age-stale-immune', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-testcontainers-lock-'));
    process.env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR = dir;
    const lockDir = join(dir, 'shared-docker-testcontainers-start.lock');
    await mkdir(lockDir, { recursive: true });
    // This test process's OWN pid is definitely alive.
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), name: 'x' }),
    );

    await expect(
      withTestcontainerStartLock('shared-docker-testcontainers-start', async () => 'started', {
        timeoutMs: 300,
        staleMs: 10 * 60_000,
        retryMs: 20,
      }),
    ).rejects.toThrow(/Timed out after 300ms/);

    await rm(dir, { recursive: true, force: true });
  });
});
