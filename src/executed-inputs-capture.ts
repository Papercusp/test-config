/**
 * Executed-inputs capture — gate-file-level-test-reuse-2026-09-27 P-009 (WI-10003476, D-004).
 *
 * The executed-source map (executed-source-map-reporter.ts) proves which MODULES a passing test
 * file loaded. A pass is only reusable at a later sha when nothing the file DEPENDS ON changed,
 * and a test depends on more than its imports: it reads migrations with readdirSync, fixtures
 * and prompts with readFileSync, and it may shell out to a script. This module observes those
 * inputs at runtime, per test file, inside the vitest worker:
 *
 *   • every node:fs read/stat/list of a path inside the repo is recorded (node_modules excluded:
 *     package-lock.json already stands for it);
 *   • a child process, a worker thread, a socket connection, a read outside the repo,
 *     an unresolved file descriptor, or a read of `.git` makes the file
 *     OPAQUE — its result depends on something a git diff cannot describe, so it is never reused.
 *
 * Transport: the worker writes one JSON file per test file into PC_EXECUTED_INPUTS_DIR; the
 * reporter (main process) reads it in onTestModuleEnd. No capture file means "inputs unknown",
 * which the reuse rule treats as not reusable. Nothing here can change a test outcome: every
 * wrapper calls straight through and records in a try/catch.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { pinModuleState } from '@papercusp/module-singleton';
import { hashConfigurationValue } from './configuration-snapshot.ts';

// Keep the pre-install function: probing through the wrapped fs export would
// recursively record the recorder's own path inspection.
const lstatInputPath = lstatSync;

export const PC_EXECUTED_INPUTS_DIR_ENV = 'PC_EXECUTED_INPUTS_DIR';

export interface InputsRecord {
  compilerInputs?: import('./execution-details.ts').RecordedWorkerCompilerInputs;
  workerDatabaseReset?: import('./execution-details.ts').RecordedWorkerDatabaseReset;
  workerExecution?: import('./execution-details.ts').RecordedWorkerExecution;
  testConfiguration?: import('./configuration-snapshot.ts').RecordedWorkerTestConfiguration;
  /** The actual worker measures itself on both sides of this file's execution. */
  runtime?: import('./execution-details.ts').RecordedWorkerRuntime;
  /** Absolute path of the test file the inputs belong to. */
  testFile: string;
  /** Absolute paths read, listed or stat-ed inside the repo root (node_modules excluded). */
  reads: string[];
  /** Why the file cannot be reused (child-process, worker-thread, socket, git-metadata, ...). */
  opaque: string[];
  /** Final worker import observation. Vitest's public diagnostic covers collection only. */
  moduleImports?: Record<string, { external: boolean }> | null;
  /** Optional OUT-only observation at the evaluator boundary, never a full runtime closure. */
  moduleEvaluations?: ModuleEvaluationObservation;
}

/** Shared by the original-result and native reporters. Neither reader consumes
 * the handoff: all reporters must see the same worker observation. */
export function readInputsRecord(dir: string | null | undefined, testFileAbs: string): InputsRecord | null {
  if (!dir) return null;
  try {
    const parsed = JSON.parse(readFileSync(inputsFilePath(dir, testFileAbs), 'utf8')) as InputsRecord;
    if (!parsed || parsed.testFile !== testFileAbs || !Array.isArray(parsed.reads)
      || !parsed.reads.every(path => typeof path === 'string') || !Array.isArray(parsed.opaque)
      || !parsed.opaque.every(reason => typeof reason === 'string')) return null;
    return parsed;
  } catch { return null; }
}

export interface ModuleEvaluationObservation {
  schemaVersion: 'vitest-evaluator-inputs-v1';
  scope: 'vitest-inlined-evaluator-inputs';
  basis: 'before-evaluator-call';
  entries: Array<{ id: string; sha256: string; byteLength: number; codeRef?: string }>;
  /** Actual VM arguments correlated with an inlined evaluator invocation. */
  vmInputs?: Array<{ inputIndex: number; id: string; api: 'runInThisContext' | 'runInContext';
    filename: string; lineOffset?: number; columnOffset?: number;
    /** Digest of the complete options object passed to this call. Absent when it
     * holds a function, accessor or host object and so cannot be identified by value. */
    optionsSha256?: string;
    sha256: string; byteLength: number; codeRef?: string }>;
  /** Evaluator calls only: Node may return cached exports or a Vitest stub. */
  externalCalls?: Array<{ id: string }>;
  reasons: string[];
}

