import { describe, it, expect } from 'vitest';
import { connect } from 'node:net';
import { getTestRedis } from './redis-container.ts';

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
  it('starts a reachable redis that answers PING with PONG', async () => {
    const url = await getTestRedis();
    expect(url).toMatch(/^redis:\/\/.+:\d+$/);
    const u = new URL(url);
    const reply = await redisPing(u.hostname, Number(u.port));
    expect(reply).toContain('PONG');
  });
});
