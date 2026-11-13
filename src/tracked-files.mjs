/**
 * tracked-files.mjs — the one tree enumerator every scripts/check-*.mjs guard
 * should use (WI-6730).
 *
 * THE BUG THIS EXISTS TO KILL: guards enumerated the tree with a bare
 * `git ls-files`, which does NOT recurse into submodules — it emits ONE gitlink
 * entry per submodule, not its contents. This repo has 39 submodules, including
 * libs/generic/sync (the sync transport + concurrency gate), libs/generic/sse,
 * libs/papercusp (harness / orchestrator / locks) and papercusp-desktop. So 26 of
 * 48 guards printed a confident ✓ for ~39 subtrees they had never opened.
 *
 * That failure mode is worse than a crash: a false ✓ actively suppresses the
 * question. `lint:no-raw-setinterval` — whose BASELINE is documented "MUST stay
 * empty ... that is the whole universal-visibility ratchet" — reported clean while
 * an unlisted host timer sat in libs/papercusp/packages/locks.
 *
 * WHY YOU CANNOT JUST EYEBALL THE PATH: `libs/generic/*` is MIXED. Some entries
 * are ordinary directories in the superproject (libs/generic/activity-bridge — IS
 * listed by plain `git ls-files`) and some are submodules (libs/generic/sync — is
 * NOT). Nothing about the path distinguishes them, which is why the blind spot
 * survived undetected.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `unscanned` IS PART OF THE CONTRACT, NOT AN ERROR CHANNEL.
 *
 * A submodule that is declared in .gitmodules but not initialized/checked out
 * contributes no files, and there is no honest way to assert anything about its
 * contents. Callers MUST NOT silently treat that as clean — that is the exact bug
 * above, one level up. Report it (see `describeUnscanned`) so a guard's output
 * says "checked N subtrees, could not check M" instead of a bare ✓.
 *
 * Today that set is normally just libs/zero-harness, which is retired and
 * deliberately not initialized — a legitimate skip, but still a stated one.
 */
import { execSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { isRepositoryIndexFault, withGitIndexFaultRetry } from './git-index-fault-core.mjs';

// Standalone callers default to their working directory. The host adapter
// supplies its original repository root explicitly.
const ROOT = process.cwd();

/**
 * Run a git enumeration, retrying a torn `.git/index` and REFUSING to report one as "no files".
 *
 * EI-22703095921400106. The `catch { return [] }` these helpers used to end in was correct for
 * the shape it was written for — an archive/checkpoint snapshot with no `.git` — and silently
 * wrong for a shape nobody had hit yet. MEASURED 2026-09-08 on this very tree, with a 0-byte
 * index: `listTrackedFiles()` returned 35,742 files healthy and **0 files, no error** torn. Every
 * guard on this helper would then report a confident ✓ having scanned NOTHING — the exact
 * "false ✓ actively suppresses the question" failure this module was created to kill (WI-6730),
 * reintroduced through the error path instead of the submodule path.
 *
 * That is strictly worse than the crash this work-item started from: a crashed guard reds the
 * gate loudly and gets fixed; a guard that scans zero files and passes lets real violations
 * through and nobody ever learns. So an unreadable index THROWS here, matching the contract
 * `listFilesIncludingUntracked` already enforces below (`if (root.error) throw root.error`).
 * Every OTHER failure keeps the quiet `[]`, so the archive/checkpoint shape is untouched.
 *
 * stderr is captured rather than discarded because the classifier needs git's diagnostic to tell
 * those two apart — the same reason, and the same `'pipe'`, that `listFilesIncludingUntracked`
 * already uses. Capturing it also keeps it OUT of guard output, preserving the quiet-probe
 * contract the old `'ignore'` was there for.
 */
function runGitEnumeration(args, cwd) {
  return withGitIndexFaultRetry(() =>
    execSync(`git ${args}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    }),
  );
}

/** True for the one error class that must never be flattened into an empty enumeration. */
function isUnreadableIndex(error) {
  return Boolean(error?.isRepositoryIndexFault) || isRepositoryIndexFault(error);
}

/**
 * Run a git command and return trimmed stdout lines.
 *
 * Empty array on an EXPECTED failure (no `.git` — archive/checkpoint snapshots); THROWS on an
 * unreadable index, because "" and "I could not read the repository" are not the same answer.
 */
function gitLines(args, cwd) {
  try {
    return runGitEnumeration(args, cwd).split('\n').filter(Boolean);
  } catch (error) {
    if (isUnreadableIndex(error)) throw error;
    return [];
  }
}

/**
 * `gitLines`, but NUL-delimited — the only form that returns REAL paths.
 *
 * WI-2145427. Without `-z`, `git ls-files` C-QUOTES any path containing a quote,
 * backslash, control char, or non-ASCII byte: a file literally named `"$LOG"` is
 * emitted as the 11-character string `"\"$LOG\""`. A newline-splitting caller then
 * hands that literal to `lstat`, which cannot resolve it — so a real, readable,
 * tracked file becomes a PHANTOM UNREADABLE PATH.
 *
 * That is not a cosmetic difference. The passing-task verdict cache binds a
 * repo-wide guard task to EVERY tracked file, and one unreadable entry fails the
 * whole closure with `provenance-incomplete`, which short-circuits BEFORE any
 * identity component is compared. Measured 2026-09-05 over 2,229 run logs: one
 * such file drove 82% of all cache decisions (45/55) to that reason and the hit
 * rate to zero, while the cache itself was perfectly healthy. The failure is
 * silent and total, and it looks exactly like a cache that is merely cold.
 *
 * `-z` also removes the ambiguity a newline IN a filename would otherwise create,
 * so the fix is strictly a widening of what can be enumerated correctly.
 * `listFilesIncludingUntracked` below already enumerates this way; this exists so
 * `listTrackedFiles` cannot drift back to the quoting form.
 */
function gitLinesNul(args, cwd) {
  try {
    // Same quiet-probe contract as `gitLines`: an archive/checkpoint snapshot with no .git is an
    // expected shape and still yields []. An unreadable index is NOT that shape and throws —
    // this is the path `listTrackedFiles` uses, so it is where the measured 0-files-no-error
    // false green came from (see `runGitEnumeration`).
    return runGitEnumeration(args, cwd).split('\0').filter(Boolean);
  } catch (error) {
    if (isUnreadableIndex(error)) throw error;
    return [];
  }
}

/** Maximum number of filesystem entries the non-git fallback will inspect. */
const FALLBACK_MAX_ENTRIES = 100_000;

/** Generated/runtime trees that Git's normal exclude-standard pass omits. */
const FALLBACK_SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.next-build-cache',
  '.next-prod',
  '.papercusp',
  '.tmp-claude',
  '.turbo',
  '.vitest-tmp',
  '.vitest-tmpdir',
  '.vite',
  '.astro',
  'build',
  'coverage',
  'dist',
  'dist-host',
  'dist-preview',
  'dist-sidecar',
  'node_modules',
  'out',
  'target',
  'test-results',
  'vitest-tmp',
]);

/**
 * The error shape emitted by Git when `cwd` is an archive/non-git directory.
 * This is intentionally narrower than "any git error": a corrupt or otherwise
 * unreadable repository must not be silently replaced with a possibly partial
 * filesystem view.
 */
function isNotGitRepository(error) {
  const text = `${error?.message ?? ''}\n${error?.stderr ?? ''}`;
  return error?.code === 'ENOENT' || /not a git repository|outside a repository|must be run in a work tree/i.test(text);
}

/**
 * Enumerate a non-git checkout without following symlinks or generated trees.
 *
 * This is deliberately iterative and bounded. A missing/unreadable directory or
 * a tree larger than the cap throws instead of returning a partial list: a partial
 * list would recreate the false-clean/stale-baseline verdict this fallback exists
 * to prevent. Paths are normalized to the same superproject-relative POSIX shape
 * returned by `git ls-files`.
 */
function listFilesystemFiles(cwd) {
  const root = resolve(cwd);
  const files = [];
  const pending = [{ dir: root, prefix: '' }];
  let inspected = 0;

  while (pending.length > 0) {
    const { dir, prefix } = pending.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      throw new Error(
        `filesystem fallback could not enumerate ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const entry of entries) {
      inspected += 1;
      if (inspected > FALLBACK_MAX_ENTRIES) {
        throw new Error(
          `filesystem fallback exceeded its ${FALLBACK_MAX_ENTRIES}-entry bound under ${root}; ` +
            'refusing to return a partial scan',
        );
      }
      if (entry.isSymbolicLink()) continue;

      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!FALLBACK_SKIP_DIRS.has(entry.name)) pending.push({ dir: join(dir, entry.name), prefix: rel });
      } else if (entry.isFile()) {
        files.push(rel.split(sep).join('/'));
      }
    }
  }

  return files.sort();
}

