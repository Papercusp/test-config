import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { testTimingRuntimeIdentity } from './test-timeout-runtime.ts';
import { defineVitestConfig, gateParticipationConfig } from './vitest-config.ts';

const run = promisify(execFile);
const runner = fileURLToPath(new URL('./historical-timeout-runner.ts', import.meta.url));
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/vitest/vitest.mjs');

describe('history-derived native Vitest execution', () => {
  it('wires both config entry points on the gate path and keeps the browser runner', () => {
    const saved = process.env.GREEN_CHECKPOINT;
    process.env.GREEN_CHECKPOINT = '1';
    try {
      expect(defineVitestConfig({ layer: 'unit' }).test?.runner).toBe(runner);
      expect(defineVitestConfig({ layer: 'integration' }).test?.runner).toBe(runner);
      expect(gateParticipationConfig().runner).toBe(runner);
      expect(defineVitestConfig({ layer: 'unit' }).test?.pool).toMatchObject({ name: 'papercusp-progress-forks', createPoolWorker: expect.any(Function) });
      expect(gateParticipationConfig().pool).toMatchObject({ name: 'papercusp-progress-forks', createPoolWorker: expect.any(Function) });
      expect(gateParticipationConfig().reporters.some(path => path.endsWith('worker-progress-pool.ts'))).toBe(true);
      expect(defineVitestConfig({ layer: 'browser' }).test?.runner).toBeUndefined();
      expect(defineVitestConfig({ layer: 'browser' }).test?.pool).toBe('threads');
      expect(gateParticipationConfig({}, {}).runner).toBeUndefined();
      expect(gateParticipationConfig({}, {}).pool).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.GREEN_CHECKPOINT;
      else process.env.GREEN_CHECKPOINT = saved;
    }
  });

  it('uses different case budgets, aborts a hung callback, cleans up, and runs the next case', async () => {
    const root = mkdtempSync(join(tmpdir(), 'historical-vitest-'));
    const now = Date.now();
    const runtime = testTimingRuntimeIdentity();
    const samples = ['a', 'b', 'c'].flatMap(runId => [
      { caseKey: 'slow', caseDurationMs: 90_000 },
      { caseKey: 'hung', caseDurationMs: 100 },
    ].map(test => ({ ...test, runId, file: 'fixture.test.ts', occurrence: 1, layer: 'unit',
      runnerIdentity: runtime, observedAtMs: now - 1_000, status: 'pass', clean: true, fileDurationMs: 100_000 })));
    try {
      writeFileSync(join(root, 'fixture.test.ts'), `
        import { it, expect, afterEach } from 'vitest';
        let aborted = false;
        let cleaned = false;
        afterEach(() => { if (aborted) cleaned = true; });
        it('slow', ({ task }) => { expect(task.timeout).toBe(365000); });
        it.fails('hung', async ({ signal, task }) => {
          expect(task.timeout).toBe(15000);
          signal.addEventListener('abort', () => { aborted = true; });
          await new Promise(() => {});
        });
        it('next case', () => { expect(aborted).toBe(true); expect(cleaned).toBe(true); });
      `);
      const outputFile = join(root, 'result.json');
      writeFileSync(join(root, 'vitest.config.mjs'), `export default { test: {
        root: ${JSON.stringify(root)}, include: ['fixture.test.ts'],
        runner: ${JSON.stringify(runner)}, pool: 'forks', maxWorkers: 1,
        testTimeout: 1, hookTimeout: 1000,
        provide: { papercuspTestLayer: 'unit', papercuspTestTimeoutHistory: ${JSON.stringify({
          schema: 1, root, runnerIdentity: runtime, observedAtMs: now, samples,
        })} }, reporters: ['json'], outputFile: ${JSON.stringify(outputFile)}
      } };`);
      // The 1ms uniform default is intentionally too small. The runner must
      // replace it BEFORE collection; simply mutating task.timeout would fail.
      await run(process.execPath, [cli, 'run', '--configLoader', 'native', '--config', join(root, 'vitest.config.mjs')], {
        cwd: root, env: { ...process.env, GREEN_CHECKPOINT: '0' }, maxBuffer: 200_000,
      });
      const result = JSON.parse(readFileSync(outputFile, 'utf8'));
      expect(result.numPassedTests).toBe(3);
      expect(result.numFailedTests).toBe(0);
      const hung = result.testResults[0].assertionResults.find((test: { title: string }) => test.title === 'hung');
      // Expected-failure status alone is insufficient: an import/assertion error
      // would also satisfy it.fails. The elapsed deadline and following case prove cancellation.
      expect(hung.duration).toBeGreaterThanOrEqual(14_900);
      expect(hung.duration).toBeLessThan(25_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
