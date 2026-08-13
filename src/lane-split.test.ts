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
  STATEFUL_PATTERNS,
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

// CONTROL C — the ORIGINAL vi.mock-only matcher, kept permanently as the control for the
// module-global-state family. It is the implementation that shipped the 2026-08-13 gate
// reds: it cannot see a registry that accumulates without any `vi.mock` in sight. If
// STATEFUL_PATTERNS is ever dropped, the real subject collapses onto this control and the
// paired assertions below stop distinguishing them.
function viMockOnlyMatcher(source: string): boolean {
  return STATEFUL_MARKERS.slice(0, 5).some((marker) => source.includes(marker));
}

// The two real shapes that reddened the gate, reduced to their essentials.
//
// REGISTRY_RESET_SOURCE is authority-op-registry.test.ts: it calls a test-only reset helper
// because `_handlers` is a module-scoped Map that outlives a single test.
const REGISTRY_RESET_SOURCE = `
import { afterEach, describe, expect, it } from 'vitest';
import { registerAuthorityOp, __resetAuthorityOpsForTests } from '../authority-op-registry';
afterEach(() => __resetAuthorityOpsForTests());
describe('registry', () => {
  it('registers', () => { registerAuthorityOp('lock.acquire', async () => 1); });
});
`;

// SIDE_EFFECT_IMPORT_SOURCE is routine-classification.registry.test.ts: a census over a
// registry it populates by importing a module purely for what that module does at load.
const SIDE_EFFECT_IMPORT_SOURCE = `
import { describe, expect, it } from 'vitest';
import { listSystemActions } from '../harness/routines/system-actions';
import '../harness/routines/register-system-actions';
describe('census', () => {
  it('classifies every registered action', () => {
    expect(listSystemActions().length).toBeGreaterThan(20);
  });
});
`;

