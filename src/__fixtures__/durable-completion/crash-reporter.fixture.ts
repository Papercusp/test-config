import { readFileSync, writeFileSync } from 'node:fs';
import type { TestModule } from 'vitest/node';
import ExecutedSourceMapReporter, { writeExecutedSourceMapSnapshot } from '../../executed-source-map-reporter.ts';

export default class CrashReporter extends ExecutedSourceMapReporter {
  constructor() {
    super(undefined, undefined, undefined, (path, payload) => {
      const checkpoint = payload as { nativeRun: { files: unknown[] } };
      if (checkpoint.nativeRun.files.length === 3 && process.env.PC_COMPLETION_CRASH_WINDOW === 'before-commit') {
        writeFileSync(`${path}.incomplete.tmp`, '{"nativeRun":');
        process.kill(process.pid, 'SIGKILL');
      }
      writeExecutedSourceMapSnapshot(path, payload);
      if (checkpoint.nativeRun.files.length === 3 && process.env.PC_COMPLETION_CRASH_WINDOW === 'committed-before-ack')
        process.kill(process.pid, 'SIGKILL');
    });
  }

  override async onTestModuleEnd(testModule: TestModule): Promise<void> {
    await super.onTestModuleEnd(testModule);
    if (process.env.PC_COMPLETION_CRASH_WINDOW !== 'acknowledged-before-kill') return;
    const checkpoint = JSON.parse(readFileSync(process.env.PC_EXECUTED_SOURCE_MAP_OUT!, 'utf8'));
    if (checkpoint.nativeRun.files.length === 3) process.kill(process.pid, 'SIGKILL');
  }
}
