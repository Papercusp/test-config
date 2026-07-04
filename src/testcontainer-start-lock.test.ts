import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
});
