/** Original config inputs for the existing executed-source diagnostic OUT channel.
 * Loaded with Node --import BEFORE Vite evaluates configs. Reporter-time disk
 * reads cannot recover these bytes. This never authorizes reusable test passes. */
import { hash as cryptoHash } from 'node:crypto';
import { Session, url as inspectorUrl } from 'node:inspector';
import { Session as PromiseSession } from 'node:inspector/promises';
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, threadId } from 'node:worker_threads';
import { pinModuleState } from '@papercusp/module-singleton';
import { observeProcessTermination } from './process-termination-observer.mjs';

interface LoadedSource { path: string; sha256: string | null }
interface Preload { kind: 'import' | 'loader' | 'require'; path: string | null; capture: boolean }
interface Capture {
  sources: Map<string, Set<string | null>>;
  imports?: Map<string, Set<string>>;
  reasons: Set<string>;
  preloads: Preload[];
}
const shared = pinModuleState<{ capture: Capture | null }>(
  '@papercusp/test-config.original-config-loads', () => ({ capture: null }));
// Terminal evidence must not dispatch through properties the application can
// replace during its epoch. Retain the observer's collection, validation and
// hash operations too. This is not a substitute for loaded-source eligibility
// or the caller's audited publication/hold suffix.
const applyIntrinsic = Reflect.apply;
const definePropertyIntrinsic = Object.defineProperty;
const oneShotHashIntrinsic = cryptoHash;
const arrayIsArrayIntrinsic = Array.isArray;
const numberIsFiniteIntrinsic = Number.isFinite;
const arraySortIntrinsic = Array.prototype.sort;
const mapForEachIntrinsic = Map.prototype.forEach;
const setForEachIntrinsic = Set.prototype.forEach;
const setAddIntrinsic = Set.prototype.add;
// Hash's constructor/copy can invoke inherited symbol setters even when its
// methods are retained. The public one-shot API avoids those JS allocations.
const hash = (bytes: string | Buffer): string => oneShotHashIntrinsic('sha256', bytes, 'hex');
const copyRows = <T extends object>(rows: T[]): T[] => {
  const result: T[] = [];
  for (let i = 0; i < rows.length; i++) appendOwn(result, { ...rows[i] });
  return result;
};
// Indexed assignment still walks an application's Array.prototype setters.
// Define a dense own property using an observer-owned, null-prototype
// descriptor; descriptor conversion must not consult inherited get/set fields.
const appendOwn = <T>(rows: T[], value: T): void => {
  const descriptor = { __proto__: null, configurable: true, enumerable: true, writable: true, value };
  definePropertyIntrinsic(rows, rows.length, descriptor);
};
const reasonRows = (reasons: Set<string>): string[] => {
  const rows: string[] = [];
  applyIntrinsic(setForEachIntrinsic, reasons, [(reason: string) => { appendOwn(rows, reason); }]);
  return applyIntrinsic(arraySortIntrinsic, rows, []);
};
const monotonicClock = performance;
const monotonicClockNow = monotonicClock.now;
const monotonicNow = (): number => applyIntrinsic(monotonicClockNow, monotonicClock, []);

export const nativeSourceRetentionLimits = Object.freeze({ sourceBytes: 16 * 1024 ** 2,
  processBytes: 64 * 1024 ** 2, pinnedSourceBytes: 128 * 1024 ** 2,
  pinnedProcessBytes: 256 * 1024 ** 2, pins: 4 });
interface SourcePin { path: string; sha256: string; byteLength: number }
export interface EngineCoverageRange { startOffset: number; endOffset: number; count: number }
export interface EngineFunctionCoverage {
  functionName: string;
  isBlockCoverage: boolean;
  ranges: EngineCoverageRange[];
}
export interface EngineCoverageTarget {
  functionName: string;
  functionRoot: { startOffset: number; endOffset: number };
  ranges: Array<{ startOffset: number; endOffset: number }>;
}
interface PreciseCoverageEnrollment { epoch: string; admission: number }
interface PreciseOwner {
  fenced: boolean;
  rejected: Array<{ method: string; monotonicMs: number }>;
}
const preciseOwnership = pinModuleState<{
  owner: PreciseOwner | null;
  installed: boolean;
  failed: boolean;
  rawPost: typeof Session.prototype.post | null;
}>('@papercusp/test-config.precise-coverage-owner', () => ({
  owner: null, installed: false, failed: false, rawPost: null,
}));

/** Exclude mutations through public Inspector and native profiler helpers. This is only
 * one part of exclusivity: native/internal/pre-captured access still requires
 * the independent loaded-source audit. No claim about those paths is made. */
function installPreciseCoverageOwnership(): void {
  if (preciseOwnership.failed) throw new Error('precise ownership installation previously failed');
  if (preciseOwnership.installed) return;
  const inspector = nodeModule.createRequire(import.meta.url)('node:inspector') as typeof import('node:inspector');
  const require = nodeModule.createRequire(import.meta.url);
  const nativeV8 = require('node:v8') as typeof import('node:v8');
  const nativeConsole = require('node:console') as typeof import('node:console');
  const reject = (method: string): never => {
    preciseOwnership.owner?.rejected.push({ method, monotonicMs: monotonicNow() });
    throw new Error(`Inspector operation rejected by exclusive precise coverage epoch: ${method}`);
  };
  // Validate the whole write set before hardening any property. These guards
  // remain delegating when no qualification epoch owns the isolate.
  const targets = [
    [Session.prototype, 'post', 'post'], [PromiseSession.prototype, 'post', 'post'],
    [Session.prototype, 'connectToMainThread', 'connectToMainThread'], [inspector, 'open', 'open'],
    [nativeV8, 'takeCoverage', 'v8.takeCoverage'], [nativeV8, 'stopCoverage', 'v8.stopCoverage'],
    [nativeConsole, 'profile', 'console.profile'], [nativeConsole, 'profileEnd', 'console.profileEnd'],
  ] as const;
  for (const [target, name] of targets) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (!descriptor?.configurable || typeof descriptor.value !== 'function')
      throw new Error(`unavailable Inspector ownership boundary: ${name}`);
  }
  preciseOwnership.rawPost = Session.prototype.post;
  try {
    for (const [target, name, operation] of targets) {
      const original = Object.getOwnPropertyDescriptor(target, name)!.value;
      Object.defineProperty(target, name, { configurable: false, writable: false,
        value: function(this: unknown, ...args: unknown[]) {
          const owner = preciseOwnership.owner;
          const method = typeof args[0] === 'string' ? args[0] : '<invalid-method>';
          // NodeWorker wraps a second protocol command in a JSON message.
          // Its outer method need not name Profiler at all; a foreign parent
          // session can otherwise mutate a worker's coverage through the relay.
          if (owner && (name !== 'post' || owner.fenced || method.startsWith('NodeWorker.') ||
              method.startsWith('Profiler.') && method !== 'Profiler.getBestEffortCoverage'))
            return reject(name === 'post' ? method : operation);
          return applyIntrinsic(original, this, args);
        } });
    }
    nodeModule.syncBuiltinESMExports();
    preciseOwnership.installed = true;
  } catch (error) { preciseOwnership.failed = true; throw error; }
}

