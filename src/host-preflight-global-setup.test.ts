/**
 * The generic host-preflight seam (WI-10005724). It must be fail-closed: a refusal and any
 * verdict it cannot read both abort the run, and an admit is the only path that applies `setEnv`.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findHostPreflightRoot, HOST_PREFLIGHT_MODULE, runHostPreflight } from './host-preflight-global-setup.ts';

const HOST = '/repo';
const MODULE_URL = pathToFileURL(join(HOST, HOST_PREFLIGHT_MODULE)).href;
const existsAtHost = (path: string): boolean => path === join(HOST, HOST_PREFLIGHT_MODULE);

function withModule(mod: unknown, seen: { url?: string; input?: unknown } = {}) {
  return {
    projectRoot: join(HOST, 'packages', 'pkg'),
    files: [join(HOST, 'packages', 'pkg', 'a.test.ts')],
    exists: existsAtHost,
    load: async (url: string) => {
      seen.url = url;
      return mod;
    },
  };
}

describe('findHostPreflightRoot', () => {
  it('walks up from the project root to the first directory holding the convention module', () => {
    expect(findHostPreflightRoot(join(HOST, 'packages', 'pkg', 'src'), existsAtHost)).toBe(HOST);
  });

  it('returns null when no ancestor holds it (a repository without a host preflight)', () => {
    expect(findHostPreflightRoot(join(HOST, 'packages', 'pkg'), () => false)).toBeNull();
  });
});

describe('runHostPreflight', () => {
  it('is a no-op without a host module', async () => {
    const env: NodeJS.ProcessEnv = {};
    await expect(runHostPreflight({ projectRoot: '/elsewhere', files: [], env, exists: () => false })).resolves.toEqual({
      verdict: 'no-host-module',
    });
    expect(env).toEqual({});
  });

  it('passes the host root, the run files and the env, and applies setEnv on admit', async () => {
    const seen: { url?: string; input?: unknown } = {};
    const env: NodeJS.ProcessEnv = {};
    const mod = {
      hostPreflight: (input: unknown) => {
        seen.input = input;
        return { verdict: 'admit', setEnv: { MARKER: 'admitted' } };
      },
    };
    await expect(runHostPreflight({ ...withModule(mod, seen), env })).resolves.toMatchObject({ verdict: 'admit' });
    expect(seen.url).toBe(MODULE_URL);
    expect(seen.input).toEqual({ root: HOST, files: [join(HOST, 'packages', 'pkg', 'a.test.ts')], env });
    expect(env.MARKER).toBe('admitted');
  });

  it('a skip applies nothing', async () => {
    const env: NodeJS.ProcessEnv = {};
    const mod = { hostPreflight: () => ({ verdict: 'skipped', reason: 'admitted-upstream', setEnv: { MARKER: 'x' } }) };
    await expect(runHostPreflight({ ...withModule(mod), env })).resolves.toMatchObject({ verdict: 'skipped' });
    expect(env).toEqual({});
  });

  it('a refusal aborts the run with the host message and applies nothing', async () => {
    const env: NodeJS.ProcessEnv = {};
    const mod = { hostPreflight: () => ({ verdict: 'refuse', message: 'VITEST_RESTRICTED_HOLD_REFUSED error=x' }) };
    await expect(runHostPreflight({ ...withModule(mod), env })).rejects.toThrow('VITEST_RESTRICTED_HOLD_REFUSED error=x');
    expect(env).toEqual({});
  });

  it.each([
    ['no verdict', undefined],
    ['an unknown verdict', { verdict: 'maybe' }],
    ['a null result', null],
  ])('fails closed on %s', async (_label, result) => {
    await expect(runHostPreflight({ ...withModule({ hostPreflight: () => result }), env: {} })).rejects.toThrow(
      /HOST_PREFLIGHT_INVALID .*unrecognised verdict/,
    );
  });

  it('fails closed when the host module does not export hostPreflight', async () => {
    await expect(runHostPreflight({ ...withModule({}), env: {} })).rejects.toThrow(/HOST_PREFLIGHT_INVALID .*does not export hostPreflight/);
  });

  it('fails closed when hostPreflight throws', async () => {
    const mod = {
      hostPreflight: () => {
        throw new Error('census exploded');
      },
    };
    await expect(runHostPreflight({ ...withModule(mod), env: {} })).rejects.toThrow('census exploded');
  });
});