/** Summarize actual compiler calls. Artifact paths are transport, not inputs.
 * An empty/unavailable seam never becomes a complete compiler census. */
export function captureWorkerCompilerInputs(observation: ModuleEvaluationObservation | undefined,
  captureId: string, testFile: string): import('./execution-details.ts').RecordedWorkerCompilerInputs | undefined {
  if (!observation) return undefined;
  const calls = observation.vmInputs ?? [];
  const missing = new Set([...observation.reasons, 'transform-pipeline-unobserved']);
  // Options are complete only when every observed call carries its own digest.
  if (!calls.length || calls.some(row => !row.optionsSha256)) missing.add('vm-options-partially-observed');
  if (!calls.length) missing.add('vm-calls-unobserved');
  // A row recorded before the options digest existed keeps its original tuple,
  // so its stored inputSha256 still recomputes to the same value.
  const inputs = calls.map(row => [row.inputIndex, row.id, row.api, row.filename,
    row.lineOffset ?? null, row.columnOffset ?? null, row.sha256, row.byteLength,
    ...(row.optionsSha256 ? [row.optionsSha256] : [])]);
  return { schemaVersion: 'worker-compiler-inputs-v1', scope: 'vitest-inlined-vm-calls', populationStatus: 'unknown',
    captureId, testFile: resolve(testFile), inputSha256: calls.length
      ? createHash('sha256').update(JSON.stringify(['worker-compiler-inputs-v1', inputs])).digest('hex') : null,
    vmCallCount: calls.length, missing: [...missing].sort() };
}

/** Observe the live worker's complete execution map at teardown, including body imports.
 * The internal seam is version-sensitive: unavailable or malformed state stays unknown.
 * Never substitute a static graph or a later disk read for this execution observation. */
export function captureModuleImports(workerState: unknown): InputsRecord['moduleImports'] {
  try {
    const info = (workerState as { moduleExecutionInfo?: unknown } | null)?.moduleExecutionInfo;
    if (!(info instanceof Map)) return null;
    const imports: Record<string, { external: boolean }> = {};
    for (const [path, value] of info) {
      if (typeof path !== 'string' || !value || typeof value !== 'object' ||
          (value.external !== undefined && typeof value.external !== 'boolean')) return null;
      // Builtins and virtual IDs are not repository source files.
      if (!isAbsolute(path)) continue;
      // Vitest's evaluator omits external for inlined modules.
      imports[path] = { external: value.external === true };
    }
    return Object.keys(imports).length ? imports : null;
  } catch {
    return null;
  }
}

export interface Recorder {
  reads: Set<string>;
  opaque: Set<string>;
  databaseReset?: Omit<import('./execution-details.ts').RecordedWorkerDatabaseReset, 'testFile' | 'finishedAt'>;
  moduleEvaluations?: ModuleEvaluationObservation;
  moduleCodeRoot?: string;
}

interface CaptureState {
  current: Recorder | null;
  installed: boolean;
  directoryIteratorUnobserved: boolean;
  repoRoot: string | null;
  evaluationContext: AsyncLocalStorage<{ recorder: Recorder; inputIndex: number; id: string; code: string }>;
}

const state = pinModuleState<CaptureState>('@papercusp/test-config.executed-inputs-capture', () => ({
  current: null,
  installed: false,
  directoryIteratorUnobserved: false,
  repoRoot: null,
  evaluationContext: new AsyncLocalStorage(),
}));

/** The per-test-file capture file name: a stable hash of the absolute test path. */
export function inputsFileName(testFile: string): string {
  return `${createHash('sha1').update(resolve(testFile)).digest('hex')}.json`;
}

export function inputsFilePath(dir: string, testFile: string): string {
  return join(dir, inputsFileName(testFile));
}