/** Arithmetic for ONE already-bound precise response, never runtime admission.
 * `zero` describes this response only. Its caller still owes pre-compilation
 * arming, exclusive epoch ownership, the held execution fence, source/epoch/
 * isolate binding and the complete independently audited target population.
 * In particular this helper MUST NOT turn best-effort zero into non-entry. */
export function classifyEngineCoverageTargets(observation: {
  sourceTextSha256: string | null;
  sourceTextLength: number | null;
  functions: EngineFunctionCoverage[];
}, expected: { sourceTextSha256: string; sourceTextLength: number; targets: EngineCoverageTarget[] }) {
  const reasons = new Set<string>();
  const spanKey = (range: { startOffset: number; endOffset: number }) =>
    `${range.startOffset}:${range.endOffset}`;
  const validSpan = (range: { startOffset: number; endOffset: number }) => range &&
    Number.isSafeInteger(range.startOffset) && Number.isSafeInteger(range.endOffset) &&
    range.startOffset >= 0 && range.endOffset > range.startOffset &&
    range.endOffset <= expected.sourceTextLength;
  const within = (inner: { startOffset: number; endOffset: number },
    outer: { startOffset: number; endOffset: number }) =>
    inner.startOffset >= outer.startOffset && inner.endOffset <= outer.endOffset;
  const crosses = (a: { startOffset: number; endOffset: number },
    b: { startOffset: number; endOffset: number }) =>
    a.startOffset < b.startOffset && b.startOffset < a.endOffset && a.endOffset < b.endOffset ||
    b.startOffset < a.startOffset && a.startOffset < b.endOffset && b.endOffset < a.endOffset;
  const result = (state: 'entry' | 'zero' | 'unknown', observedEntry = false) => ({
    scope: 'one-source-bound-coverage-response' as const, state, observedEntry,
    reasons: [...reasons].sort(),
    // No caller can mistake correct interval arithmetic for method acceptance.
    runtimeQualification: 'unknown' as const,
  });
  if (!expected || !observation || !/^[a-f0-9]{64}$/.test(expected.sourceTextSha256) ||
      !Number.isSafeInteger(expected.sourceTextLength) || expected.sourceTextLength < 1 ||
      observation.sourceTextSha256 !== expected.sourceTextSha256 ||
      observation.sourceTextLength !== expected.sourceTextLength) {
    reasons.add('source-identity-mismatch'); return result('unknown');
  }
  if (!Array.isArray(observation.functions) || !Array.isArray(expected.targets) ||
      expected.targets.length === 0) {
    reasons.add('missing-function-or-target-population'); return result('unknown');
  }
  const roots = new Set<string>();
  for (const fn of observation.functions) {
    if (!fn || typeof fn.functionName !== 'string' || typeof fn.isBlockCoverage !== 'boolean' ||
        !Array.isArray(fn.ranges) || fn.ranges.length === 0) {
      reasons.add('malformed-function-tree'); continue;
    }
    const root = fn.ranges[0], seen = new Set<string>(), ancestors: EngineCoverageRange[] = [];
    if (!validSpan(root)) { reasons.add('malformed-function-root'); continue; }
    if (roots.has(spanKey(root))) reasons.add('ambiguous-function-root');
    if (!fn.isBlockCoverage && fn.ranges.length !== 1) reasons.add('malformed-function-tree');
    roots.add(spanKey(root));
    let previousStart = -1;
    for (const range of fn.ranges) {
      if (!validSpan(range) || !Number.isSafeInteger(range.count) || range.count < 0 ||
          !within(range, root) || seen.has(spanKey(range)) || range.startOffset < previousStart) {
        reasons.add('malformed-function-tree'); continue;
      }
      while (ancestors.length && range.startOffset >= ancestors[ancestors.length - 1].endOffset)
        ancestors.pop();
      if (ancestors.length && !within(range, ancestors[ancestors.length - 1]))
        reasons.add('crossing-block-ranges');
      ancestors.push(range); seen.add(spanKey(range)); previousStart = range.startOffset;
    }
  }
  // Function roots are independently nested too. An outer function's positive
  // count does not imply entry to a nested function, but a crossing root cannot
  // be a calibrated tree. Keep this linear after sorting, not an all-pairs scan.
  const functionRoots = observation.functions.filter(fn => Array.isArray(fn?.ranges) && fn.ranges.length)
    .map(fn => fn.ranges[0]).filter(validSpan)
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const ancestors: EngineCoverageRange[] = [];
  for (const root of functionRoots) {
    while (ancestors.length && root.startOffset >= ancestors[ancestors.length - 1].endOffset)
      ancestors.pop();
    if (ancestors.length && crosses(root, ancestors[ancestors.length - 1]))
      reasons.add('crossing-function-roots');
    ancestors.push(root);
  }
  if (reasons.size) return result('unknown');
  let observedEntry = false;
  const targetIds = new Set<string>();
  for (const target of expected.targets) {
    if (!target || typeof target.functionName !== 'string' || !validSpan(target.functionRoot) ||
        !Array.isArray(target.ranges) || target.ranges.length === 0) {
      reasons.add('malformed-target-population'); continue;
    }
    const targetId = `${target.functionName}:${spanKey(target.functionRoot)}`;
    if (targetIds.has(targetId)) reasons.add('duplicate-target-function');
    targetIds.add(targetId);
    const matches = observation.functions.filter(fn => fn.functionName === target.functionName &&
      spanKey(fn.ranges[0]) === spanKey(target.functionRoot));
    if (matches.length !== 1) { reasons.add('missing-or-ambiguous-target-function'); continue; }
    const fn = matches[0], seen = new Set<string>();
    for (const targetRange of target.ranges) {
      if (!validSpan(targetRange) || !within(targetRange, target.functionRoot) || seen.has(spanKey(targetRange))) {
        reasons.add('malformed-target-population'); continue;
      }
      seen.add(spanKey(targetRange));
      // Equality is deliberate: neither containment nor a spanning zero counts.
      const exact = fn.ranges.find(range => spanKey(range) === spanKey(targetRange));
      if (!exact) { reasons.add('missing-exact-target-range'); continue; }
      if (exact.count > 0 || observation.functions.some(row => row.ranges.some(range =>
        within(range, targetRange) && range.count > 0))) observedEntry = true;
    }
  }
  return result(reasons.size ? 'unknown' : observedEntry ? 'entry' : 'zero', observedEntry);
}

