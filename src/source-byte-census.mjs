import { hash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { listFilesIncludingUntracked } from './tracked-files.mjs';

export function hashSourceFiles(root, files) {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return files.map(path => {
    const absolute = realpathSync.native(resolve(root, path));
    if (!absolute.startsWith(prefix)) throw new Error('source-path-escaped');
    return { path, sha256: hash('sha256', readFileSync(absolute)) };
  });
}

export function readSourceBytePass(root, readFiles = hashSourceFiles) {
  const census = listFilesIncludingUntracked(root, { includeMissing: true });
  if (census.unscanned.length) throw new Error('source-submodule-unscanned');
  // Git lists gitlink directories alongside their recursively enumerated leaves.
  const gitlinks = new Set(census.scanned);
  const files = [...new Set(census.files)].filter(path => !gitlinks.has(path)).sort();
  return readFiles(root, files);
}

export function confirmSourceByteManifest(before, after) {
  if (before.length !== after.length) return null;
  return before.every((entry, i) => entry.path === after[i].path && entry.sha256 === after[i].sha256)
    ? before : null;
}

/** Return the complete, stable file manifest or null when coverage is uncertain. */
export function captureSourceByteManifest(root) {
  try {
    const canonicalRoot = realpathSync.native(root);
    return confirmSourceByteManifest(readSourceBytePass(canonicalRoot), readSourceBytePass(canonicalRoot));
  } catch {
    return null;
  }
}
