/** Original config inputs for the existing executed-source diagnostic OUT channel.
 * Loaded with Node --import BEFORE Vite evaluates configs. Reporter-time disk
 * reads cannot recover these bytes. This never authorizes reusable test passes. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
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
  if (typeof nodeModule.registerHooks !== 'function') {
    state.reasons.add('config-node-load-hook-unavailable');
    return;
  }
  const record = ({ path, sha256 }: LoadedSource): void => {
    const seen = state.sources.get(path) ?? new Set<string | null>();
    seen.add(sha256);
    state.sources.set(path, seen);
  };
  nodeModule.registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    try {
      if (!url.startsWith('file:') || loaded.source == null) return loaded;
      const path = fileURLToPath(url);
      const bytes = typeof loaded.source === 'string' ? Buffer.from(loaded.source) :
        loaded.source instanceof ArrayBuffer ? Buffer.from(loaded.source) :
          Buffer.from(loaded.source.buffer, loaded.source.byteOffset, loaded.source.byteLength);
      const code = bytes.toString('utf8');
      if (/\.timestamp-\d+-[a-f0-9]+\.mjs$/.test(path)) {
        const originals = configBundleSources(code);
        if (!originals) state.reasons.add('config-bundle-originals-unavailable');
        else originals.forEach(record);
      } else if (!path.split(/[\\/]/).includes('node_modules') &&
          (loaded.format === 'module' || loaded.format === 'module-typescript')) {
        record({ path, sha256: hash(bytes) });
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

export function qualifyLoadedConfigSources(paths: string[] | null, repoRoot: string): LoadedConfigSources {
  const state = shared[KEY];
  const reasons = new Set(state?.reasons ?? ['config-node-load-capture-unavailable']);
  let changed = false;
  if (!paths?.length) reasons.add('config-dependencies-unavailable');
  const sources: LoadedConfigSources['sources'] = [];
  for (const absolute of paths ?? []) {
    const path = relative(repoRoot, absolute).split(/[\\/]/).join('/');
    if (!isAbsolute(absolute) || !path || path === '..' || path.startsWith('../') || isAbsolute(path) ||
        path.split('/').includes('node_modules')) {
      reasons.add(`config-loaded-source-outside-repository:${absolute}`);
      continue;
    }
    const hashes = state?.sources.get(absolute);
    const sha256 = hashes?.size === 1 ? [...hashes][0]! : null;
    if (sha256 === null) reasons.add(`config-original-load-unavailable:${path}`);
    let currentSha256: string | null = null;
    try { currentSha256 = hash(readFileSync(resolve(repoRoot, path))); }
    catch { reasons.add(`config-loaded-source-unreadable:${path}`); }
    if (sha256 !== null && currentSha256 !== null && sha256 !== currentSha256) {
      changed = true;
      reasons.add(`config-loaded-source-changed:${path}`);
    }
    sources.push({ path, sha256, currentSha256 });
  }
  if (sources.length === 0) reasons.add('config-loaded-sources-unavailable');
  return { schemaVersion: 'node-loaded-config-sources-v1', scope: 'repository-vite-config-dependencies',
    basis: 'node-load-hook', status: changed ? 'changed' : reasons.size ? 'unknown' : 'stable',
    sources: sources.sort((a, b) => a.path.localeCompare(b.path)), reasons: [...reasons].sort() };
}