/** Submodule paths declared in .gitmodules, superproject-relative, sorted. */
export function declaredSubmodules(cwd = ROOT) {
  return gitLines('config -f .gitmodules --get-regexp path', cwd)
    .map((line) => line.split(/\s+/)[1])
    .filter(Boolean)
    .sort();
}

/** Submodule paths registered in the superproject's local .git/config. */
function registeredSubmodules(cwd = ROOT) {
  return gitLines('config --get-regexp ^submodule', cwd)
    .map((line) => line.split(/\s+/, 2)[0])
    .filter((key) => key.startsWith('submodule.') && key.endsWith('.url'))
    .map((key) => key.slice('submodule.'.length, -'.url'.length))
    .filter(Boolean)
    .sort();
}

/**
 * Every tracked file in the superproject AND in each checked-out submodule, as
 * superproject-relative paths.
 *
 * Returns `{ files, declared, scanned, unscanned }` rather than a bare array
 * precisely so a caller cannot forget the coverage question — see the contract
 * note above.
 */
export function listTrackedFiles(cwd = ROOT) {
  // `--recurse-submodules` already emits submodule contents prefixed with the
  // submodule path, so no manual `git submodule foreach` + sed splicing is
  // needed (git >= 2.11; this repo is on 2.43). It exits 0 and simply omits an
  // uninitialized submodule, which is why coverage is computed separately below
  // rather than inferred from the exit code.
  // `-z` is load-bearing, not a style choice: without it git C-quotes any path
  // needing it and every one of the 37 guards on this helper receives an
  // unresolvable literal instead of the real filename. See `gitLinesNul`.
  const files = presentOnDisk(gitLinesNul('ls-files -z --recurse-submodules', cwd), cwd);
  return { files, ...coverageOf(files, cwd) };
}

/**
 * Drop index entries whose path has NO directory entry on disk (WI-10004173).
 *
 * On the shared tree an agent deletes a tracked file with plain `rm`, and the
 * git-sync sweep commits the deletion minutes later. Until then the index still
 * lists the path, so every whole-tree guard that enumerates this set and then
 * reads each entry threw ENOENT for every agent running it in that window
 * (three guards went red at once after one 11-file deletion). A path with no
 * entry has no content to scan, and the deletion reaches the index on the next
 * sweep, so omitting it is the honest enumeration of what is actually there.
 *
 * `lstat`, not `existsSync`: existsSync follows symlinks and would also drop a
 * tracked symlink whose target is missing. That entry is really on disk, and a
 * guard that audits symlinks must keep seeing it.
 *
 * Exported for guards that must keep their own `git ls-files` invocation (a
 * pathspec, or superproject-only scope) but read what they enumerate.
 */
export function presentOnDisk(files, cwd = ROOT) {
  return files.filter((file) => lstatSync(join(cwd, file), { throwIfNoEntry: false }) !== undefined);
}

/**
 * Every tracked AND UNTRACKED-but-not-ignored file, superproject + each
 * submodule git can descend into, as superproject-relative paths.
 *
 * ── WHY THIS CANNOT JUST BE `listTrackedFiles` (WI-6730) ────────────────────
 * The identity guards (check-no-owner-name-tags, check-no-box-identity,
 * check-no-identity-literals) deliberately pass `--others --exclude-standard`,
 * because a brand-NEW file is invisible to a plain `git ls-files` until it is
 * `git add`-ed — and that is precisely the moment a fresh identity leak is most
 * likely to be sitting in the tree. Losing that would be a real regression, not
 * a stylistic one.
 *
 * But git REFUSES to combine those flags with recursion:
 *
 *     $ git ls-files --recurse-submodules --others
 *     fatal: ls-files --recurse-submodules unsupported mode
 *
 * So these guards could not adopt `listTrackedFiles()` without trading their
 * untracked coverage for submodule coverage — one blind spot for another. This
 * function buys both: the superproject keeps the untracked-inclusive flags, and
 * each submodule is enumerated with the SAME flags in its own working tree, with
 * results prefixed back to superproject-relative paths.
 *
 * A submodule git cannot descend into (no `.git` — the archive-extracted release
 * checkouts described under `describeUnscanned`) simply contributes nothing and
 * falls out as `unscanned`, exactly like the recursing path. Coverage is computed
 * from the emitted paths, never from an exit code, so the two agree.
 */