/**
 * The working directory a relative path resolves against: a string, or a getter consulted ONLY
 * when the path is relative (so an absolute path never touches the process working directory).
 */
export type CwdSource = string | (() => string);

/** Resolve a path argument without consulting the cwd for an absolute path. */
function absoluteReadPathOf(arg: unknown, cwd: CwdSource, onParentTraversal?: () => void): string | null {
  let p: string | null = null;
  if (typeof arg === 'string') p = arg;
  else if (arg instanceof URL) {
    if (arg.protocol !== 'file:') return null;
    p = fileURLToPath(arg);
  } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(arg)) p = arg.toString('utf8');
  if (p === null || p.length === 0) return null;
  const base = isAbsolute(p) ? null : typeof cwd === 'function' ? cwd() : cwd;
  // The kernel follows a directory link before processing a later '..'. resolve
  // erases that distinction, so lexical custody cannot qualify these reads.
  const delimiter = process.platform === 'win32' ? /[\\/]/ : '/';
  if ([p, ...(base === null ? [] : [base])].some(value => value.split(delimiter).includes('..')))
    onParentTraversal?.();
  return base === null ? resolve(p) : resolve(base, p);
}

/** Return a tracked repository path; descriptors, external paths and dependencies stay null. */
export function repoPathOf(arg: unknown, repoRoot: string, cwd: CwdSource): string | null {
  const abs = absoluteReadPathOf(arg, cwd);
  if (abs === null) return null;
  const rel = relative(repoRoot, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (parts.includes('node_modules')) return null;
  return abs;
}

/** Record an fs access or retain why its input identity cannot be measured.
 * An absent repo path must never silently discard a fixture read. Reason codes
 * deliberately omit external paths and descriptor values from the handoff.
 */
export function recordRead(rec: Recorder | null, arg: unknown, repoRoot: string, cwd: CwdSource): void {
  if (!rec) return;
  let abs: string | null;
  try { abs = absoluteReadPathOf(arg, cwd, () => rec.opaque.add('fs-path-unobserved')); }
  catch { rec.opaque.add('fs-path-unobserved'); return; }
  if (abs === null) {
    rec.opaque.add(typeof arg === 'number' ? 'fs-file-descriptor' : 'fs-path-unobserved');
    return;
  }
  const rel = relative(repoRoot, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    rec.opaque.add('outside-repo-read');
    return;
  }
  if (rel.split(sep).includes('node_modules')) return;
  if (rel === '.git' || rel.startsWith(`.git${sep}`) || rel.split(sep).includes('.git')) {
    rec.opaque.add('git-metadata');
    return;
  }
  // A tracked link's spelling does not identify its target's bytes. This also
  // covers directory links and dangling links without resolving or disclosing
  // the target. Internal links stay opaque until target custody is measured.
  let probe = repoRoot;
  for (const part of rel.split(sep).filter(Boolean)) {
    probe = join(probe, part);
    try {
      if (lstatInputPath(probe).isSymbolicLink()) {
        rec.opaque.add('fs-symlink');
        break;
      }
    } catch (error) {
      // Missing paths are still useful absence inputs. Other probe failures
      // leave custody unknown; the original fs operation decides its result.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') rec.opaque.add('fs-path-unobserved');
      break;
    }
  }
  rec.reads.add(abs);
}

/** fs functions whose first argument is a path that is read, listed or stat-ed. */
export const FS_READ_FUNCTIONS = [
  'readFileSync', 'readFile', 'readdirSync', 'readdir', 'existsSync', 'exists',
  'statSync', 'stat', 'lstatSync', 'lstat', 'accessSync', 'access', 'openSync', 'open',
  'createReadStream', 'opendirSync', 'opendir', 'readlinkSync', 'readlink', 'realpathSync', 'realpath',
  'watch', 'watchFile',
] as const;
export const FS_PROMISES_READ_FUNCTIONS = [
  'readFile', 'readdir', 'stat', 'lstat', 'access', 'open', 'opendir', 'readlink', 'realpath',
] as const;
/** A descriptor may have been opened before this file's capture began. */
export const FS_DESCRIPTOR_READ_FUNCTIONS = ['read', 'readSync', 'readv', 'readvSync'] as const;
/** FileHandle methods bypass the public fs functions, including for handles
 * opened before this recorder. Their descriptor has no measured path custody. */
export const FILE_HANDLE_READ_FUNCTIONS = [
  'read', 'readv', 'readFile', 'stat', 'createReadStream', 'readLines', 'readableWebStream',
] as const;
export const CHILD_PROCESS_FUNCTIONS = [
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork',
] as const;

type AnyFn = (...args: unknown[]) => unknown;
type Patchable = Record<string, unknown>;

const WRAPPED = Symbol.for('@papercusp/test-config.executed-inputs-capture.wrapped');

function wrap(target: Patchable, name: string | symbol, before: (args: unknown[]) => void,
  invoke?: (original: AnyFn, receiver: unknown, args: unknown[]) => unknown): void {
  const properties = target as Record<PropertyKey, unknown>;
  const original = properties[name];
  if (typeof original !== 'function' || (original as unknown as Record<symbol, unknown>)[WRAPPED]) return;
  const orig = original as AnyFn;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    try {
      before(args);
    } catch {
      /* recording can never change the call */
    }
    return invoke ? invoke(orig, this, args) : orig.apply(this, args);
  };
  // Keep util.promisify.custom and any other own properties (fs.exists, fs.read...).
  for (const key of Reflect.ownKeys(orig)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    try {
      const d = Object.getOwnPropertyDescriptor(orig, key);
      if (d) Object.defineProperty(wrapped, key, d);
    } catch {
      /* non-configurable — skip */
    }
  }
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  try {
    properties[name] = wrapped;
  } catch {
    /* frozen export — leave it */
  }
}

