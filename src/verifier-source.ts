/** Shared archive identity checks for the source exporter and native reporters.
 * Keep this dependency graph limited to Node built-ins: Playwright loads callers
 * through both CommonJS and ESM transforms.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';

export interface VerifierSourceFile {
  path: string;
  kind: 'file' | 'symlink';
  executable: boolean;
  sha256: string;
}

export interface VerifierSourceReceipt {
  schemaVersion: string;
  sourceCommit: string;
  testedInputs: { path: string; sha256: string }[];
  files: VerifierSourceFile[];
  submodules?: { path: string; sha: string }[];
  gitCheckout?: { parentCommit: string; trackedFilesHash: string };
}

export class VerifierSourceError extends Error {}

/** The archive marker is a source boundary even beneath another Git checkout. */
export function findVerifierSourceRoot(from: string): string | null {
  let dir = resolve(from);
  while (true) {
    if (existsSync(join(dir, '.verifier-source.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface VerifierSourceProgress {
  step: 'git-checkout' | 'source-census';
  event: 'start' | 'progress' | 'end';
  status?: number;
  error?: string;
  completedFiles?: number;
  totalFiles?: number;
  bytesRead?: number;
  /** Next file to inspect; counters cover only the files already hashed. */
  nextPath?: string;
}

export interface VerifierSourceMutation {
  /** Absolute path of the one probe subject allowed to differ from the receipt. */
  subjectPath: string;
}

export interface VerifierDefinitionSource { commit: string; receiptPath: string }

export interface VerifiedComparisonSources {
  applicationRoot: string;
  applicationCommit: string;
  definitionCommit: string;
  runtimeUnit: string;
  digest: string;
  inputs: Set<string>;
}

export function selectedVerifierDefinition(env = process.env): VerifierDefinitionSource | null {
  const commit = env.VERIFY_TAURI_TEST_SOURCE_REF;
  const receiptPath = env.VERIFY_TAURI_TEST_SOURCE_RECEIPT;
  if (commit === undefined && receiptPath === undefined) return null;
  if (!commit || !/^[0-9a-f]{40}$/.test(commit) || !receiptPath)
    throw new VerifierSourceError('incomplete native comparison definition selection');
  return { commit, receiptPath };
}

/** Verify both independent archives against their original external receipts. */
export function readVerifierComparisonSourcesSync(definitionRoot: string, definition: VerifierDefinitionSource,
  progress?: (record: VerifierSourceProgress) => void): VerifiedComparisonSources {
  const env = process.env;
  const pid = Number(env.VERIFY_TAURI_PID);
  if (!Number.isSafeInteger(pid) || pid <= 0 || env.VERIFY_TAURI_ISOLATED_DB !== '1' || !env.OPERATOR_SOURCE_ROOT || !env.VERIFY_TAURI_SOURCE_REF)
    throw new VerifierSourceError('separate test definition requires the owned isolated native runner');
  if (!env.VERIFY_TAURI_SOURCE_RECEIPT || !definition.receiptPath)
    throw new VerifierSourceError('both external source receipts are required');
  const roots = [realpathSync(env.OPERATOR_SOURCE_ROOT), realpathSync(definitionRoot)];
  const within = (path: string, root: string) => {
    const rel = relative(root, path);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
  };
  if (within(roots[0], roots[1]) || within(roots[1], roots[0]))
    throw new VerifierSourceError('expected distinct, non-overlapping frozen source roots');
  const paths = [realpathSync(env.VERIFY_TAURI_SOURCE_RECEIPT), realpathSync(definition.receiptPath)];
  const stats = paths.map(path => statSync(path, { bigint: true }));
  if (paths.some(path => roots.some(root => within(path, root))) || !stats.every(stat => stat.isFile())
    || (stats[0].dev === stats[1].dev && stats[0].ino === stats[1].ino))
    throw new VerifierSourceError('the two source receipts must be independent and outside both archives');
  const refs = [env.VERIFY_TAURI_SOURCE_REF, definition.commit];
  const ledger = [env.PAPERCUSP_TEST_RUN_GROUP, env.PAPERCUSP_TEST_RUN_WORKSPACE,
    env.PAPERCUSP_TEST_RUN_HARNESS, env.PAPERCUSP_TEST_RUNS_DB_URL];
  if (!ledger.every(value => value?.trim()))
    throw new VerifierSourceError('native comparison requires a dedicated ledger, run group, harness and workspace');
  const runtimeUnit = 'verify-tauri-headless:' + pid;
  const digest = createHash('sha256').update(JSON.stringify([roots, paths, runtimeUnit, ledger]));
  const verified = paths.map((path, i) => {
    const bytes = readFileSync(path);
    const manifest: VerifierSourceReceipt = JSON.parse(bytes.toString('utf8'));
    if (!/^[0-9a-f]{40}$/.test(refs[i]) || manifest.sourceCommit !== refs[i])
      throw new VerifierSourceError('source receipt differs from the selected commit');
    if (!manifest.gitCheckout) throw new VerifierSourceError('native comparison requires Git custody in both source receipts');
    digest.update('\0').update(bytes);
    return verifyVerifierSourceSync(roots[i], manifest, { runtimeArtifacts: true, progress });
  });
  return { applicationRoot: roots[0], applicationCommit: verified[0].sourceCommit,
    definitionCommit: verified[1].sourceCommit, runtimeUnit, digest: digest.digest('hex'),
    inputs: new Set(verified[1].testedInputs.map(input => input.path)) };
}

/** Reuse the full source census, never a supplied SHA or the enclosing Git HEAD. */
export function readVerifierSourceReceiptSync(root: string, receiptPath = process.env.VERIFY_TAURI_SOURCE_RECEIPT,
  options: { progress?: (record: VerifierSourceProgress) => void; mutation?: VerifierSourceMutation } = {}): VerifierSourceReceipt {
  if (!receiptPath) throw new VerifierSourceError('missing independent verifier source receipt');
  const receiptRel = relative(realpathSync(root), realpathSync(receiptPath));
  if (receiptRel !== '..' && !receiptRel.startsWith(`..${sep}`))
    throw new VerifierSourceError('verifier source receipt must be outside the archive');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (process.env.VERIFY_TAURI_SOURCE_REF && receipt.sourceCommit !== process.env.VERIFY_TAURI_SOURCE_REF)
    throw new VerifierSourceError('verifier source receipt differs from selected source ref');
  verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true, progress: options.progress, mutation: options.mutation });
  return receipt;
}

/** Keep Vitest's controller available for fork-stop IPC during the full census.
 * Reuse the exact synchronous verifier; Playwright's unawaited hooks still use
 * its synchronous entry point. Resolve only after our worker has exited.
 */
export function readVerifierSourceReceipt(root: string,
  receiptPath = process.env.VERIFY_TAURI_SOURCE_RECEIPT,
  options: { mutation?: VerifierSourceMutation; progress?: (record: VerifierSourceProgress) => void;
    signal?: AbortSignal } = {}): Promise<VerifierSourceReceipt> {
  return runVerifierSourceWorker({ root, receiptPath, mutation: options.mutation }, options);
}

export function readVerifierComparisonSources(root: string, definition: VerifierDefinitionSource,
  options: { progress?: (record: VerifierSourceProgress) => void; signal?: AbortSignal } = {}): Promise<VerifiedComparisonSources> {
  return runVerifierSourceWorker({ root, definition }, options);
}

function runVerifierSourceWorker<T>(workerData: { root: string; receiptPath?: string; mutation?: VerifierSourceMutation }
  | { root: string; definition: VerifierDefinitionSource },
  options: { progress?: (record: VerifierSourceProgress) => void; signal?: AbortSignal }): Promise<T> {
  return new Promise((resolveReceipt, reject) => {
    if (options.signal?.aborted) {
      reject(new VerifierSourceError('verifier source read aborted'));
      return;
    }
    const worker = new Worker(new URL('./verifier-source-worker.mjs', import.meta.url), { workerData });
    let receipt: T | undefined;
    let failure: Error | undefined;
    const abort = () => {
      failure = new VerifierSourceError('verifier source read aborted');
      // A deadline bounds the caller's wait, not the worker's lifetime. Do not
      // settle until exit: no abandoned census may retain files or the process.
      void worker.terminate().catch(error => { failure = error; });
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', (result: { receipt?: T; error?: string; progress?: VerifierSourceProgress }) => {
      if (result.progress) {
        // Diagnostics must not change the full census or its terminal verdict.
        try { options.progress?.(result.progress); } catch { /* observer failure */ }
        return;
      }
      if (result.error) failure = new VerifierSourceError(result.error);
      else receipt = result.receipt;
    });
    worker.once('error', error => { failure = error; });
    worker.once('exit', code => {
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code === 0 && receipt) resolveReceipt(receipt);
      else reject(new VerifierSourceError(`verifier source worker exited without a receipt (code ${code})`));
    });
  });
}

