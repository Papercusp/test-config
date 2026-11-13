import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { listFilesIncludingUntracked } from './tracked-files.mjs';

/** Return the complete, stable file manifest or null when coverage is uncertain. */
export function captureSourceByteManifest(root) {
  try {
    const canonicalRoot = realpathSync(root);
    const census = listFilesIncludingUntracked(canonicalRoot);
    if (census.unscanned.length) return null;
    const files = [...new Set(census.files)].sort();
    const hashFile = file => {
      const absolute = realpathSync(resolve(canonicalRoot, file));
      if (!absolute.startsWith(canonicalRoot + sep)) throw new Error('source-path-escaped');
      return createHash('sha256').update(readFileSync(absolute)).digest('hex');
    };
    const manifest = files.map(file => ({ path: file, sha256: hashFile(file) }));
    const after = listFilesIncludingUntracked(canonicalRoot);
    if (after.unscanned.length ||
      JSON.stringify(files) !== JSON.stringify([...new Set(after.files)].sort()) ||
      manifest.some(file => hashFile(file.path) !== file.sha256)) return null;
    return manifest;
  } catch {
    return null;
  }
}
