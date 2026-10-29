/** Runtime input classification shared by the checkpoint and the Vitest reporter.
 * Keep this module independent of the test runner: checkpoints load it in plain Node. */
import { isAbsolute, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Normalize a repo-internal module key; exclude external and node_modules paths. */
export function normalizeExecutedKey(key: string, repoRoot: string): string | null {
  let p = key;
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch {
      return null;
    }
  }
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  if (p.startsWith('/@fs/')) p = p.slice('/@fs'.length);
  if (!isAbsolute(p)) return null;
  const rel = relative(repoRoot, p).split(/[/\\]/).join(posix.sep);
  if (rel.length === 0 || rel.startsWith('..')) return null;
  if (rel.split('/').includes('node_modules')) return null;
  return rel;
}

/** Existing untracked inputs make a pass opaque; tracked and absent inputs are diffable. */
export function classifyReadPaths(
  reads: string[],
  o: { repoRoot: string; isTracked: (rel: string) => boolean; exists: (abs: string) => boolean },
): { readPaths: string[]; opaqueReasons: string[] } {
  const readPaths = new Set<string>();
  const untracked: string[] = [];
  for (const abs of reads) {
    const rel = normalizeExecutedKey(abs, o.repoRoot);
    if (!rel) continue;
    if (o.isTracked(rel) || !o.exists(abs)) readPaths.add(rel);
    else untracked.push(rel);
  }
  const opaqueReasons: string[] = [];
  untracked.sort();
  for (const rel of untracked.slice(0, 5)) opaqueReasons.push(`untracked-read:${rel}`);
  if (untracked.length > 5) opaqueReasons.push(`untracked-read:+${untracked.length - 5} more`);
  return { readPaths: [...readPaths].sort(), opaqueReasons };
}
