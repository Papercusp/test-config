import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { TestCoverageSnapshot } from './test-coverage-map.ts';

const here = dirname(fileURLToPath(import.meta.url));
const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe('P016 native V8 per-file collector', () => {
  it('source-maps actual execution and keeps an uncalled branch uncovered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'test-file-v8-')); dirs.push(dir);
    const artifact = join(dir, 'captured.json');
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(join(dir, 'subject.ts'), 'export function choose(flag: boolean) {\n  if (flag) return 1;\n  return 2;\n}\n');
    await writeFile(join(dir, 'subject.test.ts'), `import { test, expect } from ${JSON.stringify(join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'dist/index.js'))};\nimport { choose } from './subject';\ntest('positive', () => expect(choose(true)).toBe(1));\n`);
    await writeFile(join(dir, 'provider.ts'), `import { TestFileCoverageProvider } from ${JSON.stringify(join(here, 'test-coverage-provider.ts'))};
import v8 from ${JSON.stringify(createRequire(import.meta.url).resolve('@vitest/coverage-v8'))};
import { writeFile } from 'node:fs/promises';
export default { ...v8, getProvider: () => new TestFileCoverageProvider(rows => writeFile(${JSON.stringify(artifact)}, JSON.stringify(rows))) };
`);
    await writeFile(join(dir, 'vitest.config.ts'), `import { defineConfig } from ${JSON.stringify(createRequire(import.meta.url).resolve('vitest/config'))};
import { executedSourceOriginalsPlugin } from ${JSON.stringify(join(here, 'vitest-config.ts'))};
export default defineConfig({ plugins: [executedSourceOriginalsPlugin()], test: { include: ['subject.test.ts'], maxWorkers: 1,
coverage: { enabled: true, provider: 'custom', customProviderModule: './provider.ts', include: ['subject.ts'], reporter: ['json'], reportsDirectory: './reports' } } });
`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:PC_|VITEST|AFFECTED_|PAPERCUSP_TEST_|PAPERCUSP_MUTATION_)/.test(key)));
    Object.assign(env, { PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '1', HARNESS_ADMIN_DATABASE_URL: 'postgresql://127.0.0.1:1/unreachable',
      PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://127.0.0.1:1/unreachable' });
    await promisify(execFile)(process.execPath, [vitest, 'run', '--root', dir, '--config', join(dir, 'vitest.config.ts')],
      { cwd: resolve(here, '../../..'), env, timeout: 90_000, maxBuffer: 1_000_000 });
    const snapshots = JSON.parse(await readFile(artifact, 'utf8')) as TestCoverageSnapshot[];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.testFile).toBe('subject.test.ts');
    expect(snapshots[0]?.sources).toEqual([expect.objectContaining({ path: 'subject.ts',
      executable: expect.arrayContaining([2, 3]), covered: expect.arrayContaining([2]) })]);
    expect(snapshots[0]?.sources[0]?.covered).not.toContain(3);
  }, 120_000);
});
