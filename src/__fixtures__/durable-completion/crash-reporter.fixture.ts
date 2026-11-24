import fs, { writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type { TestModule, TestSpecification, Vitest } from 'vitest/node';
import ExecutedSourceMapReporter, { COMPLETION_CHECKPOINT_EVERY_COMPLETION } from '../../executed-source-map-reporter.ts';
import {
  appendCompletionCheckpointSync, closeCompletionJournalSync, createCompletionJournalSync, readCompletionSnapshotSync,
  type CompletionJournal,
} from '../../../../../scripts/lib/completion-journal.mjs';

function interrupt(phase: string): void {
  const signal = process.env.PC_COMPLETION_CRASH_SIGNAL;
  if (signal !== 'SIGTERM' && signal !== 'SIGKILL') throw new Error('unsupported completion crash signal');
  writeSync(2, `REAL_COMPLETION_WRITE_INTERRUPTED phase=${phase} signal=${signal}\n`);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}

/** The folded completion snapshot at the armed out path, or null before its first commit. */
function durableSnapshot(): { nativeRun: { files: unknown[] } } | null {
  const read = readCompletionSnapshotSync(process.env.PC_EXECUTED_SOURCE_MAP_OUT!);
  return read.format === 'journal' || read.format === 'v1' ? read.snapshot : null;
}

export default class CrashReporter extends ExecutedSourceMapReporter {
  override async onInit(ctx: Vitest): Promise<void> {
    const phase = process.env.PC_COMPLETION_CRASH_WINDOW;
    if (phase !== 'before-first-snapshot' && phase !== 'after-first-bank' && phase !== 'primary-yield'
      && phase !== 'registered-complete') {
      super.onInit(ctx);
      return;
    }
    if (!process.connected || !process.send) throw new Error('pre-snapshot crash fixture requires parent IPC');
    // Bind the actual PID and independent selection before releasing the crash.
    const registered = new Promise<void>(resolve => {
      const listener = (message: unknown) => {
        if ((message as { kind?: string })?.kind !== 'native-producer-registered') return;
        process.off('message', listener);
        resolve();
      };
      process.on('message', listener);
    });
    process.send({ kind: 'native-pre-snapshot-ready', pid: process.pid });
    await registered;
    // onInit records the native start clock, before onTestRunStart freezes the
    // selection. Production enrolls before either hook; preserve that ordering.
    super.onInit(ctx);
  }

  override onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    super.onTestRunStart(specifications);
    const phase = process.env.PC_COMPLETION_CRASH_WINDOW;
    if (phase === 'before-first-snapshot') interrupt(phase);
  }

  constructor() {
    // The production journal format through its synchronous primitives, so each crash window can stop the
    // process at an exact point of the real append (WI-6554700010069681). No substitute file is written.
    const journals = new Map<string, CompletionJournal>();
    super(undefined, undefined, undefined, (path, view, { final }) => {
      const phase = process.env.PC_COMPLETION_CRASH_WINDOW;
      let journal = journals.get(path);
      if (!journal) {
        journal = createCompletionJournalSync(path);
        journals.set(path, journal);
      }
      const fd = journal.fd;
      const originalWrite = fs.writeSync;
      const originalSync = fs.fsyncSync;
      if (view.nativeRun.files.length === 3) {
        // Intercept the real journal's descriptor during the batch that commits the third completion.
        let writes = 0;
        fs.writeSync = ((descriptor: number, buffer: NodeJS.ArrayBufferView, offset?: number, length?: number) => {
          if (descriptor === fd && phase === 'batch-partially-written' && ++writes === 2) {
            // One whole record of the batch, then half of the next: an uncommitted batch with a torn tail.
            originalWrite(descriptor, buffer, offset ?? 0, Math.max(1, Math.floor((length ?? buffer.byteLength) / 2)));
            interrupt(phase);
          }
          return originalWrite(descriptor, buffer, offset, length);
        }) as typeof fs.writeSync;
        fs.fsyncSync = descriptor => {
          if (descriptor === fd && phase === 'written-before-fsync') interrupt(phase);
          originalSync(descriptor);
        };
        syncBuiltinESMExports();
      }
      try {
        appendCompletionCheckpointSync(journal, view, { final });
      } finally {
        fs.writeSync = originalWrite;
        fs.fsyncSync = originalSync;
        syncBuiltinESMExports();
        if (final) {
          journals.delete(path);
          closeCompletionJournalSync(journal);
        }
      }
      if (view.nativeRun.files.length === 3 && phase === 'committed-before-ack') interrupt(phase);
    // Each crash window targets one exact per-completion write (the first bank, the 3-file write), so this
    // fixture writes after every completion. Production spaces partial writes (WI-6554700010069387).
    }, { spacing: COMPLETION_CHECKPOINT_EVERY_COMPLETION });
  }

  override async onTestModuleEnd(testModule: TestModule): Promise<void> {
    await super.onTestModuleEnd(testModule);
    if (process.env.PC_COMPLETION_CRASH_WINDOW === 'primary-yield') {
      if (durableSnapshot()?.nativeRun.files.length === 1) {
        if (!process.connected || !process.send) throw new Error('primary yield fixture requires parent IPC');
        process.send({ kind: 'native-first-bank-ready', pid: process.pid });
        // Keep the unfinished selection pending while the real parent boundary
        // validates and persists its cursor. The parent owns bounded cleanup.
        await new Promise<void>(() => {});
      }
    }
    if (process.env.PC_COMPLETION_CRASH_WINDOW === 'after-first-bank') {
      if (durableSnapshot()?.nativeRun.files.length === 1) interrupt('after-first-bank');
    }
    if (process.env.PC_COMPLETION_CRASH_WINDOW !== 'acknowledged-before-kill') return;
    if (durableSnapshot()?.nativeRun.files.length === 3) interrupt('acknowledged-before-kill');
  }
}