/** Observe the code argument actually supplied to Vitest's worker evaluator. This
 * optional, version-sensitive seam does not inspect a later module cache or disk.
 * Calls retain their receiver, arguments, return identity and thrown errors. */
export function installModuleEvaluationCapture(mocker: unknown, artifactRoot?: string,
  vmTarget: Patchable = vm as unknown as Patchable): void {
  const rec = state.current;
  if (!rec) return;
  rec.moduleCodeRoot = artifactRoot;
  rec.moduleEvaluations = {
    schemaVersion: 'vitest-evaluator-inputs-v1', scope: 'vitest-inlined-evaluator-inputs',
    basis: 'before-evaluator-call', entries: [], vmInputs: [], externalCalls: [],
    // Setup/runner code loaded before this seam and non-module runtime inputs
    // remain outside this observation. External call IDs do not prove loader bytes.
    reasons: ['pre-setup-evaluations-unobserved', 'external-evaluations-unobserved',
      'evaluator-wrapper-unobserved', 'runtime-inputs-outside-evaluator',
      ...(!artifactRoot ? ['code-bytes-not-retained'] : [])],
  };
  try {
    const evaluator = (mocker as { moduleRunner?: { evaluator?: Patchable } } | null)?.moduleRunner?.evaluator;
    if (!evaluator || typeof evaluator.runInlinedModule !== 'function') throw new Error('unavailable');
    wrap(evaluator, 'runInlinedModule', () => {}, (original, receiver, args) => {
      const recorder = state.current, observation = recorder?.moduleEvaluations;
      let active: { recorder: Recorder; inputIndex: number; id: string; code: string } | undefined;
      try {
        const code = args[1], id = (args[2] as { id?: unknown } | null)?.id;
        if (recorder && observation) {
          if (typeof code !== 'string' || typeof id !== 'string' || id.length === 0) {
            if (!observation.reasons.includes('invalid-evaluator-input')) observation.reasons.push('invalid-evaluator-input');
          } else if (observation.entries.length >= 100_000) {
            if (!observation.reasons.includes('evaluator-observation-limit')) observation.reasons.push('evaluator-observation-limit');
          } else {
            observation.entries.push({ id, ...retainEvaluationCode(code, recorder, observation) });
            active = { recorder, inputIndex: observation.entries.length - 1, id, code };
          }
        }
      } catch {
        if (observation && !observation.reasons.includes('invalid-evaluator-input')) observation.reasons.push('invalid-evaluator-input');
      }
      return active ? state.evaluationContext.run(active, () => original.apply(receiver, args)) : original.apply(receiver, args);
    });
    if (!(evaluator.runInlinedModule as unknown as Record<symbol, unknown>)[WRAPPED]) throw new Error('unavailable');
    for (const api of ['runInThisContext', 'runInContext'] as const) {
      wrap(vmTarget, api, args => {
        const active = state.evaluationContext.getStore();
        if (!active || active.recorder !== state.current) return;
        const observation = active.recorder.moduleEvaluations;
        const code = args[0], options = args[api === 'runInContext' ? 2 : 1];
        // Read own data properties only. A getter on the options object is
        // application code and must not run inside this observer; an accessor
        // filename therefore leaves the call unmatched.
        const own = (key: string): unknown => {
          if (!options || typeof options !== 'object') return undefined;
          const property = Object.getOwnPropertyDescriptor(options, key);
          return property && 'value' in property ? property.value : undefined;
        };
        // Observe actual compiler arguments, never reconstruct a presumed wrapper.
        // The current Vitest writer supplies this filename and embeds the exact input.
        // A changed writer remains an explicit gap instead of silently matching.
        const filename = active.id.startsWith('mock:') ? active.id.slice(5) : active.id;
        if (!observation || typeof code !== 'string' || own('filename') !== filename ||
            !code.startsWith("'use strict';async (") || !code.endsWith(`${active.code}\n}}`)) return;
        if ((observation.vmInputs?.length ?? 0) >= 100_000) {
          if (!observation.reasons.includes('evaluator-observation-limit')) observation.reasons.push('evaluator-observation-limit');
          return;
        }
        const lineOffset = own('lineOffset'), columnOffset = own('columnOffset');
        // Digest the whole options object now, before the VM or its caller can
        // change it. An option that cannot be identified by value yields no
        // digest, which the compiler receipt reports as a named gap.
        const optionsSha256 = hashConfigurationValue(options, 'node-vm-call-options-v1');
        observation.vmInputs?.push({ inputIndex: active.inputIndex, id: active.id, api, filename,
          ...(typeof lineOffset === 'number' ? { lineOffset } : {}),
          ...(typeof columnOffset === 'number' ? { columnOffset } : {}),
          ...(optionsSha256 ? { optionsSha256 } : {}),
          ...retainEvaluationCode(code, active.recorder, observation) });
      });
    }
    wrap(evaluator, 'runExternalModule', args => {
      const observation = state.current?.moduleEvaluations;
      if (!observation) return;
      if (typeof args[0] !== 'string' || !args[0]) {
        if (!observation.reasons.includes('invalid-external-evaluator-input')) observation.reasons.push('invalid-external-evaluator-input');
      } else if ((observation.externalCalls?.length ?? 0) < 100_000) {
        observation.externalCalls?.push({ id: args[0] });
      } else if (!observation.reasons.includes('evaluator-observation-limit')) {
        observation.reasons.push('evaluator-observation-limit');
      }
    });
    if (typeof evaluator.runExternalModule === 'function' &&
        (evaluator.runExternalModule as unknown as Record<symbol, unknown>)[WRAPPED]) {
      rec.moduleEvaluations.reasons = rec.moduleEvaluations.reasons.filter(reason => reason !== 'external-evaluations-unobserved');
      rec.moduleEvaluations.reasons.push('external-loader-bytes-unobserved');
    }
  } catch {
    rec.moduleEvaluations.reasons.push('evaluator-seam-unavailable');
  }
}

