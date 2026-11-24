// WI-6554700010069681 stage 2: the append-only completion journal must fold to exactly the v1
// document, accept exactly the acknowledged prefix, and refuse damage a crash cannot explain.
import fs, { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendCompletionCheckpoint, appendCompletionCheckpointSync, closeCompletionJournal, closeCompletionJournalSync,
  completionFileProofInputs, completionPayloadFromBytes, createCompletionJournal, createCompletionJournalSync,
  readCompletionSnapshotSync, type CompletionJournalView,
} from '../../../scripts/lib/completion-journal.mjs';
import { completionSnapshotChunks } from '../../../scripts/lib/completion-snapshot.mjs';
import { captureRecordedProofContext, createRecordedTestPopulation } from './execution-details.ts';

const sha = (character: string) => character.repeat(64);
const runtime = { name: 'node', version: '25.1.0', executable: '/runtime/node', platform: 'linux', arch: 'x64',
  binarySha256: sha('1'), lockfileSha256: sha('2'), nativeDependencyGeneration: sha('3'), configurationSha256: sha('4') };
const pin = { schemaVersion: 'source-bytes-v1', fileCount: 3, sha256: sha('c') };
const FILES = Array.from({ length: 8 }, (_, index) => {
  const testFile = `libs/x/src/t${index}.test.ts`;
  const identity = ['unit', testFile, 'case', 1, 'test'] as [string, string, string, number, string];
  return { completionId: `completion-${index}`, testFile, projectName: 'unit', populationCaptureStatus: 'captured',
    population: createRecordedTestPopulation([{ identity, selected: true, outcome: 'passed' }], [identity]),
    proof: { inputs: { runtime: index % 3 === 2 ? { before: runtime, after: null } : { before: runtime, after: runtime },
      testConfiguration: { schemaVersion: 'vitest-worker-configuration-v1', before: sha('1'), after: sha('1') } },
    sourceEvidence: { reads: [`src/m${index}.ts`], note: 'café   😀' } } };
});
const ROWS = FILES.map((file, index) => ({ testFile: file.testFile, sources: [`src/m${index}.ts`, 'src/shared.ts'],
  ...(index % 2 ? { opaqueReasons: ['flaky-input'] } : {}) }));
const DIAGNOSTICS = FILES.map((file, index) => ({ kind: 'note', testFile: file.testFile, message: `d${index} ✓` }));
const MANIFEST = { sha256: sha('e'), specifications: FILES.map(file => ({ testFile: file.testFile, project: 'unit' })) };

interface ViewOptions { skipped?: number; terminal?: boolean; runnerIdentity?: string | null; pad?: string }
function makeView(n: number, { skipped = 0, terminal = false, runnerIdentity = sha('9'), pad }: ViewOptions = {}): CompletionJournalView {
  return {
    workspaceName: 'ws-1',
    completionCheckpoint: { schemaVersion: 1, qualificationAttemptId: 'attempt-1', runContext: 'ctx', runnerIdentity,
      reporterRunnerIdentity: sha('9'), state: terminal ? 'terminal' : 'partial', noPersist: false },
    skipped,
    rows: pad === undefined ? ROWS.slice(0, n) : [{ testFile: 'libs/x/src/t0.test.ts', pad }],
    diagnostics: DIAGNOSTICS.slice(0, Math.ceil(n / 2)),
    nativeRun: { schemaVersion: 'native-vitest-run-v1', startedAtMs: 1, finishedAtMs: terminal ? 99 : null,
      terminalHook: terminal ? 'onTestRunEnd' : null, reason: terminal ? 'passed' : null, selectedManifest: MANIFEST,
      files: FILES.slice(0, n), gaps: n > 3 ? ['module-cases-unmeasured:x'] : [] },
    configSources: { status: 'unchanged', files: [['vitest.config.ts', sha('5')]] },
    configLoadedSources: { status: 'qualified', files: [['libs/x/vitest.config.ts', sha('6')]] },
    mainProcessLoadedSources: { status: 'qualified', files: [['scripts/a.mjs', sha('7')]] },
    recordedSha: 'a'.repeat(40), ...(terminal ? {} : { sourceSnapshot: { commit: 'a'.repeat(40), status: '' } }),
    recordedGitDir: '/repo/.git', worktreeDirty: false,
    sourceBytes: { schemaVersion: 'source-byte-observation-v1', before: pin, after: pin },
    sourceSubmodules: { schemaVersion: 'submodule-checkouts-v1', before: [['libs/a', 'b'.repeat(40)]],
      after: [['libs/a', 'b'.repeat(40)]] },
  };
}

