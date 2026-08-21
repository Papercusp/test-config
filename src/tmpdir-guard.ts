/**
 * TMPDIR policy for test runs — extracted from vitest-config.ts (EI-20767792192323374) so it can
 * ALSO be applied from the test LAUNCHERS, which is the only place it actually works for Vitest's
 * own module-cache root.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS — the ordering bug this file's caller must respect
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Vitest computes its module-cache root as a CLASS FIELD INITIALIZER:
 *
 *     class Vitest { /* @internal *\/ _tmpDir = join(tmpdir(), nanoid()); }
 *
 * (vitest/dist/chunks/cli-api.*.js). That field is evaluated when `new Vitest(...)` runs, which is
 * the FIRST statement of `createVitest()` — and `createViteServer()`, the call that LOADS
 * `vitest.config.ts`, runs ~12 lines LATER. So a `process.env.TMPDIR` override performed while the
 * vitest config module is being evaluated is already too late: `os.tmpdir()` was read before it.
 *
 * vitest-config.ts carried the opposite premise in a comment for weeks ("This runs when
 * vitest.config.ts is evaluated, BEFORE the Vitest instance is constructed") and nothing verified
 * it. The consequence: EVERY workspace — shared-config or not — put vitest's ssr/client module
 * cache at BARE `/tmp/<nanoid>`, un-namespaced and un-attributable, directly in the blast radius of
 * anything sweeping `/tmp/*`. On 2026-08-18 something swept it mid-run and 5,448 test rows across
 * 4,789 files failed with `ENOENT ... mkdir '/tmp/<nanoid>/ssr'`, red-pinning the release gate on an
 * infra artifact rather than a code defect.
 *
 * THE LEVER IS THE ENVIRONMENT, BEFORE THE VITEST PROCESS STARTS. The `Vitest` class exposes no
 * `tmpDir` option (only `TestProject` takes one, handed down from its parent), so relocating that
 * root means having TMPDIR already correct when node starts vitest. Hence: the launchers
 * (`scripts/test-files.mjs`, `scripts/affected-tests.mjs`) call `ensurePapercuspTmpdir()` before
 * they spawn, and their children inherit it via `env: process.env`.
 *
 * vitest-config.ts still calls it too — that call cannot fix `_tmpDir`, but it is what protects
 * every `mkdtemp()` a TEST performs at runtime, and it covers a direct `npx vitest run` that did
 * not come through a launcher (that invocation gets a bare cache root regardless — nothing loaded
 * early enough to prevent it — but at least its test scratch stays namespaced).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY `/tmp/pcv` SPECIFICALLY — three prior incidents are encoded in this choice; do not "simplify"
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  (1) EI-5541 / 2026-06-30: an IN-REPO `<root>/.vitest-tmp` broke two whole test classes —
 *      unix-domain socket paths under it exceeded the 108-char `sun_path` limit (`listen EINVAL`
 *      for the IPC e2e + wake-executor tests), and temp dirs under it have a `.git` ANCESTOR, so
 *      the "non-git dir" detection tests (detectPapercupRoot, lockDomainForProjectDir,
 *      readCloneDefaultBranch, realGitCommit) wrongly resolved the repo.
 *  (2) 2026-06-30: an in-repo TMPDIR also strands git-sync — tests that `mkdtemp` a scratch git
 *      repo leave EMBEDDED repos in the working tree, and a no-commit one makes `git add -A` FATAL
 *      (exit 128), so the WHOLE tree stops committing.
 *  (3) EI-6063: `existsSync()` is not writability — the capability sandbox sets `TMPDIR=/tmp/claude`
 *      on a READ-ONLY bind mount that exists, so the old guard never fired and every run died with
 *      ENOENT before any test loaded.
 *
 * `/tmp/pcv` is short (socket paths stay ~55 chars), outside the repo, and marker-free up to `/`.
 */
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync } from 'node:fs';

const GIB = 1024 ** 3;

/**
 * Reuse disk-space-alarm's CRITICAL knobs rather than adding a test-only policy surface. A
 * warning-level filesystem may still have hundreds of GiB available on a large volume; the
 * critical tier is the point at which committing a whole Vitest run to that filesystem is unsafe.
 */