/** Shared OUT sidecar transport for transformed input and actual VM wrapper bytes. */
function retainEvaluationCode(code: string, recorder: Recorder, observation: ModuleEvaluationObservation):
  { sha256: string; byteLength: number; codeRef?: string } {
  const sha256 = createHash('sha256').update(code).digest('hex');
  let codeRef: string | undefined;
  const root = recorder.moduleCodeRoot;
  if (root) {
    try {
      mkdirSync(root, { recursive: true });
      if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('invalid artifact root');
      const directory = realpathSync(root);
      const path = join(directory, `${sha256}.js`);
      // Workers share this content-addressed directory. A direct wx write makes
      // partial bytes visible to an EEXIST reader. Reuse the native tracer's
      // completed-write/no-replace publication pattern; staging stays outside
      // the trusted inventory even if the worker is killed before cleanup.
      const temporary = `${directory}.pending-${process.pid}-${randomUUID()}`;
      try {
        writeFileSync(temporary, code, { flag: 'wx', mode: 0o600 });
        try { linkSync(temporary, path); } catch (error) {
          if ((error as { code?: string }).code !== 'EEXIST') throw error;
        }
      } finally {
        try { unlinkSync(temporary); } catch { /* An interrupted worker may leave staging evidence. */ }
      }
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() ||
          createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256) throw new Error('evaluator artifact differs');
      codeRef = path;
    } catch {
      for (const reason of ['evaluator-code-archive-unavailable', 'code-bytes-not-retained']) {
        if (!observation.reasons.includes(reason)) observation.reasons.push(reason);
      }
    }
  }
  return { sha256, byteLength: Buffer.byteLength(code), ...(codeRef ? { codeRef } : {}) };
}