export function listFilesIncludingUntracked(cwd = ROOT) {
  const FLAGS = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  const runZ = (dir) => {
    try {
      return {
        files: execSync(`git ${FLAGS.join(' ')}`, {
          cwd: dir,
          encoding: 'utf8',
          // Preserve stderr for classification without leaking expected
          // "not a git repository" diagnostics into guard output.
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 256 * 1024 * 1024,
        })
          .split('\0')
          .filter(Boolean),
        error: null,
      };
    } catch (error) {
      return { files: [], error };
    }
  };

  const root = runZ(cwd);
  // A git archive/checkpoint can be a perfectly valid source tree with no .git.
  // The old [] result made scan() report every baseline entry stale. Enumerate
  // that shape directly, but do not use this fallback for ordinary git repos.
  if (root.error && isNotGitRepository(root.error)) {
    const files = listFilesystemFiles(cwd);
    return { files, ...coverageOf(files, cwd) };
  }
  if (root.error) throw root.error;

  const files = root.files;
  for (const path of declaredSubmodules(cwd)) {
    const submodule = runZ(join(cwd, path));
    // A root git worktree with an archive-extracted submodule intentionally keeps
    // the existing unscanned coverage signal; only the root's non-git shape gets
    // the filesystem fallback above.
    for (const rel of submodule.files) files.push(`${path}/${rel}`);
  }
  // `--cached` carries the same index lag as listTrackedFiles (WI-10004173).
  const present = presentOnDisk(files, cwd);
  return { files: present, ...coverageOf(present, cwd) };
}

/**
 * Coverage partition for an ALREADY-COMPUTED file list — the seam that lets a
 * guard keep its own enumeration and still report honest coverage (WI-6776).
 *
 * Several guards cannot simply call `listTrackedFiles()`: check-no-nul-in-source
 * and check-no-control-bytes need `-z` (NUL-delimited) output because a guard
 * about byte-level corruption must not itself assume filenames are newline-free,
 * and check-env-feature-gates uses `git grep --recurse-submodules`. Forcing them
 * onto one enumerator would trade a real property for uniformity. What they
 * actually need to share is the COVERAGE CONTRACT, not the `git` invocation — so
 * that is what this exports.
 *
 * Returns `{ declared, scanned, unscanned }` where the partition is exact:
 * a declared submodule is `scanned` iff some emitted file sits under it.
 */
export function coverageOf(files, cwd = ROOT) {
  const declared = declaredSubmodules(cwd);
  const scanned = [];
  const unscanned = [];
  for (const path of declared) {
    if (files.some((f) => f.startsWith(`${path}/`))) scanned.push(path);
    else unscanned.push(path);
  }
  // The two gaps are NOT equally serious, and a caller that needs to ACT (rather than
  // just report) has to tell them apart:
  //
  //   unscannedPresent — content is on disk but git could not enumerate it. The scan
  //                      is missing real, existing files. THIS is the one that makes a
  //                      ✓ a lie and an absence-proof unsound.
  //   unscannedAbsent  — nothing is checked out. Contributes no files anywhere, so it
  //                      does not shrink the scan relative to what actually exists.
  //
  // Conflating them makes any "coverage is incomplete" alarm cry wolf: this repo
  // permanently carries one absent submodule (libs/zero-harness, retired and
  // deliberately uninitialized), so an alarm keyed on `unscanned` fires on every run
  // in a perfectly healthy tree and is trained away. Key alarms on unscannedPresent.
  const unscannedPresent = unscanned.filter((p) => hasContentOnDisk(p, cwd));
  const unscannedAbsent = unscanned.filter((p) => !unscannedPresent.includes(p));
  return { declared, scanned, unscanned, unscannedPresent, unscannedAbsent };
}

/** Does this submodule directory hold content on disk, whatever git can see? */
function hasContentOnDisk(path, cwd) {
  try {
    return readdirSync(join(cwd, path)).length > 0;
  } catch {
    return false;
  }
}

