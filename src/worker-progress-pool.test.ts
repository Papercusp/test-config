import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorkerProgressLease } from './worker-progress-pool.ts';

const run = promisify(execFile);
const source = fileURLToPath(new URL('./worker-progress-pool.ts', import.meta.url));
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/vitest/vitest.mjs');

describe('parent worker inactivity recovery', () => {
  afterEach(() => vi.useRealTimers());

  it('reaps a silent worker while its healthy peer keeps completing work', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stalled = vi.fn();
    const healthy = vi.fn();
    const blocked = createWorkerProgressLease(stalled);
    const advancing = createWorkerProgressLease(healthy);
    blocked.advance(1000);
    advancing.advance(1000);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(250);
      advancing.advance();
    }
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(healthy).not.toHaveBeenCalled();
    // There is no run-length cap: repeated actual completions keep this lease alive.
    for (let i = 0; i < 100; i++) { vi.advanceTimersByTime(500); advancing.advance(); }
    expect(healthy).not.toHaveBeenCalled();
    advancing.stop();
    vi.advanceTimersByTime(10_000);
    expect(healthy).not.toHaveBeenCalled();
  });

  it('rejects an invalid budget instead of disabling recovery', () => {
    const lease = createWorkerProgressLease(vi.fn());
    for (const invalid of [0, -1, Infinity, NaN]) expect(() => lease.advance(invalid)).toThrow();
  });

  it('stops a synchronously spinning fork and lets an independently progressing fork finish', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-progress-'));
    const outputFile = join(root, 'result.json');
    try {
      writeFileSync(join(root, 'blocked.test.ts'), `import { it } from 'vitest';
        it('blocks its event loop', () => { while (true) {} });`);
      writeFileSync(join(root, 'healthy.test.ts'), `import { it } from 'vitest';
        for (let i = 0; i < 14; i++) it('progress ' + i, async () => {
          await new Promise(resolve => setTimeout(resolve, 500));
        });`);
      writeFileSync(join(root, 'vitest.config.mjs'), `
        import { createProgressForksPool } from ${JSON.stringify(source)};
        export default { test: { root: ${JSON.stringify(root)}, include: ['*.test.ts'],
          pool: createProgressForksPool({ idleTimeoutMs: 5000 }), maxWorkers: 2,
          testTimeout: 20000, reporters: ['json', ${JSON.stringify(source)}],
          outputFile: ${JSON.stringify(outputFile)} } };`);
      let failed: { code?: number; killed?: boolean; stdout?: string; stderr?: string } | undefined;
      try {
        await run(process.execPath, [cli, 'run', '--configLoader', 'native', '--config', join(root, 'vitest.config.mjs')], {
          cwd: root, env: { ...process.env, GREEN_CHECKPOINT: '0' }, timeout: 45_000, maxBuffer: 200_000,
        });
      } catch (error) { failed = error as typeof failed; }
      expect(failed?.code).toBe(1);
      expect(failed?.killed).not.toBe(true);
      if (!`${failed?.stdout}\n${failed?.stderr}`.includes('Vitest worker made no test progress:')) {
        throw new Error(`Native worker fixture did not reach recovery:\n${failed?.stdout}\n${failed?.stderr}`);
      }
      expect(`${failed?.stdout}\n${failed?.stderr}`).toContain('Vitest worker made no test progress:');
      expect(`${failed?.stdout}\n${failed?.stderr}`).toContain('blocked.test.ts');
      const result = JSON.parse(readFileSync(outputFile, 'utf8'));
      const healthy = result.testResults.find((file: { name: string }) => file.name.endsWith('healthy.test.ts'));
      expect(healthy.assertionResults).toHaveLength(14);
      expect(healthy.assertionResults.every((test: { status: string }) => test.status === 'passed')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});
