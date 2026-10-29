import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, symlinkSync,
  truncateSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVerifierSourceReceipt, verifierSourceFiles, verifyVerifierSourceSync, type VerifierSourceProgress } from './verifier-source.ts';

const directories: string[] = [];
function archive(): string {
  const root = mkdtempSync(join(tmpdir(), 'verifier-census-'));
  directories.push(root);
  return root;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('full verifier source census', () => {
  it('relays async census progress without treating it as a completed receipt', async () => {
    const root = archive();
    writeFileSync(join(root, 'source.ts'), 'export {};');
    const files = verifierSourceFiles(root);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40), files,
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })) };
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', receipt.sourceCommit);
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    const independentReceipt = join(archive(), 'receipt.json');
    writeFileSync(independentReceipt, JSON.stringify(receipt));
    const progress: VerifierSourceProgress[] = [];
    await expect(readVerifierSourceReceipt(root, independentReceipt, {
      progress: record => { progress.push(record); throw new Error('observer unavailable'); },
    })).resolves.toEqual(receipt);
    expect(progress[0]).toMatchObject({ step: 'source-census', event: 'start' });
    expect(progress).toContainEqual(expect.objectContaining({ step: 'source-census', event: 'progress',
      completedFiles: 1, totalFiles: 1, bytesRead: Buffer.byteLength('export {};') }));
    expect(progress.at(-1)).toMatchObject({ step: 'source-census', event: 'end', status: 0 });
    writeFileSync(join(root, 'source.ts'), 'export {changed};');
    await expect(readVerifierSourceReceipt(root, independentReceipt, {
      progress: record => progress.push(record),
    })).rejects.toThrow('tampered');
    expect(progress.at(-1)).toMatchObject({ step: 'source-census', event: 'end', status: 3 });
  });

  it('admits only independent maintained generation-root metadata in runtime mode', () => {
    const root = archive();
    writeFileSync(join(root, 'source.ts'), 'export {};');
    const files = verifierSourceFiles(root);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40), files,
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })) };
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    const state = join(root, '.papercusp/dependency-generation-root.state');
    mkdirSync(state, { recursive: true });
    const record = join(root, '.papercusp/dependency-generation-root');
    const ignore = join(state, '.gitignore');
    writeFileSync(record, `${join(root, 'generations')}\n`);
    writeFileSync(ignore, '*\n');
    expect(() => verifyVerifierSourceSync(root, receipt)).toThrow('added .papercusp/');
    expect(verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true })).toEqual(receipt);
    writeFileSync(record, 'relative-store\n');
    expect(() => verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true })).toThrow('generation root');
    writeFileSync(record, `${join(root, 'generations')}\n`);
    writeFileSync(ignore, '*\n!payload.ts\n');
    expect(() => verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true })).toThrow('generation root');
    writeFileSync(ignore, '*\n');
    writeFileSync(join(state, 'payload.ts'), 'unexpected');
    expect(() => verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true })).toThrow('added .papercusp/');
    rmSync(join(state, 'payload.ts'));
    rmSync(record);
    symlinkSync('../source.ts', record);
    expect(() => verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true })).toThrow('independent file');
  });

  it('keeps recorded generation metadata in the source census', () => {
    const root = archive();
    mkdirSync(join(root, '.papercusp'));
    const record = join(root, '.papercusp/dependency-generation-root');
    writeFileSync(record, `${join(root, 'generations')}\n`);
    const files = verifierSourceFiles(root);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40), files,
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })) };
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    writeFileSync(record, `${join(root, 'different')}\n`);
    expect(() => verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true }))
      .toThrow('changed .papercusp/dependency-generation-root');
  });

  it('hashes complete multi-chunk files, empty files and symlink text with exact progress bytes', () => {
    const root = archive();
    const content = Buffer.alloc(2 * 1024 * 1024 + 37);
    for (let i = 0; i < content.length; i++) content[i] = i % 251;
    writeFileSync(join(root, 'large.bin'), content, { mode: 0o755 });
    writeFileSync(join(root, 'empty.bin'), '');
    symlinkSync('large.bin', join(root, 'link'));
    const progress: Array<{ bytesRead?: number; completedFiles?: number }> = [];
    const files = verifierSourceFiles(root, { progress: record => progress.push(record) });
    expect(files).toEqual([
      { path: 'empty.bin', kind: 'file', executable: false,
        sha256: createHash('sha256').update('').digest('hex') },
      { path: 'large.bin', kind: 'file', executable: true,
        sha256: createHash('sha256').update(content).digest('hex') },
      { path: 'link', kind: 'symlink', executable: true,
        sha256: createHash('sha256').update('large.bin').digest('hex') },
    ]);
    expect(progress.at(-1)).toMatchObject({ bytesRead: content.length + Buffer.byteLength('large.bin'),
      completedFiles: 3 });
  });

  it('rehashes late bytes even when file size and timestamps are restored, and rejects population drift', () => {
    const root = archive();
    const subject = join(root, 'large.bin');
    writeFileSync(subject, Buffer.alloc(2 * 1024 * 1024 + 37, 23));
    const files = verifierSourceFiles(root);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40), files,
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })) };
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    expect(verifyVerifierSourceSync(root, receipt)).toEqual(receipt);
    const before = statSync(subject);
    const fd = openSync(subject, 'r+');
    try { writeSync(fd, Buffer.from([24]), 0, 1, before.size - 1); } finally { closeSync(fd); }
    utimesSync(subject, before.atime, before.mtime);
    expect(() => verifyVerifierSourceSync(root, receipt)).toThrow('changed large.bin');
    writeFileSync(subject, Buffer.alloc(before.size, 23));
    writeFileSync(join(root, 'added.bin'), 'unexpected');
    expect(() => verifyVerifierSourceSync(root, receipt)).toThrow('added added.bin');
    rmSync(join(root, 'added.bin'));
    rmSync(subject);
    expect(() => verifyVerifierSourceSync(root, receipt)).toThrow('missing large.bin');
  });

  it('keeps peak hashing memory bounded while reading a large recorded binary', () => {
    const root = archive();
    const subject = join(root, 'large.bin');
    writeFileSync(subject, '');
    const size = 128 * 1024 * 1024;
    truncateSync(subject, size);
    const script = `
      import { verifierSourceFiles } from ${JSON.stringify(new URL('./verifier-source.ts', import.meta.url).href)};
      const before = process.resourceUsage().maxRSS;
      const files = verifierSourceFiles(process.argv[1]);
      process.stdout.write(JSON.stringify({ files, peakGrowthKiB: process.resourceUsage().maxRSS - before }));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, root],
      { encoding: 'utf8', timeout: 20_000 }));
    const digest = createHash('sha256');
    const block = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < size / block.length; i++) digest.update(block);
    expect(result.files).toEqual([{ path: 'large.bin', kind: 'file', executable: false,
      sha256: digest.digest('hex') }]);
    // A whole-file allocation exceeds this by 96 MiB. The bound is deliberately
    // generous for native loader/runtime variance and independent of wall time.
    expect(result.peakGrowthKiB).toBeLessThan(32 * 1024);
  });
});
