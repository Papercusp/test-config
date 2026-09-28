/**
 * WI-10003670 (plan gate-file-level-test-reuse-2026-09-27): run a REAL vitest child with the
 * executed-inputs capture ARMED, the way a green-checkpoint task arms it, and assert that the
 * run passes and the capture recorded the file's inputs.
 *
 * Why this exists: the P-009 capture setup (executed-inputs-capture-setup.ts) runs inside EVERY
 * test file of an armed task, but no test ever ran it inside real vitest. On 2026-09-28 it
 * registered `afterAll((suite?) => …)`, which Vitest 4 rejects (FixtureParseError), and the
 * first gate round that armed it failed 1,713 operator-core files at once.
 * setup-hook-signature.test.ts guards that one signature statically; this test catches any
 * runtime fault of the armed setup, whatever its shape.
 *
 * The control run adds a deliberately broken setup file (the 2026-09-28 hook shape) and must
 * FAIL. That proves the child's exit status reflects a setup-hook fault at all, so the passing
 * run is evidence rather than a run that could never fail.
 *
 * Isolation: the child gets its own result/out/inputs paths, every inherited runner variable is
 * stripped, and both database URLs point at a closed local port, so a child run never writes
 * test_runs or pass-proof rows and never touches the parent gate's result files.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '__fixtures__/armed-capture');
const FIXTURE_CONFIG = join(FIXTURE, 'vitest.config.ts');
const BROKEN_SETUP = join(FIXTURE, 'broken-suite-hook.fixture.ts');
const VITEST_BIN = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const UNREACHABLE_DB = 'postgresql://127.0.0.1:1/armed-capture-fixture';
const FIXTURE_WORKSPACE = '@papercusp/armed-capture-fixture';
const CHILD_TIMEOUT_MS = 120_000;

/** Inherited variables a runner or gate may set; none may leak into the child. */
const STRIPPED_PREFIXES = ['PC_', 'VITEST', 'PAPERCUSP_TEST_', 'PAPERCUSP_MUTATION_', 'AFFECTED_'];

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ArmedRun {
  status: number | null;
  output: string;
  mapPath: string;
  resultPath: string;
}

function runArmedFixture(extraSetup?: string): ArmedRun {
  const dir = mkdtempSync(join(tmpdir(), 'armed-capture-'));
  tempDirs.push(dir);
  const mapPath = join(dir, 'map.json');
  const resultPath = join(dir, 'result.jsonl');
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  Object.assign(env, {
    PC_EXECUTED_SOURCE_MAP_WORKSPACE: FIXTURE_WORKSPACE,
    PC_EXECUTED_INPUTS_DIR: join(dir, 'inputs'),
    PC_EXECUTED_SOURCE_MAP_OUT: mapPath,
    PC_EXECUTED_SOURCE_MAP_RESULT: resultPath,
    HARNESS_ADMIN_DATABASE_URL: UNREACHABLE_DB,
    PAPERCUSP_TEST_RUNS_DB_URL: UNREACHABLE_DB,
    ...(extraSetup ? { PC_ARMED_CAPTURE_FIXTURE_EXTRA_SETUP: extraSetup } : {}),
  });
  const child = spawnSync(process.execPath, [VITEST_BIN, 'run', '--root', FIXTURE, '--config', FIXTURE_CONFIG], {
    cwd: FIXTURE,
    env,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  });
  return { status: child.status, output: `${child.stdout ?? ''}\n${child.stderr ?? ''}`, mapPath, resultPath };
}

describe('executed-inputs capture, armed inside a real vitest run', () => {
  it(
    'an armed run of a real test file passes and records the file with its inputs captured',
    () => {
      const run = runArmedFixture();
      expect(run.status, run.output.slice(-4000)).toBe(0);
      expect(run.output).not.toMatch(/FixtureParseError|object destructuring/);

      // The out file is written on every flush, before the clean-checkout rail decides whether to
      // persist, so it shows what the capture produced even on a dirty tree.
      expect(existsSync(run.mapPath), run.output.slice(-4000)).toBe(true);
      const map = JSON.parse(readFileSync(run.mapPath, 'utf8')) as {
        workspaceName: string;
        rows: Array<{ inputsCaptured?: boolean }>;
      };
      expect(map.workspaceName).toBe(FIXTURE_WORKSPACE);
      expect(map.rows).toHaveLength(1);
      // The setup's afterAll wrote the file's inputs record and the reporter consumed it.
      expect(map.rows[0]?.inputsCaptured).toBe(true);

      // The runner-readable result channel reports this flush. The database is unreachable, so
      // the outcome is never `written`; it must still describe the one row.
      const lines = readFileSync(run.resultPath, 'utf8').trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1] ?? '{}') as { workspaceName?: string; outcome?: string; rows?: number };
      expect(last.workspaceName).toBe(FIXTURE_WORKSPACE);
      expect(['not-persisted', 'failed', 'timed-out']).toContain(last.outcome);
      expect(last.rows).toBe(1);
    },
    CHILD_TIMEOUT_MS + 30_000,
  );

  it(
    'control: a setup file with the 2026-09-28 suite-hook shape fails the armed run',
    () => {
      const run = runArmedFixture(BROKEN_SETUP);
      expect(run.status, run.output.slice(-4000)).not.toBe(0);
      expect(run.output).toMatch(/object destructuring/);
    },
    CHILD_TIMEOUT_MS + 30_000,
  );
});
