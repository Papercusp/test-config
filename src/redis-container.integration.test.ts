import { beforeAll, describe, it, expect } from 'vitest';
import { connect } from 'node:net';
import { getTestRedis } from './redis-container.ts';
import { TESTCONTAINER_START_LOCK_TIMEOUT_MS, TESTCONTAINERS_DOCKER_CLIENT_TIMEOUT_MS } from './testcontainer-start-lock.ts';

/** Dependency-free RESP PING — proves the container is reachable without pulling ioredis into test-config. */
function redisPing(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, host, () => sock.write('PING\r\n'));
    sock.setTimeout(5000);
    sock.on('data', (d) => {
      resolve(d.toString());
      sock.end();
    });
    sock.on('error', reject);
    sock.on('timeout', () => {
      sock.destroy();
      reject(new Error('redis ping timeout'));
    });
  });
}

describe('getTestRedis', () => {
  let url: string;
  // Startup can wait for the cross-process lock, then a Docker response and
  // readiness. Let those bounded stages report their own failure; the PING
  // assertion must not cancel startup under the shorter test-body deadline.
  beforeAll(async () => {
    url = await getTestRedis();
  }, TESTCONTAINER_START_LOCK_TIMEOUT_MS + TESTCONTAINERS_DOCKER_CLIENT_TIMEOUT_MS + 60_000);

  it('starts a reachable redis that answers PING with PONG', async () => {
    expect(url).toMatch(/^redis:\/\/.+:\d+$/);
    const u = new URL(url);
    const reply = await redisPing(u.hostname, Number(u.port));
    expect(reply).toContain('PONG');
  });
});