/** Real Git semantics are a separate precondition from exact source bytes. */
export function verifierGitCheckoutSync(root: string, sourceCommit: string,
  submodules: { path: string; sha: string }[] = []): NonNullable<VerifierSourceReceipt['gitCheckout']> {
  const git = (cwd: string, args: string[]): string => {
    const env = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new VerifierSourceError(`verification Git precondition failed: ${args.join(' ')}: ${result.stderr || result.error}`);
    return result.stdout;
  };
  const tracked = createHash('sha256');
  for (const row of [{ path: '', sha: sourceCommit }, ...submodules]) {
    const cwd = resolve(root, row.path);
    if (cwd !== resolve(root) && !cwd.startsWith(`${resolve(root)}${sep}`)) throw new VerifierSourceError('verification Git path escapes source root');
    if (!lstatSync(join(cwd, '.git')).isDirectory()) throw new VerifierSourceError(`verification Git metadata is not independent: ${row.path || '.'}`);
    if (git(cwd, ['rev-parse', '--show-toplevel']).trim() !== realpathSync(cwd)
      || git(cwd, ['rev-parse', '--verify', 'HEAD']).trim() !== row.sha) {
      throw new VerifierSourceError(`verification Git checkout differs: ${row.path || '.'}`);
    }
    // Git's recursive traversal omits real gitlinks without .gitmodules names.
    // Attest the actual index of each repository in the source receipt instead.
    const index = git(cwd, ['ls-files', '--stage', '-z']);
    if (!row.path && !index) throw new VerifierSourceError('verification Git index is empty');
    tracked.update(row.path).update('\0').update(index);
  }
  const parentCommit = git(root, ['rev-parse', '--verify', 'HEAD^']).trim();
  return { parentCommit, trackedFilesHash: tracked.digest('hex') };
}

