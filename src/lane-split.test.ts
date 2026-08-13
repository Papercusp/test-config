/**
 * Guards for the pure/stateful lane split (plan gate-suite-speedup-2026-08-12).
 *
 * FALSIFIABILITY DISCIPLINE (repo rule: prove a guard CAN fail, without mutating the shared
 * tree). The subject here is an imported MODULE, so this file keeps two deliberately-WRONG
 * implementations permanently resident as CONTROLS — `regexOnlyStatefulMatcher` and
 * `absentFileIsPure` — and asserts that each control FAILS the property the real subject
 * passes. If someone weakens `isStatefulTestSource` into either wrong shape, the control
 * assertions stop distinguishing it and this file goes red. No `cp`/restore, no sweep race.
 *
 * The calibration cases matter as much as the controls: without them, a matcher that called
 * EVERYTHING stateful would also "beat" both controls while destroying the whole point of the
 * split. So each control test is paired with an assertion that the real subject still puts
 * genuinely-pure sources in the pure lane.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STATEFUL_MARKERS,
  classifyLanes,
  isStatefulTestSource,
  isUnitTestFile,
  listUnitTestFiles,
  resolveLaneInclude,
} from './lane-split.ts';

// ─── CONTROLS: deliberately-wrong implementations, permanently resident ──────────────────
//
// CONTROL A — the "obvious" regex matcher, anchored to a line start with optional indent.
// It is wrong because registry calls appear in plenty of non-anchored positions (inside a
// beforeEach body chained off another expression, after `await`, etc.).
function regexOnlyStatefulMatcher(source: string): boolean {
  return /^\s*vi\.(mock|doMock|resetModules)\(/m.test(source);
}

// CONTROL B — treats an unreadable/absent file as PURE (the unsafe default: "we could not
// tell" collapsed into "it is fine"). The real classifier must send it to the stateful lane.
function absentFileIsPure(_rootDir: string, files: readonly string[]): { pure: string[] } {
  return { pure: [...files] };
}

// ─── fixtures ────────────────────────────────────────────────────────────────────────────

/** A scratch tree OUTSIDE the repo (TMPDIR is forced to a short /tmp path by vitest-config). */
function makeTree(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lane-split-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const PURE_SOURCE = `
import { describe, expect, it } from 'vitest';
describe('adder', () => {
  it('adds', () => { expect(1 + 1).toBe(2); });
});
`;

describe('isStatefulTestSource', () => {
  it('classifies every declared marker as stateful', () => {
    for (const marker of STATEFUL_MARKERS) {
      expect(isStatefulTestSource(`beforeEach(() => { ${marker}'./x'); });`)).toBe(true);
    }
  });

  it('calibration: a genuinely pure file is NOT stateful', () => {
    // Without this, a matcher that returned `true` unconditionally would pass every
    // control test below while making the split pointless.
    expect(isStatefulTestSource(PURE_SOURCE)).toBe(false);
  });

  it('CONTROL A: beats the line-anchored regex on a non-anchored registry call', () => {
    // A real shape: the call is not the first token on its line.
    const source = `it('x', async () => { await vi.resetModules(); });`;
    expect(regexOnlyStatefulMatcher(source)).toBe(false); // the wrong impl MISSES it …
    expect(isStatefulTestSource(source)).toBe(true); // … the real subject catches it.
  });

  it('errs toward stateful: a marker inside a comment still classifies stateful', () => {
    // Deliberate. Misclassifying stateful→pure costs correctness; pure→stateful costs
    // only speed, so every ambiguity resolves to `true`.
    expect(isStatefulTestSource(`// historical note: this used to vi.mock('./db')\n`)).toBe(true);
  });
});

describe('isUnitTestFile', () => {
  it('accepts unit tests and rejects the layered suites', () => {
    expect(isUnitTestFile('lib/a.test.ts')).toBe(true);
    expect(isUnitTestFile('lib/a.test.tsx')).toBe(true);
    expect(isUnitTestFile('lib/a.integration.test.ts')).toBe(false);
    expect(isUnitTestFile('lib/a.browser.test.ts')).toBe(false);
    expect(isUnitTestFile('lib/a.ts')).toBe(false);
  });
});

describe('listUnitTestFiles', () => {
  it('finds unit tests recursively, skips excluded trees and layered suites', () => {
    const { dir, cleanup } = makeTree({
      'lib/a.test.ts': PURE_SOURCE,
      'lib/nested/deep/b.test.tsx': PURE_SOURCE,
      'lib/c.integration.test.ts': PURE_SOURCE,
      'lib/d.browser.test.ts': PURE_SOURCE,
      'lib/notatest.ts': PURE_SOURCE,
      'node_modules/pkg/e.test.ts': PURE_SOURCE,
      'dist/f.test.ts': PURE_SOURCE,
      '.papercusp/g.test.ts': PURE_SOURCE,
      '_retired/h.test.ts': PURE_SOURCE,
    });
    try {
      expect(listUnitTestFiles(dir)).toEqual(['./lib/a.test.ts', './lib/nested/deep/b.test.tsx']);
    } finally {
      cleanup();
    }
  });

  it('emits root-relative paths with a ./ prefix, not absolute ones', () => {
    // Load-bearing: vitest resolves `include` against the project root (the WORKSPACE dir).
    // Absolute or repo-root-relative paths match ZERO files from a workspace-scoped run.
    const { dir, cleanup } = makeTree({ 'lib/a.test.ts': PURE_SOURCE });
    try {
      const files = listUnitTestFiles(dir);
      expect(files).toEqual(['./lib/a.test.ts']);
      expect(files.every((f) => !f.startsWith('/'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('does not descend into a symlinked directory', () => {
    const { dir, cleanup } = makeTree({ 'lib/a.test.ts': PURE_SOURCE, 'other/b.test.ts': PURE_SOURCE });
    try {
      symlinkSync(join(dir, 'other'), join(dir, 'lib', 'link'), 'dir');
      // `./lib/link/b.test.ts` must NOT appear — following it would double-count b.
      expect(listUnitTestFiles(dir)).toEqual(['./lib/a.test.ts', './other/b.test.ts']);
    } finally {
      cleanup();
    }
  });
});

describe('classifyLanes', () => {
  it('splits by module-registry use', () => {
    const { dir, cleanup } = makeTree({
      'lib/pure.test.ts': PURE_SOURCE,
      'lib/stateful.test.ts': `vi.mock('./db');\n${PURE_SOURCE}`,
    });
    try {
      const { pure, stateful, unreadable } = classifyLanes(dir, listUnitTestFiles(dir));
      expect(pure).toEqual(['./lib/pure.test.ts']);
      expect(stateful).toEqual(['./lib/stateful.test.ts']);
      expect(unreadable).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('CONTROL B: an unreadable file goes to the STATEFUL lane, never the pure one', () => {
    const { dir, cleanup } = makeTree({ 'lib/pure.test.ts': PURE_SOURCE });
    try {
      const files = ['./lib/pure.test.ts', './lib/does-not-exist.test.ts'];
      // The wrong impl calls the unreadable file pure …
      expect(absentFileIsPure(dir, files).pure).toContain('./lib/does-not-exist.test.ts');
      // … the real classifier quarantines it, and says so.
      const { pure, stateful, unreadable } = classifyLanes(dir, files);
      expect(pure).toEqual(['./lib/pure.test.ts']); // calibration: the readable pure file still lands pure
      expect(stateful).toEqual(['./lib/does-not-exist.test.ts']);
      expect(unreadable).toEqual(['./lib/does-not-exist.test.ts']);
    } finally {
      cleanup();
    }
  });

  it('the two lanes PARTITION the input — no file lost, none duplicated', () => {
    const { dir, cleanup } = makeTree({
      'lib/a.test.ts': PURE_SOURCE,
      'lib/b.test.ts': `vi.doMock('./x');`,
      'lib/c.test.ts': `vi.resetModules();`,
      'lib/d.test.ts': PURE_SOURCE,
    });
    try {
      const all = listUnitTestFiles(dir);
      const { pure, stateful } = classifyLanes(dir, all);
      expect([...pure, ...stateful].sort()).toEqual([...all].sort());
      expect(pure.filter((f) => stateful.includes(f))).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe('resolveLaneInclude', () => {
  it('returns only the requested lane, and reports the discovered total', () => {
    const { dir, cleanup } = makeTree({
      'lib/pure.test.ts': PURE_SOURCE,
      'lib/stateful.test.ts': `vi.mock('./db');`,
    });
    try {
      expect(resolveLaneInclude(dir, 'pure')).toEqual({ include: ['./lib/pure.test.ts'], total: 2 });
      expect(resolveLaneInclude(dir, 'stateful')).toEqual({
        include: ['./lib/stateful.test.ts'],
        total: 2,
      });
    } finally {
      cleanup();
    }
  });

  it('returns NULL for an empty lane — never [] (which vitest reads as "the whole suite")', () => {
    // The dangerous case: an empty `include` falls back to the DEFAULT include, so a lane
    // that legitimately selects nothing would run every file — in the pure lane, that means
    // running the stateful files NON-ISOLATED. `null` forces the caller to handle it.
    const { dir, cleanup } = makeTree({ 'lib/stateful.test.ts': `vi.mock('./db');` });
    try {
      expect(resolveLaneInclude(dir, 'pure').include).toBeNull();
      expect(resolveLaneInclude(dir, 'stateful').include).toEqual(['./lib/stateful.test.ts']);
    } finally {
      cleanup();
    }
  });

  it('distinguishes an EMPTY LANE from a WRONG ROOT via `total`', () => {
    // Both yield include:null, and conflating them is how a suite that never ran reads as
    // green under --passWithNoTests. total==0 is the wrong-root signal; total>0 with a null
    // include is a legitimately empty lane.
    const { dir, cleanup } = makeTree({ 'lib/stateful.test.ts': `vi.mock('./db');` });
    const empty = makeTree({ 'lib/not-a-test.ts': PURE_SOURCE });
    try {
      expect(resolveLaneInclude(dir, 'pure')).toEqual({ include: null, total: 1 });
      expect(resolveLaneInclude(empty.dir, 'pure')).toEqual({ include: null, total: 0 });
    } finally {
      cleanup();
      empty.cleanup();
    }
  });
});
