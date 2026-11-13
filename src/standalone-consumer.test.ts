/** EI-28696575595262072: shared tooling must load in a standalone consumer. */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(packageRoot, '../..');
let root: string;
let installed: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'test-config-consumer-'));
  installed = join(root, 'libs/test-config');
  mkdirSync(dirname(installed), { recursive: true });
  cpSync(packageRoot, installed, {
    recursive: true,
    filter: path => !['.git', 'node_modules', 'coverage', 'dist'].includes(path.split('/').at(-1)!),
  });
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}');
  // Dependencies may be shared; the package under test must be a real copy.
  symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
function freshNode(source: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, NODE_OPTIONS: '', ...env },
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
}
function manifest(directory: string, env: NodeJS.ProcessEnv = {}) {
  const url = pathToFileURL(join(installed, 'src/source-byte-census.mjs')).href;
  return freshNode(
    'const {captureSourceByteManifest}=await import(' + JSON.stringify(url) + ');'
    + 'console.log(JSON.stringify(captureSourceByteManifest(' + JSON.stringify(directory) + ')));', env,
  ) as null | { path: string; sha256: string }[];
}
function subject(name: string) {
  const directory = join(root, name);
  mkdirSync(directory);
  return directory;
}
describe('standalone test-config consumer', () => {
  it('loads the real config and reporter without host scripts or operator-core', () => {
    expect(existsSync(join(root, 'scripts'))).toBe(false);
    expect(existsSync(join(root, 'packages/operator-core'))).toBe(false);
    const url = pathToFileURL(join(installed, 'src/vitest-config.ts')).href;
    const result = freshNode(
      'const {defineVitestConfig}=await import(' + JSON.stringify(url) + ');'
      + 'process.argv=["node","consumer"];'
      + 'const config=defineVitestConfig({layer:"e2e"});'
      + 'const entry=config.test.reporters.find(value=>Array.isArray(value)&&String(value[0]).endsWith("/admin-test-runs-reporter.ts"));'
      + 'if(!entry)throw new Error("real reporter missing from consumer config");'
      + 'const {default:Reporter}=await import(entry[0]);'
      + 'console.log(JSON.stringify({reporter:typeof Reporter,layer:config.test.provide.papercuspTestLayer}));',
      { PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '0' },
    );
    expect(result).toEqual({ reporter: 'function', layer: 'e2e' });
  });
  it('hashes an archive without including generated trees', () => {
    const directory = subject('archive');
    writeFileSync(join(directory, 'source.ts'), 'export const answer = 42;\n');
    mkdirSync(join(directory, 'node_modules'));
    writeFileSync(join(directory, 'node_modules/generated.ts'), 'ignored');
    expect(manifest(directory)).toEqual([{ path: 'source.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  });
  it('preserves NUL-delimited tracked and untracked filenames and Git ignores', () => {
    const directory = subject('git-consumer');
    execFileSync('git', ['init', '--quiet', directory]);
    const tracked = 'tracked-"quote"-\nline.ts';
    writeFileSync(join(directory, tracked), 'tracked');
    execFileSync('git', ['add', '--', tracked], { cwd: directory });
    writeFileSync(join(directory, 'new.ts'), 'untracked');
    writeFileSync(join(directory, '.gitignore'), 'ignored.ts\n');
    writeFileSync(join(directory, 'ignored.ts'), 'ignored');
    expect(manifest(directory)?.map(file => file.path).sort()).toEqual(['.gitignore', 'new.ts', tracked].sort());
  });
  it('refuses a corrupt index instead of certifying an empty or partial manifest', () => {
    const directory = subject('corrupt-index');
    execFileSync('git', ['init', '--quiet', directory]);
    writeFileSync(join(directory, 'source.ts'), 'must not disappear');
    const index = join(directory, '.git/index');
    writeFileSync(index, '');
    expect(manifest(directory, { GIT_INDEX_FILE: index })).toBeNull();
  });
  it('refuses declared but unscanned submodules', () => {
    const directory = subject('unscanned');
    execFileSync('git', ['init', '--quiet', directory]);
    writeFileSync(join(directory, '.gitmodules'), '[submodule "missing"]\npath = missing\nurl = https://example.invalid/missing.git\n');
    writeFileSync(join(directory, 'source.ts'), 'partial');
    expect(manifest(directory)).toBeNull();
  });
});