export function validateSourcePins(pins: unknown): SourcePin[] {
  if (!Array.isArray(pins) || pins.length > nativeSourceRetentionLimits.pins ||
      new Set(pins.map(pin => pin?.path)).size !== pins.length || pins.some(pin =>
        typeof pin?.path !== 'string' || !isAbsolute(pin.path) || pin.path.length > 1024 ||
        !/^[a-f0-9]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.byteLength) ||
        pin.byteLength < 0 || pin.byteLength > nativeSourceRetentionLimits.pinnedSourceBytes) ||
      pins.reduce((total, pin) => total + pin.byteLength, 0) > nativeSourceRetentionLimits.pinnedProcessBytes)
    throw new Error('Invalid bounded native loader source pins');
  return pins.map(pin => ({ ...pin }));
}

/** Engine source text and execution ranges share a V8 script id. Neither a
 * scriptParsed event nor getScriptSource alone establishes execution. Best
 * effort coverage supplies positive observations only: GC can erase counters,
 * so an absent/zero count stays unknown. The cooperative opt-in uses one precise
 * interval and retains its unqualified raw response separately. Neither path
 * authorizes reusable passes or full runtime admission. */
export function observeEngineScriptExecution(repoRoot: string,
  options: { pinnedSources?: SourcePin[]; repositorySources?: boolean;
    preciseCoverage?: PreciseCoverageEnrollment } = {}) {
  const pins = validateSourcePins(options.pinnedSources ?? []);
  const pinnedOnly = options.repositorySources === false;
  const precise = options.preciseCoverage;
  if (precise && (Object.keys(precise).sort().join() !== 'admission,epoch' ||
      typeof precise.epoch !== 'string' || !/^[a-f0-9-]{36}$/.test(precise.epoch) ||
      !Number.isSafeInteger(precise.admission) || precise.admission < 0 || precise.admission >= 256 ||
      !pinnedOnly || pins.length === 0)) throw new Error('Invalid precise coverage enrollment');
  const session = new Session();
  const reasons = new Set<string>();
  // The terminal path uses the captured Set method, including its error path.
  const addReason = (reason: string): void => { applyIntrinsic(setAddIntrinsic, reasons, [reason]); };
  type Script = { scriptId: string; url: string; path: string;
    sourceTextSha256: string | null; sourceTextLength: number | null;
    independentPin?: SourcePin; compiledBeforePreciseArm?: boolean };
  const scripts = new Map<string, Script>();
  let pinnedBytes = 0;
  let connected = false;
  let precisePhase: 'unarmed' | 'armed' | 'taken' | 'invalid' = 'unarmed';
  let owner: PreciseOwner | null = null;
  const commands: Array<{ method: string; startedMs: number; endedMs: number | null;
    status: 'pending' | 'complete' | 'failed' }> = [];
  const post = <T>(method: string, params: Record<string, unknown> = {}): T => {
    let done = false;
    let result: unknown;
    let failure: Error | null = null;
    const command = { method, startedMs: monotonicNow(), endedMs: null as number | null,
      status: 'pending' as 'pending' | 'complete' | 'failed' };
    if (precise) appendOwn(commands, command);
    const transport = owner && preciseOwnership.owner === owner ? preciseOwnership.rawPost! : session.post;
    try {
      applyIntrinsic(transport, session, [method, params, (error: Error | null, response: unknown) => {
        done = true; failure = error; result = response;
      }]);
    } catch (error) { command.status = 'failed'; command.endedMs = monotonicNow(); throw error; }
    // Exit/signal observers must finish synchronously. Never attest a pending
    // protocol request; its eventual callback cannot repair an emitted receipt.
    command.endedMs = monotonicNow();
    command.status = !done ? 'pending' : failure ? 'failed' : 'complete';
    if (!done) throw new Error(`pending inspector request: ${method}`);
    if (failure) throw failure;
    return result as T;
  };
  session.on('Debugger.scriptParsed', ({ params }) => {
    try {
      const absolute = params.url.startsWith('file:') ? fileURLToPath(params.url) : params.url;
      if (!isAbsolute(absolute)) return;
      const pin = pins.find(pin => pathToFileURL(pin.path).href === params.url);
      if (pin && precise && precisePhase !== 'armed')
        reasons.add(precisePhase === 'taken' ? 'engine-target-after-terminal-take' : 'engine-target-before-precise-arm');
      const rel = relative(repoRoot, absolute).split(/[\\/]/).join('/');
      if (!pin && (pinnedOnly || !rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') ||
          rel.split('/').includes('node_modules'))) return;
      const path = pin ? pin.path : rel;
      if (pinnedOnly && !scripts.has(params.scriptId) && scripts.size >= nativeSourceRetentionLimits.pins) {
        reasons.add('engine-script-population-limit'); return;
      }
      const scriptLength = params.length;
      if (pin && (typeof scriptLength !== 'number' || !Number.isSafeInteger(scriptLength) ||
          scriptLength > pin.byteLength ||
          pin.byteLength > nativeSourceRetentionLimits.pinnedProcessBytes - pinnedBytes)) {
        reasons.add('engine-pinned-source-limit'); return;
      }
      const { scriptSource } = post<{ scriptSource: string }>('Debugger.getScriptSource', { scriptId: params.scriptId });
      if (typeof scriptSource !== 'string') throw new Error('engine source text unavailable');
      if (pin) pinnedBytes += pin.byteLength; // Failed matches consume the budget too.
      const sourceTextSha256 = hash(scriptSource);
      const pinMatches = !pin || scriptSource.length <= pin.byteLength &&
        Buffer.byteLength(scriptSource) === pin.byteLength && sourceTextSha256 === pin.sha256;
      if (!pinMatches) reasons.add('engine-pinned-source-mismatch');
      const prior = scripts.get(params.scriptId);
      const changed = params.isLiveEdit || (prior && prior.sourceTextSha256 !== sourceTextSha256);
      if (changed) reasons.add('engine-script-source-changed');
      scripts.set(params.scriptId, { scriptId: params.scriptId, url: params.url, path,
        sourceTextSha256: changed || !pinMatches ? null : sourceTextSha256,
        sourceTextLength: changed || !pinMatches ? null : scriptSource.length,
        ...(pin ? { independentPin: { ...pin } } : {}),
        ...(precise ? { compiledBeforePreciseArm: precisePhase !== 'armed' } : {}) });
    } catch { reasons.add('engine-script-source-unavailable'); }
  });
  try {
    if (precise) {
      // Node arms this native collector before any JS preload. Its session and
      // retained original functions are outside the public Session guard.
      if (process.env.NODE_V8_COVERAGE) {
        reasons.add('engine-native-automatic-coverage');
        throw new Error('native automatic coverage collector is already armed');
      }
      if (inspectorUrl() !== undefined) {
        reasons.add('engine-external-inspector-endpoint');
        throw new Error('external Inspector endpoint is open');
      }
      if (preciseOwnership.owner) throw new Error('precise coverage epoch already owned');
    }
    session.connect(); connected = true;
    post('Debugger.enable'); post('Profiler.enable');
    if (precise) {
      installPreciseCoverageOwnership();
      owner = { fenced: false, rejected: [] }; preciseOwnership.owner = owner;
      post('Profiler.startPreciseCoverage', { callCount: true, detailed: true, allowTriggeredUpdates: false });
      precisePhase = 'armed';
    }
  } catch { reasons.add('engine-inspector-unavailable'); if (precise) precisePhase = 'invalid'; }
  const preciseStatus = () => ({ epoch: precise?.epoch ?? null, admission: precise?.admission ?? null,
    phase: precisePhase, ownership: { scope: 'public-js-inspector-and-native-profiler-transports',
      enforced: owner !== null && preciseOwnership.owner === owner && preciseOwnership.installed,
      rejected: owner ? copyRows(owner.rejected) : [],
      internalNativeAndPrecapturedAccess: 'unmeasured' },
    fence: owner?.fenced ? 'terminal-entered-suffix-unverified' : 'not-entered',
    commands: copyRows(commands), reasons: reasonRows(reasons),
    runtimeQualification: 'unknown' as const });
  return {
    preciseStatus,
    /** The returned raw response is preparation, not a non-entry receipt. Its
     * caller must durably publish it before END, retain the audited synchronous
     * suffix/hold through parent K, and bind complete source/epoch ownership.
     * There is deliberately no caller-supplied `exclusive:true` shortcut. */
    terminalPreciseSnapshot() {
      if (!precise || !owner || preciseOwnership.owner !== owner || precisePhase !== 'armed') {
        addReason('engine-precise-terminal-out-of-order'); precisePhase = 'invalid'; return null;
      }
      owner.fenced = true;
      try {
        if (inspectorUrl() !== undefined) {
          addReason('engine-external-inspector-endpoint');
          throw new Error('external Inspector endpoint opened during the epoch');
        }
        const raw = post<{ result: Array<{ scriptId: string; url: string;
          functions: EngineFunctionCoverage[] }>; timestamp: number }>('Profiler.takePreciseCoverage');
        precisePhase = 'taken';
        if (!arrayIsArrayIntrinsic(raw.result) || !numberIsFiniteIntrinsic(raw.timestamp)) throw new Error('partial precise response');
        const observed: Array<Script & { functions: EngineFunctionCoverage[] }> = [];
        applyIntrinsic(mapForEachIntrinsic, scripts, [(script: Script) => {
          const matches: typeof raw.result = [];
          for (let i = 0; i < raw.result.length; i++) {
            const row = raw.result[i];
            if (row.scriptId === script.scriptId && row.url === script.url) appendOwn(matches, row);
          }
          const source = post<{ scriptSource: string }>('Debugger.getScriptSource', { scriptId: script.scriptId });
          const sourceMatches = typeof source.scriptSource === 'string' && script.sourceTextSha256 !== null &&
            hash(source.scriptSource) === script.sourceTextSha256;
          if (!sourceMatches) addReason('engine-script-source-changed');
          if (matches.length !== 1 || !arrayIsArrayIntrinsic(matches[0].functions))
            addReason('engine-precise-script-response-incomplete');
          appendOwn(observed, { ...script, sourceTextSha256: sourceMatches ? script.sourceTextSha256 : null,
            functions: matches.length === 1 && arrayIsArrayIntrinsic(matches[0].functions) ? matches[0].functions : [] });
        }]);
        return { schemaVersion: 'node-engine-precise-terminal-v1', ...preciseStatus(),
          basis: 'one-start-one-terminal-precise-response', offsetUnits: 'utf16-code-units',
          raw, scripts: observed };
      } catch {
        precisePhase = 'invalid'; addReason('engine-precise-terminal-response-unavailable'); return null;
      }
    },
    snapshot() {
      type Coverage = { scriptId: string; url: string; functions: Array<{ functionName: string;
        ranges: Array<{ startOffset: number; endOffset: number; count: number }> }> };
      let coverage: Coverage[] = [];
      try { coverage = post<{ result: Coverage[] }>('Profiler.getBestEffortCoverage').result; }
      catch { reasons.add('engine-execution-coverage-unavailable'); }
      const byId = new Map(coverage.map(row => [row.scriptId, row]));
      const observedScripts = [...scripts.values()].map(script => {
        const row = byId.get(script.scriptId);
        let sourceMatches = false;
        try {
          const { scriptSource } = post<{ scriptSource: string }>('Debugger.getScriptSource', { scriptId: script.scriptId });
          sourceMatches = typeof scriptSource === 'string' && script.sourceTextSha256 !== null &&
            hash(scriptSource) === script.sourceTextSha256;
          if (!sourceMatches) reasons.add('engine-script-source-changed');
        } catch { reasons.add('engine-script-source-unavailable'); }
        const retained: Array<{ functionName: string; startOffset: number; endOffset: number; count: number }> = [];
        let coverageRangesComplete = true;
        if (sourceMatches && row?.url === script.url) for (const fn of row.functions) for (const range of fn.ranges) {
          if (!Number.isSafeInteger(range.count) || range.count < 0 ||
              !Number.isSafeInteger(range.startOffset) || !Number.isSafeInteger(range.endOffset) ||
              range.startOffset < 0 || range.endOffset <= range.startOffset ||
              range.endOffset > script.sourceTextLength!) { coverageRangesComplete = false; continue; }
          // V8 already returned this complete population. Keep its late/nested
          // ranges too; the native OUT writer retains oversized observations
          // by digest instead of discarding the suffix of a pinned bundle.
          retained.push({ functionName: fn.functionName, ...range });
        }
        if (!coverageRangesComplete) reasons.add('engine-execution-ranges-invalid');
        return { ...script, sourceTextSha256: sourceMatches ? script.sourceTextSha256 : null,
          execution: retained.some(range => range.count > 0) ? 'observed' as const : 'unknown' as const,
          // Offsets address engine UTF-16 source text. A positive outer range
          // does not establish execution of a nested function or every byte.
          coverageRanges: retained, coverageRangesComplete };
      });
      return { schemaVersion: 'node-engine-script-observations-v1', basis: 'v8-script-id-source-and-best-effort-coverage',
        scope: pinnedOnly ? 'observed-independently-pinned-engine-scripts' : 'observed-repository-engine-scripts',
        sourceEncoding: 'utf8-of-engine-source-text',
        offsetUnits: 'utf16-code-units', populationStatus: 'unknown', scripts: observedScripts,
        reasons: [...reasons].sort(), unresolved: ['engine-bootstrap-observation-window-unmeasured',
          'engine-script-population-unmeasured', 'engine-best-effort-coverage-may-lose-gc-data',
          'engine-url-original-source-association-unmeasured', 'node-external-native-runtime-unmeasured',
          'node-process-descendant-population-unmeasured', 'node-loader-chain-not-closed'] };
    },
    disconnect() {
      if (precise) { precisePhase = 'invalid'; reasons.add('engine-precise-disconnected'); }
      if (owner && preciseOwnership.owner === owner) preciseOwnership.owner = null;
      if (connected) { session.disconnect(); connected = false; }
    },
  };
}