/** Never follow archive symlinks or exclude a recorded source path. */
export function verifierSourceFiles(root: string, {
  runtimeArtifacts = false, dependencyStaging = false, recordedPaths = [], gitMetadataPaths = [], symlinkRoot = root, includedPaths, progress,
}: { runtimeArtifacts?: boolean;
  /** Pre-copy preparation only; subsequent verification must reject leftover staging. */
  dependencyStaging?: boolean; recordedPaths?: string[]; gitMetadataPaths?: string[];
  /** Dependency trees can link to workspace source inside the same archive. */
  symlinkRoot?: string;
  /** Explicit population from the maintained dependency-generation record writer. */
  includedPaths?: ReadonlySet<string>;
  progress?: (record: VerifierSourceProgress) => void } = {}): VerifierSourceFile[] {
  const rows: VerifierSourceFile[] = [];
  // Runtime admission asks about the same recorded population for every entry.
  // Index it once per census; repeated array scans make a full archive quadratic.
  // These indexes contain only paths, never previously measured file identities.
  const recorded = new Set(recordedPaths);
  const recordedParents = new Set<string>();
  for (const path of recorded) {
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1))
      recordedParents.add(path.slice(0, slash));
  }
  const containsRecorded = (path: string): boolean => recorded.has(path) || recordedParents.has(path);
  // Archives include large recorded binaries. Allocating a complete Buffer for
  // each file repeatedly faults/collects gigabytes on every completion census.
  // Reuse bounded storage, but still open and hash every byte on every census.
  const readBuffer = Buffer.allocUnsafe(1024 * 1024);
  let bytesRead = 0;
  let lastReportedFiles = -256;
  let nextReportAt = 0;
  const report = (nextPath?: string): void => {
    progress?.({ step: 'source-census', event: 'progress', completedFiles: rows.length,
      ...(recordedPaths.length ? { totalFiles: recordedPaths.length } : {}), bytesRead,
      ...(nextPath ? { nextPath } : {}) });
    lastReportedFiles = rows.length;
    nextReportAt = Date.now() + 5_000;
  };
  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    // Only dependency preparation may admit the copier's retained staging.
    // Recorded source stays attested; redirects and ambiguity remain fatal.
    const staging = dependencyStaging || recordedPaths.length ? entries.filter(entry => {
      if (!entry.name.startsWith('node_modules.pinned-deps-tmp')) return false;
      const rel = relative(root, join(dir, entry.name)).split(sep).join('/');
      return !containsRecorded(rel);
    }) : [];
    // Directories have no source-file row, so even empty staging must be
    // checked explicitly rather than disappearing from the census.
    if (staging.length && !dependencyStaging)
      throw new VerifierSourceError(`unexpected dependency staging: ${relative(root, join(dir, staging[0]!.name))}`);
    if (staging.length > 1) throw new VerifierSourceError(`ambiguous dependency staging: ${relative(root, dir) || '.'}`);
    for (const entry of staging) {
      if (!/^node_modules\.pinned-deps-tmp(?:\.[1-9][0-9]*)?$/.test(entry.name))
        throw new VerifierSourceError(`invalid dependency staging name: ${relative(root, join(dir, entry.name))}`);
      if (!entry.isDirectory()) throw new VerifierSourceError(`dependency staging is not an independent directory: ${relative(root, join(dir, entry.name))}`);
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split(sep).join('/');
      if (includedPaths && !includedPaths.has(rel)) continue;
      if (staging.includes(entry)) continue;
      if (rel === '.verifier-source.json' && !includedPaths) continue;
      // Only independently verified checkout metadata is outside the source population.
      if (gitMetadataPaths.includes(rel) && !recorded.has(rel)) {
        if (!lstatSync(path).isDirectory()) throw new VerifierSourceError(`verification Git metadata is not independent: ${rel}`);
        continue;
      }
      // The maintained installer records its external generation store here.
      // Admit only its two exact regular metadata files, never the state
      // directory wholesale or any path already attested as source.
      if (runtimeArtifacts && !recorded.has(rel)
        && (rel === '.papercusp/dependency-generation-root'
          || rel === '.papercusp/dependency-generation-root.state/.gitignore')) {
        const metadata = lstatSync(path);
        if (!metadata.isFile() || (metadata.mode & 0o111) !== 0 || metadata.size > 65536)
          throw new VerifierSourceError(`generation root metadata is not an independent file: ${rel}`);
        const text = readFileSync(path, 'utf8');
        const roots = text.endsWith('\n') ? text.slice(0, -1).split('\n') : [];
        const valid = rel.endsWith('/.gitignore') ? text === '*\n'
          : roots.length > 0 && new Set(roots).size === roots.length
            && roots.every(value => !/[\0\r]/.test(value) && isAbsolute(value) && resolve(value) === value);
        if (!valid) throw new VerifierSourceError(`invalid generation root metadata: ${rel}`);
        continue;
      }
      if (runtimeArtifacts && rel === '.papercusp/dependency-generation-root.state'
        && !containsRecorded(rel)
        && !lstatSync(path).isDirectory())
        throw new VerifierSourceError(`generation root state is not an independent directory: ${rel}`);
      // TanStack derives this file from the recorded routes/config on startup.
      // A tracked tree remains source, and a redirect is never a build output.
      // Vitest writes its result cache beneath the shared config's .vitest-tmp.
      // Permit only the exact cache file, never the whole directory or recorded source.
      const vitestResultCache = /(?:^|\/)\.vitest-tmp\/vitest\/[0-9a-f]{40}\/results\.json$/.test(rel);
      // setup-vad-runtime.sh mirrors ORT's versioned wasm/module names into
      // the public root too. Keep the match at that exact root and extension.
      const vadRuntimeAsset = /^apps\/operator\/public\/ort-wasm-[^/]+\.(?:wasm|mjs)$/.test(rel);
      if (runtimeArtifacts && (vitestResultCache || vadRuntimeAsset || [
        'apps/operator-vite/src/routeTree.gen.ts', '.papercusp-pinned-deps',
        // bin/vite-build-singleflight tees every in-archive build into this exact
        // log beside the admitted apps/operator-vite/dist (an assertion such as
        // test:e2e:css-preload rebuilds after the preflight census). Diagnostic
        // output only; a recorded log, a redirect, or any sibling stays fatal.
        'apps/operator-vite/.vite-build.log',
        'apps/operator/public/silero_vad_v5.onnx',
        'apps/operator/public/silero_vad_legacy.onnx',
        'apps/operator/public/vad.worklet.bundle.min.js',
        // Native build wrappers create this exact regular flock file.
        'papercusp-desktop/src-tauri/sidecar.lock',
        // build.rs stages these exact resources from native/gnome and
        // native/linux. Exporters strip stale generated copies before sealing
        // an archive; an already recorded resource must still stay immutable.
        'papercusp-desktop/src-tauri/resources/workbench@papercusp.ai.shell-extension.zip',
        'papercusp-desktop/src-tauri/resources/workbench-install.js',
        // build.rs creates these exact placeholders on a clean native build.
        'papercusp-desktop/src-tauri/sidecar/PLACEHOLDER-README.txt',
        'papercusp-desktop/src-tauri/sidecar/db-sql/PLACEHOLDER-README.txt',
        'papercusp-desktop/src-tauri/sidecar/spa/PLACEHOLDER-README.txt',
        'papercusp-desktop/src-tauri/seed/PLACEHOLDER-README.txt',
        'papercusp-desktop/src-tauri/doc-vector-seed/PLACEHOLDER-README.txt',
      ].includes(rel))
        && !recorded.has(rel)) {
        if (!lstatSync(path).isFile()) throw new VerifierSourceError(`runtime artifact is not an independent file: ${rel}`);
        continue;
      }
      // Dependencies and build outputs are separately materialized and verified.
      // This option attests source only, with the full recorded population intact.
      const runtimeDirectory = entry.name === 'node_modules' || [
        'apps/operator/dist-verify', 'apps/operator/test-results',
        // The native dependency-generation verifier rebuilds the managed Vite client here.
        'apps/operator-vite/dist',
        'apps/operator/playwright-report', 'papercusp-desktop/src-tauri/target',
        'papercusp-desktop/src-tauri/gen/schemas',
        'libs/generic/sse/dist', 'packages/omp-plugin/dist',
        // The maintained operator-vite prebuild creates these mirrors from
        // pinned dependencies (and the SHA-pinned Porcupine model) before the
        // host bundler rechecks this census. Public source outside these exact
        // roots stays in the census; recorded files below them stay source too.
        'apps/operator/public/wake-runtime', 'apps/operator/public/vad-runtime',
        'apps/operator/public/vditor', 'apps/operator/public/vditor-local',
        'apps/operator/public/monaco', 'apps/operator/public/excalidraw',
        'apps/operator/public/porcupine', 'apps/operator/public/elevenlabs-runtime',
      ].includes(rel);
      // A strict source check already knows this whole directory is extra.
      // Do not hash an installed dependency/build tree just to reject it later.
      // Recorded paths remain source in either mode, including vendored deps.
      if (!runtimeArtifacts && recordedPaths.length && runtimeDirectory
        && entry.isDirectory() && !containsRecorded(rel))
        throw new VerifierSourceError(`tampered verification source archive: added ${rel} (runtime artifacts require --runtime-artifacts)`);
      if (runtimeArtifacts && runtimeDirectory
        && !containsRecorded(rel)) {
        if (!entry.isDirectory()) throw new VerifierSourceError(`runtime artifact is not an independent directory: ${rel}`);
        continue;
      }
      if (entry.isDirectory()) walk(path);
      else {
        const stat = lstatSync(path);
        if (!stat.isFile() && !stat.isSymbolicLink()) throw new VerifierSourceError(`unsupported archive entry: ${rel}`);
        // Synchronous hashing cannot service a timer. Bound journal volume by
        // file count/time, and name a large read before it can block or be killed.
        if (progress && (rows.length - lastReportedFiles >= 256 || Date.now() >= nextReportAt
          || stat.size >= 16 * 1024 * 1024)) report(rel);
        const hash = createHash('sha256');
        if (stat.isSymbolicLink()) {
          const bytes = readlinkSync(path);
          const target = resolve(dirname(path), String(bytes));
          const boundary = resolve(symlinkRoot);
          if (isAbsolute(String(bytes)) || target !== boundary && !target.startsWith(`${boundary}${sep}`)) {
            throw new VerifierSourceError(`archive symlink escapes source root: ${rel}`);
          }
          // Dependency redirects must resolve inside the archive, too. The
          // lexical path alone misses links routed through another symlink.
          if (symlinkRoot !== root) {
            const actual = realpathSync(path);
            if (actual !== boundary && !actual.startsWith(`${boundary}${sep}`))
              throw new VerifierSourceError(`dependency symlink escapes source root: ${rel}`);
          }
          hash.update(bytes);
          bytesRead += Buffer.byteLength(bytes);
        } else {
          const fd = openSync(path, 'r');
          try {
            let length: number;
            while ((length = readSync(fd, readBuffer, 0, readBuffer.length, null)) !== 0) {
              hash.update(readBuffer.subarray(0, length));
              bytesRead += length;
            }
          } finally {
            closeSync(fd);
          }
        }
        rows.push({ path: rel, kind: stat.isSymbolicLink() ? 'symlink' : 'file',
          executable: Boolean(stat.mode & 0o111), sha256: hash.digest('hex') });
      }
    }
  }
  walk(root);
  if (progress) report();
  return rows;
}

