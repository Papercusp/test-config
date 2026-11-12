import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { hashConfigurationValue } from './configuration-snapshot.ts';
import { captureCurrentWorkerProcessIdentity, type WorkerProcessIdentity } from './runtime-proof.ts';

// Supplied only by the maintained Vite patch, after Vite resolves per-file
// options. This observer hashes descriptors; it never changes compiler inputs.
const OBSERVER = Symbol.for('@papercusp/test-config.applied-compiler-observer-v1');
const RECEIPTS = Symbol.for('@papercusp/test-config.applied-compiler-inputs-v1');
const FUNCTIONS = ['loadTsconfigJsonForFile', 'parse', 'parseExtends', 'parseFile',
  'resolveSolutionTSConfig', 'transform', 'transformWithEsbuild'];
const GAPS = ['plugin-private-inputs-unobserved', 'cached-module-test-custody-unobserved',
  'transitive-compiler-implementation-unobserved', 'tsconfig-resolution-search-unobserved',
  'compiler-outcome-unobserved'];
const MAX_CALLS = 256;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keys = (value: object, expected: string[]) => Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const file = (value: unknown): value is string => typeof value === 'string' && value.length <= 8192
  && isAbsolute(value) && !value.includes('\0');

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
  if (!call.optionsSha256 || !call.implementation || call.tsconfigStatus === 'unavailable') return null;
  return hashConfigurationValue([call.moduleId, call.codeSha256, call.optionsSha256,
    call.tsconfigStatus, call.tsconfigInputs, call.implementation], 'vite-applied-esbuild-call-v1');
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
      || !Array.isArray(value.missing) || value.missing.length !== GAPS.length
      || new Set(value.missing).size !== GAPS.length || !GAPS.every(gap => (value.missing as unknown[]).includes(gap))) return undefined;
    const processIdentity = value.compilerProcess;
    if (processIdentity !== null && (!plain(processIdentity)
      || !keys(processIdentity, ['pid', 'threadId', 'bootId', 'startTicks'])
      || !Number.isSafeInteger(processIdentity.pid) || (processIdentity.pid as number) < 1
      || !Number.isSafeInteger(processIdentity.threadId) || (processIdentity.threadId as number) < 0
      || typeof processIdentity.bootId !== 'string' || !/^[a-f0-9-]{36}$/.test(processIdentity.bootId)
      || typeof processIdentity.startTicks !== 'string' || !/^\d+$/.test(processIdentity.startTicks))) return undefined;
    for (const [index, call] of value.calls.entries()) {
      if (!plain(call) || !keys(call, ['sequence', 'moduleId', 'codeSha256', 'optionsSha256', 'tsconfigStatus',
        'tsconfigInputs', 'implementation', 'inputSha256']) || call.sequence !== index + 1 || !file(call.moduleId)
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
      if (call.inputSha256 !== callHash(call as unknown as AppliedCompilerCall)) return undefined;
    }
    return value as unknown as AppliedCompilerReceipt;
  } catch { return undefined; }
}

const installed = new WeakSet<object>();
const functionHashes = new WeakMap<Function, string>();
function implementationIdentity(value: unknown): AppliedCompilerCall['implementation'] {
  if (!plain(value) || !keys(value, ['viteVersion', 'esbuildVersion', 'functions']) || !plain(value.functions)
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
            truncated: entries.truncated, missing: Object.freeze([...GAPS]),
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
        const call = { sequence: journal.calls.length + 1, moduleId: event.moduleId, codeSha256: sha(event.code),
          optionsSha256: hashConfigurationValue(event.options, 'vite-applied-esbuild-options-v1'), tsconfigStatus: status,
          tsconfigInputs: Object.freeze([...inputs.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
          implementation: implementationIdentity(event.implementation) };
        journal.calls.push(Object.freeze({ ...call, inputSha256: callHash(call) }));
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