export interface CaptureTargets {
  fs: Patchable;
  fsPromises: Patchable;
  /** Actual runtime prototype, obtained before beginFile. Omitted by fake targets. */
  fileHandlePrototype?: Patchable;
  /** Dir iterators use a private bound reader rather than public fs exports. */
  directoryPrototype?: object;
  /** Streams can supply bytes buffered before this file's recorder began. */
  readStreamPrototype?: object;
  childProcess: Patchable;
  workerThreads?: Patchable;
  netSocketPrototype?: Patchable;
  syncBuiltinESMExports?: () => void;
}

/**
 * Patch the capture targets ONCE per process. Every wrapper reads `state.current` at call time,
 * so one installation serves every test file the worker runs.
 */
export function installCapture(targets: CaptureTargets, repoRoot: string): void {
  state.repoRoot = repoRoot;
  if (state.installed) return;
  // The recorder must be INVISIBLE to the code under test. Reading the live `process.cwd`
  // property on every intercepted fs call made it observable: a test that replaces
  // `process.cwd` to assert nothing calls it (register-papercusp.test.ts) counted OUR calls and
  // failed only in capture-armed gate runs. So hold the native function, and consult it only for
  // a RELATIVE path. The native one is also the correct one: fs resolves a relative path against
  // the real OS working directory, never against a mocked `process.cwd`.
  const nativeCwd = process.cwd.bind(process);
  const read = (args: unknown[]) => recordRead(state.current, args[0], repoRoot, nativeCwd);
  for (const name of FS_READ_FUNCTIONS) wrap(targets.fs, name, read);
  for (const name of FS_DESCRIPTOR_READ_FUNCTIONS) wrap(targets.fs, name, read);
  for (const name of FS_PROMISES_READ_FUNCTIONS) wrap(targets.fsPromises, name, read);
  const opaque = (reason: string) => () => state.current?.opaque.add(reason);
  if (targets.fileHandlePrototype) {
    const prototype = targets.fileHandlePrototype;
    // Reject an unsupported/frozen seam rather than produce an apparently
    // complete file record with direct descriptor reads silently omitted.
    for (const name of ['read', 'readv', 'readFile', 'stat', 'createReadStream'])
      if (typeof prototype[name] !== 'function') throw new Error('file-handle-capture-unavailable');
    for (const name of FILE_HANDLE_READ_FUNCTIONS) {
      if (typeof prototype[name] !== 'function') continue;
      wrap(prototype, name, opaque('fs-file-descriptor'));
      if (!(prototype[name] as unknown as Record<symbol, unknown>)[WRAPPED])
        throw new Error('file-handle-capture-unavailable');
    }
  }
  if (targets.directoryPrototype) {
    const prototype = targets.directoryPrototype as Record<PropertyKey, unknown>;
    const readDirectory = opaque('fs-directory-cursor');
    const observeIterator = (original: AnyFn, receiver: unknown, args: unknown[]) => {
      const iterator = original.apply(receiver, args);
      try {
        if (!iterator || typeof iterator !== 'object') throw new Error('directory iterator unavailable');
        // Observe advancement, including when creation precedes beginFile or
        // one iterator crosses file boundaries. Keep the original iterator,
        // method receiver, promises and errors intact.
        wrap(iterator as Patchable, 'next', readDirectory);
        if (!(iterator as { next?: Record<symbol, unknown> }).next?.[WRAPPED])
          throw new Error('directory iterator unavailable');
      } catch {
        // A retained iterator can advance in a future file. An unobservable
        // instance therefore prevents reuse for the rest of this worker.
        state.directoryIteratorUnobserved = true;
      }
      return iterator;
    };
    for (const name of ['read', 'readSync', Symbol.asyncIterator])
      if (typeof prototype[name] !== 'function') throw new Error('directory-capture-unavailable');
    for (const name of ['read', 'readSync', 'entries', Symbol.asyncIterator]) {
      if (typeof prototype[name] !== 'function') continue;
      wrap(prototype as Patchable, name, readDirectory,
        typeof name === 'symbol' || name === 'entries' ? observeIterator : undefined);
      if (!(prototype[name] as unknown as Record<symbol, unknown>)[WRAPPED]) throw new Error('directory-capture-unavailable');
    }
  }
  if (targets.readStreamPrototype) {
    const prototype = targets.readStreamPrototype as Patchable;
    for (const name of ['read', 'emit']) {
      if (typeof prototype[name] !== 'function') throw new Error('file-stream-capture-unavailable');
      // read covers buffered pulls; data delivery also covers flowing reads
      // whose underlying I/O was scheduled before this recorder began.
      wrap(prototype, name, name === 'read' ? opaque('fs-file-stream') : args => {
        if (args[0] === 'data') state.current?.opaque.add('fs-file-stream');
      });
      if (!(prototype[name] as unknown as Record<symbol, unknown>)[WRAPPED])
        throw new Error('file-stream-capture-unavailable');
    }
  }
  for (const name of CHILD_PROCESS_FUNCTIONS) wrap(targets.childProcess, name, opaque('child-process'));
  if (targets.workerThreads) {
    const W = targets.workerThreads.Worker;
    const prototype = (W as { prototype?: Patchable } | undefined)?.prototype;
    if (typeof W !== 'function' || !prototype || typeof prototype.emit !== 'function')
      throw new Error('worker-thread-capture-unavailable');
    // A worker can predate capture. Record its actual inbound messages using
    // the current file's recorder, including deserialization failures. Startup,
    // exit and unrelated events are not input delivery.
    wrap(prototype, 'emit', args => {
      if (args[0] === 'message' || args[0] === 'messageerror') state.current?.opaque.add('worker-thread');
    });
    if (!(prototype.emit as unknown as Record<symbol, unknown>)[WRAPPED])
      throw new Error('worker-thread-capture-unavailable');
    if (typeof W === 'function' && !(W as unknown as Record<symbol, unknown>)[WRAPPED]) {
      const Original = W as unknown as new (...a: unknown[]) => object;
      class CapturedWorker extends Original {
        constructor(...a: unknown[]) {
          state.current?.opaque.add('worker-thread');
          super(...a);
        }
      }
      Object.defineProperty(CapturedWorker, WRAPPED, { value: true });
      try {
        targets.workerThreads.Worker = CapturedWorker;
      } catch {
        throw new Error('worker-thread-capture-unavailable');
      }
      if (targets.workerThreads.Worker !== CapturedWorker) throw new Error('worker-thread-capture-unavailable');
    }
  }
  if (targets.netSocketPrototype) {
    const prototype = targets.netSocketPrototype;
    for (const name of ['connect', 'read', 'emit']) {
      if (typeof prototype[name] !== 'function') throw new Error('socket-capture-unavailable');
      // A connection and its buffered bytes can predate this file. Observe
      // pulls and flowing data delivery using the current recorder, while
      // leaving unrelated events (including stdio writes) alone.
      wrap(prototype, name, name === 'emit' ? args => {
        if (args[0] === 'data') state.current?.opaque.add('socket');
      } : opaque('socket'));
      if (!(prototype[name] as unknown as Record<symbol, unknown>)[WRAPPED])
        throw new Error('socket-capture-unavailable');
    }
  }
  try {
    targets.syncBuiltinESMExports?.();
  } catch {
    /* ESM named imports keep the originals; CJS callers are still captured */
  }
  state.installed = true;
}