/** Synchronous for Playwright's unawaited onBegin hook; unknown source fails closed. */
export function verifyVerifierSourceSync<T extends VerifierSourceReceipt>(dest: string, expected: T,
  options: { runtimeArtifacts?: boolean; dependencyStaging?: boolean; progress?: (record: VerifierSourceProgress) => void;
    mutation?: VerifierSourceMutation } = {}): T {
  const phase = <V>(step: VerifierSourceProgress['step'], action: () => V): V => {
    options.progress?.({ step, event: 'start' });
    try {
      const value = action();
      options.progress?.({ step, event: 'end', status: 0 });
      return value;
    } catch (error) {
      options.progress?.({ step, event: 'end', status: 3, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  if (expected?.schemaVersion !== 'verifier-source-v1' || !expected.testedInputs?.length) {
    throw new VerifierSourceError('missing verification source provenance');
  }
  const recorded = JSON.parse(readFileSync(join(dest, '.verifier-source.json'), 'utf8'));
  if (JSON.stringify(recorded) !== JSON.stringify(expected)) throw new VerifierSourceError('tampered verification source provenance');
  if (!/^[0-9a-f]{40}$/.test(expected.sourceCommit) || !Array.isArray(expected.files) || !expected.files.length) {
    throw new VerifierSourceError('invalid verification source provenance');
  }
  const gitMetadataPaths = expected.gitCheckout ? ['.git', ...(expected.submodules ?? []).map(row => `${row.path}/.git`)] : [];
  if (expected.gitCheckout) phase('git-checkout', () => {
    if (JSON.stringify(verifierGitCheckoutSync(dest, expected.sourceCommit, expected.submodules)) !== JSON.stringify(expected.gitCheckout))
      throw new VerifierSourceError('tampered verification Git checkout');
  });
  phase('source-census', () => {
    const actual = verifierSourceFiles(dest, { runtimeArtifacts: options.runtimeArtifacts, dependencyStaging: options.dependencyStaging,
      gitMetadataPaths, recordedPaths: expected.files.map(file => file.path), progress: options.progress });
    if (JSON.stringify(actual) !== JSON.stringify(expected.files)) {
      const recorded = new Map(expected.files.map(file => [file.path, file]));
      const observed = new Map(actual.map(file => [file.path, file]));
      const differences: string[] = [];
      for (const file of expected.files) {
        const current = observed.get(file.path);
        if (!current) differences.push(`missing ${file.path}`);
        else if (JSON.stringify(current) !== JSON.stringify(file)) differences.push(`changed ${file.path}`);
      }
      for (const file of actual) {
        if (!recorded.has(file.path)) differences.push(`added ${file.path}`);
      }
      if (options.mutation) {
        // A probe is a content edit of one existing regular file. Mode, kind,
        // deletion, and every other archive difference remain provenance failures.
        if (!isAbsolute(options.mutation.subjectPath))
          throw new VerifierSourceError('mutation subject must be absolute');
        const mutationRel = relative(resolve(dest), resolve(options.mutation.subjectPath)).split(sep).join('/');
        if (!mutationRel || mutationRel.startsWith('../') || isAbsolute(mutationRel))
          throw new VerifierSourceError('mutation subject escapes verifier source archive');
        const allowed = `changed ${mutationRel}`;
        const before = recorded.get(mutationRel);
        const after = observed.get(mutationRel);
        if (!before || !after || before.kind !== 'file' || after.kind !== 'file'
          || before.executable !== after.executable)
          throw new VerifierSourceError(`mutation subject is not a recorded source file: ${mutationRel}`);
        const remaining = differences.filter(difference => difference !== allowed);
        if (remaining.length === 0) return;
        throw new VerifierSourceError(`tampered verification source archive: ${remaining.slice(0, 10).join('; ')}${remaining.length > 10 ? '; further differences omitted' : ''}`);
      }
      throw new VerifierSourceError(`tampered verification source archive: ${differences.slice(0, 10).join('; ')}${differences.length > 10 ? '; further differences omitted' : ''}`);
    }
  });
  return expected;
}
