import { beforeAll, describe, it, expect } from 'vitest';
import { getTestTypesense, type TestTypesense } from './typesense-container.ts';
import { TESTCONTAINER_START_LOCK_TIMEOUT_MS, TESTCONTAINERS_DOCKER_CLIENT_TIMEOUT_MS } from './testcontainer-start-lock.ts';

describe('getTestTypesense', () => {
  let ts: TestTypesense;
  // A failed start belongs to setup. Do not run the auth test against the
  // first test's still-pending Docker request and misreport it as auth failure.
  beforeAll(async () => {
    ts = await getTestTypesense();
  }, TESTCONTAINER_START_LOCK_TIMEOUT_MS + TESTCONTAINERS_DOCKER_CLIENT_TIMEOUT_MS + 60_000);

  it('starts a healthy typesense reachable on /health', async () => {
    expect(ts.url).toMatch(/^http:\/\/.+:\d+$/);
    const res = await fetch(`${ts.url}/health`);
    expect(res.ok).toBe(true);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('accepts the admin api key for an authenticated request', async () => {
    const res = await fetch(`${ts.url}/collections`, {
      headers: { 'X-TYPESENSE-API-KEY': ts.apiKey },
    });
    expect(res.ok).toBe(true);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
