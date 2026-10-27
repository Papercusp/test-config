/**
 * gate-participation-config.test.ts — WI-10003716
 *
 * A hand-rolled `defineConfig` workspace takes part in the green-checkpoint gate by spreading
 * gateParticipationConfig() into its `test` block. Before this existed, twelve such workspaces
 * wired only the admin reporter, so they recorded zero pass proofs and never reused one.
 *
 * Two properties are pinned here:
 *   1. the fragment carries every gate-owned piece — admin reporter, executed-source-map reporter
 *      + raised import limit + input-capture setup (placed FIRST) when armed, and the reuse skip
 *      list — while keeping vitest's default excludes, which an explicit `exclude` would replace;
 *   2. defineVitestConfig carries the SAME gate-owned pieces under the same env, so the two
 *      enrollment paths cannot drift apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults } from 'vitest/config';
import AdminTestRunsReporter, { type TestRunRow } from './admin-test-runs-reporter.ts';
import {
  ADMIN_TEST_RUNS_REPORTER_PATH,
  HOST_PREFLIGHT_GLOBAL_SETUP,
  EXECUTED_SOURCE_MAP_IMPORT_LIMIT,
  PC_EXECUTED_INPUTS_DIR_ENV,
  PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV,
  defineVitestConfig,
  gateParticipationConfig,
} from './vitest-config.ts';
import {
  PC_TEST_REUSE_SKIP_LIST_ENV,
  PC_TEST_PARTIAL_SKIP_LIST_ENV,
  PARTIAL_SKIP_LIST_SCHEMA,
  REUSE_SKIP_LIST_SCHEMA,
  executedSourceRunnerIdentity,
} from './test-pass-reuse-skip.ts';
import * as runtimeProof from './runtime-proof.ts';

const EXECUTED_SOURCE_MAP_REPORTER = /executed-source-map-reporter\.ts$/;
const INPUTS_CAPTURE_SETUP = /executed-inputs-capture-setup\.ts$/;

let scratch: string;
let savedArgv: string[];
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gate-participation-'));
  savedArgv = process.argv;
  // defineVitestConfig's unit-layer guard reads argv; keep it free of positional filters.
  process.argv = ['node', 'vitest', 'run'];
  // WI-6554700010029866: a real runtime proof exists only in a pinned release/checkpoint
  // install (node_modules/.papercusp-dependency-generation). The mutable canonical tree
  // has none, so reuse is disabled there by design — pin one identity so these cases
  // test the config wiring, not which checkout they happen to run in.
  vi.spyOn(runtimeProof, 'captureCurrentRuntimeProofIdentity').mockReturnValue({
    name: 'node', version: '25.9.0', executable: '/pinned/node',
    binarySha256: 'a'.repeat(64), platform: 'linux', arch: 'x64',
    nativeDependencyGeneration: 'b'.repeat(64), lockfileSha256: 'c'.repeat(64),
    configurationSha256: 'd'.repeat(64),
  });
});
afterEach(() => {
  process.argv = savedArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

function writeSkipList(files: string[], runnerIdentity = executedSourceRunnerIdentity()): string {
  const path = join(scratch, 'skip.json');
  writeFileSync(
    path,
    JSON.stringify({
      schema: REUSE_SKIP_LIST_SCHEMA,
      files,
      runContext: 'clean-local',
      runnerIdentity,
      judgedSha: 'a'.repeat(40),
    }),
  );
  return path;
}

function writePartialSkipList(files: string[]): string {
  const path = join(scratch, 'partial-skip.json');
  writeFileSync(path, JSON.stringify({ schema: PARTIAL_SKIP_LIST_SCHEMA, taskKey: 'integration', sourceCommit: 'a', sourceDigest: 'b',
    runnerIdentity: executedSourceRunnerIdentity(), files }));
  return path;
}

describe('gateParticipationConfig — what a hand-rolled unit config spreads in', () => {
  it('unarmed: the admin reporter, the caller setup files, and vitest default excludes plus the caller excludes', () => {
    const fragment = gateParticipationConfig(
      { setupFiles: ['./src/test-setup.ts'], exclude: ['src/**/*.integration.test.ts'] },
      {},
    );
    expect(fragment).toEqual({
      provide: { papercuspTestLayer: 'unit' },
      reporters: ['default', ADMIN_TEST_RUNS_REPORTER_PATH],
      setupFiles: ['./src/test-setup.ts'],
      globalSetup: [HOST_PREFLIGHT_GLOBAL_SETUP],
      exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
    });
  });

  it('records the unit layer and executed case for a hand-rolled project', async () => {
    const fragment = gateParticipationConfig({}, {});
    const root = fileURLToPath(new URL('../', import.meta.url));
    const rows: TestRunRow[] = [];
    const reporter = new AdminTestRunsReporter(
      async () => ({ commit: 'abc', porcelain: '' }),
      async row => { rows.push(row); },
    );
    await reporter.onInit({ config: { root, provide: fragment.provide } } as never);
    reporter.onTestModuleEnd({
      moduleId: fileURLToPath(import.meta.url),
      project: { config: { provide: fragment.provide } },
      state: () => 'passed', diagnostic: () => ({ duration: 1 }), errors: () => [],
      children: { allTests: () => [{
        fullName: 'hand-rolled project > recorded case',
        result: () => ({ state: 'passed' }),
      }] },
    } as never);
    await reporter.onTestRunEnd();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.executionDetails?.testLayer).toBe('unit');
    expect(rows[0]!.executionDetails?.passedCaseTitles).toEqual(['hand-rolled project > recorded case']);
  });

  // WI-10005724: a hand-rolled config must not lose the host preflight to its own globalSetup,
  // and the preflight must run FIRST so its refusal precedes any container start-up.
  it('puts the host preflight before the caller globalSetup', () => {
    expect(gateParticipationConfig({ globalSetup: ['./src/own-global-setup.ts'] }, {}).globalSetup).toEqual([
      HOST_PREFLIGHT_GLOBAL_SETUP,
      './src/own-global-setup.ts',
    ]);
  });

  it('keeps vitest default excludes even with no caller excludes — setting exclude replaces them', () => {
    const { exclude } = gateParticipationConfig({}, {});
    expect(exclude).toEqual([...configDefaults.exclude]);
    expect(exclude).toContain('**/node_modules/**');
  });

  it('honours the admin reporter opt-out', () => {
    expect(gateParticipationConfig({}, { PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '1' }).reporters).toEqual(['default']);
  });

  it('armed: adds the proof reporter and raised import limit, and puts the input capture BEFORE the caller setup', () => {
    const env: NodeJS.ProcessEnv = {
      [PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV]: '@papercusp/agent-mcp',
      [PC_EXECUTED_INPUTS_DIR_ENV]: join(scratch, 'inputs'),
    };
    const fragment = gateParticipationConfig({ setupFiles: ['./src/test-setup.ts'] }, env);
    expect(fragment.reporters[0]).toBe('default');
    expect(fragment.reporters[1]).toBe(ADMIN_TEST_RUNS_REPORTER_PATH);
    expect(fragment.reporters[2]).toMatch(EXECUTED_SOURCE_MAP_REPORTER);
    expect(fragment.reporters).toHaveLength(3);
    expect(fragment.setupFiles).toHaveLength(2);
    expect(fragment.setupFiles[0]).toMatch(INPUTS_CAPTURE_SETUP);
    expect(fragment.setupFiles[1]).toBe('./src/test-setup.ts');
    expect(fragment.experimental).toEqual({
      importDurations: { limit: EXECUTED_SOURCE_MAP_IMPORT_LIMIT, print: false },
    });
  });

  it('applies a valid reuse skip list as literal (glob-escaped, sorted) excludes, after the caller excludes', () => {
    const env = { [PC_TEST_REUSE_SKIP_LIST_ENV]: writeSkipList(['src/a.test.ts', 'src/(g)/b.test.ts']) };
    expect(gateParticipationConfig({ exclude: ['x/**'] }, env).exclude).toEqual([
      ...configDefaults.exclude,
      'x/**',
      'src/\\(g\\)/b.test.ts',
      'src/a.test.ts',
    ]);
  });

  it('a skip list for another runner identity is declined, so every file runs', () => {
    const env = { [PC_TEST_REUSE_SKIP_LIST_ENV]: writeSkipList(['src/a.test.ts'], 'v0.0.0 plan9 mips') };
    expect(gateParticipationConfig({}, env).exclude).toEqual([...configDefaults.exclude]);
  });

  it('applies the partial skip channel only to integration configs', () => {
    const env = { AFFECTED_PARTIAL_RESUME: '1', [PC_TEST_PARTIAL_SKIP_LIST_ENV]: writePartialSkipList(['src/a.integration.test.ts']) };
    expect(gateParticipationConfig({}, env).exclude).toEqual([...configDefaults.exclude]);
    vi.stubEnv('AFFECTED_PARTIAL_RESUME', env.AFFECTED_PARTIAL_RESUME);
    vi.stubEnv(PC_TEST_PARTIAL_SKIP_LIST_ENV, env[PC_TEST_PARTIAL_SKIP_LIST_ENV]);
    const integration = defineVitestConfig({ layer: 'integration', exclude: ['caller/**'] }).test!;
    expect(integration.exclude).toContain('src/a.integration.test.ts');
    expect(integration.exclude).toContain('caller/**');
  });
});

