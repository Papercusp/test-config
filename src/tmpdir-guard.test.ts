import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAPERCUSP_TMPDIR_CANDIDATES,
  SHARED_TMP_ROOTS,
  ensurePapercuspTmpdir,
  isWritableDir,
  tmpdirHasCriticalHeadroom,
  tmpdirIsInsideRepo,
  tmpdirNeedsOverride,
} from './tmpdir-guard.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const scratches: string[] = [];
function scratchDir(prefix: string): string {
  // Deliberately NOT under the repo — these dirs must be outside it for the
  // "not in a repo" cases to mean anything.
  const d = mkdtempSync(join('/tmp', prefix));
  scratches.push(d);
  return d;
}

afterEach(() => {
  while (scratches.length) {
    const d = scratches.pop()!;
    try {
      chmodSync(d, 0o700);
    } catch {
      /* already gone / not ours */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe('tmpdirNeedsOverride', () => {
  it('overrides an UNSET TMPDIR — os.tmpdir() then falls back to a shared root', () => {
    expect(tmpdirNeedsOverride(undefined)).toBe(true);
    expect(tmpdirNeedsOverride('')).toBe(true);
  });

  // ── THE REGRESSION THIS FILE EXISTS FOR (EI-20767792192323374) ──────────────────────────────
  // The pre-fix guard asked only "is TMPDIR usable?". `/tmp` is writable, exists, and is
  // marker-free, so it answered "usable" and DECLINED to override — leaving vitest's module-cache
  // root at bare `/tmp/<nanoid>`, which something swept mid-run, mass-failing 4,789 test files and
  // red-pinning the release gate on an infra artifact. Usable is not the same as OWNED.
  it.each([...SHARED_TMP_ROOTS])(
    'overrides the SHARED root %s even though it is perfectly usable — usable ≠ owned',
    (shared) => {
      expect(tmpdirNeedsOverride(shared)).toBe(true);
    },
  );

  it('overrides a shared root written with a trailing slash (the check is on the resolved path)', () => {
    expect(tmpdirNeedsOverride('/tmp/')).toBe(true);
    expect(tmpdirNeedsOverride('/tmp/./')).toBe(true);
  });

  it('LEAVES an explicitly-set scratch SUBDIRECTORY alone — it is already attributable', () => {
    // e.g. scripts/mutation-probe.sh points TMPDIR at its own mktemp dir on purpose. Overriding
    // that would defeat a caller who deliberately isolated themselves.
    const own = scratchDir('tmpdir-guard-owned-');
    expect(tmpdirNeedsOverride(own)).toBe(false);
  });

  it('overrides a TMPDIR that does not exist', () => {
    expect(tmpdirNeedsOverride('/tmp/tmpdir-guard-definitely-absent-8f2a1c')).toBe(true);
  });

  it('overrides a TMPDIR INSIDE a repo (2026-06-30: in-repo scratch git repos strand git-sync)', () => {
    expect(tmpdirIsInsideRepo(REPO_ROOT)).toBe(true);
    expect(tmpdirNeedsOverride(join(REPO_ROOT, 'node_modules'))).toBe(true);
  });

  it('overrides a TMPDIR that EXISTS but is READ-ONLY (EI-6063 — existsSync is not writability)', () => {
    const ro = scratchDir('tmpdir-guard-readonly-');
    chmodSync(ro, 0o500);
    expect(isWritableDir(ro)).toBe(false);
    expect(tmpdirNeedsOverride(ro)).toBe(true);
  });
});

describe('ensurePapercuspTmpdir', () => {
  it('points an unset TMPDIR at the first writable papercusp candidate', () => {
    const env: NodeJS.ProcessEnv = {};
    const chosen = ensurePapercuspTmpdir(env);
    expect(chosen).toBe(env.TMPDIR);
    expect(PAPERCUSP_TMPDIR_CANDIDATES).toContain(chosen);
    expect(isWritableDir(chosen!)).toBe(true);
  });

  it('moves TMPDIR OFF a shared root — the incident path shape can no longer be produced', () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: '/tmp' };
    const chosen = ensurePapercuspTmpdir(env);
    expect(chosen).not.toBe('/tmp');
    expect(SHARED_TMP_ROOTS.has(resolve(chosen!))).toBe(false);
    // The whole point: a cache root created under this is namespaced under a papercusp-owned
    // parent, so it is attributable and out of the blast radius of a bare `/tmp/*` sweep.
    expect(chosen!.startsWith('/tmp/') || chosen!.startsWith('/dev/shm/')).toBe(true);
  });

  it('is idempotent — a second call leaves an already-good TMPDIR untouched', () => {
    const env: NodeJS.ProcessEnv = {};
    const first = ensurePapercuspTmpdir(env);
    const second = ensurePapercuspTmpdir(env);
    expect(second).toBe(first);
  });

  it('does not touch the caller process env when handed an explicit env object', () => {
    const before = process.env.TMPDIR;
    ensurePapercuspTmpdir({ TMPDIR: '/tmp' });
    expect(process.env.TMPDIR).toBe(before);
  });

  it('skips a writable candidate on a critically-low filesystem and falls back', () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: '/tmp' };
    const chosen = ensurePapercuspTmpdir(env, {
      hasCriticalHeadroom: (dir) => dir !== '/tmp/pcv',
    });
    expect(chosen).toBe('/dev/shm/pcv');
    expect(env.TMPDIR).toBe('/dev/shm/pcv');
  });
});

