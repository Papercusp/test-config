import { GenericContainer, type StartedTestContainer } from 'testcontainers';

/**
 * Shared Redis container for integration tests (RateLimitGuard sorted-set limits,
 * queues, cache). Mirrors getTestPg: one container per test process, `.withReuse()`
 * so concurrent suites share a single instance. Returns a `redis://host:port` URL —
 * open your own client (the app uses ioredis) against it.
 *
 * Requires Docker (testcontainers).
 */
let redisPromise: Promise<StartedTestContainer> | null = null;

export async function getTestRedis(): Promise<string> {
  if (!redisPromise) {
    redisPromise = new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withReuse()
      .start();
  }
  const container = await redisPromise;
  return `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
}

export async function teardownTestRedis(): Promise<void> {
  if (redisPromise) {
    const c = await redisPromise;
    await c.stop();
    redisPromise = null;
  }
}
