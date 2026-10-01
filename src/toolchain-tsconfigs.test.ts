import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isToolchainConfigSource,
  namedConfigBasenames,
  toolchainTsconfigFiles,
} from './toolchain-tsconfigs.ts';

/**
 * gate-test-reuse-yield-2026-10-01 P-004 (D-007): the reuse rule narrows a tsconfig only when the
 * vitest toolchain does not read it, so this set must contain EVERY config vite or
 * vite-tsconfig-paths can read. Too small a set is unsound (a read config would stop invalidating);
 * too large only costs reuse. The fixtures run the real tsconfck, the library both readers use.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'toolchain-tsconfigs-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const json = (v: unknown) => JSON.stringify(v);

describe('toolchainTsconfigFiles', () => {
  it('reaches entries, extends chains, references and named projects, and nothing the toolchain never reads', async () => {
    const root = tree({
      'tsconfig.base.json': json({ compilerOptions: { strict: true } }),
      // Read by gen:declarations only: no entry extends or references it.
      'tsconfig.declarations.json': json({ files: [] }),
      // Named as an explicit `projects` entry by a vitest config, so an entry despite its name.
      'tsconfig.custom.json': json({ extends: './tsconfig.chain.json' }),
      'tsconfig.chain.json': json({}),
      'vitest.config.ts': "tsconfigPaths({ projects: ['./tsconfig.custom.json'] });\n",
      'pkg/a/tsconfig.json': json({
        extends: '../../tsconfig.base.json',
        references: [{ path: './tsconfig.lib.json' }],
      }),
      'pkg/a/tsconfig.lib.json': json({ extends: './tsconfig.shared.json' }),
      'pkg/a/tsconfig.shared.json': json({}),
      // Unread: only `tsc -p` would use it.
      'pkg/a/tsconfig.build.json': json({ extends: '../../tsconfig.base.json' }),
      'pkg/b/jsconfig.json': json({}),
      // A package-specifier extends that resolves through a node_modules symlink into the repo.
      'pkg/c/tsconfig.json': json({ extends: '@scope/cfg/tsconfig.preset.json' }),
      'shared-cfg/package.json': json({ name: '@scope/cfg', version: '0.0.0' }),
      'shared-cfg/tsconfig.preset.json': json({}),
      // findAll skips node_modules, exactly as the plugin does.
      'node_modules/dep/tsconfig.json': json({ extends: '../../tsconfig.declarations.json' }),
    });
    mkdirSync(join(root, 'node_modules/@scope'), { recursive: true });
    symlinkSync(join(root, 'shared-cfg'), join(root, 'node_modules/@scope/cfg'), 'dir');

    const set = await toolchainTsconfigFiles({ repoRoot: root, listTrackedFiles: () => ['vitest.config.ts'] });

    expect([...set].sort()).toEqual([
      'pkg/a/tsconfig.json',
      'pkg/a/tsconfig.lib.json',
      'pkg/a/tsconfig.shared.json',
      'pkg/b/jsconfig.json',
      'pkg/c/tsconfig.json',
      'shared-cfg/tsconfig.preset.json',
      'tsconfig.base.json',
      'tsconfig.chain.json',
      'tsconfig.custom.json',
    ]);
  });

  it('does not treat a config as an entry unless a config SOURCE names it', async () => {
    const files = {
      'tsconfig.custom.json': json({}),
      'notes.ts': "const x = './tsconfig.custom.json';\n",
    };
    const root = tree(files);
    const set = await toolchainTsconfigFiles({ repoRoot: root, listTrackedFiles: () => Object.keys(files) });
    expect(set.has('tsconfig.custom.json')).toBe(false);
  });

  it('throws when a TRACKED entry cannot be parsed, so the caller keeps every root tsconfig global', async () => {
    const root = tree({
      'tsconfig.base.json': json({}),
      'pkg/tsconfig.json': json({ extends: '../tsconfig.missing.json' }),
    });
    await expect(
      toolchainTsconfigFiles({ repoRoot: root, listTrackedFiles: () => ['pkg/tsconfig.json'] }),
    ).rejects.toThrow(/could not parse 1 config/);
  });

  // WI-10004941: copied dependency debris under an untracked dir (the plugin's skip rule matches
  // only a dir named exactly node_modules) used to void the whole derivation.
  it('skips an UNTRACKED entry that cannot be parsed and still derives the tracked set', async () => {
    const root = tree({
      'pkg/tsconfig.json': json({ extends: '../tsconfig.base.json' }),
      'tsconfig.base.json': json({}),
      '.papercusp/tmp/x/node_modules.pinned-deps-tmp.1/call-bound/tsconfig.json': json({
        extends: '@ljharb/tsconfig',
      }),
    });
    const skipped: string[][] = [];
    const set = await toolchainTsconfigFiles({
      repoRoot: root,
      listTrackedFiles: () => ['pkg/tsconfig.json', 'tsconfig.base.json'],
      onUntrackedParseFailures: (f) => skipped.push(f),
    });
    expect(set.has('pkg/tsconfig.json')).toBe(true);
    expect(set.has('tsconfig.base.json')).toBe(true);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toHaveLength(1);
    expect(skipped[0][0]).toMatch(/^\.papercusp\/tmp\/x\/node_modules\.pinned-deps-tmp\.1\/call-bound\/tsconfig\.json: /);
  });

  it('keeps every tracked config an unparseable untracked entry read before its failing link', async () => {
    // tsconfig.mid.json is reached ONLY through the failing untracked entry: no tracked entry
    // extends it. tsconfck reads it before failing on its own extends, so a change to it can
    // change the toolchain's outcome and it must stay in the set.
    const root = tree({
      'pkg/tsconfig.json': json({}),
      'scratch/tsconfig.json': json({ extends: '../tsconfig.mid.json' }),
      'tsconfig.mid.json': json({ extends: './tsconfig.missing.json' }),
    });
    const set = await toolchainTsconfigFiles({
      repoRoot: root,
      listTrackedFiles: () => ['pkg/tsconfig.json', 'tsconfig.mid.json'],
    });
    expect(set.has('tsconfig.mid.json')).toBe(true);
    expect(set.has('pkg/tsconfig.json')).toBe(true);
  });

  it('throws for an untracked failure when the read recording is not live', async () => {
    // A tsconfck whose parse never registers with the cache: the partial chain is unknown, so the
    // skip is unsafe and the failure must fall back to "unavailable".
    const root = tree({ 'u/tsconfig.json': json({}) });
    const tsconfck = {
      findAll: async () => [join(root, 'u/tsconfig.json')],
      parse: async () => {
        throw new Error('boom');
      },
      TSConfckCache: class {
        setParseResult(): void {}
      },
    };
    await expect(
      toolchainTsconfigFiles({ repoRoot: root, listTrackedFiles: () => [], tsconfck }),
    ).rejects.toThrow(/could not parse 1 config.*u\/tsconfig\.json: boom/);
  });
});

describe('namedConfigBasenames', () => {
  it('returns non-default config basenames named by string literals', () => {
    expect(
      namedConfigBasenames([
        "tsconfigPaths({ projects: ['./tsconfig.test.json', \"apps/x/tsconfig.json\"] })",
        'const p = `../jsconfig.app.json`; const q = "tsconfig.json";',
        "const notAConfig = 'tsconfig.json.bak';",
      ]),
    ).toEqual(['jsconfig.app.json', 'tsconfig.test.json']);
  });
});

describe('isToolchainConfigSource', () => {
  it.each([
    ['vitest.config.ts', true],
    ['apps/operator/vitest.config.ts', true],
    ['apps/operator-vite/vite.config.ts', true],
    ['vitest.workspace.mjs', true],
    ['libs/test-config/src/vitest-config.ts', true],
    ['libs/test-config/src/vitest-config.test.ts', false],
    ['packages/operator-core/lib/foo.ts', false],
  ])('%s -> %s', (rel, expected) => {
    expect(isToolchainConfigSource(rel)).toBe(expected);
  });

  it('covers every file in the tree that calls tsconfigPaths() (REAL TREE)', () => {
    // The named-project scan reads only config sources. A tsconfigPaths() call anywhere else
    // could hand the plugin a `projects` entry the derivation never sees: revisit
    // isToolchainConfigSource before adding one.
    const out = execFileSync('git', ['grep', '-l', '--recurse-submodules', '-e', 'tsconfigPaths(', '--', '*.ts', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const callers = out
      .split('\n')
      .filter(Boolean)
      .filter((rel) => !/\.test\.[cm]?[jt]sx?$/.test(rel));
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.filter((rel) => !isToolchainConfigSource(rel))).toEqual([]);
  });
});
