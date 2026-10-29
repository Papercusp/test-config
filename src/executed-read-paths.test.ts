import { describe, expect, it } from 'vitest';
import { classifyReadPaths, normalizeExecutedKey } from './executed-read-paths';

describe('runtime read paths', () => {
  it('normalizes module URLs and rejects external or dependency paths', () => {
    for (const key of ['/repo/a.ts?import', 'file:///repo/a.ts?import', '/@fs/repo/a.ts']) {
      expect(normalizeExecutedKey(key, '/repo')).toBe('a.ts');
    }
    for (const key of ['/elsewhere/a.ts', '/repo/node_modules/a.ts', 'a.ts', '/repo']) {
      expect(normalizeExecutedKey(key, '/repo')).toBeNull();
    }
  });

  it('retains tracked and absent inputs while existing untracked inputs make reuse opaque', () => {
    expect(classifyReadPaths([
      '/repo/tracked.ts', '/repo/absent.json', '/repo/tracked.ts', '/repo/generated.json',
      '/elsewhere/ignored', '/repo/node_modules/ignored',
    ], {
      repoRoot: '/repo', isTracked: rel => rel === 'tracked.ts',
      exists: abs => abs !== '/repo/absent.json',
    })).toEqual({ readPaths: ['absent.json', 'tracked.ts'], opaqueReasons: ['untracked-read:generated.json'] });
  });

  it('sorts and bounds opaque input diagnostics', () => {
    expect(classifyReadPaths(['g', 'f', 'e', 'd', 'c', 'b', 'a'].map(p => `/repo/${p}`), {
      repoRoot: '/repo', isTracked: () => false, exists: () => true,
    })).toEqual({ readPaths: [], opaqueReasons: [
      'untracked-read:a', 'untracked-read:b', 'untracked-read:c', 'untracked-read:d', 'untracked-read:e',
      'untracked-read:+2 more',
    ] });
  });
});
