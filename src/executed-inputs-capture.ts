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
 *   • a child process, a worker thread, a socket connection, or a read of `.git` makes the file
 *     OPAQUE — its result depends on something a git diff cannot describe, so it is never reused.
 *
 * Transport: the worker writes one JSON file per test file into PC_EXECUTED_INPUTS_DIR; the
 * reporter (main process) reads it in onTestModuleEnd. No capture file means "inputs unknown",
 * which the reuse rule treats as not reusable. Nothing here can change a test outcome: every
 * wrapper calls straight through and records in a try/catch.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinModuleState } from '@papercusp/module-singleton';

export const PC_EXECUTED_INPUTS_DIR_ENV = 'PC_EXECUTED_INPUTS_DIR';

export interface InputsRecord {
  /** Absolute path of the test file the inputs belong to. */
  testFile: string;
  /** Absolute paths read, listed or stat-ed inside the repo root (node_modules excluded). */
  reads: string[];
  /** Why the file cannot be reused (child-process, worker-thread, socket, git-metadata, ...). */
  opaque: string[];
  /** Final worker import observation. Vitest's public diagnostic covers collection only. */
  moduleImports?: Record<string, { external: boolean }> | null;
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
}

interface CaptureState {
  current: Recorder | null;
  installed: boolean;
  repoRoot: string | null;
}

const state = pinModuleState<CaptureState>('@papercusp/test-config.executed-inputs-capture', () => ({
  current: null,
  installed: false,
  repoRoot: null,
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

/**
 * Normalise an fs path argument to an absolute path inside `repoRoot`, or null when it is not
 * a repo path we track (a descriptor, outside the repo, under node_modules). PURE.
 */
export function repoPathOf(arg: unknown, repoRoot: string, cwd: CwdSource): string | null {
  let p: string | null = null;
  if (typeof arg === 'string') p = arg;
  else if (arg instanceof URL) {
    if (arg.protocol !== 'file:') return null;
    p = fileURLToPath(arg);
  } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(arg)) p = arg.toString('utf8');
  if (p === null || p.length === 0) return null;
  const abs = isAbsolute(p) ? resolve(p) : resolve(typeof cwd === 'function' ? cwd() : cwd, p);
  const rel = relative(repoRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (parts.includes('node_modules')) return null;
  return abs;
}

/** Record one fs access into the active recorder. `.git` reads are opaque, not inputs. */
export function recordRead(rec: Recorder | null, arg: unknown, repoRoot: string, cwd: CwdSource): void {
  if (!rec) return;
  const abs = repoPathOf(arg, repoRoot, cwd);
  if (abs === null) return;
  const rel = relative(repoRoot, abs);
  if (rel === '.git' || rel.startsWith(`.git${sep}`) || rel.split(sep).includes('.git')) {
    rec.opaque.add('git-metadata');
    return;
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
export const CHILD_PROCESS_FUNCTIONS = [
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork',
] as const;

type AnyFn = (...args: unknown[]) => unknown;
type Patchable = Record<string, unknown>;

const WRAPPED = Symbol.for('@papercusp/test-config.executed-inputs-capture.wrapped');

function wrap(target: Patchable, name: string, before: (args: unknown[]) => void): void {
  const original = target[name];
  if (typeof original !== 'function' || (original as unknown as Record<symbol, unknown>)[WRAPPED]) return;
  const orig = original as AnyFn;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    try {
      before(args);
    } catch {
      /* recording can never change the call */
    }
    return orig.apply(this, args);
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
    target[name] = wrapped;
  } catch {
    /* frozen export — leave it */
  }
}

export interface CaptureTargets {
  fs: Patchable;
  fsPromises: Patchable;
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
  state.installed = true;
  // The recorder must be INVISIBLE to the code under test. Reading the live `process.cwd`
  // property on every intercepted fs call made it observable: a test that replaces
  // `process.cwd` to assert nothing calls it (register-papercusp.test.ts) counted OUR calls and
  // failed only in capture-armed gate runs. So hold the native function, and consult it only for
  // a RELATIVE path. The native one is also the correct one: fs resolves a relative path against
  // the real OS working directory, never against a mocked `process.cwd`.
  const nativeCwd = process.cwd.bind(process);
  const read = (args: unknown[]) => recordRead(state.current, args[0], repoRoot, nativeCwd);
  for (const name of FS_READ_FUNCTIONS) wrap(targets.fs, name, read);
  for (const name of FS_PROMISES_READ_FUNCTIONS) wrap(targets.fsPromises, name, read);
  const opaque = (reason: string) => () => state.current?.opaque.add(reason);
  for (const name of CHILD_PROCESS_FUNCTIONS) wrap(targets.childProcess, name, opaque('child-process'));
  if (targets.workerThreads) {
    const W = targets.workerThreads.Worker;
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
        /* leave it */
      }
    }
  }
  if (targets.netSocketPrototype) wrap(targets.netSocketPrototype, 'connect', opaque('socket'));
  try {
    targets.syncBuiltinESMExports?.();
  } catch {
    /* ESM named imports keep the originals; CJS callers are still captured */
  }
}

/** Start capturing for the next test file (setup-file top level). */
export function beginFile(): Recorder {
  const rec: Recorder = { reads: new Set(), opaque: new Set() };
  state.current = rec;
  return rec;
}

/** Stop capturing and return the record for `testFile`. */
export function endFile(testFile: string): InputsRecord | null {
  const rec = state.current;
  state.current = null;
  if (!rec) return null;
  return { testFile: resolve(testFile), reads: [...rec.reads].sort(), opaque: [...rec.opaque].sort() };
}

/** Test seam: the live recorder (null between files). */
export function currentRecorder(): Recorder | null {
  return state.current;
}

/** Test seam: forget the installation (unit tests install against fakes). */
export function resetCaptureForTests(): void {
  state.current = null;
  state.installed = false;
  state.repoRoot = null;
}