/** Start capturing for the next test file (setup-file top level). */
export function beginFile(identity?: { captureId: string; runGroupId: string | null }): Recorder {
  const rec: Recorder = { reads: new Set(), opaque: new Set(state.directoryIteratorUnobserved ? ['fs-directory-cursor'] : []), ...(identity ? { databaseReset: {
    schemaVersion: 'worker-database-reset-v1' as const, ...identity, startedAt: new Date().toISOString(), databases: [],
  } } : {}) };
  state.current = rec;
  return rec;
}

/** Called at the actual CREATE boundary. Closures remain attached to their
 * original file; a late drop cannot upgrade a completed or subsequent file. */
export function beginDatabaseResetCapture(name: string, origin: 'empty' | 'template') {
  const rec = state.current;
  const db: NonNullable<Recorder['databaseReset']>['databases'][number] = {
    allocationId: randomUUID(), name, origin, startedAt: new Date().toISOString(), readyAt: null, cleanup: null,
  };
  rec?.databaseReset?.databases.push(db);
  return {
    isActive() { return Boolean(rec?.databaseReset && state.current === rec); },
    schema(boundary: 'before' | 'after', value: import('./configuration-snapshot.ts').OwnedDatabaseSchemaSnapshot | null) {
      if (rec?.databaseReset && state.current === rec) {
        db.schemaInputs ??= { before: null, after: null };
        db.schemaInputs[boundary] = value;
      }
    },
    ready() { if (rec?.databaseReset && state.current === rec) db.readyAt = new Date().toISOString(); },
    cleanup(outcome: NonNullable<typeof db.cleanup>['outcome']) {
      if (rec?.databaseReset && state.current === rec) db.cleanup = { at: new Date().toISOString(), outcome };
    },
  };
}

