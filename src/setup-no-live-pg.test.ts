import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VENUE_FILE = 'lib/coverage-census/attribution/persistence-venue.integration.test.ts';

/** Every workspace package.json the root `workspaces` field names (plus the root itself). */
function workspaceManifests(): string[] {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { workspaces: string[] };
  const negated = root.workspaces.filter(w => w.startsWith('!')).map(w => w.slice(1));
  const excluded = (rel: string) => negated.some(pattern => {
    const [dir, leaf] = pattern.split('/*');
    return rel.startsWith(`${dir}/`) && rel.endsWith(leaf ?? '');
  });
  const dirs: string[] = [];
  for (const entry of root.workspaces.filter(w => !w.startsWith('!'))) {
    if (!entry.endsWith('/*')) { dirs.push(entry); continue; }
    const parent = entry.slice(0, -2);
    for (const name of readdirSync(join(REPO_ROOT, parent))) dirs.push(`${parent}/${name}`);
  }
  return ['package.json', ...dirs.filter(d => !excluded(d)).map(d => `${d}/package.json`)]
    .filter(rel => existsSync(join(REPO_ROOT, rel)));
}

describe('coverage-attribution venue live-PG opt-out (WI-6554700010019145)', () => {
  async function armWith(venue: string | undefined): Promise<string | undefined> {
    vi.stubEnv('PAPERCUSP_LIVE_PG_GUARD_INITIALIZED', '0');
    vi.stubEnv('PAPERCUSP_FORBID_LIVE_PG', 'unset-by-test');
    vi.stubEnv('PAPERCUSP_LIVE_PG_VENUE', venue ?? '');
    vi.resetModules();
    await import('./setup-no-live-pg');
    return process.env.PAPERCUSP_FORBID_LIVE_PG;
  }

  it('leaves the rail disarmed only for the exact venue value', async () => {
    expect(await armWith('coverage-attribution')).toBe('0');
  });

  it.each(['', 'coverage', 'Coverage-Attribution', 'coverage-attribution ', '1'])(
    'still arms the rail for any other value (%j)', async value => {
      expect(await armWith(value)).toBe('1');
    });

  it('is carried by exactly one package script, and that script runs only the venue file', () => {
    const carriers: Array<{ manifest: string; script: string; command: string }> = [];
    for (const manifest of workspaceManifests()) {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, manifest), 'utf8')) as { scripts?: Record<string, string> };
      for (const [script, command] of Object.entries(pkg.scripts ?? {})) {
        if (command.includes('PAPERCUSP_LIVE_PG_VENUE')) carriers.push({ manifest, script, command });
      }
    }
    // Positive control: the scan must actually have reached the operator-core manifest.
    expect(workspaceManifests()).toContain('packages/operator-core/package.json');
    expect(carriers.map(c => `${c.manifest}#${c.script}`)).toEqual([
      'packages/operator-core/package.json#test:coverage-attribution-venue',
    ]);
    const args = carriers[0]!.command.split(/\s+/).filter(a => a.endsWith('.test.ts'));
    expect(args).toEqual([VENUE_FILE]);
  });
});

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
    vi.stubEnv('PAPERCUSP_LIVE_PG_VENUE', '');
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
