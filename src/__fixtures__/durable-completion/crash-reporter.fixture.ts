import fs, { readFileSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type { TestModule } from 'vitest/node';
import ExecutedSourceMapReporter, { writeExecutedSourceMapSnapshot } from '../../executed-source-map-reporter.ts';

function interrupt(phase: string): void {
  const signal = process.env.PC_COMPLETION_CRASH_SIGNAL;
  if (signal !== 'SIGTERM' && signal !== 'SIGKILL') throw new Error('unsupported completion crash signal');
  writeSync(2, `REAL_COMPLETION_WRITE_INTERRUPTED phase=${phase} signal=${signal}\n`);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}

export default class CrashReporter extends ExecutedSourceMapReporter {
  constructor() {
    super(undefined, undefined, undefined, (path, payload) => {
      const checkpoint = payload as { nativeRun: { files: unknown[] } };
      const phase = process.env.PC_COMPLETION_CRASH_WINDOW;
      const originalWrite = fs.writeFileSync;
      const originalSync = fs.fsyncSync;
      if (checkpoint.nativeRun.files.length === 3) {
        // Intercept the real writer's descriptor, after its exclusive temporary
        // file has opened. No substitute writer or unrelated scratch file is used.
        fs.writeFileSync = (file, data, options) => {
          if (typeof file === 'number' && phase === 'before-commit') {
            originalWrite(file, '{"nativeRun":');
            interrupt(phase);
          }
          originalWrite(file, data, options);
        };
        fs.fsyncSync = descriptor => {
          originalSync(descriptor);
          if (phase === 'file-synced-before-rename') interrupt(phase);
        };
        syncBuiltinESMExports();
      }
      try {
        writeExecutedSourceMapSnapshot(path, payload);
      } finally {
        fs.writeFileSync = originalWrite;
        fs.fsyncSync = originalSync;
        syncBuiltinESMExports();
      }
      if (checkpoint.nativeRun.files.length === 3 && phase === 'committed-before-ack') interrupt(phase);
    });
  }

  override async onTestModuleEnd(testModule: TestModule): Promise<void> {
    await super.onTestModuleEnd(testModule);
    if (process.env.PC_COMPLETION_CRASH_WINDOW !== 'acknowledged-before-kill') return;
    const checkpoint = JSON.parse(readFileSync(process.env.PC_EXECUTED_SOURCE_MAP_OUT!, 'utf8'));
    if (checkpoint.nativeRun.files.length === 3) interrupt('acknowledged-before-kill');
  }
}