// design-phase-plugin-dsn.test.ts reduced to the process-wide state that made it fail in the
// non-isolated lane and pass 66–72 seconds later in the same run group's isolated retry.
const PROCESS_ENV_MUTATION_SOURCE = `
const SAVED = ['HOME', 'PAPERCUSP_HOME'] as const;
beforeEach(() => {
  for (const key of SAVED) delete process.env[key];
  process.env.HOME = '/tmp/design-phase-dsn';
});
`;

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

  it('classifies every declared module-global-state pattern as stateful', () => {
    const samples = [
      `afterEach(() => __resetThingForTests());`,
      `import './register-things';\n`,
      `process.env.HOME = '/tmp/test-home';`,
      `delete process.env[key];`,
      `Object.assign(process.env, { TZ: 'UTC' });`,
    ];
    expect(STATEFUL_PATTERNS).toHaveLength(samples.length);
    for (const [index, pattern] of STATEFUL_PATTERNS.entries()) {
      // Each pattern must actually fire on something — a pattern that matches nothing
      // would sit in the list looking like coverage while providing none.
      const sample = samples[index]!;
      expect(pattern.test(sample)).toBe(true);
      expect(isStatefulTestSource(sample)).toBe(true);
    }
  });

  it('CONTROL C: beats the vi.mock-only matcher on a module-global REGISTRY reset', () => {
    // The exact miss that produced `lock.acquire already registered` on the gate.
    expect(viMockOnlyMatcher(REGISTRY_RESET_SOURCE)).toBe(false); // the shipped impl MISSED it …
    expect(isStatefulTestSource(REGISTRY_RESET_SOURCE)).toBe(true); // … the real subject catches it.
  });

  it('CONTROL C: beats the vi.mock-only matcher on a bare side-effect import', () => {
    // The exact miss that produced the TARGET_ROLE_SPEND census flip.
    expect(viMockOnlyMatcher(SIDE_EFFECT_IMPORT_SOURCE)).toBe(false);
    expect(isStatefulTestSource(SIDE_EFFECT_IMPORT_SOURCE)).toBe(true);
  });

  it('CONTROL C: beats the vi.mock-only matcher on process-environment mutation', () => {
    // The exact structural miss behind EI-20324961932717738. The subject and test blobs were
    // identical across pass/fail commits; only the shared-fork execution mode differed.
    expect(viMockOnlyMatcher(PROCESS_ENV_MUTATION_SOURCE)).toBe(false);
    expect(isStatefulTestSource(PROCESS_ENV_MUTATION_SOURCE)).toBe(true);
  });

  it('classifies env assignments/deletions as stateful without mistaking reads for writes', () => {
    expect(isStatefulTestSource(`process.env.PORT ?? '3055';`)).toBe(false);
    expect(isStatefulTestSource(`process.env.PORT === '3070';`)).toBe(false);
    expect(isStatefulTestSource(`process.env.PORT ??= '3055';`)).toBe(true);
    expect(isStatefulTestSource(`process.env[key] ||= 'value';`)).toBe(true);
    expect(isStatefulTestSource(`delete process.env.PAPERCUSP_HOME;`)).toBe(true);
    expect(isStatefulTestSource(`Reflect.set(process.env, key, value);`)).toBe(true);
    expect(isStatefulTestSource(`vi.stubEnv('TZ', 'UTC');`)).toBe(true);
  });

  it('catches a bare side-effect import carrying a TRAILING COMMENT', () => {
    // REGRESSION, found by the full pure-lane validation run rather than by review. The first
    // version of the pattern anchored at `;?\s*$`, so this real line from
    // lib/plan-items/reconcile-rule.test.ts:18 did NOT match — and that file then failed the
    // run. Note its comment ANNOUNCES the global mutation, so the naive anchor was worst
    // exactly where the evidence was clearest.
    const real = `import './reconcile-rule'; // registers plan-item-reconcile:done into the global engine\n`;
    expect(isStatefulTestSource(real)).toBe(true);
    expect(isStatefulTestSource(`import './x'; /* sets up the registry */\n`)).toBe(true);
    expect(isStatefulTestSource(`import './x' // no semicolon\n`)).toBe(true);
  });

  it('calibration: an ordinary BINDING import is not mistaken for a side-effect import', () => {
    // Without this, a bare-import pattern that also matched `import { x } from 'y'` would
    // beat CONTROL C by classifying the entire suite stateful — destroying the split while
    // looking like a fix. PURE_SOURCE's own vitest import is the case that must stay pure.
    expect(isStatefulTestSource(`import { describe, it } from 'vitest';\n`)).toBe(false);
    expect(isStatefulTestSource(`import type { Foo } from './foo';\n`)).toBe(false);
    expect(isStatefulTestSource(PURE_SOURCE)).toBe(false);
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

  it('rejects NON-TypeScript test files — the unit include is .test.ts(x) only', () => {
    // The lane split hands vitest an EXPLICIT file list instead of a glob, so admitting an
    // extension the `layerInclude` glob never matched ENROLS a file the suite never ran.
    // `.test.js` did exactly that to lib/pot-eval/fixtures/seed-app/test/baseline.test.js —
    // a `node:test` fixture — which vitest then failed with "No test suite found in file".
    expect(isUnitTestFile('lib/pot-eval/fixtures/seed-app/test/baseline.test.js')).toBe(false);
    expect(isUnitTestFile('lib/a.test.js')).toBe(false);
    expect(isUnitTestFile('lib/a.test.jsx')).toBe(false);
    expect(isUnitTestFile('lib/a.test.mjs')).toBe(false);
    expect(isUnitTestFile('lib/a.test.cjs')).toBe(false);
    expect(isUnitTestFile('lib/a.test.mts')).toBe(false);
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
      // A node:test FIXTURE belonging to a seeded sample app — never a vitest suite.
      'lib/fixtures/seed-app/test/baseline.test.js': `import { test } from 'node:test';\n`,
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
