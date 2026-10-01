import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { testConfigMainProcessFiles } from './main-process-closure.ts';
import {
  ADMIN_TEST_RUNS_REPORTER_PATH,
  BASELINE_SCHEMA_GLOBAL_SETUP_PATH,
  PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV,
  defineVitestConfig,
  type TestLayer,
} from './vitest-config.ts';
import { WORKER_SETUP_FILE_PATHS } from './worker-setup-files.ts';

/**
 * gate-test-reuse-yield-2026-10-01 P-003 (D-004): the reuse rule keeps a test-config source file
 * global only when the vitest MAIN process can load it. Too small a set is unsound (a main-process
 * change would be matched per proof, and no proof records the main process), so the real-tree pin
 * below builds the actual config and requires every reporter and globalSetup it can hand vitest to
 * be in the set, and none of them to be declared worker-only.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** A throwaway package: { 'src/x.ts': '…' } plus a package.json with the given exports. */
function fixture(files: Record<string, string>, exportsField: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pc-main-closure-'));
  dirs.push(root);
  const pkg = join(root, 'libs', 'test-config');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(resolve(pkg, rel, '..'), { recursive: true });
    writeFileSync(join(pkg, rel), text);
  }
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: exportsField }));
  const srcDir = join(pkg, 'src');
  const run = (workerSetupFiles: string[] = []) =>
    [...testConfigMainProcessFiles({ srcDir, repoRoot: root, workerSetupFiles })].sort();
  return { run, srcDir };
}

describe('testConfigMainProcessFiles (synthetic tree)', () => {
  it('follows relative imports, re-exports, dynamic imports and path literals from vitest-config.ts', () => {
    const { run } = fixture({
      'src/vitest-config.ts': [
        "import { a } from './a.ts';",
        "export { b } from './b';",
        "const r = resolve(__dirname, 'reporter.ts');",
        "const g = new URL('./global-setup.ts', import.meta.url);",
        "if (x) await import('./lazy.js');",
      ].join('\n'),
      'src/a.ts': "import type { T } from './types.ts';",
      'src/b.ts': '',
      'src/types.ts': '',
      'src/reporter.ts': "import './reporter-helper.ts';",
      'src/reporter-helper.ts': '',
      'src/global-setup.ts': '',
      'src/lazy.ts': '',
      'src/worker-only.ts': '',
    });
    expect(run()).toEqual(
      [
        'a.ts',
        'b.ts',
        'global-setup.ts',
        'lazy.ts',
        'reporter-helper.ts',
        'reporter.ts',
        'types.ts',
        'vitest-config.ts',
      ].map((f) => `libs/test-config/src/${f}`),
    );
  });

  it('seeds every package export, since a config may import any of them bare', () => {
    const { run } = fixture(
      { 'src/vitest-config.ts': '', 'src/index.ts': "export * from './barrel-dep.ts';", 'src/barrel-dep.ts': '', 'src/x.ts': '' },
      { '.': './src/index.ts' },
    );
    expect(run()).toEqual(
      ['barrel-dep.ts', 'index.ts', 'vitest-config.ts'].map((f) => `libs/test-config/src/${f}`),
    );
  });

  it('skips a worker setup file reached only as a path literal, but keeps one a main-process file imports', () => {
    const files = {
      'src/vitest-config.ts': "const s = resolve(__dirname, 'setup-a.ts');\nconst t = resolve(__dirname, 'setup-b.ts');",
      'src/setup-a.ts': "import './setup-a-dep.ts';",
      'src/setup-a-dep.ts': '',
      'src/setup-b.ts': '',
    };
    const { run, srcDir } = fixture(files);
    const worker = [join(srcDir, 'setup-a.ts'), join(srcDir, 'setup-b.ts')];
    expect(run(worker)).toEqual(['libs/test-config/src/vitest-config.ts']);
    // Declared worker-only, but the main process imports it: the import edge wins.
    const imported = fixture({ ...files, 'src/vitest-config.ts': `${files['src/vitest-config.ts']}\nimport './setup-b.ts';` });
    expect(imported.run([join(imported.srcDir, 'setup-a.ts'), join(imported.srcDir, 'setup-b.ts')])).toEqual(
      ['libs/test-config/src/setup-b.ts', 'libs/test-config/src/vitest-config.ts'],
    );
  });

  it('ignores bare specifiers and anything resolving outside the source directory', () => {
    const { run } = fixture({
      'src/vitest-config.ts': "import 'vitest/config';\nimport '../outside.ts';\nimport './missing.ts';",
      'outside.ts': '',
    });
    expect(run()).toEqual(['libs/test-config/src/vitest-config.ts']);
  });
});

describe('testConfigMainProcessFiles (real tree)', () => {
  const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
  const rel = (abs: string) => relative(repoRoot, abs).split('\\').join('/');
  const closure = testConfigMainProcessFiles();

  it('holds the config, both gate reporters and the baseline-schema globalSetup', () => {
    for (const abs of [ADMIN_TEST_RUNS_REPORTER_PATH, BASELINE_SCHEMA_GLOBAL_SETUP_PATH]) {
      expect(closure.has(rel(abs))).toBe(true);
    }
    expect(closure.has('libs/test-config/src/vitest-config.ts')).toBe(true);
    expect(closure.has('libs/test-config/src/executed-source-map-reporter.ts')).toBe(true);
    // Worker setup files are per-proof inputs, so they must not be swept in.
    for (const abs of WORKER_SETUP_FILE_PATHS) expect(closure.has(rel(abs))).toBe(false);
  });

  it.each<TestLayer>(['unit', 'integration', 'browser'])(
    'the built %s config hands vitest no worker-declared file as a reporter or globalSetup, and every test-config one is in the closure',
    (layer) => {
      const prev = process.env[PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV];
      process.env[PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV] = 'main-process-closure-test';
      try {
        const cfg = defineVitestConfig({ layer, globalSetup: [BASELINE_SCHEMA_GLOBAL_SETUP_PATH] });
        const test = (cfg as { test?: Record<string, unknown> }).test ?? {};
        const asPaths = (v: unknown): string[] =>
          (Array.isArray(v) ? v : v == null ? [] : [v])
            .map((x) => (Array.isArray(x) ? x[0] : x))
            .filter((x): x is string => typeof x === 'string');
        const ours = (p: string) => rel(p).startsWith('libs/test-config/src/');
        const mainSide = [...asPaths(test.reporters), ...asPaths(test.globalSetup)].filter(ours);
        expect(mainSide.length).toBeGreaterThan(0);
        for (const p of mainSide) {
          expect(WORKER_SETUP_FILE_PATHS).not.toContain(p);
          expect(closure.has(rel(p))).toBe(true);
        }
        // Yield pin: every test-config setup file the config adds is declared worker-only.
        for (const p of asPaths(test.setupFiles).filter(ours)) expect(WORKER_SETUP_FILE_PATHS).toContain(p);
      } finally {
        if (prev === undefined) delete process.env[PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV];
        else process.env[PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV] = prev;
      }
    },
  );
});
