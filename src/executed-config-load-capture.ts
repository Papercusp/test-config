/** Original config inputs for the existing executed-source diagnostic OUT channel.
 * Loaded with Node --import BEFORE Vite evaluates configs. Reporter-time disk
 * reads cannot recover these bytes. This never authorizes reusable test passes. */
import { createHash } from 'node:crypto';
import { Session } from 'node:inspector';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, threadId } from 'node:worker_threads';
import { pinModuleState } from '@papercusp/module-singleton';
import { observeProcessTermination } from './process-termination-observer.mjs';

interface LoadedSource { path: string; sha256: string | null }
interface Preload { kind: 'import' | 'loader' | 'require'; path: string | null; capture: boolean }
interface Capture { sources: Map<string, Set<string | null>>; reasons: Set<string>; preloads: Preload[] }
const shared = pinModuleState<{ capture: Capture | null }>(
  '@papercusp/test-config.original-config-loads', () => ({ capture: null }));
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Engine source text and execution ranges share a V8 script id. Neither a
 * scriptParsed event nor getScriptSource alone establishes execution. Best
 * effort coverage supplies positive observations only: GC can erase counters,
 * so an absent/zero count stays unknown. No precise coverage, pauses or code
 * rewriting are used, and this diagnostic never authorizes reusable passes. */
export function observeEngineScriptExecution(repoRoot: string) {
  const session = new Session();
  const reasons = new Set<string>();
  const scripts = new Map<string, { scriptId: string; url: string; path: string;
    sourceTextSha256: string | null; sourceTextLength: number | null }>();
  let connected = false;
  const post = <T>(method: string, params: Record<string, unknown> = {}): T => {
    let done = false;
    let result: unknown;
    let failure: Error | null = null;
    session.post(method, params, (error, response) => { done = true; failure = error; result = response; });
    // Exit/signal observers must finish synchronously. Never attest a pending
    // protocol request; its eventual callback cannot repair an emitted receipt.
    if (!done) throw new Error(`pending inspector request: ${method}`);
    if (failure) throw failure;
    return result as T;
  };
  session.on('Debugger.scriptParsed', ({ params }) => {
    try {
      const absolute = params.url.startsWith('file:') ? fileURLToPath(params.url) : params.url;
      if (!isAbsolute(absolute)) return;
      const path = relative(repoRoot, absolute).split(/[\\/]/).join('/');
      if (!path || isAbsolute(path) || path === '..' || path.startsWith('../') ||
          path.split('/').includes('node_modules')) return;
      const { scriptSource } = post<{ scriptSource: string }>('Debugger.getScriptSource', { scriptId: params.scriptId });
      if (typeof scriptSource !== 'string') throw new Error('engine source text unavailable');
      const sourceTextSha256 = hash(scriptSource);
      const prior = scripts.get(params.scriptId);
      const changed = params.isLiveEdit || (prior && prior.sourceTextSha256 !== sourceTextSha256);
      if (changed) reasons.add('engine-script-source-changed');
      scripts.set(params.scriptId, { scriptId: params.scriptId, url: params.url, path,
        sourceTextSha256: changed ? null : sourceTextSha256,
        sourceTextLength: changed ? null : scriptSource.length });
    } catch { reasons.add('engine-script-source-unavailable'); }
  });
  try {
    session.connect(); connected = true;
    post('Debugger.enable'); post('Profiler.enable');
  } catch { reasons.add('engine-inspector-unavailable'); }
  return {
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
        const ranges = sourceMatches && row?.url === script.url ? row.functions.flatMap(fn =>
          fn.ranges.filter(range => Number.isSafeInteger(range.count) && range.count >= 0 &&
            Number.isSafeInteger(range.startOffset) && Number.isSafeInteger(range.endOffset) &&
            range.startOffset >= 0 && range.endOffset > range.startOffset &&
            range.endOffset <= script.sourceTextLength!).map(range => ({ functionName: fn.functionName, ...range }))) : [];
        return { ...script, sourceTextSha256: sourceMatches ? script.sourceTextSha256 : null,
          execution: ranges.some(range => range.count > 0) ? 'observed' as const : 'unknown' as const,
          // Offsets address engine UTF-16 source text. A positive outer range
          // does not establish execution of a nested function or every byte.
          coverageRanges: ranges };
      });
      return { schemaVersion: 'node-engine-script-observations-v1', basis: 'v8-script-id-source-and-best-effort-coverage',
        scope: 'observed-repository-engine-scripts', sourceEncoding: 'utf8-of-engine-source-text',
        offsetUnits: 'utf16-code-units', populationStatus: 'unknown', scripts: observedScripts,
        reasons: [...reasons].sort(), unresolved: ['engine-bootstrap-observation-window-unmeasured',
          'engine-script-population-unmeasured', 'engine-best-effort-coverage-may-lose-gc-data',
          'engine-url-original-source-association-unmeasured', 'node-external-native-runtime-unmeasured',
          'node-process-descendant-population-unmeasured', 'node-loader-chain-not-closed'] };
    },
    disconnect() { if (connected) { session.disconnect(); connected = false; } },
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
  const state: Capture = { sources: new Map(), reasons: new Set(), preloads: [] };
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
      const evidence = qualifyLoadedSources([...state.sources.keys()], repoRoot, 'process');
      if (!isMainThread) evidence.reasons.push('process-worker-thread-entrypoint-unmeasured');
      if (!entrypoint || !evidence.sources.some(source => source.path === entrypoint && source.sha256 !== null)) {
        evidence.reasons.push('process-entrypoint-original-load-unavailable');
        if (evidence.status === 'stable') evidence.status = 'unknown';
      }
      const directory = `${outPath}.processes`;
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${process.pid}-${threadId}.json`), JSON.stringify({
        schemaVersion: 'node-loaded-process-sources-v1', scope: 'repository-node-process-sources',
        entrypoint, pid: process.pid, parentPid: process.ppid, isMainThread, threadId, ...termination, ...evidence,
        engineScripts: engine?.snapshot() ?? null,
        // These are observed inputs, never a census of every descendant or a
        // complete runtime identity. The preload itself predates its own hook.
        unresolved: ['node-process-descendant-population-unmeasured', 'node-preload-self-unmeasured',
          'node-external-native-runtime-unmeasured', 'node-loader-chain-not-closed'],
      }));
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
  nodeModule.registerHooks({ load(url, context, nextLoad) {
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

export function qualifyLoadedConfigSources(paths: string[] | null, repoRoot: string): LoadedConfigSources {
  return { schemaVersion: 'node-loaded-config-sources-v1', scope: 'repository-vite-config-dependencies',
    ...qualifyLoadedSources(paths, repoRoot, 'config') };
}

export function qualifyLoadedMainProcessSources(configPaths: string[] | null, repoRoot: string): LoadedMainProcessSources {
  const config = new Set(configPaths ?? []);
  const paths = [...(shared.capture?.sources.keys() ?? [])].filter(path => !config.has(path));
  const evidence = qualifyLoadedSources(paths, repoRoot, 'main-process');
  if (!configPaths?.length) {
    evidence.reasons.push('main-process-config-population-unavailable');
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
  const processFiles = read('process-directory', () => readdirSync(options.outPath + '.processes').sort(), []);
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
