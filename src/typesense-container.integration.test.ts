import { describe, it, expect } from 'vitest';
import { getTestTypesense } from './typesense-container.ts';

describe('getTestTypesense', () => {
  it('starts a healthy typesense reachable on /health', async () => {
    const ts = await getTestTypesense();
    expect(ts.url).toMatch(/^http:\/\/.+:\d+$/);
    const res = await fetch(`${ts.url}/health`);
    expect(res.ok).toBe(true);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('accepts the admin api key for an authenticated request', async () => {
    const ts = await getTestTypesense();
    const res = await fetch(`${ts.url}/collections`, {
      headers: { 'X-TYPESENSE-API-KEY': ts.apiKey },
    });
    expect(res.ok).toBe(true);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
