import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { satisfies } from '../../../scripts/check-peer-dep-conflicts.mjs';

// Nx 22.6.5 pins tsquery ~6.1.4, whose TypeScript peer excludes the host's
// TypeScript 6. Exercise the parser resolved by Nx and its real migration so
// the narrow override cannot hide a broken migration or another stale install.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'package.json'));
const nxRequire = createRequire(require.resolve('@nx/jest/package.json'));
const queryManifest = JSON.parse(readFileSync(nxRequire.resolve('@phenomnomnominal/tsquery/package.json'), 'utf8'));
const queryRequire = createRequire(nxRequire.resolve('@phenomnomnominal/tsquery/package.json'));

interface TestTree {
  write(path: string, value: string): void;
  read(path: string, encoding: 'utf-8'): string | null;
}

const { createTreeWithEmptyWorkspace } = require('@nx/devkit/testing') as {
  createTreeWithEmptyWorkspace(): TestTree;
};
const migrate = nxRequire('./src/migrations/update-22-2-0/convert-jest-config-to-cjs').default as
  (tree: TestTree) => Promise<unknown>;

function configTree(source: string): TestTree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write('nx.json', JSON.stringify({ plugins: ['@nx/jest/plugin'] }));
  tree.write('package.json', JSON.stringify({ type: 'commonjs' }));
  tree.write('jest.config.ts', source);
  return tree;
}

describe('installed Nx tsquery compatibility', () => {
  it('accepts the actual TypeScript version resolved by the Nx parser', () => {
    const typescript = JSON.parse(readFileSync(queryRequire.resolve('typescript/package.json'), 'utf8'));
    expect(satisfies(typescript.version, queryManifest.peerDependencies.typescript)).toBe(true);
  });

  it('converts named imports and the default Jest config using the real Nx migration', async () => {
    const tree = configTree("import { defaults } from 'jest-config';\nexport default { ...defaults, testEnvironment: 'node' };\n");
    await migrate(tree);
    const result = tree.read('jest.config.ts', 'utf-8');
    expect(result).toContain("const { defaults } = require('jest-config')");
    expect(result).toContain('module.exports =');
    expect(result).toContain("testEnvironment: 'node'");
    expect(result).not.toContain('export default');
  });

  it('preserves an ESM-only config instead of generating invalid CommonJS', async () => {
    const source = 'export default { rootDir: import.meta.dirname };\n';
    const tree = configTree(source);
    const warning = await migrate(tree);
    expect(tree.read('jest.config.ts', 'utf-8')).toBe(source);
    expect(warning).toBeTypeOf('function');
  });
});
