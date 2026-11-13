import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import nativeFs, { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, symlinkSync,
  truncateSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  it('refuses unrecorded dependencies before traversing them when runtime mode was omitted', () => {
    const root = archive();
    writeFileSync(join(root, 'source.ts'), 'export {};');
    const files = verifierSourceFiles(root);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40), files,
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })) };
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    const dependency = join(root, 'node_modules');
    mkdirSync(dependency);
    writeFileSync(join(dependency, 'extra.js'), 'separately verified dependency');
    const readdir = vi.spyOn(nativeFs, 'readdirSync');
    syncBuiltinESMExports();
    try {
      expect(() => verifyVerifierSourceSync(root, receipt))
        .toThrow('tampered verification source archive: added node_modules');
      expect(readdir.mock.calls.some(([path]) => path === dependency)).toBe(false);
      expect(verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true })).toEqual(receipt);
      expect(readdir.mock.calls.some(([path]) => path === dependency)).toBe(false);
      writeFileSync(join(root, 'source.ts'), 'changed source');
      expect(() => verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true }))
        .toThrow('changed source.ts');
    } finally {
      readdir.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('hashes the full archive with linear recorded-path lookup work', () => {
    const root = archive();
    for (let index = 0; index < 256; index++)
      writeFileSync(join(root, `source-${index}.ts`), `export default ${index};`);
    for (const path of ['packages/omp-plugin/dist/recorded.cjs',
      'vendor/node_modules.pinned-deps-tmp.5/recorded.ts']) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), 'recorded source');
    }
    const expected = verifierSourceFiles(root);
    const paths = expected.map(file => file.path);
    let pathReads = 0;
    // Count provenance-list access instead of timing the filesystem. Rewalking
    // this list for every entry makes large native archives quadratic.
    const recordedPaths = new Proxy(paths, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) pathReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    const generated = join(root, 'node_modules/ignored.cjs');
    mkdirSync(dirname(generated));
    writeFileSync(generated, 'separately verified dependency');
    expect(verifierSourceFiles(root, { runtimeArtifacts: true, recordedPaths })).toEqual(expected);
    expect(pathReads).toBeLessThanOrEqual(paths.length * 4);
    writeFileSync(join(root, 'source-0.ts'), 'export default 9;');
    const changed = verifierSourceFiles(root, { runtimeArtifacts: true, recordedPaths });
    expect(changed.map(file => file.path)).toEqual(expected.map(file => file.path));
    expect(changed.find(file => file.path === 'source-0.ts')?.sha256)
      .not.toBe(expected.find(file => file.path === 'source-0.ts')?.sha256);
  });

  it('rejects a cancelled census only after its actual worker exits', async () => {
    const root = archive();
    writeFileSync(join(root, 'source.ts'), 'export {};');
    const files = verifierSourceFiles(root);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40), files,
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })) };
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    const independentReceipt = join(archive(), 'receipt.json');
    writeFileSync(independentReceipt, JSON.stringify(receipt));
    const controller = new AbortController();
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    try {
      await expect(readVerifierSourceReceipt(root, independentReceipt, {
        signal: controller.signal,
        progress: () => controller.abort(),
      })).rejects.toThrow('verifier source read aborted');
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(terminate.mock.contexts[0]).toBeInstanceOf(Worker);
      expect((terminate.mock.contexts[0] as Worker).threadId).toBe(-1);
    } finally { terminate.mockRestore(); }
  });

  it('does not start a census worker when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    try {
      await expect(readVerifierSourceReceipt(archive(), undefined, { signal: controller.signal }))
        .rejects.toThrow('verifier source read aborted');
      expect(terminate).not.toHaveBeenCalled();
    } finally { terminate.mockRestore(); }
  });

  it.each([
    'papercusp-desktop/src-tauri/resources/workbench@papercusp.ai.shell-extension.zip',
    'papercusp-desktop/src-tauri/resources/workbench-install.js',
  ])('admits only independent unrecorded Workbench build output: %s', artifact => {
    const root = archive();
    writeFileSync(join(root, 'source.ts'), 'export {};');
    const files = verifierSourceFiles(root);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40), files,
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })) };
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    const output = join(root, artifact);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, 'generated Workbench resource');
    expect(() => verifyVerifierSourceSync(root, receipt)).toThrow(`added ${artifact}`);
    expect(verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true })).toEqual(receipt);
    rmSync(output);
    symlinkSync(join(root, 'source.ts'), output);
    expect(() => verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true }))
      .toThrow('runtime artifact is not an independent file');
    rmSync(output);
    writeFileSync(output, 'rebuilt Workbench resource');
    const unexpected = artifact + '.unexpected';
    writeFileSync(join(root, unexpected), 'unexpected source');
    expect(() => verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true }))
      .toThrow(`added ${unexpected}`);
    rmSync(join(root, unexpected));
    writeFileSync(join(root, 'source.ts'), 'changed source');
    expect(() => verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true }))
      .toThrow('changed source.ts');
  });

  it.each([
    'papercusp-desktop/src-tauri/resources/workbench@papercusp.ai.shell-extension.zip',
    'papercusp-desktop/src-tauri/resources/workbench-install.js',
  ])('keeps previously recorded Workbench resources immutable: %s', artifact => {
    const root = archive();
    const output = join(root, artifact);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, 'recorded resource');
    const files = verifierSourceFiles(root);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40), files,
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })) };
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    writeFileSync(output, 'changed recorded resource');
    expect(() => verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true }))
      .toThrow(`changed ${artifact}`);
  });

  it('treats operator-vite dist as generated output while preserving recorded source files', () => {
    const root = archive();
    writeFileSync(join(root, 'source.ts'), 'export {};');
    const files = verifierSourceFiles(root);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40), files,
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })) };
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));

    const generated = join(root, 'apps/operator-vite/dist/cli.cjs');
    mkdirSync(dirname(generated), { recursive: true });
    writeFileSync(generated, 'rebuilt managed client');
    expect(() => verifyVerifierSourceSync(root, receipt)).toThrow('added apps/operator-vite/dist');
    expect(verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true })).toEqual(receipt);

    const recordedRoot = archive();
    const recorded = join(recordedRoot, 'apps/operator-vite/dist/cli.cjs');
    mkdirSync(dirname(recorded), { recursive: true });
    writeFileSync(recorded, 'committed managed client');
    const recordedFiles = verifierSourceFiles(recordedRoot);
    const recordedReceipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'e'.repeat(40), files: recordedFiles,
      testedInputs: recordedFiles.map(({ path, sha256 }) => ({ path, sha256 })) };
    writeFileSync(join(recordedRoot, '.verifier-source.json'), JSON.stringify(recordedReceipt));
    writeFileSync(recorded, 'changed recorded managed client');
    expect(() => verifyVerifierSourceSync(recordedRoot, recordedReceipt, { runtimeArtifacts: true }))
      .toThrow('changed apps/operator-vite/dist/cli.cjs');
  });

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

describe('test:file frozen-source provenance labels', () => {
  it('surfaces a missing receipt without describing it as a Git read failure', async () => {
    const root = archive();
    const subject = join(root, 'source.ts');
    writeFileSync(join(root, '.verifier-source.json'), '{}');
    writeFileSync(subject, 'export {};');
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', '');

    // @ts-expect-error the executable Node router intentionally has no declaration file
    const { formatProvenanceBanner, snapshotProvenance } = await import('../../../scripts/test-files.mjs');
    const snapshot = snapshotProvenance([subject], root);
    expect(snapshot.provenanceError).toContain('missing independent verifier source receipt');
    expect(snapshot.entries).toEqual([expect.objectContaining({ path: 'source.ts', state: 'unknown' })]);

    const banner = formatProvenanceBanner(snapshot, 'pre-run');
    expect(banner).toContain('provenanceError:');
    expect(banner).toContain('missing independent verifier source receipt');
    expect(banner).toContain('[state UNKNOWN — provenance could not be determined]');
    expect(banner).not.toMatch(/git could not be read/i);
  });
});
