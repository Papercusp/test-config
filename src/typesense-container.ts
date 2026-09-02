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
 * The Typesense image this test substrate pins. SINGLE SOURCE OF TRUTH: this
 * constant is the only place the tag is written — never restate it in prose,
 * because a second copy is what silently drifts from the code beside it.
 */
export const TEST_TYPESENSE_IMAGE = 'typesense/typesense:29.0';

/**
 * Shared Typesense container for search integration tests, pinned to
 * `TEST_TYPESENSE_IMAGE` and configured via the same env vars the app uses
 * (`TYPESENSE_DATA_DIR` / `TYPESENSE_API_KEY` / `TYPESENSE_ENABLE_CORS`).
 *
 * DELIBERATE SKEW — this substrate's pin is its own, and is NOT a claim of
 * parity with any deployment. This is a shared submodule with several consuming
 * repos which pin Typesense differently: at least one ships no production
 * compose file at all, and another pins a different major in its application
 * compose than in its data-plane compose. No single consumer file can therefore
 * be cited as the parity authority — such a citation is unresolvable in some
 * consumers and false in others. Do not reintroduce one, and do not restate the
 * tag in prose; `typesense-container-pin.test.ts` enforces both.
 * (EI-20467401893261300)
 *
 * Data dir is a tmpfs so it's writable + fast and leaves no host artifacts.
 * Readiness is the unauthenticated `GET /health` (`{"ok":true}`).
 * `.withReuse()` shares one instance across suites.
 *
 * Requires Docker (testcontainers).
 */
let typesensePromise: Promise<StartedTestContainer> | null = null;

export async function getTestTypesense(): Promise<TestTypesense> {
  if (!typesensePromise) {
    typesensePromise = withTestcontainerStartLock('shared-docker-testcontainers-start', () =>
      new GenericContainer(TEST_TYPESENSE_IMAGE)
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
