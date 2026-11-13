import { createHash, randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { closeSync, fstatSync, openSync, readFileSync, readlinkSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashConfigurationValue } from '@papercusp/test-config/configuration-snapshot';
import { captureCurrentWorkerProcessIdentity, type WorkerProcessIdentity } from '@papercusp/test-config/runtime-proof';

// Supplied only by the maintained Vite patch, after Vite resolves per-file
// options. This observer hashes descriptors; it never changes compiler inputs.
const OBSERVER = Symbol.for('@papercusp/test-config.applied-compiler-observer-v1');
const RECEIPTS = Symbol.for('@papercusp/test-config.applied-compiler-inputs-v1');
const FUNCTIONS = ['loadTsconfigJsonForFile', 'parse', 'parseExtends', 'parseFile',
  'resolveSolutionTSConfig', 'transform', 'transformWithEsbuild'];
const GAPS = ['plugin-private-inputs-unobserved', 'cached-module-test-custody-unobserved',
  'transitive-compiler-implementation-unobserved', 'tsconfig-resolution-search-unobserved'];
const OUTCOME_GAP = 'compiler-outcome-unobserved';
const MAX_CALLS = 256;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keys = (value: object, expected: string[]) => Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const file = (value: unknown): value is string => typeof value === 'string' && value.length <= 8192
  && isAbsolute(value) && !value.includes('\0');

/** Original boundary observations only. Node's internal resolver probes and
 * cached search provenance remain opaque, so this never certifies completeness. */
export interface AppliedTsconfigSearch {
  schemaVersion: 'tsconfig-resolution-search-v1';
  status: 'partial';
  lookups: ReadonlyArray<Readonly<{ path: string; outcome: 'file' | 'fifo' | 'missing' | 'other' | 'error'; errorCode: string | null }>>;
  extends: ReadonlyArray<Readonly<{ from: string; request: string; resolved: string | null; errorCode: string | null }>>;
  cacheHits: ReadonlyArray<Readonly<{ kind: 'parse' | 'find' | 'file'; path: string }>>;
  truncated: boolean;
}

function parseTsconfigSearch(value: unknown): AppliedTsconfigSearch | undefined {
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 8192 && !v.includes('\0');
  const errorCode = (v: unknown) => v === null || (typeof v === 'string' && /^[A-Z0-9_]{1,128}$/.test(v));
  if (!plain(value) || !keys(value, ['schemaVersion', 'status', 'lookups', 'extends', 'cacheHits', 'truncated'])
    || value.schemaVersion !== 'tsconfig-resolution-search-v1' || value.status !== 'partial'
    || typeof value.truncated !== 'boolean') return undefined;
  for (const key of ['lookups', 'extends', 'cacheHits'])
    if (!Array.isArray(value[key]) || (value[key] as unknown[]).length > 1024) return undefined;
  if (!(value.lookups as unknown[]).every(v => plain(v) && keys(v, ['path', 'outcome', 'errorCode'])
    && file(v.path) && ['file', 'fifo', 'missing', 'other', 'error'].includes(v.outcome as string) && errorCode(v.errorCode)
    && (v.outcome === 'missing' ? v.errorCode === 'ENOENT' : v.outcome === 'error' ? v.errorCode !== null : v.errorCode === null))
    || !(value.extends as unknown[]).every(v => plain(v) && keys(v, ['from', 'request', 'resolved', 'errorCode'])
      && file(v.from) && text(v.request) && (v.resolved === null ? v.errorCode !== null : file(v.resolved) && v.errorCode === null)
      && errorCode(v.errorCode))
    || !(value.cacheHits as unknown[]).every(v => plain(v) && keys(v, ['kind', 'path'])
      && ['parse', 'find', 'file'].includes(v.kind as string) && file(v.path))) return undefined;
  return value as unknown as AppliedTsconfigSearch;
}

/** Selected loaded scripts, not an ESM/dynamic/native-library closure census.
 * No backing-file read stands in for V8's loaded script source. Native evidence
 * retains its original spawn custody; it does not prove use by later calls. */
export interface AppliedCompilerImplementationInputs {
  schemaVersion: 'compiler-implementation-inputs-v1';
  status: 'partial';
  selection: 'vite-boundary-and-esbuild-cjs-cache';
  javascriptStatus: 'captured' | 'unavailable' | 'ambiguous' | 'truncated';
  javascript: ReadonlyArray<Readonly<{ path: string; sha256: string; byteLength: number }>>;
  nativeStatus: 'observed' | 'unobserved' | 'unavailable' | 'ambiguous';
  native: Readonly<{ path: string; sha256: string; byteLength: number;
    process: Readonly<{ pid: number; startTicks: string }>; argv: readonly string[];
    origin: Readonly<{ captureId: string; sequence: number; moduleId: string }> }> | null;
  /** Current request use, separate from the original native spawn observation. */
  nativeUse?: Readonly<AppliedCompilerNativeUse>;
}

type NativeImage = NonNullable<AppliedCompilerImplementationInputs['native']>;
export interface AppliedCompilerNativeUse {
  schemaVersion: 'esbuild-native-use-v1';
  status: 'observed' | 'unobserved' | 'unavailable' | 'ambiguous';
  request: Readonly<{ serviceId: string; requestId: number; image: NativeImage }> | null;
}

const MAX_IMPLEMENTATION_FILES = 64;
const MAX_IMPLEMENTATION_BYTES = 16 * 1024 * 1024;
function parseImplementationInputs(value: unknown): AppliedCompilerImplementationInputs | undefined {
  if (!plain(value) || !keys(value, ['schemaVersion', 'status', 'selection', 'javascriptStatus', 'javascript', 'nativeStatus', 'native',
    ...(Object.hasOwn(value, 'nativeUse') ? ['nativeUse'] : [])])
    || value.schemaVersion !== 'compiler-implementation-inputs-v1' || value.status !== 'partial'
    || value.selection !== 'vite-boundary-and-esbuild-cjs-cache'
    || !['captured', 'unavailable', 'ambiguous', 'truncated'].includes(value.javascriptStatus as string)
    || !Array.isArray(value.javascript) || value.javascript.length > MAX_IMPLEMENTATION_FILES
    || !['observed', 'unobserved', 'unavailable', 'ambiguous'].includes(value.nativeStatus as string)) return undefined;
  let previous = '', bytes = 0;
  for (const source of value.javascript) {
    if (!plain(source) || !keys(source, ['path', 'sha256', 'byteLength']) || !file(source.path) || source.path <= previous
      || !digest(source.sha256) || !Number.isSafeInteger(source.byteLength) || (source.byteLength as number) < 1) return undefined;
    previous = source.path; bytes += source.byteLength as number;
  }
  if (bytes > MAX_IMPLEMENTATION_BYTES || (value.javascriptStatus === 'captured' && !value.javascript.length)) return undefined;
  const native = value.native;
  if (value.nativeStatus !== 'observed') { if (native !== null) return undefined; }
  else if (!validNativeImage(native)) return undefined;
  if (Object.hasOwn(value, 'nativeUse')) {
    const use = value.nativeUse;
    if (!plain(use) || !keys(use, ['schemaVersion', 'status', 'request']) || use.schemaVersion !== 'esbuild-native-use-v1'
      || !['observed', 'unobserved', 'unavailable', 'ambiguous'].includes(use.status as string)) return undefined;
    if (use.status !== 'observed') { if (use.request !== null) return undefined; }
    else if (!plain(use.request) || !keys(use.request, ['serviceId', 'requestId', 'image'])
      || typeof use.request.serviceId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(use.request.serviceId)
      || !Number.isSafeInteger(use.request.requestId) || (use.request.requestId as number) < 0
      || !validNativeImage(use.request.image)) return undefined;
  }
  return value as unknown as AppliedCompilerImplementationInputs;
}

function validNativeImage(native: unknown): native is NativeImage {
  return !(!plain(native) || !keys(native, ['path', 'sha256', 'byteLength', 'process', 'argv', 'origin'])
    || !file(native.path) || !digest(native.sha256) || !Number.isSafeInteger(native.byteLength)
    || (native.byteLength as number) < 1 || (native.byteLength as number) > 64 * 1024 * 1024
    || !plain(native.process) || !keys(native.process, ['pid', 'startTicks'])
    || !Number.isSafeInteger(native.process.pid) || (native.process.pid as number) < 1
    || typeof native.process.startTicks !== 'string' || !/^\d+$/.test(native.process.startTicks)
    || !Array.isArray(native.argv) || native.argv.length !== 3 || !file(native.argv[0])
    || typeof native.argv[1] !== 'string' || !/^--service=[0-9.]{1,64}$/.test(native.argv[1]) || native.argv[2] !== '--ping'
    || !plain(native.origin) || !keys(native.origin, ['captureId', 'sequence', 'moduleId']) || !file(native.origin.moduleId)
    || typeof native.origin.captureId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(native.origin.captureId)
    || !Number.isSafeInteger(native.origin.sequence) || (native.origin.sequence as number) < 1);
}

type JavascriptInputs = Pick<AppliedCompilerImplementationInputs, 'javascriptStatus' | 'javascript'>;
/** Current-isolate script bytes, not files re-read after load. Conflicting
 * scripts at one path fail closed instead of guessing which one executes. */
async function loadedJavascriptInputs(implementation: unknown): Promise<JavascriptInputs> {
  const unavailable = { javascriptStatus: 'unavailable', javascript: Object.freeze([]) } as const;
  const session = new Session();
  try {
    if (!plain(implementation) || typeof implementation.moduleUrl !== 'string' || !plain(implementation.functions)) return unavailable;
    const require = createRequire(implementation.moduleUrl);
    const root = require.cache[require.resolve('esbuild')];
    if (!root?.loaded || root.exports !== implementation.esbuild
      || root.exports.transform !== implementation.functions.transform) return unavailable;
    const paths = new Set([fileURLToPath(implementation.moduleUrl)]), pending = [root], seen = new Set();
    while (pending.length) {
      const entry = pending.pop()!;
      if (seen.has(entry)) continue;
      seen.add(entry);
      if (!entry.loaded || !file(entry.filename)) return unavailable;
      paths.add(entry.filename);
      if (paths.size > MAX_IMPLEMENTATION_FILES || seen.size > MAX_IMPLEMENTATION_FILES)
        return { javascriptStatus: 'truncated', javascript: Object.freeze([]) };
      if (entry.children.length > MAX_IMPLEMENTATION_FILES) return { javascriptStatus: 'truncated', javascript: Object.freeze([]) };
      pending.push(...entry.children);
    }
    const scripts = new Map<string, Set<string>>();
    session.on('Debugger.scriptParsed', ({ params }) => {
      try {
        const path = params.url.startsWith('file:') ? fileURLToPath(params.url) : params.url;
        if (paths.has(path)) {
          const ids = scripts.get(path) ?? new Set<string>();
          if (ids.size < 3) ids.add(params.scriptId);
          scripts.set(path, ids);
        }
      } catch { /* Non-file scripts are not selected. */ }
    });
    session.connect();
    await session.post('Debugger.enable');
    const javascript: AppliedCompilerImplementationInputs['javascript'][number][] = [];
    let bytes = 0;
    for (const path of [...paths].sort()) {
      const ids = scripts.get(path);
      if (!ids?.size) return unavailable;
      if (ids.size > 2) return { javascriptStatus: 'ambiguous', javascript: Object.freeze([]) };
      let source: { path: string; sha256: string; byteLength: number } | undefined;
      for (const scriptId of ids) {
        const { scriptSource } = await session.post('Debugger.getScriptSource', { scriptId });
        const byteLength = Buffer.byteLength(scriptSource);
        if (!byteLength || bytes + byteLength > MAX_IMPLEMENTATION_BYTES)
          return { javascriptStatus: 'truncated', javascript: Object.freeze([]) };
        const sha256 = sha(scriptSource);
        if (source && source.sha256 !== sha256) return { javascriptStatus: 'ambiguous', javascript: Object.freeze([]) };
        source = { path, sha256, byteLength };
      }
      bytes += source!.byteLength;
      javascript.push(Object.freeze(source!));
    }
    return { javascriptStatus: 'captured', javascript: Object.freeze(javascript) };
  } catch { return unavailable; }
  finally { try { session.disconnect(); } catch { /* An unavailable inspector stays unknown. */ } }
}

const implementationCall = new AsyncLocalStorage<object>();
const NATIVE_USE_OBSERVER = Symbol.for('@papercusp/test-config.esbuild-native-use-observer-v1');
const nativeUseObservers = new WeakMap<object, Set<(event: unknown) => void>>();
const serviceIdentities = new WeakMap<object, string>();
function subscribeNativeUse(implementation: unknown, observe: (event: unknown) => void): (() => void) | undefined {
  if (!plain(implementation)) return undefined;
  let listeners = nativeUseObservers.get(implementation);
  if (!listeners) {
    if (Object.hasOwn(implementation, NATIVE_USE_OBSERVER)) return undefined;
    listeners = new Set();
    const registered = listeners;
    Object.defineProperty(implementation, NATIVE_USE_OBSERVER, { value: (event: unknown) => {
      for (const listener of registered) { try { listener(event); } catch { /* Diagnostics never change compilation. */ } }
    } });
    nativeUseObservers.set(implementation, listeners);
  }
  listeners.add(observe);
  return () => { listeners.delete(observe); };
}
type ObservedChild = ChildProcess;
const nativeServices = new WeakMap<Function, { child: ObservedChild; native: NonNullable<AppliedCompilerImplementationInputs['native']> }>();
const childStartTicks = (pid: number) => readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').slice(1).join(') ').split(' ')[19];
function observedNative(child: unknown, version: string,
  origin: NonNullable<AppliedCompilerImplementationInputs['native']>['origin']): AppliedCompilerImplementationInputs['native'] {
  let fd: number | undefined;
  try {
    const candidate = child as { pid?: number; spawnargs?: string[] };
    if (process.platform !== 'linux' || !Number.isSafeInteger(candidate?.pid) || candidate.pid! < 1
      || candidate.spawnargs?.length !== 3 || !file(candidate.spawnargs[0])
      || candidate.spawnargs[1] !== '--service=' + version || candidate.spawnargs[2] !== '--ping') return null;
    const prefix = '/proc/' + candidate.pid;
    const startTicks = () => childStartTicks(candidate.pid!);
    const start = startTicks();
    if (!start || !/^\d+$/.test(start)) return null;
    // The kernel's executing image, never a guessed ESBUILD_BINARY_PATH.
    fd = openSync(prefix + '/exe', 'r');
    const stat = fstatSync(fd), path = readlinkSync(prefix + '/exe');
    if (!stat.isFile() || !file(path) || stat.size < 1 || stat.size > 64 * 1024 * 1024) return null;
    const source = readFileSync(fd);
    if (source.length !== stat.size || startTicks() !== start) return null;
    return Object.freeze({ path, sha256: createHash('sha256').update(source).digest('hex'), byteLength: source.length,
      process: Object.freeze({ pid: candidate.pid!, startTicks: start }), argv: Object.freeze([...candidate.spawnargs]),
      origin: Object.freeze({ ...origin }) });
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export interface AppliedCompilerCall {
  sequence: number;
  moduleId: string;
  codeSha256: string;
  optionsSha256: string | null;
  tsconfigStatus: 'captured' | 'absent' | 'inline' | 'not-used' | 'unavailable';
  tsconfigInputs: ReadonlyArray<Readonly<{ path: string; sha256: string; byteLength: number }>>;
  implementation: Readonly<{ viteVersion: string; esbuildVersion: string;
    functionHashes: ReadonlyArray<Readonly<{ name: string; sha256: string }>> }> | null;
  /** Hash of measured call inputs only; operational capture/process IDs are separate. */
  inputSha256: string | null;
  /** Optional on legacy receipts; partial even when every recorded probe succeeded. */
  tsconfigSearch?: Readonly<AppliedTsconfigSearch>;
  /** Optional on legacy callers; never removes the transitive gap. */
  implementationInputs?: Readonly<AppliedCompilerImplementationInputs>;
  /** Optional for legacy/inflight observations. Bound to the original call. */
  outcome?: Readonly<{ status: 'success'; callBinding: string; resultSha256: string | null }
    | { status: 'failure'; callBinding: string; errorSha256: string | null }>;
}

export interface AppliedCompilerReceipt {
  schemaVersion: 'vite-applied-compiler-inputs-v1';
  scope: 'vite-esbuild-calls';
  basis: 'before-compiler-call';
  populationStatus: 'unknown';
  captureId: string;
  /** The original compiler process, NOT an assertion about the test worker. */
  compilerProcess: Readonly<WorkerProcessIdentity> | null;
  calls: ReadonlyArray<Readonly<AppliedCompilerCall>>;
  truncated: boolean;
  missing: readonly string[];
}

function callHash(call: Omit<AppliedCompilerCall, 'inputSha256'>): string | null {
  if (!call.optionsSha256 || !call.implementation || call.tsconfigStatus === 'unavailable' || call.tsconfigSearch?.truncated
    || (call.implementationInputs && call.implementationInputs.javascriptStatus !== 'captured')) return null;
  const inputs = call.implementationInputs;
  // PID/lifetime are custody, not semantic compiler inputs.
  const semanticImage = (image: NativeImage | null) => image && {
    path: image.path, sha256: image.sha256, byteLength: image.byteLength, argv: image.argv };
  const implementation = inputs && { ...inputs, native: inputs.native && {
    path: inputs.native.path, sha256: inputs.native.sha256, byteLength: inputs.native.byteLength, argv: inputs.native.argv },
    ...(inputs.nativeUse ? { nativeUse: { schemaVersion: inputs.nativeUse.schemaVersion, status: inputs.nativeUse.status,
      image: semanticImage(inputs.nativeUse.request?.image ?? null) } } : {}) };
  return hashConfigurationValue([call.moduleId, call.codeSha256, call.optionsSha256,
    call.tsconfigStatus, call.tsconfigInputs, call.implementation,
    ...(call.tsconfigSearch ? [call.tsconfigSearch] : []), ...(implementation ? [implementation] : [])], 'vite-applied-esbuild-call-v1');
}

function callBinding(captureId: string, call: AppliedCompilerCall): string {
  return sha(JSON.stringify(['vite-esbuild-settlement-v1', captureId, call.sequence, call.moduleId, call.inputSha256]));
}

/** Strict JSON transport parser. A digest of a bounded call does not certify
 * plugin closure, successful compilation, a census or worker/test attribution. */
export function parseAppliedCompilerReceipt(value: unknown): AppliedCompilerReceipt | undefined {
  try {
    // Reject accessors, functions, cycles and oversized values without executing them.
    if (hashConfigurationValue(value, 'applied-compiler-receipt-validation') === null || !plain(value)
      || !keys(value, ['schemaVersion', 'scope', 'basis', 'populationStatus', 'captureId', 'compilerProcess', 'calls', 'truncated', 'missing'])
      || value.schemaVersion !== 'vite-applied-compiler-inputs-v1' || value.scope !== 'vite-esbuild-calls'
      || value.basis !== 'before-compiler-call' || value.populationStatus !== 'unknown'
      || typeof value.captureId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.captureId)
      || typeof value.truncated !== 'boolean' || !Array.isArray(value.calls) || !value.calls.length || value.calls.length > MAX_CALLS
      || !Array.isArray(value.missing) || !GAPS.every(gap => (value.missing as unknown[]).includes(gap))) return undefined;
    const processIdentity = value.compilerProcess;
    if (processIdentity !== null && (!plain(processIdentity)
      || !keys(processIdentity, ['pid', 'threadId', 'bootId', 'startTicks'])
      || !Number.isSafeInteger(processIdentity.pid) || (processIdentity.pid as number) < 1
      || !Number.isSafeInteger(processIdentity.threadId) || (processIdentity.threadId as number) < 0
      || typeof processIdentity.bootId !== 'string' || !/^[a-f0-9-]{36}$/.test(processIdentity.bootId)
      || typeof processIdentity.startTicks !== 'string' || !/^\d+$/.test(processIdentity.startTicks))) return undefined;
    for (const [index, call] of value.calls.entries()) {
      if (!plain(call) || !keys(call, ['sequence', 'moduleId', 'codeSha256', 'optionsSha256', 'tsconfigStatus',
        'tsconfigInputs', 'implementation', 'inputSha256', ...(Object.hasOwn(call, 'outcome') ? ['outcome'] : []),
        ...(Object.hasOwn(call, 'tsconfigSearch') ? ['tsconfigSearch'] : []),
        ...(Object.hasOwn(call, 'implementationInputs') ? ['implementationInputs'] : [])])
        || call.sequence !== index + 1 || !file(call.moduleId)
        || !digest(call.codeSha256) || (call.optionsSha256 !== null && !digest(call.optionsSha256))
        || !['captured', 'absent', 'inline', 'not-used', 'unavailable'].includes(call.tsconfigStatus as string)
        || !Array.isArray(call.tsconfigInputs) || call.tsconfigInputs.length > 1024) return undefined;
      let previous = '';
      for (const input of call.tsconfigInputs) {
        if (!plain(input) || !keys(input, ['path', 'sha256', 'byteLength']) || !file(input.path)
          || input.path <= previous || !digest(input.sha256) || !Number.isSafeInteger(input.byteLength)
          || (input.byteLength as number) < 0) return undefined;
        previous = input.path;
      }
      if ((call.tsconfigStatus === 'captured' && !call.tsconfigInputs.length)
        || (['absent', 'inline', 'not-used'].includes(call.tsconfigStatus as string) && call.tsconfigInputs.length)) return undefined;
      const implementation = call.implementation;
      if (implementation !== null && (!plain(implementation) || !keys(implementation, ['viteVersion', 'esbuildVersion', 'functionHashes'])
        || typeof implementation.viteVersion !== 'string' || !implementation.viteVersion.length || implementation.viteVersion.length > 128
        || typeof implementation.esbuildVersion !== 'string' || !implementation.esbuildVersion.length || implementation.esbuildVersion.length > 128
        || !Array.isArray(implementation.functionHashes) || implementation.functionHashes.length !== FUNCTIONS.length
        || !implementation.functionHashes.every((fn, i) => plain(fn) && keys(fn, ['name', 'sha256'])
          && fn.name === FUNCTIONS[i] && digest(fn.sha256)))) return undefined;
      if (Object.hasOwn(call, 'tsconfigSearch') && !parseTsconfigSearch(call.tsconfigSearch)) return undefined;
      const inputs = Object.hasOwn(call, 'implementationInputs') ? parseImplementationInputs(call.implementationInputs) : undefined;
      if (Object.hasOwn(call, 'implementationInputs') && !inputs) return undefined;
      const useOrigin = inputs?.nativeUse?.request?.image.origin;
      if (useOrigin && (useOrigin.captureId !== value.captureId || useOrigin.sequence !== call.sequence
        || useOrigin.moduleId !== call.moduleId)) return undefined;
      if (call.inputSha256 !== callHash(call as unknown as AppliedCompilerCall)) return undefined;
      if (Object.hasOwn(call, 'outcome')) {
        const outcome = call.outcome;
        if (!plain(outcome) || !['success', 'failure'].includes(outcome.status as string)
          || !keys(outcome, ['status', 'callBinding', outcome.status === 'success' ? 'resultSha256' : 'errorSha256'])
          || outcome.callBinding !== callBinding(value.captureId, call as unknown as AppliedCompilerCall)) return undefined;
        const outcomeHash = outcome.status === 'success' ? outcome.resultSha256 : outcome.errorSha256;
        if (outcomeHash !== null && !digest(outcomeHash)) return undefined;
      }
    }
    const outcomeUnknown = value.truncated || value.calls.some(call => !call.outcome
      || (call.outcome.status === 'success' ? !call.outcome.resultSha256 : !call.outcome.errorSha256));
    const missing = [...GAPS, ...(outcomeUnknown ? [OUTCOME_GAP] : [])];
    if (value.missing.length !== missing.length || new Set(value.missing).size !== missing.length
      || !missing.every(gap => (value.missing as unknown[]).includes(gap))) return undefined;
    return value as unknown as AppliedCompilerReceipt;
  } catch { return undefined; }
}

const installed = new WeakSet<object>();
const functionHashes = new WeakMap<Function, string>();
function implementationIdentity(value: unknown): AppliedCompilerCall['implementation'] {
  if (!plain(value) || !keys(value, ['viteVersion', 'esbuildVersion', 'functions',
    ...(Object.hasOwn(value, 'moduleUrl') ? ['moduleUrl', 'esbuild'] : [])]) || !plain(value.functions)
    || !keys(value.functions, FUNCTIONS) || typeof value.viteVersion !== 'string' || typeof value.esbuildVersion !== 'string') return null;
  const hashes = [];
  for (const name of FUNCTIONS) {
    const fn = Object.getOwnPropertyDescriptor(value.functions, name)?.value;
    if (typeof fn !== 'function') return null;
    let hash = functionHashes.get(fn);
    if (!hash) { hash = sha(Function.prototype.toString.call(fn)); functionHashes.set(fn, hash); }
    hashes.push(Object.freeze({ name, sha256: hash }));
  }
  return Object.freeze({ viteVersion: value.viteVersion, esbuildVersion: value.esbuildVersion, functionHashes: Object.freeze(hashes) });
}

/** Opt-in on the actual resolved Vite config. An unpatched or unsupported Vite
 * produces no receipt. The shared reporter can read the original environment
 * through readAppliedCompilerInputs; it must separately establish test custody. */
export function installAppliedCompilerInputCapture(config: object): boolean {
  if (installed.has(config)) return true;
  try {
    if (Object.hasOwn(config, OBSERVER)) return false;
    const captureId = randomUUID();
    const processIdentity = captureCurrentWorkerProcessIdentity();
    const compilerProcess = processIdentity ? Object.freeze(processIdentity) : null;
    const journals = new WeakMap<object, { calls: AppliedCompilerCall[]; truncated: boolean }>();
    Object.defineProperty(config, OBSERVER, { value: (event: unknown) => {
      try {
        if (!plain(event) || event.version !== 1 || !event.environment || typeof event.environment !== 'object') return;
        const environment = event.environment;
        let journal = journals.get(environment);
        if (!journal) {
          journal = { calls: [], truncated: false };
          const entries = journal;
          Object.defineProperty(environment, RECEIPTS, { value: () => Object.freeze({
            schemaVersion: 'vite-applied-compiler-inputs-v1', scope: 'vite-esbuild-calls', basis: 'before-compiler-call',
            populationStatus: 'unknown', captureId, compilerProcess, calls: Object.freeze([...entries.calls]),
            truncated: entries.truncated, missing: Object.freeze([...GAPS, ...(entries.truncated || entries.calls.some(call =>
              !call.outcome || (call.outcome.status === 'success' ? !call.outcome.resultSha256 : !call.outcome.errorSha256))
              ? [OUTCOME_GAP] : [])]),
          }) });
          journals.set(environment, journal);
        }
        if (journal.calls.length >= MAX_CALLS) { journal.truncated = true; return; }
        if (!file(event.moduleId) || typeof event.code !== 'string' || !plain(event.tsconfig)
          || !Array.isArray(event.tsconfig.inputs)) { journal.truncated = true; return; }
        const inputs = new Map<string, { path: string; sha256: string; byteLength: number }>();
        let status = event.tsconfig.status as AppliedCompilerCall['tsconfigStatus'];
        for (const input of event.tsconfig.inputs) {
          if (!plain(input) || !file(input.path) || !digest(input.sha256) || !Number.isSafeInteger(input.byteLength)
            || (input.byteLength as number) < 0 || inputs.size >= 1024) { status = 'unavailable'; break; }
          const prior = inputs.get(input.path);
          if (prior && (prior.sha256 !== input.sha256 || prior.byteLength !== input.byteLength)) status = 'unavailable';
          inputs.set(input.path, Object.freeze({ path: input.path, sha256: input.sha256 as string, byteLength: input.byteLength as number }));
        }
        let tsconfigSearch: Readonly<AppliedTsconfigSearch> | undefined;
        if (Object.hasOwn(event.tsconfig, 'search')) {
          // Copy descriptors into an immutable snapshot; neither a later cache
          // lookup nor the observer's caller can rewrite the original search.
          const source = hashConfigurationValue(event.tsconfig.search, 'tsconfig-search-validation') !== null
            ? parseTsconfigSearch(event.tsconfig.search) : undefined;
          if (!source) status = 'unavailable';
          else tsconfigSearch = Object.freeze({ ...source,
            lookups: Object.freeze(source.lookups.map(v => Object.freeze({ ...v }))),
            extends: Object.freeze(source.extends.map(v => Object.freeze({ ...v }))),
            cacheHits: Object.freeze(source.cacheHits.map(v => Object.freeze({ ...v }))) });
        }
        const call = { sequence: journal.calls.length + 1, moduleId: event.moduleId, codeSha256: sha(event.code),
          optionsSha256: hashConfigurationValue(event.options, 'vite-applied-esbuild-options-v1'), tsconfigStatus: status,
          tsconfigInputs: Object.freeze([...inputs.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
          implementation: implementationIdentity(event.implementation), ...(tsconfigSearch ? { tsconfigSearch } : {}) };
        let original: Readonly<AppliedCompilerCall> = Object.freeze({ ...call, inputSha256: callHash(call) });
        journal.calls.push(original);
        // This closure owns the exact slot even when concurrent calls settle
        // out of order. Replace frozen snapshots; never mutate earlier reads.
        let settled = false;
        const settle = (settlement: unknown) => {
          if (settled) return;
          try {
            if (!plain(settlement)) return;
            const status = Object.getOwnPropertyDescriptor(settlement, 'status')?.value;
            let outcome: AppliedCompilerCall['outcome'];
            const binding = callBinding(captureId, original);
            if (status === 'success') {
              const result = Object.getOwnPropertyDescriptor(settlement, 'result')?.value;
              outcome = Object.freeze({ status, callBinding: binding,
                resultSha256: hashConfigurationValue(result, 'vite-esbuild-result-v1') });
            } else if (status === 'failure') {
              const error = Object.getOwnPropertyDescriptor(settlement, 'error')?.value;
              const message = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined;
              outcome = Object.freeze({ status, callBinding: binding,
                errorSha256: typeof message === 'string' ? sha(message) : null });
            } else return;
            journal!.calls[original.sequence - 1] = Object.freeze({ ...original, outcome });
            settled = true;
          } catch { /* An unobserved settlement retains the explicit gap. */ }
        };
        let execution: Promise<unknown> | undefined;
        Object.defineProperty(settle, 'run', { value: (invoke: () => Promise<unknown>) => execution ??= (async () => {
          const javascript = await loadedJavascriptInputs(event.implementation);
          const context = {}, natives: Array<{ child: ObservedChild; native: NonNullable<AppliedCompilerImplementationInputs['native']> }> = [];
          const pendingSpawns: Array<{ child: ObservedChild; listener: () => void }> = [];
          const transform = plain(event.implementation) && plain(event.implementation.functions)
            ? event.implementation.functions.transform : undefined;
          const esbuild = plain(event.implementation) ? event.implementation.esbuild : undefined;
          let requests = 0, responses = 0, useUnavailable = false;
          let useRequest: AppliedCompilerNativeUse['request'] = null;
          const observeUse = (message: unknown) => {
            try {
              if (implementationCall.getStore() !== context || !plain(message) || message.implementation !== esbuild) return;
              requests++;
              if (requests !== 1 || message.version !== 1 || !plain(message.channel)
                || !Number.isSafeInteger(message.requestId) || (message.requestId as number) < 0
                || typeof message.register !== 'function') { useUnavailable = true; return; }
              const { channel: service, requestId, child, register } = message;
              const origin = { captureId, sequence: original.sequence, moduleId: original.moduleId };
              const image = observedNative(child, original.implementation?.esbuildVersion ?? '', origin);
              if (!image) useUnavailable = true;
              let serviceId = serviceIdentities.get(service);
              if (!serviceId) { serviceId = randomUUID(); serviceIdentities.set(service, serviceId); }
              // Register at SEND. Stream delivery may run in another call's ALS
              // context; this closure retains the exact channel/request origin.
              register((reply: unknown) => {
                try {
                  responses++;
                  if (responses !== 1 || !plain(reply) || reply.version !== 1 || reply.phase !== 'response'
                    || reply.channel !== service || reply.requestId !== requestId || reply.child !== child
                    || reply.implementation !== esbuild || !image) { useUnavailable = true; return; }
                  const after = observedNative(child, original.implementation?.esbuildVersion ?? '', origin);
                  if (!after || JSON.stringify(after) !== JSON.stringify(image)) { useUnavailable = true; return; }
                  useRequest = Object.freeze({ serviceId: serviceId!, requestId: requestId as number, image });
                } catch { useUnavailable = true; }
              });
            } catch { useUnavailable = true; }
          };
          let unavailable = false, spawns = 0;
          const spawned = channel('tracing:child_process.spawn:end');
          const observeSpawn = (message: unknown) => {
            try {
              if (implementationCall.getStore() !== context) return;
              const child = (message as { process?: ObservedChild })?.process;
              if (!child?.spawnargs?.some(arg => arg.startsWith('--service='))) return;
              spawns = Math.min(3, spawns + 1);
              if (spawns > 1) return;
              // Node publishes spawn:end before assigning the public PID.
              // Its subsequent spawn event has both PID and executable ready.
              const listener = () => {
                try {
                  const native = observedNative(child, original.implementation?.esbuildVersion ?? '',
                    { captureId, sequence: original.sequence, moduleId: original.moduleId });
                  if (native) natives.push({ child, native }); else unavailable = true;
                } catch { unavailable = true; }
              };
              pendingSpawns.push({ child, listener });
              child.once('spawn', listener);
            } catch { unavailable = true; }
          };
          let subscribed = false;
          let unsubscribeUse: (() => void) | undefined;
          try {
            try { spawned.subscribe(observeSpawn); subscribed = true; } catch { unavailable = true; }
            try { unsubscribeUse = subscribeNativeUse(esbuild, observeUse); } catch { useUnavailable = true; }
            return await implementationCall.run(context, invoke);
          } finally {
            unsubscribeUse?.();
            if (subscribed) spawned.unsubscribe(observeSpawn);
            for (const { child, listener } of pendingSpawns) child.off('spawn', listener);
            let service = natives[0];
            if (typeof transform === 'function') {
              if (spawns > 1 || unavailable) nativeServices.delete(transform);
              else if (service) nativeServices.set(transform, service);
              else {
                const cached = nativeServices.get(transform);
                try {
                  if (cached && !cached.child.killed && cached.child.exitCode === null
                    && childStartTicks(cached.native.process.pid) === cached.native.process.startTicks) service = cached;
                } catch { /* Never infer a live native image from argv alone. */ }
              }
            }
            const inputs: Readonly<AppliedCompilerImplementationInputs> = Object.freeze({
              schemaVersion: 'compiler-implementation-inputs-v1', status: 'partial',
              selection: 'vite-boundary-and-esbuild-cjs-cache', ...javascript,
              nativeStatus: spawns > 1 ? 'ambiguous' : unavailable ? 'unavailable' : service ? 'observed' : 'unobserved',
              native: spawns <= 1 && !unavailable ? service?.native ?? null : null,
              nativeUse: Object.freeze({ schemaVersion: 'esbuild-native-use-v1',
                status: requests > 1 || responses > 1 ? 'ambiguous' : useUnavailable || (requests > 0 && !useRequest)
                  ? 'unavailable' : useRequest ? 'observed' : 'unobserved',
                request: requests === 1 && responses === 1 && !useUnavailable ? useRequest : null }) });
            const updated = { ...call, implementationInputs: inputs };
            original = Object.freeze({ ...updated, inputSha256: callHash(updated) });
            journal!.calls[original.sequence - 1] = original;
          }
        })() });
        return settle;
      } catch { /* Missing or unsupported input never changes compiler behavior. */ }
    } });
    installed.add(config);
    return true;
  } catch { return false; }
}

export function readAppliedCompilerInputs(environment: object | undefined): AppliedCompilerReceipt | undefined {
  try {
    const read = environment && Object.getOwnPropertyDescriptor(environment, RECEIPTS)?.value;
    return typeof read === 'function' ? parseAppliedCompilerReceipt(read()) : undefined;
  } catch { return undefined; }
}

/** A settled result hash is only output of this one esbuild call. The other
 * four missing inputs still prevent whole-compiler or test-proof authority. */
export function successfulAppliedCompilerOutput(receipt: unknown, sequence: number): string | undefined {
  const parsed = parseAppliedCompilerReceipt(receipt);
  const call = parsed?.calls.find(call => call.sequence === sequence);
  return !parsed?.truncated && call?.inputSha256 && call.outcome?.status === 'success'
    && call.outcome.resultSha256 ? call.outcome.resultSha256 : undefined;
}