describe('defineVitestConfig and gateParticipationConfig carry the same gate-owned pieces', () => {
  it('under one armed env with a skip list, both configs name the same reporters, capture, limit and skipped files', () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('GREEN_CHECKPOINT', undefined);
    vi.stubEnv('PAPERCUSP_DISABLE_TEST_RUNS_REPORTER', undefined);
    vi.stubEnv(PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV, '@papercusp/test-config');
    vi.stubEnv(PC_EXECUTED_INPUTS_DIR_ENV, join(scratch, 'inputs'));
    vi.stubEnv(PC_TEST_REUSE_SKIP_LIST_ENV, writeSkipList(['src/a.test.ts']));

    const plain = gateParticipationConfig();
    const shared = defineVitestConfig({ layer: 'unit' }).test!;

    // Gate-owned reporters are identical and follow 'default' in both.
    expect(shared.reporters).toEqual(plain.reporters);
    // The capture setup leads both setup lists.
    expect(plain.setupFiles[0]).toMatch(INPUTS_CAPTURE_SETUP);
    expect((shared.setupFiles as string[])[0]).toBe(plain.setupFiles[0]);
    expect(shared.experimental).toEqual(plain.experimental);
    // Both end with the same reuse-skip excludes.
    expect(plain.exclude.at(-1)).toBe('src/a.test.ts');
    expect((shared.exclude as string[]).at(-1)).toBe('src/a.test.ts');
  });

  it('unarmed, neither carries the proof reporter, the capture or the raised limit', () => {
    vi.stubEnv('CI', '');
    vi.stubEnv(PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV, undefined);
    vi.stubEnv(PC_TEST_REUSE_SKIP_LIST_ENV, undefined);
    vi.stubEnv('PAPERCUSP_DISABLE_TEST_RUNS_REPORTER', undefined);

    const plain = gateParticipationConfig();
    const shared = defineVitestConfig({ layer: 'unit' }).test!;
    expect(plain.reporters).toEqual(['default', ADMIN_TEST_RUNS_REPORTER_PATH]);
    expect(shared.reporters).toEqual(plain.reporters);
    expect(plain.experimental).toBeUndefined();
    expect(shared.experimental).toBeUndefined();
    expect((shared.setupFiles as string[]).some((f) => INPUTS_CAPTURE_SETUP.test(f))).toBe(false);
  });
});