/** Read the originals EMBEDDED IN THE ACTUALLY LOADED Vite ESM config bundle.
 * Vite prepends three file-scope constants to its esbuild inputs. Remove only
 * that exact, path-derived prefix; unknown compiler forms remain unknown. */
export function configBundleSources(code: string): LoadedSource[] | null {
  try {
    const encoded = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/.exec(code)?.[1];
    if (!encoded) return null;
    const map = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (typeof map.sourceRoot !== 'string' || !map.sourceRoot.startsWith('file:') ||
        !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent) ||
        map.sources.length !== map.sourcesContent.length || map.sources.length === 0) return null;
    return map.sources.map((source: unknown, index: number): LoadedSource => {
      if (typeof source !== 'string') throw new Error('unknown source');
      const path = fileURLToPath(new URL(source, map.sourceRoot));
      const content = map.sourcesContent[index];
      if (typeof content !== 'string') return { path, sha256: null };
      // JSON inputs do not pass through Vite's file-scope injection plugin.
      if (path.endsWith('.json')) return { path, sha256: hash(content) };
      const prefix = `const __vite_injected_original_dirname = ${JSON.stringify(dirname(path))};` +
        `const __vite_injected_original_filename = ${JSON.stringify(path)};` +
        `const __vite_injected_original_import_meta_url = ${JSON.stringify(pathToFileURL(path).href)};`;
      const at = content.startsWith('#!') ? content.indexOf('\n') + 1 : 0;
      if (!content.slice(at).startsWith(prefix)) return { path, sha256: null };
      const original = content.slice(0, at) + content.slice(at + prefix.length);
      // import.meta.resolve adds another injected constant whose body is
      // version-dependent. Do not claim original bytes for that unknown form.
      return { path, sha256: original.startsWith('const __vite_injected_original_import_meta_resolve') ||
        original.slice(at).startsWith('const __vite_injected_original_import_meta_resolve') ? null : hash(original) };
    });
  } catch { return null; }
}

