import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./__fixtures__/durable-completion', import.meta.url));
const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const directories: string[] = [];
const expectedFiles = ['armed-capture/sample.armed-fixture.ts', 'case-ledger/cases.case-fixture.ts',
  'durable-completion/collection-error.fixture.ts'];

async function runFixture(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [vitest, 'run', '--root', fixture,
    '--config', join(fixture, 'vitest.config.ts')],
  { cwd: fixture, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  let error: Error | undefined;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const stopOwnedTree = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure;
    }
  };
  const timer = setTimeout(() => {
    error = new Error('owned Vitest child exceeded its 120-second safety bound');
    stopOwnedTree();
  }, 120_000);
  try {
    return await new Promise<{ error: Error | undefined; signal: NodeJS.Signals | null;
      stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => {
        try { stopOwnedTree(); } catch (failure) { reject(failure); }
      });
      child.once('close', (_status, signal) => { resolve({ error, signal, stdout, stderr }); });
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) stopOwnedTree();
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('atomic completion through the real Vitest lifecycle', () => {
  it.each(['before-commit', 'committed-before-ack', 'acknowledged-before-kill'])(
    'recovers committed results and proof after %s', async phase => {
      const directory = mkdtempSync(join(tmpdir(), 'completion-crash-'));
      directories.push(directory);
      const outPath = join(directory, 'out.json');
      const resultPath = join(directory, 'result.jsonl');
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (!['PC_', 'VITEST', 'PAPERCUSP_TEST_', 'PAPERCUSP_CHECKPOINT_', 'PAPERCUSP_MUTATION_', 'AFFECTED_']
          .some(prefix => key.startsWith(prefix))) env[key] = value;
      }
      Object.assign(env, {
        PC_EXECUTED_SOURCE_MAP_WORKSPACE: '@papercusp/durable-completion-fixture',
        PC_EXECUTED_SOURCE_MAP_OUT: outPath,
        PC_EXECUTED_SOURCE_MAP_RESULT: resultPath,
        PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1',
        PC_EXECUTED_INPUTS_DIR: join(directory, 'inputs'),
        PC_COMPLETION_CRASH_WINDOW: phase,
        PAPERCUSP_TEST_RUN_GROUP: `frozen-durability-${phase}`,
        PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID: 'frozen-durability-attempt',
        HARNESS_ADMIN_DATABASE_URL: 'postgresql://127.0.0.1:1/completion-crash-fixture',
        PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://127.0.0.1:1/completion-crash-fixture',
      });
      const child = await runFixture(env);
      const output = `${child.stdout}\n${child.stderr}`;
      expect(child.error, output).toBeUndefined();
      expect(child.signal, output).toBe('SIGKILL');
      expect(existsSync(resultPath), output).toBe(false);
      const recovery = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(process.argv[1], 'utf8'));", outPath],
      { encoding: 'utf8', timeout: 10_000 });
      expect(recovery.status, recovery.stderr).toBe(0);
      const checkpoint = JSON.parse(recovery.stdout);
      const { completionIntegrity, ...body } = checkpoint;
      expect(completionIntegrity).toEqual({ schemaVersion: 1,
        sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') });
      const files = checkpoint.nativeRun.files as Array<{ testFile: string; completionId: string;
        state: string; proof: { inputs: unknown; sourceEvidence: unknown } }>;
      const selected = checkpoint.nativeRun.selectedManifest.specifications as Array<{ testFile: string }>;
      expect(selected).toHaveLength(expectedFiles.length);
      for (const expectedFile of expectedFiles)
        expect(selected.filter(specification => specification.testFile.endsWith(expectedFile))).toHaveLength(1);
      expect(files).toHaveLength(phase === 'before-commit' ? 2 : 3);
      const acknowledgmentIds = [...output.matchAll(/COMPLETION_ACK ids=(\[[^\n]+?\]) path=/g)]
        .flatMap(match => JSON.parse(match[1]!) as string[]);
      expect(acknowledgmentIds).toHaveLength(phase === 'acknowledged-before-kill' ? 3 : 2);
      for (const completionId of acknowledgmentIds)
        expect(files.filter(file => file.completionId === completionId)).toHaveLength(1);
      for (const file of files) expect(file.proof).toHaveProperty('sourceEvidence');
      expect(checkpoint.nativeRun.terminalHook).toBeNull();
      expect(checkpoint.completionCheckpoint).toMatchObject({ state: 'partial',
        runGroupId: `frozen-durability-${phase}`, qualificationAttemptId: 'frozen-durability-attempt', noPersist: true });
      if (phase !== 'before-commit') {
        expect(files.filter(file => file.state === 'passed')).toHaveLength(1);
        expect(files.filter(file => file.testFile.endsWith('cases.case-fixture.ts') && file.state !== 'passed')).toHaveLength(1);
        expect(files.filter(file => file.testFile.endsWith('collection-error.fixture.ts') && file.state !== 'passed')).toHaveLength(1);
      }
    }, 150_000);
});