export const DEFAULT_TMPDIR_CRITICAL_HEADROOM = Object.freeze({
  freePctMin: 0.02,
  freeBytesMin: 2 * GIB,
});

export interface TmpdirStatfs {
  blocks: number | bigint;
  bavail: number | bigint;
  bsize: number | bigint;
}

export interface TmpdirGuardDeps {
  hasCriticalHeadroom?: (dir: string, env: NodeJS.ProcessEnv) => boolean;
}

function positiveEnvNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Does `dir` have enough byte headroom to host a new test run? Fail OPEN when statfs is
 * unavailable: the existing mkdir+rm probe still catches an already-full/read-only path, while an
 * unreadable metric must not make every test launcher unusable on a non-Linux or unusual sandbox.
 */
export function tmpdirHasCriticalHeadroom(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  readStatfs: (path: string) => TmpdirStatfs = (path) => statfsSync(path),
): boolean {
  try {
    const fsst = readStatfs(dir);
    const blockSize = Number(fsst.bsize);
    const totalBytes = Number(fsst.blocks) * blockSize;
    const freeBytes = Number(fsst.bavail) * blockSize;
    if (
      !Number.isFinite(totalBytes) ||
      totalBytes <= 0 ||
      !Number.isFinite(freeBytes) ||
      freeBytes < 0
    ) {
      return true;
    }

    const freePctMin =
      positiveEnvNumber(
        env,
        'PAPERCUSP_DISK_ALARM_CRITICAL_PCT',
        DEFAULT_TMPDIR_CRITICAL_HEADROOM.freePctMin * 100,
      ) / 100;
    const freeBytesMin =
      positiveEnvNumber(
        env,
        'PAPERCUSP_DISK_ALARM_CRITICAL_GB',
        DEFAULT_TMPDIR_CRITICAL_HEADROOM.freeBytesMin / GIB,
      ) * GIB;
    return freeBytes >= freeBytesMin && freeBytes / totalBytes >= freePctMin;
  } catch {
    return true;
  }
}

/**
 * Ordered TMPDIR candidates. `/tmp` first (short — keeps `sun_path` well under 108); `/dev/shm`
 * as the fallback for sandboxes that mount ALL of `/tmp` read-only (EI-6063), which is the one
 * tmpfs the implement-runner sandbox confirms is always writable.
 */
export const PAPERCUSP_TMPDIR_CANDIDATES: readonly string[] = ['/tmp/pcv', '/dev/shm/pcv'];

/**
 * Well-known SHARED tmp roots. A tmp root here is owned by nobody: a directory created directly
 * under one carries nothing identifying it as an in-flight test run, so any housekeeping sweep is
 * structurally unable to know to spare it. Resolving to one of these is itself a reason to
 * override — this is the clause added by EI-20767792192323374, and the one the original
 * writability-only guard was missing.
 */
export const SHARED_TMP_ROOTS: ReadonlySet<string> = new Set(['/tmp', '/var/tmp', '/dev/shm']);

/**
 * True if `dir` (or any ancestor up to `/`) holds a repo-root marker (`.git` / `package.json`) —
 * i.e. TMPDIR points INSIDE a repo. See incidents (1) and (2) in the module comment: a guard that
 * only fired when TMPDIR was unset/missing let anything that SET it to an existing in-repo path
 * slip straight through.
 */
export function tmpdirIsInsideRepo(dir: string): boolean {
  let p = resolve(dir);
  for (;;) {
    if (existsSync(resolve(p, '.git')) || existsSync(resolve(p, 'package.json'))) return true;
    const parent = dirname(p);
    if (parent === p) return false; // reached the filesystem root
    p = parent;
  }
}

/**
 * True if `dir` exists AND is actually WRITABLE. Existence alone is not enough (EI-6063): a
 * read-only bind mount surfaces as ENOENT/EROFS/EACCES on WRITE, never on a plain `statSync` /
 * `existsSync`. The only way to tell the two apart is to actually try — probe with mkdir+rm.
 */