function install(): void {
  if (shared.capture || process.env.PC_EXECUTED_SOURCE_MAP_PRELOAD !== '1' ||
      !process.env.PC_EXECUTED_SOURCE_MAP_OUT || !process.env.PC_EXECUTED_SOURCE_MAP_WORKSPACE) return;
  const imports = new Map<string, Set<string>>();
  const state: Capture = { sources: new Map(), imports, reasons: new Set(), preloads: [] };
  shared.capture = state;
  // A later preload can wrap this hook and replace the bytes it observed.
  // Without a receipt for that layer, the intermediate bytes are not original
  // execution authority. Recognize only this preload, including symlink paths.
  const preloads: Array<{ kind: Preload['kind']; specifier: string }> = [];
  const args = process.execArgv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--eval' || args[i] === '-e') { i++; continue; }
    const flag = /^(--import|--(?:experimental-)?loader|--require|-r)(?:=(.*))?$/.exec(args[i]);
    if (flag) preloads.push({ kind: flag[1] === '--import' ? 'import' :
      flag[1] === '--require' || flag[1] === '-r' ? 'require' : 'loader',
      specifier: flag[2] ?? args[++i] ?? '' });
  }
  const options = process.env.NODE_OPTIONS ?? '';
  const preloadFlags = [...options.matchAll(/(?:^|\s)(--import|--(?:experimental-)?loader|--require|-r)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)];
  for (const match of preloadFlags) preloads.push({ kind: match[1] === '--import' ? 'import' :
    match[1] === '--require' || match[1] === '-r' ? 'require' : 'loader',
    specifier: match[2] ?? match[3] ?? match[4] });
  if ((options.match(/(?:^|\s)(?:--import|--(?:experimental-)?loader|--require|-r)(?==|\s|$)/g)?.length ?? 0) !== preloadFlags.length)
    state.reasons.add('node-loader-chain-unmeasured');
  for (const preload of preloads) {
    let path: string | null = null;
    let capture = false;
    try {
      path = preload.specifier.startsWith('file:') ? fileURLToPath(preload.specifier) : resolve(preload.specifier);
      capture = preload.kind === 'import' && realpathSync(path) === realpathSync(fileURLToPath(import.meta.url));
    } catch { state.reasons.add('node-loader-chain-unmeasured'); }
    state.preloads.push({ kind: preload.kind, path, capture });
    if (!capture) state.reasons.add('node-loader-chain-unmeasured');
  }
  // npm, command routers and their descendants do not instantiate the Vitest
  // reporter. Retain each process's observed inputs beside that same OUT file.
  // Vitest stops forks with SIGTERM, which does not emit Node's exit event.
  // Signal receipts are explicit diagnostics, never evidence of exit code 0.
  // A missing receipt (including SIGKILL) remains unknown.
  const repoRoot = process.env.PC_EXECUTED_SOURCE_MAP_ROOT;
  const outPath = process.env.PC_EXECUTED_SOURCE_MAP_OUT;
  const engine = repoRoot && isAbsolute(repoRoot) ? observeEngineScriptExecution(repoRoot) : null;
  // argv and cwd are mutable application state. Capture the original entry
  // before the command body can rewrite them, rather than trusting them at exit.
  const entry = process.argv[1] ? resolve(process.argv[1]) : null;
  const rel = repoRoot && entry ? relative(repoRoot, entry).split(/[\\/]/).join('/') : null;
  const entrypoint = isMainThread && rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') &&
    !rel.split('/').includes('node_modules') ? rel : null;
  if (repoRoot && isAbsolute(repoRoot)) observeProcessTermination(termination => {
    try {
      const directory = `${outPath}.processes`;
      mkdirSync(directory, { recursive: true });
      const receiptPath = join(directory, `${process.pid}-${threadId}.json`);
      const receipt = {
        schemaVersion: 'node-loaded-process-sources-v1', scope: 'repository-node-process-sources',
        entrypoint, pid: process.pid, parentPid: process.ppid, isMainThread, threadId, ...termination,
        // These are observed inputs, never a census of every descendant or a
        // complete runtime identity. The preload itself predates its own hook.
        unresolved: ['node-process-descendant-population-unmeasured', 'node-preload-self-unmeasured',
          'node-external-native-runtime-unmeasured', 'node-loader-chain-not-closed'],
      };
      // Vitest can SIGKILL the fork while disk reads or inspector work are in
      // progress. Retain the signal observation first, with explicit unknown
      // evidence. It does not attest the parent's eventual termination outcome.
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, basis: 'node-load-hook', status: 'unknown',
        sources: [], observedSources: [], engineScripts: null,
        reasons: ['process-source-snapshot-incomplete', 'process-engine-snapshot-incomplete'],
        loaderChain: { scope: 'declared-node-preloads', status: 'unknown',
          preloads: state.preloads.map(preload => ({ ...preload, observedSha256: null })),
          unresolved: ['node-loader-chain-not-closed', 'node-preload-self-unmeasured'] },
      }));
      const evidence = qualifyLoadedSources([...state.sources.keys()], repoRoot, 'process');
      if (!isMainThread) evidence.reasons.push('process-worker-thread-entrypoint-unmeasured');
      if (!entrypoint || !evidence.sources.some(source => source.path === entrypoint && source.sha256 !== null)) {
        evidence.reasons.push('process-entrypoint-original-load-unavailable');
        if (evidence.status === 'stable') evidence.status = 'unknown';
      }
      // An interrupted enrichment must not truncate the retained observation.
      writeFileSync(`${receiptPath}.pending`, JSON.stringify({ ...receipt, ...evidence,
        engineScripts: engine?.snapshot() ?? null,
      }));
      renameSync(`${receiptPath}.pending`, receiptPath);
    } catch { /* The consumer records absent/malformed receipts as unknown. */ }
  });
  if (typeof nodeModule.registerHooks !== 'function') {
    state.reasons.add('config-node-load-hook-unavailable');
    return;
  }
  const record = ({ path, sha256 }: LoadedSource): void => {
    const seen = state.sources.get(path) ?? new Set<string | null>();
    // Retain the bytes at this hook's boundary even when another hook can
    // replace them later. Qualification below keeps those diagnostics separate
    // from original-source authority; a preload list never closes a chain.
    seen.add(sha256);
    state.sources.set(path, seen);
  };
  nodeModule.registerHooks({ resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    try {
      if (context.parentURL?.startsWith('file:') && resolved.url.startsWith('file:')) {
        const parent = fileURLToPath(context.parentURL);
        const child = fileURLToPath(resolved.url);
        const children = imports.get(parent) ?? new Set<string>();
        children.add(child);
        imports.set(parent, children);
      }
    } catch { state.reasons.add('config-node-resolve-capture-failed'); }
    return resolved;
  }, load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    try {
      if (!url.startsWith('file:')) return loaded;
      const path = fileURLToPath(url);
      if (loaded.source == null) {
        if (!path.split(/[\\/]/).includes('node_modules')) record({ path, sha256: null });
        return loaded;
      }
      const bytes = typeof loaded.source === 'string' ? Buffer.from(loaded.source) :
        loaded.source instanceof ArrayBuffer ? Buffer.from(loaded.source) :
          Buffer.from(loaded.source.buffer, loaded.source.byteOffset, loaded.source.byteLength);
      const code = bytes.toString('utf8');
      if (/\.timestamp-\d+-[a-f0-9]+\.mjs$/.test(path)) {
        const originals = configBundleSources(code);
        if (!originals) state.reasons.add('config-bundle-originals-unavailable');
        else originals.forEach(record);
      } else if (!path.split(/[\\/]/).includes('node_modules') &&
          (loaded.format === 'module' || loaded.format === 'module-typescript' || loaded.format === 'json')) {
        record({ path, sha256: hash(bytes) });
      } else if (!path.split(/[\\/]/).includes('node_modules')) {
        record({ path, sha256: null });
      }
      // CommonJS compile overrides and Vite's runner loader are not witnessed
      // by this ESM seam. Their missing sources remain explicit below.
    } catch { state.reasons.add('config-node-load-capture-failed'); }
    return loaded; // observation only: Node receives the exact unchanged result
  } });
}
install();

