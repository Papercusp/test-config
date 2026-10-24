import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { TestCoverageSnapshot } from './test-coverage-map.ts';
import { qualifyCoverageSnapshots } from './test-coverage-map.ts';
import { readTestCoverage } from './test-coverage-store.ts';
import { startDedicatedNativePg } from './pg.ts';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe('P016 native V8 per-file collector', () => {
  it('ingests child execution into its canonical scope and rejects source drift without changing LCOV', async () => {
    const pg = await startDedicatedNativePg();
    const sql = postgres(pg.getConnectionUri(), { max: 2, onnotice: () => {} });
    try {
      await sql`CREATE SCHEMA harness_shared`;
      await sql.unsafe(await readFile(resolve(here, '../../papercusp/libs/db/sql/1566-test-coverage-map.sql'), 'utf8'));
      const dir = await mkdtemp(join(tmpdir(), 'coverage-gate-child-')); dirs.push(dir);
      const canonical = await mkdtemp(join(tmpdir(), 'coverage-canonical-')); dirs.push(canonical);
      const source = 'export function choose(flag: boolean) {\n  if (flag) return 1;\n  return 2;\n}\n';
      const test = `import { test, expect } from ${JSON.stringify(join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'dist/index.js'))};\nimport { choose } from './subject';\ntest('positive', () => expect(choose(true)).toBe(1));\n`;
      for (const root of [dir, canonical]) {
        await writeFile(join(root, 'package.json'), '{"type":"module"}');
        await writeFile(join(root, 'subject.ts'), source);
        await writeFile(join(root, 'subject.test.ts'), test);
      }
      await writeFile(join(dir, 'vitest.config.ts'), `import { defineConfig } from ${JSON.stringify(join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'dist/config.js'))};
import { executedSourceOriginalsPlugin } from ${JSON.stringify(join(here, 'vitest-config.ts'))};
export default defineConfig({ plugins: [executedSourceOriginalsPlugin()], test: { include: ['subject.test.ts'], maxWorkers: 1,
coverage: { provider: 'custom', customProviderModule: ${JSON.stringify(join(here, 'test-coverage-provider.ts'))}, include: ['subject.ts'], reporter: ['json','lcov'], reportsDirectory: './reports' } } });
`);
      const scope = { workspaceId: 'coverage-workspace', harnessSlug: 'coverage-harness',
        executionRoot: dir, repositoryRoot: canonical, candidate: 'a'.repeat(40) };
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(?:PC_|VITEST|AFFECTED_|PAPERCUSP_TEST_|PAPERCUSP_MUTATION_|PAPERCUSP_WORKSPACE|PAPERCUSP_HARNESS)/.test(key)));
      Object.assign(env, { GREEN_CHECKPOINT: '1', PAPERCUSP_TEST_RUN_SOURCE: 'ci', PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '1',
        PC_TEST_FILE_COVERAGE_SCOPE: JSON.stringify(scope), PAPERCUSP_TEST_RUNS_DB_URL: pg.getConnectionUri() });
      // Load generated fixture config as native source so committed import hooks
      // verify its dependencies individually rather than a Vite timestamp bundle.
      const result = await promisify(execFile)(process.execPath, [vitest, 'run', '--coverage', '--root', dir,
        '--config', join(dir, 'vitest.config.ts'), '--configLoader', 'native'],
        { cwd: resolve(here, '../../..'), env, timeout: 90_000, maxBuffer: 1_000_000 });
      const rows = await readTestCoverage(sql, scope.workspaceId, scope.harnessSlug, canonical, ['subject.ts']);
      expect(rows, result.stdout + result.stderr).toHaveLength(1);
      expect(rows[0]).toMatchObject({ root: canonical, scopeRoot: canonical, testFile: 'subject.test.ts',
        provenance: { executionRoot: dir, candidate: scope.candidate }, populationComplete: true });
      expect(rows[0]!.sources[0]!.covered).toContain(2);
      expect(rows[0]!.sources[0]!.covered).not.toContain(3);
      expect(await readTestCoverage(sql, 'other-workspace', scope.harnessSlug, canonical, ['subject.ts'])).toEqual([]);
      expect(await readFile(join(dir, 'reports/lcov.info'), 'utf8')).toContain('SF:subject.ts');
      expect(await readFile(join(dir, 'reports/coverage-final.json'), 'utf8')).toContain('subject.ts');
      await writeFile(join(canonical, 'subject.ts'), source + '// newer source\n');
      await expect(qualifyCoverageSnapshots([{ ...rows[0]!, root: dir, scopeRoot: dir }], scope))
        .rejects.toThrow('canonical source mismatch');
    } finally { await sql.end({ timeout: 3 }); await pg.stop(); }
  }, 120_000);
  it('source-maps actual execution and keeps an uncalled branch uncovered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'test-file-v8-')); dirs.push(dir);
    const artifact = join(dir, 'captured.json');
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(join(dir, 'subject.ts'), 'export function choose(flag: boolean) {\n  if (flag) return 1;\n  return 2;\n}\n');
    await writeFile(join(dir, 'unused.ts'), 'export const neverLoaded = 1;\n');
    await writeFile(join(dir, 'subject.test.ts'), `import { test, expect } from ${JSON.stringify(join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'dist/index.js'))};\nimport { choose } from './subject';\ntest('positive', () => expect(choose(true)).toBe(1));\n`);
    await writeFile(join(dir, 'provider.ts'), `import { TestFileCoverageProvider } from ${JSON.stringify(join(here, 'test-coverage-provider.ts'))};
import v8 from ${JSON.stringify(createRequire(import.meta.url).resolve('@vitest/coverage-v8'))};
import { writeFile } from 'node:fs/promises';
export default { ...v8, getProvider: () => new TestFileCoverageProvider(rows => writeFile(${JSON.stringify(artifact)}, JSON.stringify(rows))) };
`);
    await writeFile(join(dir, 'vitest.config.ts'), `import { defineConfig } from ${JSON.stringify(join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'dist/config.js'))};
import { executedSourceOriginalsPlugin } from ${JSON.stringify(join(here, 'vitest-config.ts'))};
export default defineConfig({ plugins: [executedSourceOriginalsPlugin()], test: { include: ['subject.test.ts'], maxWorkers: 1,
coverage: { enabled: true, provider: 'custom', customProviderModule: './provider.ts', include: ['subject.ts','unused.ts'], reporter: ['json'], reportsDirectory: './reports' } } });
`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:PC_|VITEST|AFFECTED_|PAPERCUSP_TEST_|PAPERCUSP_MUTATION_)/.test(key)));
    Object.assign(env, { PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '1', HARNESS_ADMIN_DATABASE_URL: 'postgresql://127.0.0.1:1/unreachable',
      PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://127.0.0.1:1/unreachable' });
    const result = await promisify(execFile)(process.execPath, [vitest, 'run', '--root', dir,
      '--config', join(dir, 'vitest.config.ts'), '--configLoader', 'native'],
      { cwd: resolve(here, '../../..'), env, timeout: 90_000, maxBuffer: 1_000_000 });
    const snapshots = JSON.parse(await readFile(artifact, 'utf8').catch(error => {
      throw new Error(`Native V8 capture missing: ${String(error)}\n${result.stdout}\n${result.stderr}`);
    })) as TestCoverageSnapshot[];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.testFile).toBe('subject.test.ts');
    expect(snapshots[0]?.sources).toEqual([expect.objectContaining({ path: 'subject.ts',
      executable: expect.arrayContaining([2, 3]), covered: expect.arrayContaining([2]) })]);
    expect(snapshots[0]?.sources[0]?.covered).not.toContain(3);
    expect(await readFile(join(dir, 'reports/coverage-final.json'), 'utf8')).toContain('unused.ts');
  }, 120_000);
});
