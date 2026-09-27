import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { ClientRequest, createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TESTCONTAINER_START_LOCK_TIMEOUT_MS,
  TESTCONTAINERS_DOCKER_CLIENT_TIMEOUT_MS,
  withTestcontainerStartLock,
} from './testcontainer-start-lock.ts';

// Exercise the exact Dockerode dependency used by Testcontainers, without
// contacting or changing the host's Docker daemon.
const requireTestcontainers = createRequire(import.meta.resolve('testcontainers'));
const Docker = requireTestcontainers('dockerode') as typeof import('dockerode');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Testcontainers Docker response deadline (real local transport)', () => {
  it.each([
    { transport: 'tcp', realTime: false },
    { transport: 'unix', realTime: false },
    { transport: 'default-unix', realTime: false },
    { transport: 'default-unix', realTime: true },
  ] as const)('aborts a delayed $transport response and releases the startup lock (realTime=$realTime)', async ({ transport, realTime }) => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-docker-deadline-'));
    const socketPath = join(dir, 'docker.sock');
    const lockPath = join(dir, 'fixture-start.lock');
    const responseTimers = new Set<ReturnType<typeof setTimeout>>();
    let sawLockHeld = false;
    const server = createServer((_request, response) => {
      sawLockHeld = existsSync(lockPath);
      // A missing timeout resolves successfully, so the guard fails rather
      // than hanging the test indefinitely.
      const timer = setTimeout(() => response.end('late response'),
        realTime ? TESTCONTAINERS_DOCKER_CLIENT_TIMEOUT_MS + 10_000 : 750);
      responseTimers.add(timer);
    });
    const originalTimeout = ClientRequest.prototype.setTimeout;
    const deadlines: number[] = [];
    const timeoutSpy = vi.spyOn(ClientRequest.prototype, 'setTimeout')
      .mockImplementation(function (this: ClientRequest, milliseconds, callback) {
        if (this.path === '/_ping') {
          deadlines.push(milliseconds);
          // Measure the real configured deadline, then accelerate only its
          // socket timer. The request, abort, rejection and lock are real.
          return originalTimeout.call(this, realTime ? milliseconds : 50, callback);
        }
        return originalTimeout.call(this, milliseconds, callback);
      });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        if (transport !== 'tcp') server.listen(socketPath, resolve);
        else server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      const host = transport === 'default-unix' ? undefined : transport === 'unix'
        ? `unix://${socketPath}`
        : `tcp://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      vi.stubEnv('DOCKER_HOST', host);
      vi.stubEnv('DOCKER_TLS_VERIFY', '0');
      vi.stubEnv('DOCKER_CERT_PATH', undefined);
      vi.stubEnv('DOCKER_PATH_PREFIX', undefined);
      vi.stubEnv('DOCKER_CLIENT_TIMEOUT', undefined);
      vi.stubEnv('PAPERCUSP_DISABLE_TESTCONTAINERS_START_LOCK', undefined);
      vi.stubEnv('PAPERCUSP_TESTCONTAINERS_LOCK_DIR', dir);

      const startedAt = performance.now();
      await expect(withTestcontainerStartLock('fixture-start', async () => {
        const docker = new Docker(transport === 'default-unix' ? { socketPath } : undefined);
        return docker.ping();
      })).rejects.toThrow(/socket hang up|timeout/i);
      expect(sawLockHeld).toBe(true);
      expect(deadlines).toEqual([TESTCONTAINERS_DOCKER_CLIENT_TIMEOUT_MS]);
      expect(performance.now() - startedAt).toBeLessThan(TESTCONTAINER_START_LOCK_TIMEOUT_MS);
      expect(existsSync(lockPath)).toBe(false);
      await expect(withTestcontainerStartLock('fixture-start', async () => 'next caller'))
        .resolves.toBe('next caller');
    } finally {
      timeoutSpy.mockRestore();
      for (const timer of responseTimers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  }, TESTCONTAINER_START_LOCK_TIMEOUT_MS + 10_000);
});