export interface LoadedConfigSources {
  schemaVersion: 'node-loaded-config-sources-v1';
  scope: 'repository-vite-config-dependencies';
  basis: 'node-load-hook';
  status: 'stable' | 'changed' | 'unknown';
  sources: Array<{ path: string; sha256: string | null; currentSha256: string | null }>;
  /** Diagnostic bytes at this hook's boundary, including embedded config
   * originals. Never proof of the final bytes returned by later loaders. */
  observedSources: Array<{ path: string; observedSha256: string | null }>;
  /** Positive native-loader observations only; never an import census. */
  importPopulation?: {
    basis: 'node-resolve-and-load-observations';
    status: 'unknown';
    entrypoints: string[];
    paths: string[];
    unresolved: string[];
  };
  reasons: string[];
  loaderChain: {
    scope: 'declared-node-preloads';
    status: 'unknown';
    preloads: Array<Preload & { observedSha256: string | null }>;
    unresolved: string[];
  };
}

/** The repository files observed by this main process, beyond bundled config
 * inputs. This does not establish external/native code or child-process closure. */
export interface LoadedMainProcessSources extends Omit<LoadedConfigSources, 'schemaVersion' | 'scope'> {
  schemaVersion: 'node-loaded-main-process-sources-v1';
  scope: 'repository-node-main-process-sources';
}

