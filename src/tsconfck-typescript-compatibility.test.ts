import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNative, TSConfckCache, type TSConfckParseNativeResult, type TSConfckParseResult } from 'tsconfck';
import { createServer } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { afterEach, describe, expect, it } from 'vitest';
import { satisfies } from '../../../scripts/check-peer-dep-conflicts.mjs';

// tsconfck's optional TypeScript peer stops at v5. These real-library checks
// cover the compiler interface a compatibility override would rely on, including
// the Vite plugin's parseNative path. They do not suppress npm's peer diagnostics.
const require = createRequire(import.meta.url);
const typescript = require('typescript') as {
  sys: unknown;
  resolveModuleName(name: string, importer: string, options: unknown, host: unknown): {
    resolvedModule?: { resolvedFileName: string };
  };
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'tsconfck-host-compiler-'));
  dirs.push(root);
  for (const [path, value] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

function aliasTree(): string {
  return tree({
    'package.json': { name: 'tsconfck-host-compiler-fixture', dependencies: { typescript: '*' } },
    'tsconfig.base.json': {
      compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
        paths: { '@fixture/*': ['./src/*'] },
      },
    },
    'tsconfig.json': { extends: './tsconfig.base.json', include: ['src/**/*.ts'], references: [{ path: './dependency' }] },
    'src/main.ts': "import { value } from '@fixture/value';\nexport { value };\n",
    'src/value.ts': 'export const value = 42;\n',
    'dependency/tsconfig.json': { compilerOptions: { composite: true }, include: ['src/**/*.ts'] },
    'dependency/src/index.ts': 'export const dependency = true;\n',
  });
}

describe('tsconfck native host-compiler compatibility', () => {
  it('records a scoped host-compiler override when the upstream peer range is outdated', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const host = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const compiler = JSON.parse(readFileSync(require.resolve('typescript/package.json'), 'utf8'));
    const parser = JSON.parse(readFileSync(
      resolve(dirname(fileURLToPath(import.meta.resolve('tsconfck'))), '../package.json'), 'utf8',
    ));
    if (!satisfies(compiler.version, parser.peerDependencies.typescript)) {
      // Bind this exception to the tested host compiler instead of granting
      // every future compiler version an unconditional wildcard exception.
      expect(host.overrides?.tsconfck?.typescript).toBe('$typescript');
      const spec = host.devDependencies.typescript;
      const range = spec.startsWith('npm:') ? spec.slice(spec.lastIndexOf('@') + 1) : spec;
      expect(satisfies(compiler.version, range)).toBe(true);
    }
  });

  it('uses the host TypeScript 6 compiler for extends, aliases and project references', async () => {
    const manifest = JSON.parse(readFileSync(require.resolve('typescript/package.json'), 'utf8'));
    expect(manifest.version.split('.')[0]).toBe('6');
    const root = aliasTree();
    const parsed = await parseNative(join(root, 'tsconfig.json'));
    expect(parsed.result?.fileNames).toContain(join(root, 'src/main.ts'));
    expect(parsed.result?.options.strict).toBe(true);
    expect(parsed.referenced?.map((ref) => ref.tsconfigFile)).toEqual([join(root, 'dependency/tsconfig.json')]);
    const module = typescript.resolveModuleName(
      '@fixture/value', join(root, 'src/main.ts'), parsed.result?.options, typescript.sys,
    );
    expect(module.resolvedModule?.resolvedFileName).toBe(join(root, 'src/value.ts'));
  });

  it('reuses a native parse through the existing tsconfck cache', async () => {
    const root = aliasTree();
    const cache = new TSConfckCache<TSConfckParseNativeResult | TSConfckParseResult>();
    const first = await parseNative(join(root, 'tsconfig.json'), { cache });
    const second = await parseNative(join(root, 'src/main.ts'), { cache });
    expect(second).toBe(first);
  });

  it('rejects a broken extends chain with compiler diagnostics', async () => {
    const root = tree({ 'tsconfig.json': { extends: './missing.json' } });
    await expect(parseNative(join(root, 'tsconfig.json'))).rejects.toThrow(/missing\.json/);
  });

  it('resolves a Vite import through the real plugin with parseNative enabled', async () => {
    const root = aliasTree();
    const server = await createServer({
      root,
      configFile: false,
      plugins: [tsconfigPaths({ projects: ['tsconfig.json'], parseNative: true })],
      server: { middlewareMode: true, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    try {
      const result = await server.pluginContainer.resolveId('@fixture/value', join(root, 'src/main.ts'));
      expect(result?.id).toBe(join(root, 'src/value.ts'));
    } finally {
      await server.close();
    }
  });
});
