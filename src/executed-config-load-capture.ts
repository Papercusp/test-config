/** Original config inputs for the existing executed-source diagnostic OUT channel.
 * Loaded with Node --import BEFORE Vite evaluates configs. Reporter-time disk
 * reads cannot recover these bytes. This never authorizes reusable test passes. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface LoadedSource { path: string; sha256: string | null }
interface Capture { sources: Map<string, Set<string | null>>; reasons: Set<string> }
const KEY = Symbol.for('@papercusp/test-config.original-config-loads');
const shared = globalThis as typeof globalThis & { [KEY]?: Capture };
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

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
  if (shared[KEY] || process.env.PC_EXECUTED_SOURCE_MAP_PRELOAD !== '1' ||
      !process.env.PC_EXECUTED_SOURCE_MAP_OUT || !process.env.PC_EXECUTED_SOURCE_MAP_WORKSPACE) return;
  const state: Capture = { sources: new Map(), reasons: new Set() };
  shared[KEY] = state;
  // A later preload can wrap this hook and replace the bytes it observed.
  // Without a receipt for that layer, the intermediate bytes are not original
  // execution authority. Recognize only this preload, including symlink paths.
  const preloads: string[] = [];
  const args = process.execArgv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--eval' || args[i] === '-e') { i++; continue; }
    if (args[i] === '--import') preloads.push(args[++i] ?? '');
    else if (args[i].startsWith('--import=')) preloads.push(args[i].slice(9));
    else if (/^(?:--(?:experimental-)?loader|--require|-r)(?:=|$)/.test(args[i]))
      state.reasons.add('node-loader-chain-unmeasured');
  }
  const options = process.env.NODE_OPTIONS ?? '';
  const importFlags = [...options.matchAll(/(?:^|\s)--import(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)];
  for (const match of importFlags) preloads.push(match[1] ?? match[2] ?? match[3]);
  if ((options.match(/(?:^|\s)--import(?==|\s|$)/g)?.length ?? 0) !== importFlags.length ||
      /(?:^|\s)(?:--(?:experimental-)?loader|--require|-r)(?:=|\s|$)/.test(options))
    state.reasons.add('node-loader-chain-unmeasured');
  for (const preload of preloads) {
    try {
      const path = preload.startsWith('file:') ? fileURLToPath(preload) : resolve(preload);
      if (realpathSync(path) !== realpathSync(fileURLToPath(import.meta.url)))
        state.reasons.add('node-loader-chain-unmeasured');
    } catch { state.reasons.add('node-loader-chain-unmeasured'); }
  }
  // npm, command routers and their descendants do not instantiate the Vitest
  // reporter. Retain each process's observed inputs beside that same OUT file.
  // A missing exit receipt remains unknown (for example a killed process).
  const repoRoot = process.env.PC_EXECUTED_SOURCE_MAP_ROOT;
  const outPath = process.env.PC_EXECUTED_SOURCE_MAP_OUT;
  // argv and cwd are mutable application state. Capture the original entry
  // before the command body can rewrite them, rather than trusting them at exit.
  const entry = process.argv[1] ? resolve(process.argv[1]) : null;
  const rel = repoRoot && entry ? relative(repoRoot, entry).split(/[\\/]/).join('/') : null;
  const entrypoint = rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') &&
    !rel.split('/').includes('node_modules') ? rel : null;
  if (repoRoot && isAbsolute(repoRoot)) process.once('exit', exitCode => {
    try {
      const evidence = qualifyLoadedSources([...state.sources.keys()], repoRoot, 'process');
      if (!entrypoint || !evidence.sources.some(source => source.path === entrypoint && source.sha256 !== null)) {
        evidence.reasons.push('process-entrypoint-original-load-unavailable');
        if (evidence.status === 'stable') evidence.status = 'unknown';
      }
      const directory = `${outPath}.processes`;
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${process.pid}.json`), JSON.stringify({
        schemaVersion: 'node-loaded-process-sources-v1', scope: 'repository-node-process-sources',
        entrypoint, pid: process.pid, parentPid: process.ppid, exitCode, ...evidence,
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
    seen.add(state.reasons.has('node-loader-chain-unmeasured') ? null : sha256);
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
  reasons: string[];
}

/** The repository files observed by this main process, beyond bundled config
 * inputs. This does not establish external/native code or child-process closure. */
export interface LoadedMainProcessSources extends Omit<LoadedConfigSources, 'schemaVersion' | 'scope'> {
  schemaVersion: 'node-loaded-main-process-sources-v1';
  scope: 'repository-node-main-process-sources';
}

function qualifyLoadedSources(paths: string[] | null, repoRoot: string, prefix: 'config' | 'main-process' | 'process'):
  Omit<LoadedConfigSources, 'schemaVersion' | 'scope'> {
  const state = shared[KEY];
  const reasons = new Set(state?.reasons ?? [`${prefix}-node-load-capture-unavailable`]);
  let changed = false;
  if (!paths?.length) reasons.add(`${prefix}-dependencies-unavailable`);
  const sources: LoadedConfigSources['sources'] = [];
  for (const absolute of paths ?? []) {
    const path = relative(repoRoot, absolute).split(/[\\/]/).join('/');
    if (!isAbsolute(absolute) || !path || path === '..' || path.startsWith('../') || isAbsolute(path) ||
        path.split('/').includes('node_modules')) {
      reasons.add(`${prefix}-loaded-source-outside-repository:${absolute}`);
      continue;
    }
    const hashes = state?.sources.get(absolute);
    const sha256 = hashes?.size === 1 ? [...hashes][0]! : null;
    if (sha256 === null) reasons.add(`${prefix}-original-load-unavailable:${path}`);
    let currentSha256: string | null = null;
    try { currentSha256 = hash(readFileSync(resolve(repoRoot, path))); }
    catch { reasons.add(`${prefix}-loaded-source-unreadable:${path}`); }
    if (sha256 !== null && currentSha256 !== null && sha256 !== currentSha256) {
      changed = true;
      reasons.add(`${prefix}-loaded-source-changed:${path}`);
    }
    sources.push({ path, sha256, currentSha256 });
  }
  if (sources.length === 0) reasons.add(`${prefix}-loaded-sources-unavailable`);
  return { basis: 'node-load-hook', status: changed ? 'changed' : reasons.size ? 'unknown' : 'stable',
    sources: sources.sort((a, b) => a.path.localeCompare(b.path)), reasons: [...reasons].sort() };
}

export function qualifyLoadedConfigSources(paths: string[] | null, repoRoot: string): LoadedConfigSources {
  return { schemaVersion: 'node-loaded-config-sources-v1', scope: 'repository-vite-config-dependencies',
    ...qualifyLoadedSources(paths, repoRoot, 'config') };
}

export function qualifyLoadedMainProcessSources(configPaths: string[] | null, repoRoot: string): LoadedMainProcessSources {
  const config = new Set(configPaths ?? []);
  const paths = [...(shared[KEY]?.sources.keys() ?? [])].filter(path => !config.has(path));
  const evidence = qualifyLoadedSources(paths, repoRoot, 'main-process');
  if (!configPaths?.length) {
    evidence.reasons.push('main-process-config-population-unavailable');
    if (evidence.status === 'stable') evidence.status = 'unknown';
  }
  return { schemaVersion: 'node-loaded-main-process-sources-v1', scope: 'repository-node-main-process-sources', ...evidence };
}