describe('tmpdirHasCriticalHeadroom', () => {
  const statfs = (blocks: number, freeBlocks: number) => () => ({
    blocks,
    bavail: freeBlocks,
    bsize: 1024 ** 3,
  });

  it('rejects a huge filesystem below the shared critical percentage even with many GiB free', () => {
    expect(tmpdirHasCriticalHeadroom('/tmp/pcv', {}, statfs(1_000, 19))).toBe(false);
    expect(tmpdirHasCriticalHeadroom('/tmp/pcv', {}, statfs(1_000, 21))).toBe(true);
  });

  it('rejects a small filesystem below the shared absolute byte floor', () => {
    expect(tmpdirHasCriticalHeadroom('/tmp/pcv', {}, statfs(20, 1))).toBe(false);
  });

  it('fails open when statfs is unavailable so the writability probe remains authoritative', () => {
    expect(
      tmpdirHasCriticalHeadroom('/tmp/pcv', {}, () => {
        throw new Error('statfs unavailable');
      }),
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// COVERAGE GUARD — the half that stops this regressing.
//
// The fix only works from a process that starts BEFORE vitest, so it lives in the launchers. That
// makes it invisible to every ordinary test: delete the call and the whole suite still passes,
// while every run silently goes back to writing its module cache into shared `/tmp`. This guard is
// what fails instead.
// ────────────────────────────────────────────────────────────────────────────────────────────
describe('test launchers apply the TMPDIR policy before they spawn vitest', () => {
  const LAUNCHERS = ['scripts/test-files.mjs', 'scripts/affected-tests.mjs'] as const;
  // Subject root is overridable so falsifiability can be PROVEN against a COPY outside the tree
  // (scripts/mutation-probe.sh tier 2) instead of mutating the shared checkout, where git-sync's
  // sweep can commit the mutant even when nothing goes wrong. Defaults to the real thing.
  const LAUNCHER_ROOT = process.env.PC_TMPDIR_GUARD_LAUNCHER_ROOT ?? REPO_ROOT;
  const HOST_LAUNCHERS = LAUNCHERS.filter((rel) => existsSync(join(LAUNCHER_ROOT, rel)));
  // Any child-process invocation (the import statement carries no `(`, so it never matches).
  const INVOCATION = /\b(?:spawnSync|spawn|execSync|execFileSync)\s*\(/;

  it('checks either the complete Papercusp launcher pair or no host launchers', () => {
    // test-config is a shared library: SideStage does not own Papercusp's two
    // launchers, while a Papercusp checkout must never silently lose only one.
    expect(HOST_LAUNCHERS).toEqual(HOST_LAUNCHERS.length === 0 ? [] : [...LAUNCHERS]);
  });

  it.each(HOST_LAUNCHERS)('%s imports ensurePapercuspTmpdir from the guard module', (rel) => {
    const src = readFileSync(join(LAUNCHER_ROOT, rel), 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*ensurePapercuspTmpdir[^}]*\}\s*from\s*['"][^'"]*tmpdir-guard\.ts['"]/);
  });

  it.each(HOST_LAUNCHERS)('%s CALLS ensurePapercuspTmpdir() before any child-process spawn', (rel) => {
    const src = readFileSync(join(LAUNCHER_ROOT, rel), 'utf8');
    const callIdx = src.indexOf('ensurePapercuspTmpdir()');
    expect(callIdx, `${rel} never calls ensurePapercuspTmpdir()`).toBeGreaterThan(-1);

    const firstSpawn = src.search(INVOCATION);
    // A launcher with no spawn at all would vacuously pass, which is the failure mode this
    // assertion exists to prevent — these files exist to spawn vitest.
    expect(firstSpawn, `${rel} spawns nothing — has the guard's premise changed?`).toBeGreaterThan(-1);
    expect(
      callIdx,
      `${rel} spawns a child process before applying the TMPDIR policy — vitest would read the ` +
        `inherited TMPDIR and put its module cache in a shared tmp root (EI-20767792192323374)`,
    ).toBeLessThan(firstSpawn);
  });

  it('vitest-config.ts still applies the policy too (it governs test-runtime mkdtemp)', () => {
    const src = readFileSync(join(__dirname, 'vitest-config.ts'), 'utf8');
    expect(src).toContain('ensurePapercuspTmpdir()');
  });

  it('vitest-config.ts no longer claims it runs before the Vitest instance is constructed', () => {
    // That premise was false on Vitest 4 and is exactly what hid this bug: `new Vitest()` (whose
    // `_tmpDir` class field calls join(tmpdir(), nanoid())) runs BEFORE createViteServer() loads
    // this config. If someone reinstates the claim, the reasoning that produced the incident is
    // back in the file.
    const src = readFileSync(join(__dirname, 'vitest-config.ts'), 'utf8');
    expect(src).not.toMatch(/BEFORE the Vitest instance is\s*\n?\s*\/\/\s*constructed/);
  });
});

describe('the papercusp tmp root is a real, usable directory on this box', () => {
  it('creates the chosen candidate if missing and it is writable afterwards', () => {
    const env: NodeJS.ProcessEnv = {};
    const chosen = ensurePapercuspTmpdir(env)!;
    mkdirSync(chosen, { recursive: true });
    expect(isWritableDir(chosen)).toBe(true);
    // Socket paths under it must stay well clear of the 108-char sun_path limit (EI-5541).
    expect(chosen.length).toBeLessThan(20);
    // And it must not be inside a repo (2026-06-30 git-sync stranding).
    expect(tmpdirIsInsideRepo(chosen)).toBe(false);
  });
});