// What the v1 writer stored for a view (writeCompletionCheckpoint, and flushPending when final),
// frozen here as the oracle the fold must reproduce.
function v1Snapshot(view: CompletionJournalView, final: boolean): Record<string, unknown> {
  const { sourceBytes, sourceSubmodules, recordedSha, worktreeDirty } = view;
  const lostRunner = final && !(view.completionCheckpoint as { runnerIdentity?: unknown }).runnerIdentity;
  const rows = view.rows.map(row => lostRunner ? { ...(row as object), opaqueReasons: [...new Set([
    ...((row as { opaqueReasons?: string[] }).opaqueReasons ?? []), 'worker-runtime-unavailable'])] } : row);
  return { workspaceName: view.workspaceName, rows, diagnostics: [...view.diagnostics],
    nativeRun: { ...view.nativeRun, files: view.nativeRun.files.map(file => ({ ...(file as object), sourceBytes,
      sourceSubmodules, proofContext: captureRecordedProofContext({ commitSha: recordedSha, worktreeDirty,
        ...completionFileProofInputs(file), sourceBytes, sourceSubmodules }) })) },
    skipped: view.skipped, configSources: view.configSources, configLoadedSources: view.configLoadedSources,
    mainProcessLoadedSources: view.mainProcessLoadedSources, completionCheckpoint: view.completionCheckpoint,
    recordedSha, ...(view.sourceSnapshot !== undefined ? { sourceSnapshot: view.sourceSnapshot } : {}),
    recordedGitDir: view.recordedGitDir, worktreeDirty };
}

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'completion-journal-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const withoutIntegrity = (snapshot: unknown) => {
  const { completionIntegrity: _integrity, ...rest } = snapshot as Record<string, unknown>;
  return rest;
};
let written = 0;
/** The v1 document for a view, written by the real v1 writer and read back by the v1 reader. */
function v1ReadBack(view: CompletionJournalView, final: boolean) {
  const path = join(dir, `v1-${written++}.json`);
  writeFileSync(path, [...completionSnapshotChunks(v1Snapshot(view, final))].join(''));
  const read = readCompletionSnapshotSync(path);
  if (read.format !== 'v1') throw new Error(`expected v1, read ${read.format}`);
  return withoutIntegrity(read.snapshot);
}
function readJournal(path: string, chunkBytes?: number) {
  const read = readCompletionSnapshotSync(path, chunkBytes);
  if (read.format !== 'journal') throw new Error(`expected a journal, read ${read.format}`);
  return read;
}
const lineStarts = (bytes: Buffer) => {
  const starts = [0];
  for (let index = bytes.indexOf(10); index !== -1 && index + 1 < bytes.length; index = bytes.indexOf(10, index + 1))
    starts.push(index + 1);
  return starts;
};