function qualifyLoadedSources(paths: string[] | null, repoRoot: string, prefix: 'config' | 'main-process' | 'process'):
  Omit<LoadedConfigSources, 'schemaVersion' | 'scope'> {
  const state = shared.capture;
  const reasons = new Set(state?.reasons ?? [`${prefix}-node-load-capture-unavailable`]);
  let changed = false;
  if (!paths?.length) reasons.add(`${prefix}-dependencies-unavailable`);
  const sources: LoadedConfigSources['sources'] = [];
  const observedSources: LoadedConfigSources['observedSources'] = [];
  for (const absolute of paths ?? []) {
    const path = relative(repoRoot, absolute).split(/[\\/]/).join('/');
    if (!isAbsolute(absolute) || !path || path === '..' || path.startsWith('../') || isAbsolute(path) ||
        path.split('/').includes('node_modules')) {
      reasons.add(`${prefix}-loaded-source-outside-repository:${absolute}`);
      continue;
    }
    const hashes = state?.sources.get(absolute);
    const observedSha256 = hashes?.size === 1 ? [...hashes][0]! : null;
    const sha256 = state?.reasons.has('node-loader-chain-unmeasured') ? null : observedSha256;
    if (sha256 === null) reasons.add(`${prefix}-original-load-unavailable:${path}`);
    let currentSha256: string | null = null;
    try { currentSha256 = hash(readFileSync(resolve(repoRoot, path))); }
    catch { reasons.add(`${prefix}-loaded-source-unreadable:${path}`); }
    if (sha256 !== null && currentSha256 !== null && sha256 !== currentSha256) {
      changed = true;
      reasons.add(`${prefix}-loaded-source-changed:${path}`);
    }
    sources.push({ path, sha256, currentSha256 });
    observedSources.push({ path, observedSha256 });
  }
  if (sources.length === 0) reasons.add(`${prefix}-loaded-sources-unavailable`);
  return { basis: 'node-load-hook', status: changed ? 'changed' : reasons.size ? 'unknown' : 'stable',
    sources: sources.sort((a, b) => a.path.localeCompare(b.path)), reasons: [...reasons].sort(),
    observedSources: observedSources.sort((a, b) => a.path.localeCompare(b.path)),
    loaderChain: { scope: 'declared-node-preloads', status: 'unknown',
      preloads: (state?.preloads ?? []).map(preload => {
        const hashes = preload.path ? state?.sources.get(preload.path) : undefined;
        return { ...preload, observedSha256: hashes?.size === 1 ? [...hashes][0]! : null };
      }),
      unresolved: ['node-loader-chain-not-closed', 'node-preload-self-unmeasured'] },
  };
}

/** Vite's native config loader reports dependencies: []. Follow only actual
 * resolve edges from its resolved entry, and retain only inputs our load hook
 * observed. Unexecuted imports, earlier cache entries and external code remain
 * unknown. This does not change the reusable-pass dependency population. */
function observedConfigImports(entries: string[], repoRoot: string) {
  const localPath = (absolute: string): string | null => {
    const path = relative(repoRoot, absolute).split(/[\\/]/).join('/');
    return isAbsolute(absolute) && path && path !== '..' && !path.startsWith('../') &&
      !isAbsolute(path) && !path.split('/').includes('node_modules') ? path : null;
  };
  const unresolved = new Set(['config-import-population-unmeasured', 'node-loader-chain-not-closed',
    'node-preload-self-unmeasured', 'node-external-native-runtime-unmeasured']);
  // A committed preload and a working-tree reporter can share this singleton.
  // Older state has source observations but no resolve observations; retain
  // that explicit gap rather than losing the entire diagnostic OUT file.
  if (!shared.capture?.imports) unresolved.add('config-import-resolve-capture-unavailable');
  const canonical = entries.map(entry => {
    try { return realpathSync(entry); } catch { return entry; }
  });
  const pending = [...canonical];
  const visited = new Set<string>();
  const paths: string[] = [];
  while (pending.length) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    if (!localPath(path)) { unresolved.add('config-import-outside-repository'); continue; }
    if (shared.capture?.sources.has(path)) paths.push(path);
    else unresolved.add(`config-import-original-load-unavailable:${localPath(path)}`);
    for (const child of shared.capture?.imports?.get(path) ?? []) pending.push(child);
  }
  paths.sort();
  return { paths, observation: {
    basis: 'node-resolve-and-load-observations' as const, status: 'unknown' as const,
    entrypoints: [...new Set(canonical.map(localPath).filter((path): path is string => path !== null))].sort(),
    paths: paths.map(path => localPath(path)!), unresolved: [...unresolved].sort(),
  } };
}

export function qualifyLoadedConfigSources(paths: string[] | null, repoRoot: string,
  configEntries?: string[] | null): LoadedConfigSources {
  const native = !paths?.length && configEntries?.length ? observedConfigImports(configEntries, repoRoot) : null;
  const evidence = qualifyLoadedSources(native?.paths ?? paths, repoRoot, 'config');
  if (native) {
    if (evidence.status === 'stable') evidence.status = 'unknown';
    evidence.reasons.push('config-import-population-unmeasured');
  }
  return { schemaVersion: 'node-loaded-config-sources-v1', scope: 'repository-vite-config-dependencies',
    ...evidence, ...(native ? { importPopulation: native.observation } : {}) };
}

export function qualifyLoadedMainProcessSources(configPaths: string[] | null, repoRoot: string,
  configEntries?: string[] | null): LoadedMainProcessSources {
  const native = !configPaths?.length && configEntries?.length ? observedConfigImports(configEntries, repoRoot) : null;
  const config = new Set(native?.paths ?? configPaths ?? []);
  const paths = [...(shared.capture?.sources.keys() ?? [])].filter(path => !config.has(path));
  const evidence = qualifyLoadedSources(paths, repoRoot, 'main-process');
  if (!configPaths?.length) {
    evidence.reasons.push(native?.paths.length
      ? 'main-process-config-population-unmeasured' : 'main-process-config-population-unavailable');
    if (evidence.status === 'stable') evidence.status = 'unknown';
  }
  return { schemaVersion: 'node-loaded-main-process-sources-v1', scope: 'repository-node-main-process-sources', ...evidence };
}

