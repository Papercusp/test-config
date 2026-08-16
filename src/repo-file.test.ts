/**
 * repo-file.test.ts — the walk-up resolver is depth- and machine-proof (P-049).
 * Run: cd libs/test-config && npx vitest run src/repo-file.test.ts
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepoFile, resolveRepoFile } from './repo-file';

describe('resolveRepoFile', () => {
  it('finds a repo-relative file from any nesting depth', () => {
    const root = mkdtempSync(join(tmpdir(), 'repofile-'));
    mkdirSync(join(root, 'libs/db/sql'), { recursive: true });
    writeFileSync(join(root, 'libs/db/sql/001-x.sql'), 'CREATE TABLE t ();\n');
    const deep = join(root, 'packages/core/lib/deeply/nested');
    mkdirSync(deep, { recursive: true });
    expect(resolveRepoFile(deep, 'libs/db/sql/001-x.sql')).toBe(join(root, 'libs/db/sql/001-x.sql'));
    expect(readRepoFile(deep, 'libs/db/sql/001-x.sql')).toBe('CREATE TABLE t ();\n');
    // From the root itself too.
    expect(resolveRepoFile(root, 'libs/db/sql/001-x.sql')).toBe(join(root, 'libs/db/sql/001-x.sql'));
  });

  it('walks PAST nested package roots (submodule layout)', () => {
    const root = mkdtempSync(join(tmpdir(), 'repofile-'));
    // target only at the OUTER root; the inner dir has its own package.json.
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target/f.txt'), 'outer\n');
    const inner = join(root, 'libs/sub/packages/x');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(root, 'libs/sub/package.json'), '{}');
    expect(readRepoFile(inner, 'target/f.txt')).toBe('outer\n');
  });

  it('throws LOUDLY (not a silent fallback) when nothing on the walk holds the path', () => {
    const root = mkdtempSync(join(tmpdir(), 'repofile-'));
    expect(() => resolveRepoFile(root, 'no/such/file.sql')).toThrow(/no ancestor/);
  });

  it('resolves THIS repo from THIS test (the real consumer shape)', () => {
    // The exact call the migrated suites make — proves it works in-tree.
    const p = resolveRepoFile(__dirname, 'libs/test-config/src/repo-file.ts');
    expect(p.endsWith('libs/test-config/src/repo-file.ts')).toBe(true);
  });
});