describe('completion journal (WI-6554700010069681)', () => {
  it('folds to exactly the v1 document after every batch, partial and terminal, with or without a runner identity', () => {
    for (const runnerIdentity of [sha('9'), null]) {
      const path = join(dir, `fold-${runnerIdentity ? 'runner' : 'lost'}.json`);
      const journal = createCompletionJournalSync(path, { run: 'run-1', pid: 4242, startedAtMs: 1 });
      const partial = [makeView(1), makeView(3, { skipped: 1 }), makeView(3, { skipped: 1 }), makeView(6, { skipped: 2 })];
      for (const view of partial) {
        appendCompletionCheckpointSync(journal, view);
        expect(withoutIntegrity(readJournal(path).snapshot)).toStrictEqual(v1ReadBack(view, false));
      }
      // The repeated view changed no section, so it wrote no state record.
      expect(journal.stateRecords).toBe(3);
      const terminal = makeView(7, { skipped: 2, terminal: true, runnerIdentity });
      appendCompletionCheckpointSync(journal, terminal, { final: true });
      closeCompletionJournalSync(journal);
      const read = readJournal(path);
      expect(withoutIntegrity(read.snapshot)).toStrictEqual(v1ReadBack(terminal, true));
      expect(read.integrity).toMatchObject({ schemaVersion: 2, journal: 'completion-journal-v1', run: 'run-1',
        acceptedBytes: statSync(path).size, tailBytes: 0, final: true });
      expect(read.stats).toMatchObject({ commits: 5, stateRecords: 4, modules: 7, pid: 4242 });
      expect(read.snapshot.nativeRun.files[0].sourceBytes).toBe(read.snapshot.nativeRun.files[6].sourceBytes);
    }
  });

  it('reads every line whichever chunk offset it ends at (N-1, N and N+1 bytes into a chunk)', () => {
    const path = join(dir, 'chunks.json');
    const journal = createCompletionJournalSync(path, { run: 'run-2', pid: 1, startedAtMs: 1 });
    appendCompletionCheckpointSync(journal, makeView(2));
    appendCompletionCheckpointSync(journal, makeView(5, { skipped: 3 }));
    closeCompletionJournalSync(journal);
    const expected = readJournal(path).snapshot;
    const longest = Math.max(...readFileSync(path, 'utf8').split('\n').map(line => Buffer.byteLength(line) + 1));
    for (const size of [...Array.from({ length: 64 }, (_, index) => index + 1), longest - 1, longest, longest + 1])
      expect(readJournal(path, size).snapshot, `chunk ${size}`).toStrictEqual(expected);
  });

  it('reads records of exactly 64 KiB - 1, 64 KiB and 64 KiB + 1 bytes with the default chunk', () => {
    const rowLine = (path: string) => readFileSync(path, 'utf8').split('\n').find(line => line.includes('"kind":"row"'))!;
    const base = join(dir, 'base.json');
    const probe = createCompletionJournalSync(base, { run: 'run-3', pid: 1, startedAtMs: 1 });
    appendCompletionCheckpointSync(probe, makeView(1, { pad: '' }));
    closeCompletionJournalSync(probe);
    const baseLength = Buffer.byteLength(rowLine(base)) + 1;
    for (const target of [65_535, 65_536, 65_537]) {
      const path = join(dir, `row-${target}.json`);
      const view = makeView(1, { pad: 'a'.repeat(target - baseLength) });
      const journal = createCompletionJournalSync(path, { run: 'run-3', pid: 1, startedAtMs: 1 });
      appendCompletionCheckpointSync(journal, view);
      closeCompletionJournalSync(journal);
      expect(Buffer.byteLength(rowLine(path)) + 1).toBe(target);
      expect(withoutIntegrity(readJournal(path).snapshot)).toStrictEqual(v1ReadBack(view, false));
    }
  });

  it('folds the same run identically however its completions were batched', () => {
    const final = makeView(6, { skipped: 2 });
    const expected = v1ReadBack(final, false);
    for (const batching of [[6], [0, 6], [1, 6], [2, 4, 6], [1, 2, 3, 4, 5, 6], [6, 6]]) {
      const path = join(dir, `batches-${batching.join('-')}.json`);
      const journal = createCompletionJournalSync(path, { run: 'run-4', pid: 1, startedAtMs: 1 });
      for (const n of batching) appendCompletionCheckpointSync(journal, n === 6 ? final : makeView(n, { skipped: n % 2 }));
      closeCompletionJournalSync(journal);
      const read = readJournal(path);
      expect(withoutIntegrity(read.snapshot), batching.join(',')).toStrictEqual(expected);
      expect(read.stats.commits).toBe(batching.length);
    }
    const journal = createCompletionJournalSync(join(dir, 'shrink.json'), { run: 'run-4', pid: 1, startedAtMs: 1 });
    appendCompletionCheckpointSync(journal, makeView(3));
    expect(() => appendCompletionCheckpointSync(journal, makeView(2))).toThrow(/append-only/);
    closeCompletionJournalSync(journal);
  });

  it('accepts exactly the acknowledged prefix when cut at any byte, and refuses damage before the tail', () => {
    const path = join(dir, 'torn.json');
    const journal = createCompletionJournalSync(path, { run: 'run-5', pid: 1, startedAtMs: 1 });
    const header = journal.bytes;
    const commits = [makeView(1), makeView(3, { skipped: 1 }), makeView(4, { skipped: 1 })]
      .map(view => appendCompletionCheckpointSync(journal, view).acceptedBytes);
    closeCompletionJournalSync(journal);
    const bytes = readFileSync(path);
    expect(commits.at(-1)).toBe(bytes.length);
    const cut = join(dir, 'cut.json');
    const folds = commits.map(end => {
      writeFileSync(cut, bytes.subarray(0, end));
      return withoutIntegrity(readJournal(cut).snapshot);
    });
    const starts = lineStarts(bytes);
    // Every byte of the final batch, every line boundary +-2, and a stride over the earlier batches.
    const lengths = new Set<number>();
    for (let length = commits.at(-2)!; length <= bytes.length; length++) lengths.add(length);
    for (const start of [...starts, bytes.length]) for (let delta = -2; delta <= 2; delta++) lengths.add(start + delta);
    for (let length = header; length < commits.at(-2)!; length += 5) lengths.add(length);
    for (const length of [...lengths].filter(length => length >= header && length <= bytes.length).sort((a, b) => a - b)) {
      writeFileSync(cut, bytes.subarray(0, length));
      const read = readJournal(cut);
      const acknowledged = commits.filter(end => end <= length).length - 1;
      expect(read.integrity.acceptedBytes, `cut at ${length}`).toBe(acknowledged < 0 ? header : commits[acknowledged]);
      expect(read.integrity.tailBytes).toBe(length - read.integrity.acceptedBytes);
      if (acknowledged < 0) expect(read.snapshot).toBeNull();
      else expect(withoutIntegrity(read.snapshot), `cut at ${length}`).toStrictEqual(folds[acknowledged]);
    }
    // One flipped byte in any line but the last is damage, not a torn write: refuse the file. (Byte 40
    // keeps the journal prefix intact, so this is the journal reader refusing, not the v1 parser.)
    const flip = (offset: number) => {
      const damaged = Buffer.from(bytes);
      damaged[offset] = damaged[offset]! ^ 0x01;
      writeFileSync(cut, damaged);
    };
    for (const start of starts.slice(0, -1)) {
      flip(start + 40);
      expect(() => readCompletionSnapshotSync(cut), `damage at ${start + 40}`).toThrow(/corrupt/);
    }
    // Damage inside the journal prefix makes it unrecognizable: it still refuses, as v1 garbage.
    flip(3);
    expect(() => readCompletionSnapshotSync(cut)).toThrow();
    // Damage in the last line (the final commit) is indistinguishable from a torn write.
    flip(starts.at(-1)! + 40);
    expect(readJournal(cut).integrity.acceptedBytes).toBe(commits.at(-2));
  });

  it('parses captured OUT bytes of either format exactly as the file reader does (custody and native receipts)', () => {
    const path = join(dir, 'bytes.json'), cut = join(dir, 'bytes-cut.json');
    const journal = createCompletionJournalSync(path, { run: 'run-bytes', pid: 7, startedAtMs: 1 });
    const views = [makeView(2), makeView(5, { skipped: 1 }), makeView(7, { skipped: 2, terminal: true })];
    const commits = views.map((view, index) =>
      appendCompletionCheckpointSync(journal, view, { final: index === views.length - 1 }).acceptedBytes);
    closeCompletionJournalSync(journal);
    const bytes = readFileSync(path);
    const expected = readJournal(path).snapshot;
    expect(completionPayloadFromBytes(bytes)).toStrictEqual(expected);
    expect(completionPayloadFromBytes(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))).toStrictEqual(expected);
    for (const size of [1, 2, 63, 64, 65]) expect(completionPayloadFromBytes(bytes, size), `chunk ${size}`).toStrictEqual(expected);
    // A torn tail folds to the acknowledged prefix, as the file reader folds it.
    for (const end of [commits[0]! + 1, commits[1]!, bytes.length - 1]) {
      writeFileSync(cut, bytes.subarray(0, end));
      expect(completionPayloadFromBytes(bytes.subarray(0, end)), `cut at ${end}`).toStrictEqual(readJournal(cut).snapshot);
    }
    // v1 bytes stay one JSON document.
    const v1 = Buffer.from([...completionSnapshotChunks(v1Snapshot(views[2]!, true))].join(''));
    expect(completionPayloadFromBytes(v1)).toStrictEqual(JSON.parse(v1.toString('utf8')));
    // No committed batch, damage before the tail, bytes that are no OUT, and a non-byte argument all throw.
    expect(() => completionPayloadFromBytes(bytes.subarray(0, commits[0]! - 1))).toThrow(/no committed batch/);
    const damaged = Buffer.from(bytes), offset = lineStarts(bytes)[1]! + 40;
    damaged[offset] = damaged[offset]! ^ 0x01;
    expect(() => completionPayloadFromBytes(damaged)).toThrow(/corrupt/);
    expect(() => completionPayloadFromBytes(Buffer.from('{'))).toThrow(SyntaxError);
    expect(() => completionPayloadFromBytes('{}' as unknown as Uint8Array)).toThrow(TypeError);
  });

  it('replaces a journal atomically on restart: the old writer stops, mixed runs are refused, other formats stay explicit', async () => {
    const path = join(dir, 'restart.json');
    expect(readCompletionSnapshotSync(path)).toEqual({ format: 'absent' });
    writeFileSync(path, '');
    expect(readCompletionSnapshotSync(path)).toEqual({ format: 'empty' });
    const first = createCompletionJournalSync(path, { run: 'run-a', pid: 11, startedAtMs: 1 });
    appendCompletionCheckpointSync(first, makeView(2));
    const firstBytes = readFileSync(path);
    const second = await createCompletionJournal(path, { run: 'run-b', pid: 22, startedAtMs: 2 });
    // Unpublished until its first commit: the first run's journal still answers at the path.
    expect(readJournal(path).integrity.run).toBe('run-a');
    await appendCompletionCheckpoint(second, makeView(1));
    expect(() => appendCompletionCheckpointSync(first, makeView(3))).toThrow(/replaced/);
    expect(first.poisoned).toBeInstanceOf(Error);
    const read = readJournal(path);
    expect(read.integrity.run).toBe('run-b');
    expect(read.stats.pid).toBe(22);
    expect(withoutIntegrity(read.snapshot)).toStrictEqual(v1ReadBack(makeView(1), false));
    await closeCompletionJournal(second);
    closeCompletionJournalSync(first);
    const secondBytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([firstBytes, secondBytes.subarray(secondBytes.indexOf(10) + 1)]));
    expect(() => readCompletionSnapshotSync(path)).toThrow(/mixed run ids/);
    writeFileSync(path, [...completionSnapshotChunks(v1Snapshot(makeView(2), false))].join(''));
    expect(readCompletionSnapshotSync(path).format).toBe('v1');
  });

  it('publishes the journal only with its first commit, so a crash or failure before it leaves the path absent', async () => {
    const temporaries = () => fs.readdirSync(dir).filter(name => name.endsWith('.journal-tmp'));
    const abandoned = join(dir, 'abandoned.json');
    const never = createCompletionJournalSync(abandoned, { run: 'run-7', pid: 1, startedAtMs: 1 });
    expect(readCompletionSnapshotSync(abandoned)).toEqual({ format: 'absent' });
    expect(never.unpublished).toMatch(/\.journal-tmp$/);
    expect(temporaries()).toHaveLength(1);
    closeCompletionJournalSync(never);
    expect(temporaries()).toEqual([]);
    expect(readCompletionSnapshotSync(abandoned)).toEqual({ format: 'absent' });

    // A first batch that fails to write, or to rename into place, is cut back and stays unpublished.
    const path = join(dir, 'first.json');
    const journal = createCompletionJournalSync(path, { run: 'run-8', pid: 1, startedAtMs: 1 });
    const headerBytes = journal.bytes;
    const originalWrite = fs.writeSync, originalRename = fs.renameSync;
    try {
      fs.writeSync = ((descriptor: number, ...rest: unknown[]) => {
        if (descriptor === journal.fd) throw new Error('disk full');
        return (originalWrite as (...a: unknown[]) => number)(descriptor, ...rest);
      }) as typeof fs.writeSync;
      syncBuiltinESMExports();
      expect(() => appendCompletionCheckpointSync(journal, makeView(2))).toThrow(/disk full/);
      fs.writeSync = originalWrite;
      fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
        if (from === journal.unpublished) throw new Error('rename refused');
        originalRename(from, to);
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      expect(() => appendCompletionCheckpointSync(journal, makeView(2))).toThrow(/rename refused/);
    } finally {
      fs.writeSync = originalWrite;
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
    }
    expect(readCompletionSnapshotSync(path)).toEqual({ format: 'absent' });
    expect(statSync(journal.unpublished!).size).toBe(headerBytes);
    expect(journal.poisoned).toBeNull();
    expect(journal.commits).toBe(0);
    appendCompletionCheckpointSync(journal, makeView(2));
    expect(journal.unpublished).toBeNull();
    expect(temporaries()).toEqual([]);
    expect(withoutIntegrity(readJournal(path).snapshot)).toStrictEqual(v1ReadBack(makeView(2), false));
    appendCompletionCheckpointSync(journal, makeView(3, { terminal: true }), { final: true });
    closeCompletionJournalSync(journal);
    expect(withoutIntegrity(readJournal(path).snapshot)).toStrictEqual(v1ReadBack(makeView(3, { terminal: true }), true));

    const later = join(dir, 'async.json');
    const asyncJournal = await createCompletionJournal(later, { run: 'run-9', pid: 1, startedAtMs: 1 });
    expect(readCompletionSnapshotSync(later)).toEqual({ format: 'absent' });
    await appendCompletionCheckpoint(asyncJournal, makeView(1));
    expect(readJournal(later).integrity.run).toBe('run-9');
    await closeCompletionJournal(asyncJournal);
    const asyncAbandoned = join(dir, 'async-abandoned.json');
    await closeCompletionJournal(await createCompletionJournal(asyncAbandoned, { run: 'run-10', pid: 1, startedAtMs: 1 }));
    expect(readCompletionSnapshotSync(asyncAbandoned)).toEqual({ format: 'absent' });
    expect(temporaries()).toEqual([]);
  });

  it('cuts a failed batch back off, so the next batch continues a clean chain', () => {
    const path = join(dir, 'rollback.json');
    const journal = createCompletionJournalSync(path, { run: 'run-6', pid: 1, startedAtMs: 1 });
    appendCompletionCheckpointSync(journal, makeView(2));
    const committed = journal.bytes;
    const original = fs.writeSync;
    let calls = 0;
    try {
      fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
        if (++calls === 2) throw new Error('disk full');
        return (original as (...a: unknown[]) => number)(...args);
      }) as typeof fs.writeSync;
      syncBuiltinESMExports();
      expect(() => appendCompletionCheckpointSync(journal, makeView(4, { skipped: 1 }))).toThrow(/disk full/);
    } finally {
      fs.writeSync = original;
      syncBuiltinESMExports();
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(statSync(path).size).toBe(committed);
    expect(journal.poisoned).toBeNull();
    appendCompletionCheckpointSync(journal, makeView(4, { skipped: 1 }));
    closeCompletionJournalSync(journal);
    expect(withoutIntegrity(readJournal(path).snapshot)).toStrictEqual(v1ReadBack(makeView(4, { skipped: 1 }), false));
  });
});
