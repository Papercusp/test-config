/**
 * gate-test-reuse-yield-2026-10-01 P-003 (A3, D-004): which libs/test-config source files the
 * vitest MAIN process can load.
 *
 * A change to one of these reaches every test through the runner itself (the config, a reporter,
 * a globalSetup), so the reuse rule keeps it GLOBAL (scripts/lib/test-pass-reuse.mjs
 * isGlobalRunnerInput). Any other test-config source file runs only inside a worker, where the
 * executed-source-map reporter records it in the proof's executedModules, so it is an ordinary
 * per-proof input.
 *
 * The set is DERIVED, never hand-listed: a static walk over this directory, seeded from
 *   - vitest-config.ts (every workspace config is built by it), and
 *   - every target in package.json `exports` (a config's BARE `@papercusp/test-config[/x]` import
 *     is externalized by vite and loaded natively in the main process, so any export may be one;
 *     a config's RELATIVE imports are recorded per proof in readPaths and need no seed).
 * Edges: every relative module specifier (static, re-export, dynamic `import()`, `require()`),
 * type-only ones included, plus every `resolve(__dirname, '<file>')` / `new URL('<file>',
 * import.meta.url)` that names a file here, because that is how vitest-config.ts hands vitest
 * its reporters and globalSetup.
 * The one exclusion: a path in WORKER_SETUP_FILE_PATHS reached ONLY through such a string literal.
 * vitest runs a setup file inside each worker, never in the main process; if a main-process file
 * also IMPORTS it, the import edge keeps it in the set.
 *
 * Everything errs toward MORE global: a type-only import, an unused export, or a specifier that
 * merely looks relative widens the set and costs reuse, never soundness. Computed at the judged
 * tree; a change that shrinks the set must edit a file that stays in it (the importer that dropped
 * the edge is still reachable), so that change is itself global.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKER_SETUP_FILE_PATHS } from './worker-setup-files.ts';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SRC_DIR, '..');
const MONOREPO_ROOT = resolve(PACKAGE_DIR, '..', '..');

/** Extensions tried, in order, for a specifier that resolves to no existing file as written. */
const RESOLVE_SUFFIXES = ['', '.ts', '.mts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js'];

/** Module specifiers: `from '…'`, `import '…'`, `import('…')`, `require('…')`. */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"`])([^'"`\n]+)\1/g;
/** Path literals handed to vitest: `resolve(__dirname, '…')`, `new URL('…', import.meta.url)`. */
const PATH_LITERAL_RE =
  /\bresolve\(\s*__dirname\s*,\s*(['"`])([^'"`\n]+)\1\s*\)|\bnew\s+URL\(\s*(['"`])([^'"`\n]+)\3\s*,\s*import\.meta\.url\s*\)/g;

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** The file a relative specifier names, or null when it names nothing inside `srcDir`. */
function resolveInSrc(fromFile: string, spec: string, srcDir: string): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = RESOLVE_SUFFIXES.map((s) => base + s);
  // A `.js` specifier that names a `.ts` source (TS ESM convention).
  if (/\.[cm]?js$/.test(base)) candidates.push(base.replace(/\.([cm]?)js$/, '.$1ts'));
  for (const c of candidates) {
    if ((c === srcDir || c.startsWith(srcDir + sep)) && isFile(c)) return c;
  }
  return null;
}

/** Absolute files named by package.json `exports` / `main` that live in `srcDir`. */
function exportTargets(packageDir: string, srcDir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    main?: unknown;
    exports?: unknown;
  };
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      const abs = resolve(packageDir, v);
      if (abs.startsWith(srcDir + sep) && isFile(abs)) out.add(abs);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) visit(x);
    }
  };
  visit(pkg.main);
  visit(pkg.exports);
  return [...out];
}

export interface MainProcessClosureOptions {
  /** Directory scanned (default: this file's directory). */
  srcDir?: string;
  /** Directory holding package.json (default: srcDir/..). */
  packageDir?: string;
  /** Root the returned paths are relative to (default: the monorepo root). */
  repoRoot?: string;
  /** Absolute paths vitest runs only as worker setupFiles (default: WORKER_SETUP_FILE_PATHS). */
  workerSetupFiles?: readonly string[];
}

/**
 * Repo-relative POSIX paths of every test-config source file the vitest main process can load.
 * Throws when the package manifest is unreadable; callers then keep every test-config file global.
 */
export function testConfigMainProcessFiles(opts: MainProcessClosureOptions = {}): Set<string> {
  const srcDir = resolve(opts.srcDir ?? SRC_DIR);
  const packageDir = resolve(opts.packageDir ?? (opts.srcDir ? resolve(srcDir, '..') : PACKAGE_DIR));
  const repoRoot = resolve(opts.repoRoot ?? MONOREPO_ROOT);
  const workerSetup = new Set((opts.workerSetupFiles ?? WORKER_SETUP_FILE_PATHS).map((p) => resolve(p)));

  const seeds = [join(srcDir, 'vitest-config.ts'), ...exportTargets(packageDir, srcDir)];
  const seen = new Set<string>();
  const queue: string[] = [];
  const add = (abs: string): void => {
    if (!seen.has(abs) && isFile(abs)) {
      seen.add(abs);
      queue.push(abs);
    }
  };
  for (const s of seeds) add(s);
  while (queue.length > 0) {
    const file = queue.pop()!;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(SPECIFIER_RE)) {
      const hit = resolveInSrc(file, m[2], srcDir);
      if (hit) add(hit);
    }
    for (const m of text.matchAll(PATH_LITERAL_RE)) {
      const lit = m[2] ?? m[4];
      const hit = resolveInSrc(file, lit.startsWith('.') ? lit : `./${lit}`, srcDir);
      if (hit && !workerSetup.has(hit)) add(hit);
    }
  }
  const out = new Set<string>();
  for (const abs of seen) out.add(relative(repoRoot, abs).split(sep).join('/'));
  return out;
}
