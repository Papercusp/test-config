import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { withTestcontainerStartLock } from './testcontainer-start-lock.ts';

export interface TestTypesense {
  /** Base URL, e.g. http://127.0.0.1:49xxx */
  url: string;
  host: string;
  port: number;
  /** Admin API key (pass as `X-TYPESENSE-API-KEY` or the typesense client `apiKey`). */
  apiKey: string;
}

const TEST_TYPESENSE_API_KEY = 'test-typesense-key';

/**
 * Shared Typesense container for search integration tests. Pinned to the same
 * image the app runs in prod (`typesense/typesense:29.0`) and configured via the
 * same env vars (`TYPESENSE_DATA_DIR` / `TYPESENSE_API_KEY` / `TYPESENSE_ENABLE_CORS`)
 * — see docker-compose.prod.yml. Data dir is a tmpfs so it's writable + fast and
 * leaves no host artifacts. Readiness is the unauthenticated `GET /health`
 * (`{"ok":true}`). `.withReuse()` shares one instance across suites.
 *
 * Requires Docker (testcontainers).
 */
let typesensePromise: Promise<StartedTestContainer> | null = null;

export async function getTestTypesense(): Promise<TestTypesense> {
  if (!typesensePromise) {
    typesensePromise = withTestcontainerStartLock('shared-docker-testcontainers-start', () =>
      new GenericContainer('typesense/typesense:29.0')
        .withExposedPorts(8108)
        .withEnvironment({
          TYPESENSE_DATA_DIR: '/data',
          TYPESENSE_API_KEY: TEST_TYPESENSE_API_KEY,
          TYPESENSE_ENABLE_CORS: 'true',
        })
        .withTmpFs({ '/data': 'rw' })
        .withWaitStrategy(Wait.forHttp('/health', 8108).forStatusCode(200))
        .withReuse()
        .start(),
    );
  }
  const container = await typesensePromise;
  const host = container.getHost();
  const port = container.getMappedPort(8108);
  return { url: `http://${host}:${port}`, host, port, apiKey: TEST_TYPESENSE_API_KEY };
}

export async function teardownTestTypesense(): Promise<void> {
  if (typesensePromise) {
    const c = await typesensePromise;
    await c.stop();
    typesensePromise = null;
  }
}
