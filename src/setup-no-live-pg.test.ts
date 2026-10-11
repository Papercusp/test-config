import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('integration live-PG endpoint admission', () => {
  it.each([false, true])('keeps ambient targets protected with explicit private endpoint=%s', async admitted => {
    vi.stubEnv('PAPERCUSP_LIVE_PG_GUARD_INITIALIZED', '0');
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgresql://private:private-secret@localhost:37461/papercusp');
    vi.stubEnv('DATABASE_URL', 'postgresql://live:live-secret@localhost:23325/papercusp');
    vi.stubEnv('PAPERCUSP_TEST_PG_ADMIN_URL', admitted
      ? 'postgresql://private:private-secret@localhost:37461/papercusp' : '');
    // An inherited unvalidated list must never widen the real setup's admission.
    vi.stubEnv('PAPERCUSP_SAFE_TEST_PG_ENDPOINTS', '[{"host":"localhost","port":"23325"}]');
    vi.stubEnv('PAPERCUSP_FORBID_LIVE_PG_TARGETS', '[]');
    vi.stubEnv('PAPERCUSP_FORBID_LIVE_PG', '0');
    vi.resetModules();
    await import('./setup-no-live-pg');
    expect(process.env.PAPERCUSP_FORBID_LIVE_PG).toBe('1');
    expect(JSON.parse(process.env.PAPERCUSP_FORBID_LIVE_PG_TARGETS!)).toEqual(expect.arrayContaining([
      { host: 'localhost', port: '37461', database: 'papercusp' },
      { host: 'localhost', port: '23325', database: 'papercusp' },
    ]));
    expect(JSON.parse(process.env.PAPERCUSP_SAFE_TEST_PG_ENDPOINTS!)).toEqual(admitted
      ? [{ host: 'localhost', port: '37461' }] : []);
    expect(process.env.PAPERCUSP_FORBID_LIVE_PG_TARGETS).not.toContain('secret');
    expect(process.env.PAPERCUSP_SAFE_TEST_PG_ENDPOINTS).not.toContain('secret');
  });
});
