import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { captureCurrentRuntimeCapabilities, parseRuntimeCapabilitySnapshot } from './runtime-proof.ts';

describe('original worker runtime surface', () => {
  it('captures an immutable bounded surface without claiming capability completeness', () => {
    const first = captureCurrentRuntimeCapabilities()!;
    expect(first).not.toBeNull();
    expect(first.values.versions).toContainEqual(['node', process.versions.node]);
    expect(first.values.platform).toBe(process.platform);
    expect(first.values.arch).toBe(process.arch);
    expect(captureCurrentRuntimeCapabilities()).toEqual(first);
    expect(Object.isFrozen(first.values.features[0])).toBe(true);
    expect(Object.isFrozen(first.values.permissions)).toBe(true);
    expect(parseRuntimeCapabilitySnapshot(JSON.parse(JSON.stringify(first)))).toEqual(first);
    for (const patch of [{ populationStatus: 'complete' }, { missing: [] }, { sha256: 'a'.repeat(64) },
      { values: { ...first.values, arch: 'unmeasured' } }])
      expect(parseRuntimeCapabilitySnapshot({ ...first, ...patch })).toBeUndefined();
    let invoked = false;
    const values = { ...first.values };
    Object.defineProperty(values, 'arch', { enumerable: true, get() { invoked = true; throw new Error('accessor'); } });
    expect(parseRuntimeCapabilitySnapshot({ ...first, values })).toBeUndefined();
    expect(invoked).toBe(false);
  });

  it('measures actual timezone and permission changes in the selected interpreter', () => {
    const module = fileURLToPath(new URL('./runtime-proof.ts', import.meta.url));
    const program = `
      import { pathToFileURL } from 'node:url';
      import { spawnSync } from 'node:child_process';
      const { captureCurrentRuntimeCapabilities } = await import(pathToFileURL(process.argv[1]).href);
      let childAllowed = true;
      try { const result = spawnSync(process.execPath, ['--version']); childAllowed = result.status === 0; }
      catch (error) { if (error.code !== 'ERR_ACCESS_DENIED') throw error; childAllowed = false; }
      process.stdout.write(JSON.stringify({ snapshot: captureCurrentRuntimeCapabilities(), childAllowed,
        offset: new Date('2026-01-01T12:00:00Z').getTimezoneOffset() }));
    `;
    const run = (zone: string, restricted = false) => {
      const child = spawnSync(process.execPath, [...(restricted ? ['--permission', '--allow-fs-read=*'] : []),
        '--input-type=module', '-e', program, module], {
        encoding: 'utf8', env: { ...process.env, TZ: zone, NODE_OPTIONS: '', BUN_OPTIONS: '' }, timeout: 30_000 });
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(parseRuntimeCapabilitySnapshot(result.snapshot)).toEqual(result.snapshot);
      return result;
    };
    const utc = run('UTC'), same = run('UTC'), changed = run('America/New_York'), restricted = run('UTC', true);
    expect(same.snapshot).toEqual(utc.snapshot);
    expect(utc.offset).toBe(0);
    expect(changed.offset).toBe(300);
    expect(changed.snapshot.sha256).not.toBe(utc.snapshot.sha256);
    expect(utc.childAllowed).toBe(true);
    expect(restricted.childAllowed).toBe(false);
    expect(restricted.snapshot.values.permissions).toMatchObject({ available: true, fsRead: true, child: false, worker: false });
    expect(restricted.snapshot.sha256).not.toBe(utc.snapshot.sha256);
    expect(restricted.snapshot.missing).toContain('resource-permission-policy-unobserved');
  }, 60_000);
});
