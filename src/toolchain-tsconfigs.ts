/**
 * gate-test-reuse-yield-2026-10-01 P-004 (A4, D-007): which tsconfig / jsconfig files the vitest
 * TOOLCHAIN reads.
 *
 * Two readers exist, and both go through tsconfck:
 *   - vite-tsconfig-paths (tsconfigPaths() in vitest-config.ts and in the root vitest.config.ts):
 *     it takes its entry configs from `projects` when given, otherwise from
 *     `tsconfck.findAll(workspaceRoot, { configNames: ['tsconfig.json', 'jsconfig.json'] })`
 *     skipping `.git` and `node_modules`, and `tsconfck.parse()`s each, which follows `extends`
 *     and `references`.
 *   - vite's own esbuild transform: tsconfck finds the NEAREST `tsconfig.json` of each file and
 *     follows its `extends`. Those nearest files are a subset of the entries above.
 * So a config file outside the set derived here is read by neither: changing it cannot change
 * how any test file is transformed or resolved. The reuse rule (scripts/lib/test-pass-reuse.mjs)
 * therefore keeps a root `tsconfig.*.json` GLOBAL only when it is in this set, and stops treating
 * an unread `tsconfig.*.json` as configuring everything beneath its directory. A test that reads
 * such a file itself still sees it: an in-process read is recorded in its proof's readPaths, and a
 * read by a spawned process makes the proof opaque (executed-inputs-capture.ts, `child-process`).
 *
 * DERIVED, never hand-listed, with the same library calls the plugin makes:
 *   1. Entries: `findAll` with the plugin's default configNames and skip rule, plus every config
 *      basename a vite/vitest config source names as a string literal (an explicit `projects`
 *      entry such as `./tsconfig.test.json`), matched anywhere in the tree.
 *   2. Every entry is `parse`d; its own file, its `extended` chain and, recursively, its
 *      `referenced` configs are reached.
 *   3. Reached paths are realpath'd and kept only when inside the repo and outside node_modules
 *      (a node_modules config changes only through package-lock.json, which is global).
 *
 * Everything errs toward MORE configs read: a literal that merely looks like a config name, an
 * entry under an untracked directory, or a solution reference adds to the set and costs reuse,
 * never soundness. Any parse failure THROWS: the caller then keeps every root tsconfig global
 * (the pre-P-004 rule), because a config tsconfck cannot parse may still have been read up to
 * the failing link.
 *
 * Computed at the judged tree. A change that removes a config from the set must edit the config
 * that stopped extending or referencing it. That config is still reached (or is a deleted
 * `tsconfig.json` / `jsconfig.json`, which the reuse rule never narrows), so its own change
 * still invalidates under the unnarrowed rule.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

/** vite-tsconfig-paths 5.x default `configNames`: the files it discovers as entry configs. */
export const TOOLCHAIN_TSCONFIG_ENTRY_NAMES: readonly string[] = ['tsconfig.json', 'jsconfig.json'];

/**
 * Files that can hand tsconfigPaths() an explicit `projects` list: vite / vitest config and
 * workspace files, and this package's config factory (libs/test-config/src). A guard test pins
 * that tsconfigPaths() is called nowhere else.
 */
export function isToolchainConfigSource(rel: string): boolean {
  if (/\.test\.[cm]?[jt]sx?$/.test(rel)) return false;
  return /(?:^|\/)vite(?:st)?[.-][^/]*\.[cm]?[jt]sx?$/.test(rel) || /^libs\/test-config\/src\/.*\.[cm]?[jt]sx?$/.test(rel);
}

/** A string literal that names a config file: `'./tsconfig.test.json'`, `"jsconfig.app.json"`. */
const CONFIG_LITERAL_RE = /(['"`])([^'"`\n]*(?:ts|js)config[^'"`\n/]*\.json)\1/g;

/** Config basenames named by literals in `sources` beyond the default entry names. */
export function namedConfigBasenames(sources: Iterable<string>): string[] {
  const names = new Set<string>();
  for (const text of sources) {
    for (const m of text.matchAll(CONFIG_LITERAL_RE)) {
      const name = basename(m[2]);
      if (!TOOLCHAIN_TSCONFIG_ENTRY_NAMES.includes(name)) names.add(name);
    }
  }
  return [...names].sort();
}

interface ParseResultLike {
  tsconfigFile: string;
  extended?: { tsconfigFile: string }[];
  referenced?: ParseResultLike[];
}

interface TsconfckLike {
  findAll(dir: string, options: { configNames: string[]; skip: (dir: string) => boolean }): Promise<string[]>;
  parse(file: string, options: { cache: unknown }): Promise<ParseResultLike>;
  TSConfckCache: new () => unknown;
}

function defaultListTrackedFiles(repoRoot: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--recurse-submodules'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 60_000,
  });
  return out.split('\0').filter(Boolean);
}

export interface ToolchainTsconfigOptions {
  repoRoot: string;
  /** Seam: repo-relative tracked files (default `git ls-files --recurse-submodules`). */
  listTrackedFiles?: (repoRoot: string) => string[];
  /** Seam: the tsconfck module (default: the copy vite-tsconfig-paths imports). */
  tsconfck?: TsconfckLike;
}

/**
 * The repo-relative POSIX paths of every tsconfig/jsconfig file the vitest toolchain reads.
 * Throws when any entry fails to parse (callers treat that as "unavailable").
 */
export async function toolchainTsconfigFiles(o: ToolchainTsconfigOptions): Promise<Set<string>> {
  const t: TsconfckLike = o.tsconfck ?? ((await import('tsconfck')) as unknown as TsconfckLike);
  const realRoot = realpathSync(o.repoRoot);
  const tracked = (o.listTrackedFiles ?? defaultListTrackedFiles)(o.repoRoot);
  const sources: string[] = [];
  for (const rel of tracked) {
    if (!isToolchainConfigSource(rel)) continue;
    try {
      sources.push(readFileSync(join(o.repoRoot, rel), 'utf8'));
    } catch {
      // A tracked source missing from the tree names nothing the toolchain can load.
    }
  }
  const configNames = [...TOOLCHAIN_TSCONFIG_ENTRY_NAMES, ...namedConfigBasenames(sources)];
  const entries = await t.findAll(o.repoRoot, {
    configNames,
    skip: (dir) => dir === '.git' || dir === 'node_modules',
  });

  const reachedAbs = new Set<string>();
  const visit = (r: ParseResultLike) => {
    if (reachedAbs.has(r.tsconfigFile)) return;
    reachedAbs.add(r.tsconfigFile);
    for (const e of r.extended ?? []) reachedAbs.add(e.tsconfigFile);
    for (const ref of r.referenced ?? []) visit(ref);
  };
  const cache = new t.TSConfckCache();
  const failures: string[] = [];
  for (const entry of entries) {
    try {
      visit(await t.parse(entry, { cache }));
    } catch (err) {
      failures.push(`${relative(o.repoRoot, entry)}: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `tsconfck could not parse ${failures.length} config(s); first: ${failures.slice(0, 3).join(' | ')}`,
    );
  }

  const reached = new Set<string>();
  for (const abs of reachedAbs) {
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      // Keep the path as tsconfck reported it.
    }
    const rel = relative(realRoot, real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    const posix = rel.split(sep).join('/');
    if (posix.split('/').includes('node_modules')) continue;
    reached.add(posix);
  }
  return reached;
}