/** Stop capturing and return the record for `testFile`. */
export function endFile(testFile: string): InputsRecord | null {
  const rec = state.current;
  state.current = null;
  if (!rec) return null;
  const evaluations = rec.moduleEvaluations;
  const compiled = new Set(evaluations?.vmInputs?.map(row => row.inputIndex));
  if (evaluations?.entries.length && evaluations.entries.every((_, index) =>
    compiled.has(index))) {
    evaluations.reasons = evaluations.reasons.filter(reason => reason !== 'evaluator-wrapper-unobserved');
  }
  return { testFile: resolve(testFile), reads: [...rec.reads].sort(), opaque: [...rec.opaque].sort(),
    ...(rec.databaseReset ? { workerDatabaseReset: { ...structuredClone(rec.databaseReset),
      testFile: resolve(testFile), finishedAt: new Date().toISOString() } } : {}),
    ...(rec.moduleEvaluations ? { moduleEvaluations: rec.moduleEvaluations } : {}) };
}

/** Test seam: the live recorder (null between files). */
export function currentRecorder(): Recorder | null {
  return state.current;
}

/**
 * Test seam: snapshot the state resetCaptureForTests clears; the returned function restores it.
 * In an armed worker the setup file's real recorder and installation must survive unit tests
 * that reset and install against fakes, or the file's record is lost (WI-6554700010042252).
 */
export function snapshotCaptureForTests(): () => void {
  const saved = { current: state.current, installed: state.installed, repoRoot: state.repoRoot,
    directoryIteratorUnobserved: state.directoryIteratorUnobserved };
  return () => {
    state.current = saved.current;
    state.installed = saved.installed;
    state.repoRoot = saved.repoRoot;
    state.directoryIteratorUnobserved = saved.directoryIteratorUnobserved;
  };
}

/** Test seam: forget the installation (unit tests install against fakes). */
export function resetCaptureForTests(): void {
  state.current = null;
  state.installed = false;
  state.directoryIteratorUnobserved = false;
  state.repoRoot = null;
}
