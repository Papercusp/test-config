import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TESTCONTAINERS_LAST_USED_DIR_ENV,
  recordTestcontainerUse,
  resolveTestcontainerLastUsedRoot,
  startedContainerIds,
} from './testcontainer-last-used.ts';
import { withTestcontainerStartLock } from './testcontainer-start-lock.ts';

// WI-6554700010009309: every testcontainer start stamps a last-use marker that
// bin/reclaim-docker-disk.sh reads to tell a used container from a leaked one.

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const fakeContainer = (id: string) => ({ getId: () => id });

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-last-used-'));
  dirs.push(dir);
  return dir;
};
const savedEnv = {
  lock: process.env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR,
  lastUsed: process.env[TESTCONTAINERS_LAST_USED_DIR_ENV],
  disable: process.env.PAPERCUSP_DISABLE_TESTCONTAINERS_START_LOCK,
};
const restore = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};
afterEach(() => {
  restore('PAPERCUSP_TESTCONTAINERS_LOCK_DIR', savedEnv.lock);
  restore(TESTCONTAINERS_LAST_USED_DIR_ENV, savedEnv.lastUsed);
  restore('PAPERCUSP_DISABLE_TESTCONTAINERS_START_LOCK', savedEnv.disable);
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveTestcontainerLastUsedRoot', () => {
  it('is a sibling of the start-lock root, matching the reaper default', () => {
    expect(resolveTestcontainerLastUsedRoot('/tmp/pcv/testcontainers-locks', {})).toBe(
      '/tmp/pcv/testcontainers-last-used',
    );
  });

  it('honours the explicit override', () => {
    expect(
      resolveTestcontainerLastUsedRoot('/tmp/pcv/testcontainers-locks', {
        [TESTCONTAINERS_LAST_USED_DIR_ENV]: '/x/markers',
      }),
    ).toBe('/x/markers');
  });
});

describe('startedContainerIds', () => {
  it('reads a started container directly', () => {
    expect(startedContainerIds(fakeContainer(ID_A))).toEqual([ID_A]);
  });

  it('reads containers carried as fields (the baseline-schema `{ c, generation }` shape)', () => {
    expect(startedContainerIds({ c: fakeContainer(ID_B), generation: 3 })).toEqual([ID_B]);
  });

  it('ignores values that are not 64-hex container ids', () => {
    expect(startedContainerIds(fakeContainer('abc'))).toEqual([]);
    expect(startedContainerIds({ getId: () => { throw new Error('not started'); } })).toEqual([]);
    expect(startedContainerIds(42)).toEqual([]);
    expect(startedContainerIds(null)).toEqual([]);
  });
});

describe('recordTestcontainerUse', () => {
  it('creates the marker, then refreshes its mtime on a later use', async () => {
    const root = join(tempDir(), 'markers');
    expect(await recordTestcontainerUse(fakeContainer(ID_A), root)).toEqual([ID_A]);
    const marker = join(root, ID_A);
    expect(existsSync(marker)).toBe(true);

    const old = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(marker, old, old);
    await recordTestcontainerUse(fakeContainer(ID_A), root);
    expect(Date.now() - statSync(marker).mtimeMs).toBeLessThan(60_000);
  });

  it('never throws when the marker root cannot be created', async () => {
    const parent = tempDir();
    const blocker = join(parent, 'is-a-file');
    writeFileSync(blocker, '');
    await expect(recordTestcontainerUse(fakeContainer(ID_A), join(blocker, 'markers'))).resolves.toEqual([]);
  });
});

describe('withTestcontainerStartLock records last use', () => {
  it('stamps the started container under the locked path', async () => {
    const base = tempDir();
    process.env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR = join(base, 'locks');
    delete process.env[TESTCONTAINERS_LAST_USED_DIR_ENV];
    delete process.env.PAPERCUSP_DISABLE_TESTCONTAINERS_START_LOCK;
    const result = await withTestcontainerStartLock('last-used-test', async () => fakeContainer(ID_A));
    expect(result.getId()).toBe(ID_A);
    expect(existsSync(join(base, 'testcontainers-last-used', ID_A))).toBe(true);
  });

  it('stamps the started container when the start lock is disabled', async () => {
    const base = tempDir();
    process.env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR = join(base, 'locks');
    process.env[TESTCONTAINERS_LAST_USED_DIR_ENV] = join(base, 'explicit');
    process.env.PAPERCUSP_DISABLE_TESTCONTAINERS_START_LOCK = '1';
    await withTestcontainerStartLock('last-used-test', async () => ({ c: fakeContainer(ID_B), generation: 1 }));
    expect(existsSync(join(base, 'explicit', ID_B))).toBe(true);
  });

  it('a failed start stamps nothing and still rethrows', async () => {
    const base = tempDir();
    process.env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR = join(base, 'locks');
    delete process.env[TESTCONTAINERS_LAST_USED_DIR_ENV];
    delete process.env.PAPERCUSP_DISABLE_TESTCONTAINERS_START_LOCK;
    await expect(
      withTestcontainerStartLock('last-used-test', async () => {
        throw new Error('docker down');
      }),
    ).rejects.toThrow('docker down');
    expect(existsSync(join(base, 'testcontainers-last-used'))).toBe(false);
  });
});