export function isWritableDir(dir: string): boolean {
  const probe = resolve(dir, `.pcv-write-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(probe);
    rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 2026-07-13 (green-checkpoint red, candidate 06368a3a): the "`/tmp/pcv` has NO repo-root marker up
 * to `/`" premise was asserted in a comment but never VERIFIED at runtime. On this shared box some
 * other process `mkdir`'d a bare `.git` directly at `/tmp` and never cleaned it up — poisoning every
 * path beneath it INCLUDING `/tmp/pcv`, and silently defeating hasGitAncestor/findRepoRoot for the
 * whole box (the EI-5541 "non-git dir" class, reintroduced from a new angle).
 *
 * A `.git` entry that is a completely EMPTY directory cannot be a real repo/worktree marker (a real
 * one always has at least a HEAD file / objects dir / config), so removing it is safe — and it makes
 * the premise this module depends on actually hold rather than merely being documented.
 */
export function scrubStrayEmptyGitMarker(dir: string): void {
  const gitPath = resolve(dir, '.git');
  try {
    if (statSync(gitPath).isDirectory() && readdirSync(gitPath).length === 0) {
      rmSync(gitPath, { recursive: true, force: true });
    }
  } catch {
    // doesn't exist, isn't a directory, or isn't empty (a real repo) — never touch it.
  }
}

/**
 * Should we relocate TMPDIR away from `cur`? `cur` is the CURRENT value of `$TMPDIR`; `undefined`
 * means unset, in which case `os.tmpdir()` falls back to a shared root (`/tmp` on this box) and the
 * answer is yes.
 *
 * Deliberately NOT "is it usable" alone. A usable-but-SHARED root (`/tmp`) is exactly the state that
 * produced EI-20767792192323374: the old guard looked only at unset/missing/in-repo/unwritable, so
 * with `/tmp` writable and marker-free it correctly concluded "usable" and declined — leaving
 * vitest's cache root un-namespaced in the shared sweep zone. An explicitly-set SUBDIRECTORY of a
 * shared root is left alone: it is already attributable to whoever created it (e.g.
 * scripts/mutation-probe.sh points TMPDIR at its own scratch dir on purpose).
 */
export function tmpdirNeedsOverride(cur: string | undefined): boolean {
  if (!cur) return true;
  if (!existsSync(cur)) return true;
  if (SHARED_TMP_ROOTS.has(resolve(cur))) return true;
  if (tmpdirIsInsideRepo(cur)) return true;
  if (!isWritableDir(cur)) return true;
  return false;
}

/**
 * Point `env.TMPDIR` at a papercusp-owned, namespaced, writable tmp root when the current one is
 * unset / missing / in-repo / unwritable / a shared root. Idempotent and safe to call from any
 * process. Returns the TMPDIR in effect afterwards (unchanged if no override was needed, and
 * unchanged if NO candidate proved writable — failing loudly at the real mkdir call site is more
 * diagnosable than silently pointing at a dir that fails the same way one level down).
 *
 * MUST run before the process that will read `os.tmpdir()` — for vitest that means before `node`
 * starts it, i.e. in the launcher. See the module comment for why a call from inside
 * `vitest.config.ts` is too late for vitest's own cache root.
 */
export function ensurePapercuspTmpdir(
  env: NodeJS.ProcessEnv = process.env,
  deps: TmpdirGuardDeps = {},
): string | undefined {
  // Scrub before deciding: a stray empty `/tmp/.git` would make every candidate below look in-repo.
  scrubStrayEmptyGitMarker('/tmp');

  const hasCriticalHeadroom =
    deps.hasCriticalHeadroom ??
    ((dir: string, candidateEnv: NodeJS.ProcessEnv) =>
      tmpdirHasCriticalHeadroom(dir, candidateEnv));

  if (
    env.TMPDIR &&
    !tmpdirNeedsOverride(env.TMPDIR) &&
    hasCriticalHeadroom(env.TMPDIR, env)
  ) {
    return env.TMPDIR;
  }

  for (const candidate of PAPERCUSP_TMPDIR_CANDIDATES) {
    try {
      mkdirSync(candidate, { recursive: true });
    } catch {
      continue; // this candidate's parent is itself unwritable — try the next
    }
    if (isWritableDir(candidate) && hasCriticalHeadroom(candidate, env)) {
      env.TMPDIR = candidate;
      return candidate;
    }
    // Exists but still not writable (e.g. mkdirSync silently no-op'd on a read-only mount that
    // tolerates recursive:true on an already-existing dir) — fall through to the next candidate.
  }

  return env.TMPDIR;
}