/** True when a checked-out submodule directory carries its own Git metadata. */
function hasGitMetadataOnDisk(path, cwd) {
  try {
    return lstatSync(join(cwd, path, '.git'), { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/**
 * One-line coverage suffix for a guard's success message, so a ✓ always states
 * what it did NOT look at. Returns '' when every declared submodule was scanned.
 *
 * Accepts either the bare `unscanned` array or a whole `listTrackedFiles()`
 * result (preferred — it already knows `declared`, so no re-read of .gitmodules).
 *
 * ── WHY THIS REPORTS A CAUSE, NOT JUST A LIST (WI-6776) ─────────────────────
 * The first version said "NOT scanned — not initialized", which is the right
 * FACT with the wrong DIAGNOSIS, and the wrong diagnosis is expensive: it sends
 * a reader to `git submodule update --init` chasing a fault that does not exist.
 * That wasted-diagnostic-time cost is what EI-19301033966613245 was filed about.
 *
 * THE SHAPES THIS REPO ACTUALLY HAS (all measured 2026-08-02, and note that the
 * relevant `.git` is the SUBMODULE's — every one of these trees is itself a
 * linked worktree, so the superproject `.git` is a file in all of them):
 *
 *   papercusp (staging)      38/39 enumerated. The one gap, libs/zero-harness,
 *                            is retired and deliberately not checked out.
 *   papercusp-release,       0/39 enumerated, yet 38 hold content ON DISK.
 *   papercup-release         Submodule SOURCE is `git archive`-extracted by
 *                            setup-release-checkout.sh (deliberate — many pins
 *                            are never pushed to origin), and an archive
 *                            extraction cannot produce a `.git`, so
 *                            --recurse-submodules has nothing to descend into.
 *                            Stable across repeated measurement.
 *   papercusp-checkpoint     ⚠ VARIES. The GREEN GATE's own tree read 0/39 at
 *                            02:05Z and 38/39 at 02:21Z, after a 02:17Z rebuild
 *                            registered its submodules.
 *
 * That last row is the reason this function exists rather than a one-off fix.
 * The gate's tree is not reliably either shape, so NO caller may assume one —
 * and a guard's own output is the only surviving record of which shape it in
 * fact ran against. Do not "simplify" this by hard-coding an expectation, and
 * do not assert `.git` presence as a precondition: it is legitimately absent in
 * the release checkouts, where a precondition demanding it would fail forever.
 *
 * The suffix therefore names the shape it actually found:
 *
 *   present-on-disk with own .git but no local registration → NOT REGISTERED
 *   present-on-disk without .git       → archive-extracted / worktree (BY DESIGN)
 *   absent-from-disk                    → genuinely not initialized
 *
 * Reporting the RATIO is the load-bearing part: `0/39` cannot be misread as
 * clean, whereas a bare ✓ over an empty scan reads exactly like a pass.
 */
export function describeUnscanned(unscannedOrScan, cwd = ROOT) {
  const isScan = unscannedOrScan && !Array.isArray(unscannedOrScan);
  const unscanned = isScan ? unscannedOrScan.unscanned : unscannedOrScan;
  if (!unscanned || unscanned.length === 0) return '';
  const declared = isScan ? unscannedOrScan.declared : declaredSubmodules(cwd);
  const total = declared?.length ?? unscanned.length;

  const present = isScan && unscannedOrScan.unscannedPresent
    ? unscannedOrScan.unscannedPresent
    : unscanned.filter((p) => hasContentOnDisk(p, cwd));
  const absent = unscanned.filter((p) => !present.includes(p));
  const registered = new Set(registeredSubmodules(cwd));
  const pathKey = (path) => path.endsWith('/') ? path.slice(0, -1) : path;
  const notRegistered = present.filter(
    (path) => hasGitMetadataOnDisk(path, cwd) && !registered.has(pathKey(path)),
  );
  const archiveExtracted = present.filter((path) => !notRegistered.includes(path));

  // Cap the name list: in a release-shaped tree EVERY submodule lands in one
  // bucket for one by-design reason, and printing 39 paths every run buries the
  // ratio that actually matters.
  const names = (list) =>
    list.length <= 4 ? list.join(', ') : `${list.slice(0, 4).join(', ')} +${list.length - 4} more`;

  const parts = [];
  if (notRegistered.length > 0) {
    parts.push(
      `${notRegistered.length} present on disk but NOT registered with the superproject — ` +
        `own .git metadata exists, but submodule.<path>.url is absent from .git/config: ${names(notRegistered)}`,
    );
  }
  if (archiveExtracted.length > 0) {
    parts.push(
      `${archiveExtracted.length} present on disk but NOT git-enumerable — archive-extracted release checkout ` +
        `or linked worktree (no .git, so --recurse-submodules cannot descend), BY DESIGN: ${names(archiveExtracted)}`,
    );
  }
  if (absent.length > 0) parts.push(`${absent.length} not initialized: ${names(absent)}`);

  return (
    ` (⚠ coverage ${total - unscanned.length}/${total} declared submodule(s) enumerated; ` +
    `${parts.join('; ')}. This result says nothing about them.)`
  );
}