type DiagnosticRow = Record<string, unknown>;

/** Consume the existing capture channels after the runner closes. Keep the
 * complete diagnostic summary even when an artifact or source guard fails.
 * Matching termination receipts establish worker lifetime, never loader closure. */
export function writeExecutedCaptureDiagnostic(options: {
  outPath: string; cgroupsPath: string; auditPath: string; parentExitsPath: string; summaryPath: string;
  cgroupPath: string; runGroup: string; deadlineEpochMs: number;
  child: { code: number | null; signal: string | null; resultLine: string; spawnFailure?: string | null };
  verifySource: () => void;
  details?: Record<string, unknown>;
}) {
  const failures: Array<{ label: string; error: string }> = [];
  const read = <T>(label: string, fn: () => T, fallback: T): T => {
    try { return fn(); } catch (error) { failures.push({ label, error: String(error) }); return fallback; }
  };
  const object = (value: unknown): DiagnosticRow => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected artifact object');
    return value as DiagnosticRow;
  };
  const jsonl = (path: string): DiagnosticRow[] => readFileSync(path, 'utf8').trim().split('\n')
    .filter(Boolean).map(line => object(JSON.parse(line)));
  const isForkEntry = (entry: unknown): boolean => typeof entry === 'string' &&
    entry.replaceAll('\\', '/').endsWith('/vitest/dist/workers/forks.js');
  const sourceUnchanged = read('post-run-source-guard', () => { options.verifySource(); return true; }, false);
  if (options.child.spawnFailure) failures.push({ label: 'child-spawn', error: options.child.spawnFailure });
  const membership = read('cgroup-artifact', () => jsonl(options.cgroupsPath), []);
  const reporter = read('reporter-artifact', () => object(JSON.parse(readFileSync(options.outPath, 'utf8'))), {});
  const processFiles = read('process-directory', () => readdirSync(options.outPath + '.processes')
    .filter(file => file.endsWith('.json')).sort(), []);
  const receipts = processFiles.map(file => read('process-artifact:' + file,
    () => object(JSON.parse(readFileSync(join(options.outPath + '.processes', file), 'utf8'))), null))
    .filter((row): row is DiagnosticRow => row !== null);
  const audit = read('committed-loader-artifact', () => jsonl(options.auditPath), []);
  const parentExits = read('parent-exit-artifact', () => jsonl(options.parentExitsPath), []);
  const config = read('config-observations', () => object(reporter.configLoadedSources), {});
  const mainProcess = read('main-process-observations', () => object(reporter.mainProcessLoadedSources), {});
  if (!Array.isArray(config.observedSources) || !config.observedSources.length ||
      !Array.isArray(mainProcess.observedSources) || !mainProcess.observedSources.length || !receipts.length || !audit.length)
    failures.push({ label: 'armed-capture', error: 'config/process/loader receipts absent' });
  const forks = membership.filter(row => row.phase === 'preload' && row.vitestFork === true &&
    row.isMainThread === true && Array.isArray(row.argv) && row.argv.some(isForkEntry));
  if (!forks.length || membership.some(row => !Number.isInteger(row.pid) || Number(row.pid) <= 0 ||
      row.cgroupPath !== options.cgroupPath || row.runGroup !== options.runGroup ||
      row.deadlineEpochMs !== options.deadlineEpochMs))
    failures.push({ label: 'fork-containment', error: 'actual fork containment missing or mismatched' });
  const forkProcessCoverage = forks.map(fork => {
    const sources = receipts.filter(row => row.pid === fork.pid && row.isMainThread === true);
    const parents = parentExits.filter(row => row.pid === fork.pid && isForkEntry(row.entry));
    const source = sources.length === 1 ? sources[0] : undefined;
    const parent = parents.length === 1 ? parents[0] : undefined;
    const terminals = membership.filter(row => row.pid === fork.pid && row.isMainThread === true &&
      (row.phase === 'exit' || row.phase === 'signal'));
    const contained = terminals.length === 1 ? terminals[0] : undefined;
    const parentMatches = Number.isInteger(parent?.parentPid) && Number(parent?.parentPid) > 0 &&
      source?.parentPid === parent?.parentPid;
    const cleanExit = source?.phase === 'exit' && source.exitCode === 0 && source.signal === null &&
      parent?.code === 0 && parent.signal === null && contained?.phase === 'exit' &&
      contained.exitCode === 0 && contained.signal === null;
    const signalExit = source?.phase === 'signal' && source.exitCode === null &&
      (source.signal === 'SIGTERM' || source.signal === 'SIGINT') && parent?.code === null &&
      parent.signal === source.signal && contained?.phase === 'signal' &&
      contained.exitCode === null && contained.signal === source.signal;
    return { pid: fork.pid, receiptPresent: !!source, parentExit: parent ?? null,
      sourcePhase: source?.phase ?? null, sourceSignal: source?.signal ?? null,
      containmentTerminalPresent: !!contained, terminationVerified: !!(parentMatches && (cleanExit || signalExit)) };
  });
  if (forkProcessCoverage.some(row => !row.terminationVerified))
    failures.push({ label: 'fork-termination', error: 'actual fork source/containment/parent terminal receipts missing or mismatched' });
  const tokens = Object.fromEntries([...options.child.resultLine.matchAll(/([A-Za-z]+)=([^\s]+)/g)]
    .map(match => [match[1], match[2]]));
  if (options.child.code !== 0 || options.child.signal !== null || tokens.status !== 'passed' ||
      tokens.requested !== '1' || tokens.executed !== '1' || tokens.matched !== '1' || tokens.skippedTests !== '0')
    failures.push({ label: 'test-result', error: 'runner did not pass the exact single diagnostic file without skips' });
  const summary = { ...options.details, schemaVersion: 'executed-capture-diagnostic-v1',
    child: options.child, sourceUnchanged, failures, membership, reporter, receipts, audit, parentExits,
    containedForkPids: [...new Set(forks.map(row => row.pid))], forkProcessCoverage,
    valid: sourceUnchanged && failures.length === 0, loaderChainAcceptance: 'unknown' };
  // Write before the caller converts a failed diagnostic into a failed task.
  writeFileSync(options.summaryPath, JSON.stringify(summary) + '\n');
  return summary;
}
