/**
 * admin-test-runs-reporter.ts — custom Vitest reporter that writes one row per
 * test FILE to harness_shared.test_runs. Powers the /admin/testing (+ /adv) status
 * chips without parsing Vitest output.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-010. Lifted into
 * @papercusp/test-config and AUTO-WIRED by defineVitestConfig (2026-06-08) so EVERY
 * workspace records — not just apps/operator + operator-core. Self-contained on
 * purpose (node: builtins, a LAZY postgres import, and the dependency-free
 * @papercusp/module-singleton pin — see the root-state block below) so it can never
 * fail to LOAD in a lib that lacks operator-core; the 3 helpers it used to import
 * (resolveGitContext / inferWorkspaceRoot / resolveTestRunSource) are inlined below.
 *
 * D-007 fail-soft contract — LOAD-BEARING:
 *   - 1s connect timeout; ONE shared pg client reused for the whole run
 *   - rows flush in bounded bulk inserts, never one queued query per test file
 *   - swallow every PG / git / fs error; never throw out of any hook
 *   - never taint test output; never affect the process exit code
 *
 * Opt-out via PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1 (defineVitestConfig drops it).
 * Mutation probes set PAPERCUSP_MUTATION_PROBE=1; those deliberate baseline and
 * mutant outcomes are falsifiability evidence, not repository-health evidence.
 * They are recorded with source='mutation-probe' and their explicit phase so
 * adequacy evidence can bind to a real test_runs id; health/gate readers exclude
 * that source explicitly.
 *
 * Vitest 4 API: onTestModuleEnd (per file) + onTestRunEnd (flush). Older
 * onFinished/onTaskUpdate names from Vitest 1-3 are NOT called.
 */

import type { Reporter, TestModule, Vitest } from 'vitest/node';
import { pinModuleState } from '@papercusp/module-singleton';
import { exec } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION, recordedTestLayer, isRecordedCaseTitle,
  MAX_RECORDED_FAILED_CASES, MAX_RECORDED_PASSED_CASES, type TestRunExecutionDetails,
  parseRecordedRuntimeEnvironment, type RecordedRuntimeEnvironment, type RuntimeEnvironmentCaptureStatus,
} from './execution-details.ts';

/**
 * EI-19307211919650123: classify the `.git` entry at `dir` for the root walk.
 * Three outcomes, because `.git` being a FILE is ambiguous and the two cases
 * need OPPOSITE answers:
 *
 *  - `'root'` — a real repo root. Either `.git` is a DIRECTORY, or it is a
 *    LINKED-WORKTREE gitlink (`gitdir: …/.git/worktrees/<name>`). A worktree's
 *    checkout IS the repo root: paths must be relative to it.
 *  - `'skip'` — a SUBMODULE gitlink (`gitdir: …/.git/modules/<name>`). The
 *    SUPERPROJECT above is the root the tab's registry globs are relative to,
 *    so the walk must continue past it. Also the default for any gitlink shape
 *    we don't recognise — this classifier may only ever ADD a stopping point it
 *    can prove, never invent one, so an unknown gitlink keeps today's behaviour.
 *  - `'none'` — no `.git` here at all.
 *
 * Why this exists: the walk used to stop ONLY at a `.git` directory, so it sailed
 * straight past `papercusp-checkpoint` (the green gate's checkout — a linked
 * worktree, hence a `.git` FILE) and landed on a stray `/home/<user>/.git` that
 * contains only `info/` and is not a repo at all. Every gate row was then stamped
 * `papercupai-workspace/papercusp-checkpoint/…`, which {@link shouldRecordTestRunPath}
 * DROPS via NON_SIGNAL_PREFIXES — so the release gate, the one suite whose verdict
 * gates the whole fleet, recorded nothing. Same bug hit `papercusp-staging` and any
 * `.papercusp/worktrees/` isolation tree.
 *
 * Pure (modulo fs) + exported for unit testing.
 */
export function classifyGitEntry(dir: string): 'root' | 'skip' | 'none' {
  let isFile: boolean;
  try {
    const st = statSync(join(dir, '.git'));
    if (st.isDirectory()) return 'root';
    isFile = st.isFile();
  } catch {
    return 'none';
  }
  if (!isFile) return 'none';
  try {
    // A gitlink is a one-liner: `gitdir: <absolute-or-relative path>`.
    const target = readFileSync(join(dir, '.git'), 'utf8').trim();
    const m = /^gitdir:\s*(.+)$/.exec(target);
    if (!m) return 'skip';
    // Normalise separators so the marker test is platform-agnostic.
    const gitdir = m[1].trim().split('\\').join('/');
    // A submodule checked out inside a linked superproject worktree points at
    // `<worktree>/.git/worktrees/<name>/modules/<path>`. It contains both
    // markers, but the submodule is still not the monorepo root.
    const worktreeMarker = /(?:^|\/)\.git\/worktrees\//;
    const worktreeMatch = worktreeMarker.exec(gitdir);
    if (worktreeMatch) {
      const worktreeTarget = gitdir.slice(worktreeMatch.index + worktreeMatch[0].length);
      return /(?:^|\/)modules\//.test(worktreeTarget) ? 'skip' : 'root';
    }
    if (/(?:^|\/)\.git\/modules\//.test(gitdir)) return 'skip';
    return 'skip'; // `/modules/` (submodule) and every unrecognised shape
  } catch {
    return 'skip';
  }
}

// ── inlined: inferWorkspaceRoot — find the true SUPERPROJECT root so recorded
//    file paths are monorepo-relative (the tab's registry globs expect that). ──

/**
 * WI-10000776 — the reporter's root state, PINNED to the realm instead of held in
 * plain module scope.
 *
 * Both fields are read by {@link resolveRecordRoot}, and `file_path` derived from
 * that root is HALF A JOIN KEY: `coverage_evidence` joins `test_runs` on
 * `(run_group_id, file_path)`, and the two sides reach this module by DIFFERENT
 * specifiers — the reporter is loaded by absolute path (ADMIN_TEST_RUNS_REPORTER_PATH),
 * while the coverage-census attribution setup does
 * `import('@papercusp/test-config/admin-test-runs-reporter')`. That is textbook
 * module-record duplication (bare specifier vs path, plus a `node_modules/@papercusp/*`
 * symlink), which would give each side its OWN root and break the join with nothing
 * failing. Pinning makes both sides share one root; `pinModuleState` also COUNTS
 * evaluations, so a genuine split is reported by `listModuleDuplications()` rather
 * than rediscovered from a contradictory reading.
 */
const _rootState = pinModuleState('@papercusp/test-config.admin-test-runs-reporter.root', () => ({
  /** Lazily-computed process root (from `process.cwd()`), the pre-WI-10000776 behaviour. */
  cachedRoot: null as string | null,
  /** The CHECKOUT UNDER TEST for this run, set once in `onInit`. Null ⇒ fall back. */
  runRoot: null as string | null,
}));

/**
 * The root walk itself, WITHOUT the cache — so a caller that knows which checkout it
 * means (see {@link setRunRoot}) actually gets an answer about THAT directory.
 * {@link inferWorkspaceRoot} short-circuits on its cache and therefore ignores its own
 * `from` argument once warm; that is fine for its cwd-derived use, and wrong for ours.
 *
 * Walk up to the first ancestor that {@link classifyGitEntry} calls a repo
 * root — a `.git` DIRECTORY, or a linked-WORKTREE gitlink. CRITICAL: a git
 * SUBMODULE also carries a `.git` FILE (a gitlink) and must be SKIPPED. The
 * original `existsSync('.git')` check stopped at the submodule, so a submodule
 * workspace recorded SUBMODULE-relative paths (e.g. `packages/orchestrator/…`
 * or `grid-core/src/…`) instead of the monorepo-relative
 * `libs/papercusp/packages/orchestrator/…` / `libs/generic/papergrid/grid-core/src/…`
 * the tab globs match → those rows were invisible in the tab. The fix for THAT
 * (skip every `.git` file) then over-corrected into the worktree bug described
 * on classifyGitEntry, which is why the two cases are now told apart explicitly.
 *
 * Pure (modulo fs) + exported for unit testing.
 */
export function computeWorkspaceRootFrom(from: string): string {
  let dir = resolve(from);
  while (true) {
    if (classifyGitEntry(dir) === 'root') return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

export function inferWorkspaceRoot(from = process.cwd()): string {
  if (_rootState.cachedRoot) return _rootState.cachedRoot;
  const root = computeWorkspaceRootFrom(from);
  _rootState.cachedRoot = root;
  return root;
}

/**
 * WI-10000776 — pin this RUN's root to the checkout Vitest is actually testing.
 *
 * The bug: every recorded path was relativized against the root inferred from
 * `process.cwd()`, i.e. the PAPERCUSP tree, whichever checkout the suite belonged to.
 * A sibling checkout (e.g. `~/papercupai-workspace/portal`) therefore produced
 * `../…/portal/tests/x.test.ts`, and {@link shouldRecordTestRunPath} DROPS anything
 * starting `../` — so its rows were silently discarded, no `test_run_id` was ever
 * minted, and `plans:bind-spec-evidence` (which needs a non-null one) could not carry
 * `test`-kind evidence for any plan in that checkout. The tests ran, passed, and left
 * no trace.
 *
 * The fix is the ROOT, not the guard. `configRoot` goes through
 * {@link computeWorkspaceRootFrom} rather than being used raw, so a run rooted inside a
 * git SUBMODULE still resolves to that checkout's true superproject — otherwise this
 * would reintroduce the submodule-relative-path bug described above. With the root
 * correct, `/tmp/fake.test.ts` STILL relativizes outside it and is STILL rejected by the
 * same `../` test, so WI-5183's fixture guard survives intact rather than being loosened.
 *
 * Fail-soft per the D-007 contract: any failure leaves the run root unset, which is
 * exactly the pre-WI-10000776 behaviour. Returns the root it pinned, for tests.
 */
export function setRunRoot(configRoot: string | null | undefined): string | null {
  try {
    if (!configRoot || typeof configRoot !== 'string') {
      _rootState.runRoot = null;
      return null;
    }
    _rootState.runRoot = computeWorkspaceRootFrom(configRoot);
    return _rootState.runRoot;
  } catch {
    _rootState.runRoot = null;
    return null;
  }
}

/**
 * WI-10000776 — read Vitest's resolved root for this run, fail-soft. `ctx.config.root`
 * is the Vitest ResolvedConfig root; `ctx.vite.config.root` is the underlying Vite
 * server's, used as the fallback. A ctx that carries neither (every pre-existing unit
 * test constructs one) yields `null`, i.e. today's cwd-derived behaviour. Exported so
 * the extraction is testable without reaching into the reporter's private state.
 */
export function readRunConfigRoot(ctx: unknown): string | null {
  const pick = (holder: unknown): string | null => {
    const root = (holder as { config?: { root?: unknown } } | null | undefined)?.config?.root;
    return typeof root === 'string' && root.length > 0 ? root : null;
  };
  try {
    return pick(ctx) ?? pick((ctx as { vite?: unknown } | null | undefined)?.vite);
  } catch {
    return null;
  }
}

/**
 * The ONE root every recorded path and git read resolves against: this run's checkout
 * when {@link setRunRoot} identified one, else the cwd-derived workspace root.
 */
export function resolveRecordRoot(): string {
  return _rootState.runRoot ?? inferWorkspaceRoot();
}

/**
 * EI-18767688096795873: does `configFile` (Vitest's RESOLVED config path for this
 * run) live OUTSIDE the repo working tree entirely? A canonical `vitest.config.ts`
 * always resolves inside `repoRoot`; a throwaway config (e.g. a mutation-testing
 * harness's `--config /tmp/<...>/vitest.mutant.config.ts`, built to alias in a
 * deliberately-broken module and assert the suite goes red) never does — by
 * construction, NOT by convention, so this needs no cooperation from whatever
 * produced the config. `false`/no configFile at all is NOT flagged: we can only ever
 * use this to SUPPRESS a false positive, never to manufacture one, so an unknown
 * case must default to "trust it" (the pre-existing behavior). Pure + exported for
 * unit testing.
 */
export function isScratchConfigFile(configFile: string | false | undefined, repoRoot: string): boolean {
  if (!configFile) return false;
  const rel = relative(repoRoot, configFile);
  return rel.startsWith('..') || isAbsolute(rel);
}

// ── inlined: resolveTestRunSource (was testing-run-source.ts). ──
type TestRunSource = 'ci' | 'local' | 'admin-ui' | 'mutation-probe';
const VALID_SOURCES: ReadonlySet<TestRunSource> = new Set(['ci', 'local', 'admin-ui', 'mutation-probe']);
function resolveTestRunSource(): TestRunSource {
  if (process.env.PAPERCUSP_MUTATION_PROBE === '1') return 'mutation-probe';
  const override = process.env.PAPERCUSP_TEST_RUN_SOURCE;
  if (override && VALID_SOURCES.has(override as TestRunSource)) return override as TestRunSource;
  return process.env.CI ? 'ci' : 'local';
}

/**
 * WI-1702898 — `source='ci'` is an EVIDENCE CLAIM, and a dirty tree cannot support it.
 *
 * A run against a tree ~100 agents are concurrently mutating proves nothing about any
 * sha: the files that executed are not the files any commit contains. Those rows were
 * nonetheless written as `source='ci'` (3,126 of them on 2026-08-31), where they are
 * indistinguishable from real gate evidence and silently inflate every aggregate over
 * it — including the one an agent reaches for when asked "how is the greening going".
 *
 * The row is still WRITTEN: it is real flakiness/timing data. What it loses is the
 * claim to be CI evidence. `local` is the honest bucket (that is what an unstable
 * working tree is), `run_group_id` still carries the gate-run provenance, and
 * `worktree_dirty` still carries the reason.
 */
export function resolveRecordedTestRunSource(
  declared: TestRunSource,
  worktreeDirty: boolean,
): TestRunSource {
  return declared === 'ci' && worktreeDirty ? 'local' : declared;
}

/**
 * WI-1702898 — the JUDGED sha, stamped by the runner that knows it, preferred over the
 * sha this process can infer.
 *
 * The gate used to stamp nothing here, on the stated premise that "the reporter resolves
 * it with `git rev-parse HEAD` in the checkout it ran in, which for the gate IS the
 * judged candidate". The premise is right and the mechanism is not: that resolution runs
 * under a 200ms fail-soft timeout and degrades to `null`, so under fleet load an entire
 * suite lands with `commit_sha=NULL` — 6,337 files on 2026-08-31. The largest body of
 * test evidence on the box could not be joined to what was being judged, which is what
 * made "what is failing on the candidate" unanswerable in the first place.
 *
 * An explicit stamp is an OBSERVATION by the process that chose the sha; a local
 * `rev-parse` is an INFERENCE about which checkout we happen to be sitting in. When both
 * exist the observation wins — the same precedence the gate-candidate cell draws between
 * its `retriage-marker` and `run-probe` sources.
 */
export function resolveTestRunCommit(inferred: string | null): string | null {
  const stamped = process.env.PAPERCUSP_TEST_RUN_COMMIT?.trim();
  return stamped || inferred;
}

/**
 * Mutation-probe runs deliberately produce a baseline and usually a failing
 * mutant result. Neither is a repository-health measurement, so the reporter
 * records the row with source='mutation-probe' and leaves filtering to readers.
 *
 * Exported so the marker contract is unit-testable without connecting to PG.
 */
export function isMutationProbeRun(): boolean {
  return process.env.PAPERCUSP_MUTATION_PROBE === '1';
}

/** The probe wrapper exports `baseline` or `mutant`; preserve the marker on
 * every per-file row without inventing a phase when the environment is absent. */
export function resolveMutationProbePhase(): string | null {
  if (!isMutationProbeRun()) return null;
  const phase = process.env.PAPERCUSP_MUTATION_PHASE?.trim();
  return phase || null;
}

// ── inlined: resolveGitContext (was testing-branch-resolve.ts). 200ms timeout,
//    cached 30s, fail-soft → {branch:null,commit:null}. ──
interface GitContext { branch: string | null; commit: string | null; }

/**
 * A best-effort snapshot of the shared checkout around one test run. A run
 * that starts or ends with an unreadable snapshot is dirty by definition: the
 * commit SHA alone is not proof that the executed files matched that commit.
 * This mirrors the shared-tree ingestion path in operator-core's
 * `computeWorktreeDirty` helper, but stays local so this auto-wired reporter
 * remains loadable by packages that do not depend on operator-core.
 */
export interface WorktreeGitSnapshot {
  commit: string | null;
  porcelain: string | null;
}

/**
 * WI-10004076: WHY a snapshot pair fails to prove the tree stable, or null when it does.
 * A gate lane demoted from `ci` to `local` cannot be diagnosed afterwards (the next run
 * re-materializes the checkpoint tree), so the reason has to be named at flush time.
 */
export function describeWorktreeDirt(before: WorktreeGitSnapshot, after: WorktreeGitSnapshot): string | null {
  if (!before.commit || !after.commit) {
    return `HEAD unreadable (before=${before.commit ?? 'null'} after=${after.commit ?? 'null'})`;
  }
  if (before.commit !== after.commit) return `HEAD moved ${before.commit.slice(0, 12)} -> ${after.commit.slice(0, 12)}`;
  if (before.porcelain === null || after.porcelain === null) {
    return `git status unreadable ${before.porcelain === null ? 'before' : 'after'} the run`;
  }
  for (const [when, porcelain] of [['before', before.porcelain], ['after', after.porcelain]] as const) {
    const lines = porcelain.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length > 0) return `${lines.length} porcelain line(s) ${when} the run: ${lines.slice(0, 5).join(' | ')}`;
  }
  return null;
}

export function computeWorktreeDirty(before: WorktreeGitSnapshot, after: WorktreeGitSnapshot): boolean {
  return describeWorktreeDirt(before, after) !== null;
}

let _gitCache: { value: GitContext; expiresAt: number } | null = null;
/**
 * EI-24836213046334894: a KILLED child's output is never a reading. When the event loop is
 * blocked past `timeout` (a caller's spawnSync), exec's timeout handler destroys the still
 * unread stdout and signals a child that had already exited 0, so the callback reports
 * err=null with stdout '' (measured on Node v25.9.0). That '' is a false read: an empty HEAD,
 * or an empty `git status --porcelain` that looks like a CLEAN tree. `child.killed` is the one
 * signal that survives the race, so it maps to null (unreadable) like any other failure.
 * Exported for the regression test only.
 */
export function runGit(cmd: string, cwd: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolveP) => {
    try {
      const child = exec(cmd, { cwd, timeout: timeoutMs }, (err, stdout) => {
        resolveP(err || child.killed ? null : stdout.trim());
      });
      child.on('error', () => resolveP(null));
    } catch {
      resolveP(null);
    }
  });
}
async function resolveGitContext(): Promise<GitContext> {
  const now = Date.now();
  if (_gitCache && _gitCache.expiresAt > now) return _gitCache.value;
  // WI-10000776: the branch/commit stamped on a row must describe the checkout the
  // tests came from, not whichever tree the process happened to start in.
  const root = resolveRecordRoot();
  const [branchRaw, commitRaw] = await Promise.all([
    runGit('git rev-parse --abbrev-ref HEAD', root, 200),
    runGit('git rev-parse HEAD', root, 200),
  ]);
  const value: GitContext = {
    branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
    commit: commitRaw || null,
  };
  _gitCache = { value, expiresAt: now + 30_000 };
  return value;
}

/**
 * WI-10004898 — which checkout's git state proves (or disproves) a run clean.
 *
 * Normally the record root: the checkout the tests came from. A COPY-OUT
 * mutation probe is the one runner whose record root cannot answer. It runs the
 * guard inside `/tmp/mutation-probe.XXXXXX/mirror`, which deliberately has no `.git`.
 * The mirror holds the origin checkout's files as symlinks, plus the probe's own
 * scratch copy of the subject. So `git status` there fails, and every
 * copy-out row recorded `commit_sha=NULL, worktree_dirty=true` even when the
 * origin was a pristine checkout of one commit. Spec-evidence freshness rates a
 * dirty run `unknown` (EI-24159008584241244), so no mutation row was usable
 * from any tree.
 *
 * mutation-probe.sh exports the origin checkout as
 * PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT for copy-out guards. Snapshotting it answers
 * the question freshness asks: did every file the run could load, apart from the
 * mutated subject, come from one commit? The deliberate mutation is still
 * labelled by mutationPhase. A probe whose origin is the shared tree is still
 * dirty, so the change only lets a clean origin (an as-committed clone) prove it.
 * It is honoured ONLY inside a probe run and only for an absolute path; otherwise
 * the record root stands.
 */
export function resolveWorktreeSnapshotRoot(): string {
  const origin = process.env.PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT?.trim();
  if (origin && isAbsolute(origin) && isMutationProbeRun()) return origin;
  return resolveRecordRoot();
}

/**
 * Snapshot the whole shared tree rather than only the currently reported
 * module. Vitest's onInit hook runs before module discovery, and an unrelated
 * generated artifact can still invalidate the commit identity stamped on a
 * row. The fail-safe null handling in computeWorktreeDirty makes git timeout
 * or failure visible as dirty instead of silently restoring the old default.
 */
export async function captureWorktreeSnapshot(run: WorktreeGitRunner = runGit): Promise<WorktreeGitSnapshot> {
  const root = resolveWorktreeSnapshotRoot();
  const [commit, porcelain] = await Promise.all([
    runGitWithRetry(run, 'git rev-parse HEAD', root),
    runGitWithRetry(run, 'git status --porcelain --untracked-files=all', root),
  ]);
  if (!porcelain) return { commit, porcelain };
  const exemption = await resolveProbeSubjectExemption(root, run);
  return { commit, porcelain: exemption ? exemptProbeSubject(porcelain, exemption) : porcelain };
}

/**
 * WI-10004952: the one path an IN-TREE mutation probe is entitled to leave modified.
 *
 * A copy-out probe mutates a scratch copy, so its origin checkout stays clean and
 * PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT lets a clean clone prove the row clean. An
 * in-tree probe mutates the subject IN the checkout, so the porcelain snapshot always
 * showed that subject and every in-tree row landed worktree_dirty=true, even from a
 * pristine `lint:as-committed --keep` clone. mutation-probe.sh now names the subject
 * (PAPERCUSP_MUTATION_PROBE_SUBJECT, absolute) in in-tree mode; the snapshot drops
 * exactly that path's modification line and nothing else, which answers the same
 * question the origin-root rule answers: did every file the run could load, apart
 * from the mutated subject, come from one commit?
 *
 * A subject inside a submodule shows in the superproject as ONE line for the
 * submodule. That line is exempt only when the submodule still sits at the commit
 * the superproject pins AND its own porcelain is exactly the subject; a moved
 * gitlink or any other dirt keeps the row dirty.
 */
export interface ProbeSubjectExemption {
  /** Subject path relative to the snapshot root (POSIX). */
  subjectRel: string;
  nested: {
    /** The nested repository's path relative to the snapshot root (POSIX). */
    repoRel: string;
    /** Subject path relative to the nested repository (POSIX). */
    subjectRelInRepo: string;
    /** The nested repository's own porcelain, or null when unreadable. */
    porcelain: string | null;
    /** Its HEAD equals the gitlink the snapshot root's HEAD pins. */
    gitlinkMatches: boolean;
  } | null;
}

/** Porcelain v1 modification codes only: an added, deleted, renamed or untracked
 * subject is not the in-place edit a probe makes, so it is never exempt. Lowercase
 * `m` is the short-format submodule-modified-content code. */
const PROBE_SUBJECT_EXEMPT_STATUS = /^[Mm]{1,2}$/;

function parsePorcelainLine(line: string): { status: string; path: string } | null {
  // runGit trims stdout, so the FIRST line's leading space is gone (" M a" reads "M a");
  // split on the status token instead of fixed columns.
  const m = line.trim().match(/^(\S{1,2})\s+(.+)$/);
  return m ? { status: m[1], path: m[2] } : null;
}

export function exemptProbeSubject(porcelain: string, ex: ProbeSubjectExemption): string {
  return porcelain
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return false;
      const p = parsePorcelainLine(line);
      if (!p || !PROBE_SUBJECT_EXEMPT_STATUS.test(p.status)) return true;
      if (ex.nested === null) return p.path !== ex.subjectRel;
      if (p.path !== ex.nested.repoRel) return true;
      if (!ex.nested.gitlinkMatches || ex.nested.porcelain === null) return true;
      return exemptProbeSubject(ex.nested.porcelain, { subjectRel: ex.nested.subjectRelInRepo, nested: null }) !== '';
    })
    .join('\n');
}

function toPosixPath(p: string): string {
  return p.split('\\').join('/');
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** One exemption policy, interpreted by both awaited and native synchronous hooks. */
function* probeSubjectExemptionReads(root: string): Generator<{ cmd: string; cwd: string }, ProbeSubjectExemption | null, string | null> {
  const subject = process.env.PAPERCUSP_MUTATION_PROBE_SUBJECT?.trim();
  if (!subject || !isAbsolute(subject) || !isMutationProbeRun()) return null;
  const subjectReal = realOrSelf(subject);
  const subjectRepo = yield { cmd: 'git rev-parse --show-toplevel', cwd: dirname(subjectReal) };
  if (!subjectRepo) return null;
  const rootReal = realOrSelf(root);
  const repoRel = toPosixPath(relative(rootReal, subjectRepo));
  if (repoRel.startsWith('..') || isAbsolute(repoRel) || repoRel.includes("'")) return null;
  const subjectRel = toPosixPath(relative(rootReal, subjectReal));
  if (repoRel === '') return { subjectRel, nested: null };
  const porcelain = yield { cmd: 'git status --porcelain --untracked-files=all', cwd: subjectRepo };
  const head = yield { cmd: 'git rev-parse HEAD', cwd: subjectRepo };
  const gitlink = yield { cmd: `git rev-parse 'HEAD:${repoRel}'`, cwd: rootReal };
  return {
    subjectRel,
    nested: {
      repoRel,
      subjectRelInRepo: toPosixPath(relative(subjectRepo, subjectReal)),
      porcelain,
      gitlinkMatches: !!head && head === gitlink,
    },
  };
}

export async function resolveProbeSubjectExemption(root: string, run: WorktreeGitRunner = runGit): Promise<ProbeSubjectExemption | null> {
  const reads = probeSubjectExemptionReads(root);
  let step = reads.next();
  while (!step.done) {
    const { cmd, cwd } = step.value;
    step = reads.next(await runGitWithRetry(run, cmd, cwd));
  }
  return step.value;
}

export function resolveProbeSubjectExemptionSync(
  root: string,
  run: (cmd: string, cwd: string, timeoutMs: number) => string | null,
): ProbeSubjectExemption | null {
  const reads = probeSubjectExemptionReads(root);
  let step = reads.next();
  while (!step.done) {
    const { cmd, cwd } = step.value;
    let observed: string | null = null;
    for (const budget of WORKTREE_SNAPSHOT_GIT_BUDGETS_MS) {
      observed = run(cmd, cwd, budget);
      if (observed !== null) break;
    }
    step = reads.next(observed);
  }
  return step.value;
}

/**
 * WI-10004931: per-attempt budgets for each snapshot git read. A timed-out read
 * returns null, and null is dirty by design (D-007), so a single 2s budget let
 * fleet IO load stamp a provably clean tree dirty: a ~38-submodule clone's
 * `git status` measured 1.8s while vitest ran beside it. Only a read that fails
 * on EVERY attempt stays null, so missing proof still records dirty.
 */
export const WORKTREE_SNAPSHOT_GIT_BUDGETS_MS: readonly number[] = [2_000, 8_000];

export type WorktreeGitRunner = (cmd: string, cwd: string, timeoutMs: number) => Promise<string | null>;

async function runGitWithRetry(run: WorktreeGitRunner, cmd: string, cwd: string): Promise<string | null> {
  for (const budget of WORKTREE_SNAPSHOT_GIT_BUDGETS_MS) {
    const out = await run(cmd, cwd, budget);
    if (out !== null) return out;
  }
  return null;
}

export interface TestRunRow {
  filePath: string; // workspace-relative POSIX
  status: 'pass' | 'fail' | 'skip' | 'cancelled' | 'error';
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  outputTail: string | null;
  /** EI-18767688096795873: true when this run's resolved vitest config lives
   *  outside the repo tree (a throwaway/mutation-testing config) — see
   *  `isScratchConfigFile`. */
  isScratchConfig: boolean;
  /** EI-20327093837421120: true when the shared tree was not stable around the run. */
  worktreeDirty: boolean;
  /** The post-run snapshot's commit. Reuse the same 2s integrity probe rather
   * than re-running a 200ms best-effort lookup once per persisted file. */
  commitSha: string | null;
  /** Measured per-file proof; absent/NULL is unknown, never zero skipped tests. */
  executionDetails?: TestRunExecutionDetails | null;
}

/** Read Vitest's completed cases, not module status or a truncated stdout tail. */
export function collectModuleExecution(testModule: TestModule, preferredPassedCasePattern?: RegExp): Pick<
  NonNullable<TestRunRow['executionDetails']>,
  'passed' | 'failed' | 'skipped' | 'collectionFailed' | 'failedCaseTitles' | 'passedCaseTitles'
> | null {
  try {
    const status = moduleStatus(testModule);
    if (status === 'error' || typeof testModule.children?.allTests !== 'function') return null;
    let passed = 0, failed = 0, skipped = 0;
    const failedCaseTitles = new Set<string>();
    const passedCaseTitles = new Set<string>();
    const preferredPassedCaseTitles = new Set<string>();
    for (const test of testModule.children.allTests()) {
      switch (test.result().state) {
        case 'passed':
          passed++;
          if (isRecordedCaseTitle(test.fullName) && passedCaseTitles.size < MAX_RECORDED_PASSED_CASES) {
            passedCaseTitles.add(test.fullName);
          }
          if (isRecordedCaseTitle(test.fullName) && preferredPassedCasePattern &&
              preferredPassedCaseTitles.size < MAX_RECORDED_PASSED_CASES) {
            preferredPassedCasePattern.lastIndex = 0;
            if (preferredPassedCasePattern.test(test.fullName)) preferredPassedCaseTitles.add(test.fullName);
          }
          break;
        case 'failed':
          failed++;
          if (isRecordedCaseTitle(test.fullName) && failedCaseTitles.size < MAX_RECORDED_FAILED_CASES) {
            failedCaseTitles.add(test.fullName);
          }
          break;
        case 'skipped': skipped++; break;
        default: return null; // pending/unreadable is not a completed measurement
      }
    }
    const recordedPassedCaseTitles = [...new Set([...preferredPassedCaseTitles, ...passedCaseTitles])]
      .slice(0, MAX_RECORDED_PASSED_CASES);
    return {
      passed, failed, skipped, collectionFailed: status === 'fail' && failed === 0,
      ...(failedCaseTitles.size > 0 ? { failedCaseTitles: [...failedCaseTitles] } : {}),
      ...(recordedPassedCaseTitles.length > 0 ? { passedCaseTitles: recordedPassedCaseTitles } : {}),
    };
  } catch {
    return null;
  }
}

/** A structured assertion detail captured from Vitest's TestCase result. */
export interface TestFailureDetail {
  file: string;
  test: string;
  message?: string;
  actual?: string;
  expected?: string;
}

/**
 * EI-22137062583459326: MUST stay byte-identical to `COLLECTION_FAILURE_TEST`
 * exported by `packages/operator-core/lib/testing-run-store.ts`. That file's
 * `distillVitestRun` synthesizes a failure for a file that failed with no
 * failing assertion to attribute it to (a pure collection/`beforeAll` crash),
 * keyed by this literal joined with the file path (same NUL-joined scheme as
 * the per-test details below), then looks up this reporter's failureDetails
 * sidecar under that same key to enrich it with a real message. This file is
 * deliberately self-contained (no operator-core import — see the module
 * doc comment), so the literal is duplicated rather than imported;
 * admin-test-runs-reporter.test.ts pins the exact string.
 */
const COLLECTION_FAILURE_TEST = '(file failed to collect)';

const FAILURE_DETAIL_VALUE_MAX_CHARS = 2_000;
const FAILURE_DETAILS_MAX_RECORDS = 2_000;

function boundFailureText(value: string, maxChars = FAILURE_DETAIL_VALUE_MAX_CHARS): string {
  if (maxChars <= 0) return '';
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function stringifyFailureValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const seen = new WeakSet<object>();
    const encoded = JSON.stringify(value, (_key, child: unknown) => {
      if (typeof child === 'bigint') return `${child}n`;
      if (typeof child === 'object' && child !== null) {
        if (seen.has(child)) return '[Circular]';
        seen.add(child);
      }
      return child;
    });
    if (encoded !== undefined) return encoded;
  } catch {
    /* fall through to the fail-soft string conversion */
  }
  try {
    return String(value);
  } catch {
    return '[unserializable]';
  }
}

function errorField(error: unknown, field: 'message' | 'actual' | 'expected'): unknown {
  try {
    if (error && typeof error === 'object') return (error as Record<string, unknown>)[field];
  } catch {
    /* fail-soft */
  }
  return undefined;
}

/**
 * Format one Vitest TestError without relying on its already-elided message.
 * The structured values are deliberately appended after the message so the
 * module-level 4KB tail retains them when a stack is long.
 */
export function formatTestCaseError(error: unknown): string {
  let message: string | undefined;
  try {
    const raw = error instanceof Error ? error.message : errorField(error, 'message');
    if (raw !== undefined && raw !== null) message = boundFailureText(stringifyFailureValue(raw));
  } catch {
    /* fail-soft */
  }
  const lines = message ? [message] : [];
  for (const field of ['actual', 'expected'] as const) {
    const value = errorField(error, field);
    if (value === undefined) continue;
    lines.push(`${field}: ${boundFailureText(stringifyFailureValue(value))}`);
  }
  if (lines.length > 0) return lines.join('\n');
  return stringifyFailureValue(error);
}

function readFailureDetailsFile(file: string): TestFailureDetail[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      failures?: unknown;
      details?: unknown;
    };
    const raw = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.failures) ? parsed.failures : parsed.details);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry): TestFailureDetail | null => {
        if (!entry || typeof entry !== 'object') return null;
        const value = entry as Record<string, unknown>;
        if (typeof value.file !== 'string' || !value.file || typeof value.test !== 'string' || !value.test) return null;
        const detail: TestFailureDetail = { file: value.file, test: value.test };
        for (const field of ['message', 'actual', 'expected'] as const) {
          if (value[field] !== undefined) detail[field] = boundFailureText(stringifyFailureValue(value[field]));
        }
        return detail;
      })
      .filter((entry): entry is TestFailureDetail => entry !== null)
      .slice(0, FAILURE_DETAILS_MAX_RECORDS);
  } catch {
    return [];
  }
}

function writeFailureDetails(details: TestFailureDetail[]): void {
  const path = process.env.PAPERCUSP_TEST_FAILURE_DETAILS_PATH?.trim();
  if (!path || details.length === 0) return;

  const existing = readFailureDetailsFile(path);
  const merged = new Map<string, TestFailureDetail>();
  for (const detail of [...existing, ...details]) {
    const key = `${detail.file}\u0000${detail.test}`;
    const previous = merged.get(key);
    merged.set(key, {
      ...(previous ?? {}),
      ...detail,
      ...(previous?.message && !detail.message ? { message: previous.message } : {}),
      ...(previous?.actual !== undefined && detail.actual === undefined ? { actual: previous.actual } : {}),
      ...(previous?.expected !== undefined && detail.expected === undefined ? { expected: previous.expected } : {}),
    });
  }

  const payload = JSON.stringify({ version: 1, failures: [...merged.values()].slice(0, FAILURE_DETAILS_MAX_RECORDS) });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
  } catch {
    try { unlinkSync(temp); } catch { /* fail-soft */ }
  }
}

export type WorktreeSnapshotReader = () => Promise<WorktreeGitSnapshot>;
export type TestRunRowWriter = (row: TestRunRow) => Promise<void>;
export type TestRunRowsWriter = (rows: readonly TestRunRow[]) => Promise<void>;

/**
 * Resolve a host-level loop-lag value from the resource-governor snapshot.
 *
 * The Vitest reporter runs in a child process, so its own event-loop histogram
 * is not the operator host signal consumed by `testing:runs`. The host
 * publisher already writes that signal atomically; consume only a fresh,
 * measured millisecond reading and preserve `null` for malformed, stale, or
 * unknown snapshots. Kept pure so the provenance/freshness boundary is tested
 * without depending on the live host file.
 */
export function resolveReporterHostLoopLag(
  snapshot: unknown,
  nowMs: number,
  maxAgeMs = 15_000,
): number | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return null;
  const root = snapshot as {
    sampledAtMs?: unknown;
    signals?: Record<string, { state?: unknown; value?: unknown; unit?: unknown; observedAtMs?: unknown }>;
  };
  const signal = root.signals?.['latency.eventLoopP95Ms'];
  if (!signal || signal.state !== 'measured' || signal.unit !== 'milliseconds') return null;
  if (typeof signal.value !== 'number' || !Number.isFinite(signal.value) || signal.value < 0) return null;
  const observedAtMs = typeof signal.observedAtMs === 'number'
    ? signal.observedAtMs
    : (typeof root.sampledAtMs === 'number' ? root.sampledAtMs : null);
  if (observedAtMs === null || !Number.isFinite(observedAtMs)) return null;
  const ageMs = nowMs - observedAtMs;
  if (ageMs < 0 || ageMs > maxAgeMs) return null;
  return signal.value;
}

let _hostLoopLagCache: { path: string; readAtMs: number; value: number | null } | null = null;

function readReporterHostLoopLag(env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): number | null {
  const explicit = env.PAPERCUSP_TEST_RUN_LOOP_LAG_P95_MS?.trim();
  if (explicit) {
    const value = Number(explicit);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const healthDir = env.PAPERCUSP_RESOURCE_GOVERNOR_HEALTH_DIR
    ? env.PAPERCUSP_RESOURCE_GOVERNOR_HEALTH_DIR
    : join(homedir(), '.papercusp', 'runtime', 'resource-governor');
  const healthPath = join(healthDir, 'live-health.json');
  if (_hostLoopLagCache && _hostLoopLagCache.path === healthPath && nowMs - _hostLoopLagCache.readAtMs < 1_000) {
    return _hostLoopLagCache.value;
  }
  let value: number | null = null;
  try {
    const snapshot = JSON.parse(readFileSync(healthPath, 'utf8')) as unknown;
    value = resolveReporterHostLoopLag(snapshot, nowMs);
  } catch {
    value = null;
  }
  _hostLoopLagCache = { path: healthPath, readAtMs: nowMs, value };
  return value;
}

export function captureReporterSaturationSnapshot(): { loopLagP95Ms: number | null; rssMb: number | null } {
  // Read the host publisher's atomic snapshot rather than measuring this child
  // process. A missing/stale file remains an explicit unknown (`null`).
  const loopLagP95Ms = readReporterHostLoopLag();
  let rssMb: number | null = null;
  try {
    rssMb = Math.round((process.memoryUsage().rss / 1_048_576) * 10) / 10;
  } catch {
    rssMb = null;
  }
  return { loopLagP95Ms, rssMb };
}

/**
 * EXPORTED for the coverage-census attribution setup (plan
 * deterministic-coverage-census-2026-08-17, P-004), which stamps the CURRENT test file onto
 * each `coverage_evidence` traffic row. That row joins back to `test_runs` on
 * `(run_group_id, file_path)`, so the two paths must be derived by the SAME function — a
 * second, "equivalent" relativizer is exactly how a join key silently stops matching (one
 * side keeps a `./` prefix, or resolves a different root under a submodule) and the evidence
 * becomes unattributable with nothing failing.
 */
export function toWorkspaceRel(absPath: string): string {
  const root = resolveRecordRoot();
  return relative(root, absPath).split(/[/\\]/).join(posix.sep);
}

const NON_SIGNAL_PREFIXES = [
  'papercupai-workspace/papercup-checkpoint/',
  'papercupai-workspace/papercusp-checkpoint/',
  'papercupai-workspace/papercup-staging/',
] as const;

export function shouldRecordTestRunPath(filePath: string): boolean {
  // A `toWorkspaceRel`'d path that still starts with `../` resolved OUTSIDE the
  // workspace root entirely (e.g. `/tmp/fake.test.ts` → `../../../../tmp/fake.test.ts`)
  // — never a real repo file, so never a real regression signal. WI-5183: this
  // reporter's OWN fail-soft self-tests (admin-test-runs-reporter.test.ts) construct
  // fake TestModules with `moduleId: '/tmp/fake.test.ts'` and drive them through
  // onTestModuleEnd for real (to prove it never throws) — on a dev box with a live
  // PG reachable, that real call recorded real rows for a file that has never
  // existed in git, which the flakiness scanner then flagged as a 100%-flip-rate
  // "test" to quarantine (nonsensical: there is no real file/glob to quarantine).
  // General fix (not a one-off path literal): reject ANY moduleId that normalizes
  // outside the workspace root, not just this specific fixture path.
  //
  // WI-10000776: the root this is measured against is now the CHECKOUT UNDER TEST
  // (see setRunRoot), not whichever tree the process started in. That is what makes
  // this guard mean what it says: a sibling checkout's own tests are INSIDE its root
  // and record, while `/tmp/fake.test.ts` is outside EVERY checkout and is still
  // rejected here. The guard did not need loosening — the root was wrong.
  if (filePath.startsWith('../') || filePath.startsWith('..\\')) return false;
  if (filePath.startsWith('_retired/') || filePath.includes('/_retired/')) return false;
  if (filePath.startsWith('.papercusp/scratch/tdg-') || filePath.includes('/.papercusp/scratch/tdg-')) return false;
  // `*.flakeproof.test.{ts,tsx}` is the reserved, gitignored scratch fixture for
  // scripts/flake-soak.sh --self-test: it is DELIBERATELY reddened to prove the
  // throttle discriminates, and never committed. Recording its runs turns an
  // intended RED into a "test failing repeatedly" watchdog signal on a file that
  // does not exist in git (EI-10761). It is never a real regression signal.
  if (filePath.includes('.flakeproof.test.')) return false;
  // Rust/Cargo BUILD-ARTIFACT trees. The desktop sidecar build copies the
  // template `checks/*.test.ts` (which import `@papercusp/template-kit`) into
  // the cargo target dir, where node_modules are NOT linked — so every copy
  // reds with "Cannot find package '@papercusp/template-kit'". These dirs are
  // gitignored build output, never a source regression (EI-11176). Covers the
  // per-worktree `*-cargo-target/` dirs (WI-3388's CARGO_TARGET_DIR) and the
  // standard `target/{debug,release}/` cargo output.
  if (filePath.includes('cargo-target/')) return false;
  if (/(?:^|\/)target\/(?:debug|release)\//.test(filePath)) return false;
  // Cross-target and sidecar-specific Cargo profiles do not put `debug` or
  // `release` immediately below target/, so matching only the profile segment
  // lets relocated bundles leak into the test-run ledger. A src-tauri/target
  // tree is unambiguously Cargo output; keep the source templates/ tree live.
  if (/(?:^|\/)src-tauri\/target\//.test(filePath)) return false;
  if (NON_SIGNAL_PREFIXES.some((prefix) => filePath.startsWith(prefix))) return false;
  return true;
}

function moduleStatus(m: TestModule): TestRunRow['status'] {
  let state: string;
  try {
    state = m.state();
  } catch {
    return 'error';
  }
  switch (state) {
    case 'passed': return 'pass';
    case 'failed': return 'fail';
    case 'skipped': return 'skip';
    default: return 'error';
  }
}

// Minimal structural type for the postgres-js client — avoids depending on the
// package's CJS default-export typing (which needs esModuleInterop and tripped a
// standalone tsc across the 22 workspaces that inherit this reporter).
export type PgSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  (rows: readonly Record<string, unknown>[], ...columns: string[]): unknown;
  end(opts?: { timeout?: number }): Promise<unknown>;
};
export type PgHandle = { sql: PgSql } | null;

// ONE shared pg client reused for EVERY per-file insert across the whole run,
// memoized as a PROMISE so the fire-and-forget per-file inserts can't race into
// creating multiple clients. A fresh client per file exhausted PG's connection
// slots at scale (operator-core ~950 files on a box near max_connections). Closed
// in onTestRunEnd/onExit. EXPORTED (with closeSharedPg) for the sibling
// executed-source-map reporter (P-002, gate-latency-selection-and-retry-policy-2026-09-06),
// which flushes through this same handle instead of opening a second client per run.
//
// WI-10003715: the handle is LEASED, never closed out from under a sibling. Vitest runs every
// reporter's onTestRunEnd CONCURRENTLY (Vitest.report → Promise.all), and both reporters used
// to call closeSharedPg() in their finally — so whichever finished first ended the client while
// the other was still mid-flush (the executed-source-map writer loops chunked queries), failing
// its next query with CONNECTION_ENDED. That silently dropped the pass proofs of the largest
// workspaces at the first green gate that recorded any (01a67545: web, harness, operator-vite,
// test-config). Each reporter now retainSharedPg()s in onInit and releases in onTestRunEnd/
// onExit; only the LAST release ends the client. Pinned (not a bare `let`) so a split module
// record cannot give the two reporters separate counts.
const sharedPg = pinModuleState('@papercusp/test-config.shared-pg', () => ({
  promise: undefined as Promise<PgHandle> | undefined,
  holders: 0,
}));

export function tryGetPg(): Promise<PgHandle> {
  if (sharedPg.promise) return sharedPg.promise;
  sharedPg.promise = (async (): Promise<PgHandle> => {
    try {
      // `?? mod` handles both the ESM-default and CJS-namespace interop shapes
      // without relying on esModuleInterop in every consumer's tsconfig.
      const mod = (await import('postgres')) as { default?: unknown };
      const pg = (mod.default ?? mod) as (url: string, opts: Record<string, unknown>) => PgSql;
      // The dedicated ledger variable wins (WI-10006736): an isolated verifier exports
      // HARNESS_ADMIN_DATABASE_URL at its throwaway database, so a run that must keep its
      // results points PAPERCUSP_TEST_RUNS_DB_URL at the shared ledger. Keep this order in
      // step with resolveExecutedMapPgUrl (scripts/lib/executed-source-map.mjs).
      const url =
        process.env.PAPERCUSP_TEST_RUNS_DB_URL ??
        process.env.HARNESS_ADMIN_DATABASE_URL ??
        'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
      const sql = pg(url, {
        max: 2,
        connect_timeout: reporterWriteBudget(process.env).connectTimeoutSec,
        onnotice: () => {},
      });
      return { sql };
    } catch (e) {
      if (process.env.PAPERCUSP_DEBUG_REPORTER) {
        try {
          const fs = await import('node:fs');
          fs.appendFileSync('/tmp/_rep_dbg', `${new Date().toISOString()} tryGetPg-fail: ${e instanceof Error ? e.message : String(e)}\n`);
        } catch { /* swallow */ }
      }
      return null;
    }
  })();
  return sharedPg.promise;
}

/** Hold the shared client for one reporter's run. The returned release is idempotent (a reporter
 *  releases from both onTestRunEnd and onExit), and it ends the client only when no other holder
 *  remains. WI-10003715. */
export function retainSharedPg(): () => Promise<void> {
  sharedPg.holders += 1;
  let released = false;
  return async () => {
    if (!released) {
      released = true;
      sharedPg.holders = Math.max(0, sharedPg.holders - 1);
    }
    await closeSharedPgIfUnheld();
  };
}

/** The release path for a reporter that never retained (e.g. unarmed): end the client only if
 *  no sibling still holds it, so a bystander can never cut a live flush short. WI-10003715. */
export async function closeSharedPgIfUnheld(): Promise<void> {
  if (sharedPg.holders === 0) await closeSharedPg();
}

/** Unconditional end of the shared client. Reporters must NOT call this directly — use the lease
 *  (retainSharedPg) or closeSharedPgIfUnheld; this stays exported for tests and teardown. */
export async function closeSharedPg(): Promise<void> {
  const p = sharedPg.promise;
  sharedPg.promise = undefined;
  if (!p) return;
  try {
    const handle = await p;
    if (handle?.sql) await handle.sql.end({ timeout: 2 });
  } catch {
    /* swallow — D-007 */
  }
}

/**
 * WI-6583 — harness_slug was populated on 2 of 647,266 rows, workspace_id on
 * 1,592, because this only ever checked ONE naming convention
 * (PAPERCUSP_TEST_RUN_HARNESS / PAPERCUSP_WORKSPACE_ID — a pair stamped only
 * by a deliberately harness-scoped "dogfood" run, P-007). That is not the
 * only place a test run's harness/workspace identity is knowable at write
 * time — it is simply the narrowest. Two OTHER naming conventions already
 * carry the same information on the vast majority of REAL runs and were
 * never checked here:
 *   - `HARNESS_SLUG` (+ `PAPERCUSP_WORKSPACE_ID`) — stamped on every
 *     harness-spawned agent-role process
 *     (endpoint-route/routes/harness/spawn.ts).
 *   - `PAPERCUSP_HARNESS_SLUG` (+ `PAPERCUSP_WORKSPACE`) — stamped on an
 *     interactive su/psu shell session (the dev box this reporter itself
 *     runs on most often).
 * Checked in that order (most explicit override first). Exported so the
 * precedence is unit-testable without touching this function's PG/git IO.
 *
 * This does NOT undo the release gate's deliberate exclusion. green-checkpoint
 * REBUILDS its children's env from an ALLOWLIST rather than stripping keys from
 * the host's: `canonicalGreenCheckpointSourceEnv` (called by
 * `buildGreenCheckpointEnv`) keeps only `GREEN_CHECKPOINT_SOURCE_ENV_KEYS` plus
 * the `AFFECTED_` / `VITEST_` prefixes, so neither `PAPERCUSP_*` nor
 * `HARNESS_SLUG` survives into the child. It then stamps only what IT wants,
 * specifically so its rows stay unattributed
 * (`source='ci'` rows are about the checkpoint tree, not one hive's own suite).
 */
function concreteTestRunHarnessSlug(value: string | null | undefined): string | null {
  const slug = value?.trim();
  if (!slug || slug === '*' || slug.toLowerCase() === 'all') return null;
  return slug;
}

export function resolveTestRunHarnessSlug(): string | null {
  return concreteTestRunHarnessSlug(
    process.env.PAPERCUSP_TEST_RUN_HARNESS ||
    process.env.HARNESS_SLUG ||
    process.env.PAPERCUSP_HARNESS_SLUG ||
    null,
  );
}

/**
 * Sibling of {@link resolveTestRunHarnessSlug} — see its doc comment.
 *
 * `PAPERCUSP_TEST_RUN_WORKSPACE` is the ledger-only override and wins, mirroring
 * `PAPERCUSP_TEST_RUN_HARNESS`. It exists because the isolated verify-tauri-headless rig
 * rebinds `PAPERCUSP_WORKSPACE_ID` to its throwaway `verify-tauri-isolated-<display>`
 * workspace for the app under test, so an isolated e2e run's SHARED-ledger rows were
 * stamped with a workspace that no workspace-scoped reader (spec-evidence binding, the
 * Tests tab) will ever match — measured 2026-10-06, rows 20845991/20845992. The runner
 * (scripts/run-operator-e2e-isolated.sh) pins it to the caller's workspace before the rig
 * starts; the app still sees the isolated id. Same shape as PAPERCUSP_TEST_RUNS_DB_URL.
 */
export function resolveTestRunWorkspaceId(): string | null {
  return (
    process.env.PAPERCUSP_TEST_RUN_WORKSPACE ||
    process.env.PAPERCUSP_WORKSPACE_ID ||
    process.env.PAPERCUSP_WORKSPACE ||
    null
  );
}

const TEST_RUN_INSERT_COLUMNS = [
  'file_path',
  'framework',
  'status',
  'duration_ms',
  'started_at',
  'finished_at',
  'output_tail',
  'run_group_id',
  'source',
  'branch',
  'commit_sha',
  'harness_slug',
  'workspace_id',
  'loop_lag_p95_ms',
  'rss_mb',
  'is_scratch_config',
  'worktree_dirty',
  'execution_details',
] as const;

// 500 rows × 18 columns = 9,000 bind parameters, comfortably below Postgres's
// 65,535-parameter ceiling even for a full unsharded workspace run.
export const TEST_RUN_INSERT_BATCH_SIZE = 500;

/**
 * WI-10006245: a run whose rows are EVIDENCE (a mutation probe binding its
 * mutant FAIL row) names a receipt file. Every row this reporter tries to write
 * gets one JSON line there: `inserted` with the test_runs id, `timeout` (the row
 * may still have landed), or `failed` with the reason. Without it every failure
 * below is swallowed (D-007), which is how three caught mutants left no row and
 * nothing said so until a bind found nothing to bind.
 */
export const TEST_RUN_RECEIPT_ENV = 'PAPERCUSP_TEST_RUN_RECEIPT_FILE';

export type TestRunReceipt =
  | { filePath: string; status: string; outcome: 'inserted'; id: string }
  | { filePath: string; status: string; outcome: 'timeout' | 'failed'; reason: string };

export function appendTestRunReceipts(env: NodeJS.ProcessEnv, receipts: readonly TestRunReceipt[]): void {
  const file = env[TEST_RUN_RECEIPT_ENV]?.trim();
  if (!file || receipts.length === 0) return;
  try {
    appendFileSync(file, receipts.map((receipt) => `${JSON.stringify(receipt)}\n`).join(''));
  } catch {
    /* fail-soft — D-007: a receipt is a report, never a reason to fail the run */
  }
}

/**
 * Write budget. The 1s connect / 1s per-batch / 4.5s total / 5s flush defaults
 * keep an ordinary run from ever stalling on the ledger. An evidence run (one
 * that names a receipt file) gets a longer budget, because a missing row there
 * costs a whole re-run. Suspected cause of the missing mutant rows: this budget
 * expiring while the gate held the box [inferred — the receipt reason is what
 * confirms or refutes it].
 */
export function reporterWriteBudget(env: NodeJS.ProcessEnv): {
  connectTimeoutSec: number;
  insertTimeoutMs: number;
  totalInsertMs: number;
  flushBudgetMs: number;
} {
  return env[TEST_RUN_RECEIPT_ENV]?.trim()
    ? { connectTimeoutSec: 10, insertTimeoutMs: 15_000, totalInsertMs: 25_000, flushBudgetMs: 30_000 }
    : { connectTimeoutSec: 1, insertTimeoutMs: 1_000, totalInsertMs: 4_500, flushBudgetMs: 5_000 };
}

function receiptReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200) || 'unknown';
}

function unwrittenReceipts(rows: readonly TestRunRow[], outcome: 'timeout' | 'failed', reason: string): TestRunReceipt[] {
  return rows.map((row) => ({ filePath: row.filePath, status: row.status, outcome, reason }));
}

type TestRunInsertContext = {
  branch: string | null;
  inferredCommit: string | null;
  declaredSource: TestRunSource;
  runGroupId: string | null;
  harnessSlug: string | null;
  workspaceId: string | null;
  loopLagP95Ms: number | null;
  rssMb: number | null;
};

function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveP) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    promise.then(() => finish(true), () => finish(false));
  });
}

/**
 * Persist a completed run through a bounded number of sequential bulk statements.
 *
 * The old implementation launched one Postgres.js query per file concurrently and
 * raced only the JavaScript waiters. A timed-out waiter does NOT cancel its queued
 * query, so a 674-file shard left hundreds of queries behind a two-connection client;
 * Vitest then spent 34 seconds draining that hidden queue after printing its terminal
 * summary. One sequential bulk query may still time out, but there can never be more
 * than that single in-flight query for closeSharedPg() to destroy.
 */
export async function insertTestRunRowsWithSql(
  sql: PgSql,
  rows: readonly TestRunRow[],
  context: TestRunInsertContext,
  budget: Pick<ReturnType<typeof reporterWriteBudget>, 'insertTimeoutMs' | 'totalInsertMs'> = reporterWriteBudget(process.env),
): Promise<TestRunReceipt[]> {
  const receipts: TestRunReceipt[] = [];
  const deadline = Date.now() + budget.totalInsertMs;
  for (let offset = 0; offset < rows.length; offset += TEST_RUN_INSERT_BATCH_SIZE) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      receipts.push(...unwrittenReceipts(rows.slice(offset), 'timeout', `flush_deadline_${budget.totalInsertMs}ms`));
      return receipts;
    }
    const sourceRows = rows.slice(offset, offset + TEST_RUN_INSERT_BATCH_SIZE);
    const batch = sourceRows
      .map((row) => ({
        file_path: row.filePath,
        framework: 'vitest',
        status: row.status,
        duration_ms: row.durationMs,
        // postgres-js's multi-row helper rejects Date objects. ISO strings retain
        // the same timestamptz value while keeping the helper's type inference valid.
        started_at: row.startedAt.toISOString(),
        finished_at: row.finishedAt.toISOString(),
        output_tail: row.outputTail,
        run_group_id: context.runGroupId,
        source: resolveRecordedTestRunSource(context.declaredSource, row.worktreeDirty),
        branch: context.branch,
        commit_sha: resolveTestRunCommit(row.commitSha ?? context.inferredCommit),
        harness_slug: context.harnessSlug,
        workspace_id: context.workspaceId,
        loop_lag_p95_ms: context.loopLagP95Ms,
        rss_mb: context.rssMb,
        is_scratch_config: row.isScratchConfig,
        worktree_dirty: row.worktreeDirty,
        // EI-24799048791133095: pass the OBJECT. This client keeps postgres-js's
        // default jsonb serializer (JSON.stringify), so a pre-stringified value was
        // encoded twice and stored as a jsonb STRING scalar; every
        // `execution_details->>'key'` read then returned NULL.
        execution_details: row.executionDetails ?? null,
      }));
    let written: unknown;
    let failure: unknown = null;
    const query = Promise.resolve(sql`
      INSERT INTO harness_shared.test_runs
        ${sql(batch, ...TEST_RUN_INSERT_COLUMNS)}
      RETURNING id, file_path
    `).then(
      (value) => { written = value; },
      (error) => { failure = error ?? new Error('insert_rejected'); throw failure; },
    );
    const timeoutMs = Math.min(budget.insertTimeoutMs, remainingMs);
    const completed = await settleWithin(query, timeoutMs);
    if (!completed) {
      receipts.push(
        ...(failure
          ? unwrittenReceipts(sourceRows, 'failed', receiptReason(failure))
          : unwrittenReceipts(sourceRows, 'timeout', `pg_insert_timeout_${timeoutMs}ms`)),
        // Later batches are never attempted once one has not completed.
        ...unwrittenReceipts(rows.slice(offset + TEST_RUN_INSERT_BATCH_SIZE), 'timeout', 'not_attempted_after_failed_batch'),
      );
      return receipts;
    }
    receipts.push(...insertedReceipts(sourceRows, written));
  }
  return receipts;
}

/**
 * Pair RETURNING rows back to the rows we sent. Matched by file_path (multiset), not
 * position: Postgres does not promise RETURNING order for a multi-row insert.
 */
function insertedReceipts(sourceRows: readonly TestRunRow[], written: unknown): TestRunReceipt[] {
  const returned = Array.isArray(written) ? (written as Array<{ id?: unknown; file_path?: unknown }>) : [];
  const idsByPath = new Map<string, string[]>();
  for (const row of returned) {
    if (row?.id === undefined || row.id === null || typeof row.file_path !== 'string') continue;
    const ids = idsByPath.get(row.file_path) ?? [];
    ids.push(String(row.id));
    idsByPath.set(row.file_path, ids);
  }
  return sourceRows.map((row): TestRunReceipt => {
    const id = idsByPath.get(row.filePath)?.shift();
    return id === undefined
      ? { filePath: row.filePath, status: row.status, outcome: 'failed', reason: 'insert_returned_no_id' }
      : { filePath: row.filePath, status: row.status, outcome: 'inserted', id };
  });
}

/**
 * The ledger writer every recorder shares: git context, source (ci/local/mutation-probe),
 * harness/workspace scope and saturation, then one bounded bulk insert. Exported so the
 * node:test recorder (node-test-ledger.ts, EI-24836213046334894) writes rows with exactly
 * the semantics this Vitest reporter does instead of a parallel copy.
 */
export async function insertRows(rows: readonly TestRunRow[]): Promise<void> {
  if (rows.length === 0) return;
  let branch: string | null = null;
  let inferredCommit: string | null = null;
  try {
    const ctx = await resolveGitContext();
    branch = ctx.branch;
    inferredCommit = ctx.commit;
  } catch { /* fail-soft */ }

  const pg = await tryGetPg();
  if (!pg) {
    appendTestRunReceipts(process.env, unwrittenReceipts(rows, 'failed', 'pg_unavailable'));
    return;
  }

  const { loopLagP95Ms, rssMb } = captureReporterSaturationSnapshot();
  try {
    const receipts = await insertTestRunRowsWithSql(pg.sql, rows, {
      branch,
      inferredCommit,
      declaredSource: resolveTestRunSource(),
      runGroupId: process.env.PAPERCUSP_TEST_RUN_GROUP ?? null,
      harnessSlug: resolveTestRunHarnessSlug(),
      workspaceId: resolveTestRunWorkspaceId(),
      loopLagP95Ms,
      rssMb,
    });
    appendTestRunReceipts(process.env, receipts);
  } catch (error) {
    /* swallow — D-007; an evidence run still learns why through its receipt */
    appendTestRunReceipts(process.env, unwrittenReceipts(rows, 'failed', receiptReason(error)));
  }
}

/**
 * Build the `output_tail` for a module's row: module-level errors (import /
 * setup crashes) first, else — for a FAILED module — the failed test cases'
 * error messages. Without the second leg every assertion-failure row landed
 * with an EMPTY tail, so triaging a red chip on the Tests tab always required
 * a local re-run (2026-06-11 overnight-loop forensics: four flake rows from a
 * box-wide pkill incident were indistinguishable from real regressions).
 * Structurally typed + fail-soft per D-007 — a reporter must never throw.
 * Exported for tests.
 */
export function buildOutputTail(
  testModule: TestModule,
  status: TestRunRow['status'],
): string | null {
  let tail: string | null = null;
  try {
    const errs = testModule.errors?.() ?? [];
    if (errs.length > 0) {
      tail = errs
        .map((e: unknown) => formatTestCaseError(e))
        .join('\n')
        .slice(-4000);
    }
  } catch { /* fail-soft */ }
  if (tail || status !== 'fail') return tail;
  try {
    const lines: string[] = [];
    const collection = (testModule as unknown as {
      children?: { allTests?: () => Iterable<unknown> };
    }).children;
    for (const t of collection?.allTests?.() ?? []) {
      const tc = t as {
        fullName?: string;
        result?: () => { state?: string; errors?: ReadonlyArray<{ message?: string } | undefined> };
      };
      const res = tc.result?.();
      if (res?.state !== 'failed') continue;
      for (const e of res.errors ?? []) {
        lines.push(`${tc.fullName ?? '(test)'}: ${formatTestCaseError(e)}`);
        if (lines.length >= 20) break;
      }
      if (lines.length >= 20) break;
    }
    if (lines.length > 0) tail = lines.join('\n').slice(-4000);
  } catch { /* fail-soft */ }
  return tail;
}

function collectTestFailureDetails(testModule: TestModule, file: string): TestFailureDetail[] {
  const details: TestFailureDetail[] = [];
  // Tracks "did collection get far enough to discover at least one failing
  // test case", independently of `details` — the loop below only PUSHES a
  // detail when the error carries a structured actual/expected diff (this
  // sidecar exists to recover values Vitest's own JSON reporter elides), so a
  // plain-message test failure leaves `details` empty despite collection
  // having succeeded. Conflating the two would misclassify that case as a
  // collection crash below (EI-22137062583459326 test 2 caught exactly this).
  let sawFailingTestCase = false;
  try {
    const collection = (testModule as unknown as {
      children?: { allTests?: () => Iterable<unknown> };
    }).children;
    for (const t of collection?.allTests?.() ?? []) {
      const tc = t as {
        fullName?: string;
        result?: () => {
          state?: string;
          errors?: ReadonlyArray<{ message?: unknown; actual?: unknown; expected?: unknown } | undefined>;
        };
      };
      const result = tc.result?.();
      if (result?.state !== 'failed') continue;
      sawFailingTestCase = true;
      const test = typeof tc.fullName === 'string' && tc.fullName.trim() ? tc.fullName : '(test)';
      for (const error of result.errors ?? []) {
        if (!error) continue;
        const detail: TestFailureDetail = { file, test };
        const message = errorField(error, 'message');
        const actual = errorField(error, 'actual');
        const expected = errorField(error, 'expected');
        if (message !== undefined) detail.message = boundFailureText(stringifyFailureValue(message));
        if (actual !== undefined) detail.actual = boundFailureText(stringifyFailureValue(actual));
        if (expected !== undefined) detail.expected = boundFailureText(stringifyFailureValue(expected));
        if (detail.actual !== undefined || detail.expected !== undefined) details.push(detail);
        break;
      }
      if (details.length >= 20) break;
    }
  } catch {
    /* fail-soft */
  }
  // EI-22137062583459326: a module that fails to COLLECT (e.g. a `beforeAll`
  // throw) registers no failing test case above — Vitest never got past setup
  // to discover any, so `allTests()` is empty and `sawFailingTestCase` stays
  // false. Vitest's own `--reporter=json` frequently omits
  // `testResults[].message` for that same file-level entry too, so
  // distillVitestRun's enrichFailure (testing-run-store.ts) has nothing to
  // enrich with and the agent sees "(no failure message reported)" instead of
  // the real thrown error — observed: a PostgresError 42P07 fixture DDL
  // collision, surfaced only as a silent "14 skipped". Fill the SAME sidecar
  // key distillVitestRun looks up for a collection failure
  // (COLLECTION_FAILURE_TEST) from the module-level error Vitest DOES expose
  // via testModule.errors() — the same source buildOutputTail already uses
  // for the DB row's output_tail, so this is no new capability, just wiring
  // the existing signal into the sidecar too. Gated on `!sawFailingTestCase`,
  // never on `details.length`, so a real per-test failure that merely lacks a
  // structured diff is never misreported as a collection crash.
  if (!sawFailingTestCase) {
    try {
      if (moduleStatus(testModule) === 'fail') {
        const errs = testModule.errors?.() ?? [];
        if (errs.length > 0) {
          const message = formatTestCaseError(errs[0]);
          if (message) {
            details.push({ file, test: COLLECTION_FAILURE_TEST, message: boundFailureText(message) });
          }
        }
      }
    } catch {
      /* fail-soft */
    }
  }
  return details;
}

/**
 * EI-18767688096795873: the onInit glue, pulled out pure/exported so the
 * try/catch + defaulting is directly unit-testable without touching the
 * reporter's private field. Vitest's OWN `ctx.config` (ResolvedConfig)
 * deliberately omits `config`/`configFile` (see its `Omit<...>` in vitest's
 * types) — the resolved path to the config file actually used lives on the
 * underlying Vite dev server's resolved config instead. Defaults to `false`
 * (trust the run) on ANY read failure, matching the "only ever suppress a
 * false positive" contract.
 */
export function computeIsScratchConfig(ctx: Pick<Vitest, 'vite'>): boolean {
  try {
    return isScratchConfigFile(ctx.vite.config.configFile, resolveRecordRoot());
  } catch {
    return false;
  }
}

type PendingExecutionDetails = Omit<
  NonNullable<TestRunRow['executionDetails']>,
  'filePath' | 'passed' | 'failed' | 'skipped' | 'collectionFailed' | 'commitSha' | 'worktreeDirty'
> & Pick<NonNullable<TestRunRow['executionDetails']>, 'filePath' | 'passed' | 'failed' | 'skipped' | 'collectionFailed'>;
type PendingTestRunRow = Omit<TestRunRow, 'worktreeDirty' | 'commitSha' | 'executionDetails'> & {
  executionDetails?: PendingExecutionDetails | null;
};

type RuntimeEnvironmentCapture =
  | { status: 'captured'; witness: RecordedRuntimeEnvironment }
  | { status: Exclude<RuntimeEnvironmentCaptureStatus, 'captured'> };

export default class AdminTestRunsReporter implements Reporter {
  private pending: PendingTestRunRow[] = [];
  /** Captured in onInit, before Vitest starts executing test modules. */
  private worktreeBefore: Promise<WorktreeGitSnapshot> | null = null;
  /** Vitest can call both onTestRunEnd and onExit; flush rows exactly once. */
  private flushed = false;
  /** EI-18767688096795873: computed once in onInit from the run's resolved
   *  config file — see computeIsScratchConfig / isScratchConfigFile. */
  private isScratchConfig = false;
  /** Optional structured assertion values for testing:run's private sidecar. */
  private failureDetails: TestFailureDetail[] = [];
  private failureDetailsFlushed = false;
  private executionContext: Omit<NonNullable<TestRunRow['executionDetails']>,
    'filePath' | 'passed' | 'failed' | 'skipped' | 'collectionFailed' | 'commitSha' | 'worktreeDirty'> | null = null;

  constructor(
    readWorktreeSnapshotOrOptions?: WorktreeSnapshotReader | Record<string, unknown>,
    writeRow?: TestRunRowWriter,
    writeRows?: TestRunRowsWriter,
    readRuntimeEnvironment?: () => Promise<RecordedRuntimeEnvironment | null>,
  ) {
    // Vitest constructs reporters with its options object. Keep that runtime
    // contract intact while allowing the unit suite to inject deterministic
    // snapshot/writer seams.
    this.readWorktreeSnapshot =
      typeof readWorktreeSnapshotOrOptions === 'function' ? readWorktreeSnapshotOrOptions : captureWorktreeSnapshot;
    this.writeRows =
      writeRows ??
      (writeRow
        ? async (rows) => {
            await Promise.allSettled(rows.map((row) => writeRow(row)));
          }
        : insertRows);
    const configuredReader = typeof readWorktreeSnapshotOrOptions === 'object'
      ? readWorktreeSnapshotOrOptions?.readRuntimeEnvironment : undefined;
    this.readRuntimeEnvironment = readRuntimeEnvironment ??
      (typeof configuredReader === 'function'
        ? configuredReader as () => Promise<RecordedRuntimeEnvironment | null> : undefined);
  }

  private readonly readWorktreeSnapshot: WorktreeSnapshotReader;
  private readonly writeRows: TestRunRowsWriter;
  private readonly readRuntimeEnvironment?: () => Promise<RecordedRuntimeEnvironment | null>;

  private async captureRuntimeEnvironment(): Promise<RuntimeEnvironmentCapture> {
    if (!this.readRuntimeEnvironment) return { status: 'not-configured' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('runtime-environment-capture-timeout');
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => this.readRuntimeEnvironment!()),
        new Promise<typeof timedOut>(resolve => { timer = setTimeout(() => resolve(timedOut), 1_000); }),
      ]);
      if (result === timedOut) return { status: 'timed-out' };
      if (result === null) return { status: 'unavailable' };
      const parsed = parseRecordedRuntimeEnvironment(result);
      if (!parsed) return { status: 'invalid' };
      // The reporter owns the observation instant. A reader cannot backdate it.
      return { status: 'captured', witness: { ...parsed, units: [...parsed.units], observedAt: new Date().toISOString() } };
    } catch { return { status: 'error' }; }
    finally { if (timer) clearTimeout(timer); }
  }
  private preferredPassedCasePattern?: RegExp;

  /** WI-10003715: this reporter's lease on the shared PG client (see retainSharedPg). */
  private pgLease: (() => Promise<void>) | null = null;

  async onInit(ctx: Vitest): Promise<void> {
    // Select which actually passing identities occupy the existing bounded
    // evidence field, without filtering execution or changing skip counts.
    // Late cases in a large suite otherwise have no full-suite proof path.
    const preferredTitles = process.env.PAPERCUSP_TEST_RUN_CASE_TITLE_PATTERN?.trim();
    this.preferredPassedCasePattern = preferredTitles ? new RegExp(preferredTitles) : undefined;
    this.pgLease ??= retainSharedPg();
    // WI-10000776 — FIRST (after the lease above, which reads no root), before anything reads a root. Vitest calls onInit before it
    // executes any test module, so this is the one moment the checkout under test is
    // known and nothing has been relativized yet. Both statements below resolve a root
    // (computeIsScratchConfig → resolveRecordRoot; the snapshot → git in that root), so
    // ordering here is load-bearing, not stylistic.
    setRunRoot(readRunConfigRoot(ctx));
    this.isScratchConfig = computeIsScratchConfig(ctx);
    this.worktreeBefore = this.readWorktreeSnapshot();
    this.flushed = false;
    this.failureDetails = [];
    this.failureDetailsFlushed = false;
    this.executionContext = {
      schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
      root: resolveRecordRoot(),
      runGroupId: process.env.PAPERCUSP_TEST_RUN_GROUP ?? null,
      workspaceId: resolveTestRunWorkspaceId(),
      harnessSlug: resolveTestRunHarnessSlug(),
      testNamePattern: ctx?.config?.testNamePattern?.source ?? null,
      testLayer: recordedTestLayer({ schemaVersion: 1,
        testLayer: (ctx?.config?.provide as Record<string, unknown> | undefined)?.papercuspTestLayer }),
      mutationPhase: resolveMutationProbePhase(),
    };
    const runtimeEnvironmentBefore = await this.captureRuntimeEnvironment();
    this.executionContext.runtimeEnvironmentBeforeCaptureStatus = runtimeEnvironmentBefore.status;
    if (runtimeEnvironmentBefore.status === 'captured')
      this.executionContext.runtimeEnvironmentBefore = runtimeEnvironmentBefore.witness;
  }

  /** Per-module hook — queue the row until the end snapshot is available. */
  onTestModuleEnd(testModule: TestModule): void {
    try {
      const filePath = toWorkspaceRel(testModule.moduleId);
      if (!shouldRecordTestRunPath(filePath)) return;
      const status = moduleStatus(testModule);
      let durationMsRaw = 0;
      try {
        durationMsRaw = testModule.diagnostic().duration ?? 0;
      } catch { /* fail-soft */ }
      const finishedAt = new Date();
      const durationMs = Math.round(durationMsRaw);
      const startedAt = new Date(finishedAt.getTime() - durationMs);

      const outputTail = buildOutputTail(testModule, status);
      this.failureDetails.push(...collectTestFailureDetails(testModule, filePath));

      const counts = collectModuleExecution(testModule, this.preferredPassedCasePattern);
      // Root and project configs may differ in a multi-project run. The module's
      // project wins; absence there stays unknown instead of inheriting a root label.
      const testLayer = testModule.project
        ? recordedTestLayer({ schemaVersion: 1,
            testLayer: (testModule.project.config.provide as Record<string, unknown> | undefined)?.papercuspTestLayer })
        : this.executionContext?.testLayer;
      const executionDetails = counts && this.executionContext
        ? { ...this.executionContext, testLayer, filePath, ...counts } : null;
      this.pending.push({ filePath, status, durationMs, startedAt, finishedAt, outputTail,
        isScratchConfig: this.isScratchConfig, executionDetails });
    } catch {
      /* swallow — D-007 */
    }
  }

  private async flushPending(): Promise<void> {
    if (this.flushed) return;
    this.flushed = true;
    if (this.pending.length === 0) return;

    let worktreeDirty = true;
    let dirtReason: string | null = 'snapshot not taken';
    let commitSha: string | null = null;
    try {
      const before = this.worktreeBefore ? await this.worktreeBefore : await this.readWorktreeSnapshot();
      const after = await this.readWorktreeSnapshot();
      dirtReason = describeWorktreeDirt(before, after);
      worktreeDirty = dirtReason !== null;
      commitSha = after.commit;
    } catch (err) {
      // D-007: missing proof of stability is dirty, never a false clean.
      worktreeDirty = true;
      dirtReason = `snapshot threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (worktreeDirty && resolveTestRunSource() === 'ci') {
      // WI-10004076: the demotion erases every row of this invocation from source='ci'
      // triage, and the tree that caused it is gone by the next run — say why, once.
      process.stderr.write(
        `[admin-test-runs] ${this.pending.length} row(s) recorded source=local, not ci: worktree not proven stable — ${dirtReason}\n`,
      );
    }

    const runtimeEnvironmentAfter = await this.captureRuntimeEnvironment();
    const rows = this.pending.splice(0).map((row) => ({
      ...row,
      worktreeDirty,
      commitSha,
      executionDetails: row.executionDetails
        ? { ...row.executionDetails, worktreeDirty, commitSha,
          ...(worktreeDirty && dirtReason ? { worktreeDirtyReason: dirtReason } : {}),
          runtimeEnvironmentAfterCaptureStatus: runtimeEnvironmentAfter.status,
          ...(runtimeEnvironmentAfter.status === 'captured'
            ? { runtimeEnvironmentAfter: runtimeEnvironmentAfter.witness } : {}) }
        : null,
    }));
    const { flushBudgetMs } = reporterWriteBudget(process.env);
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      this.writeRows(rows.map((row) => ({ ...row, worktreeDirty, commitSha }))).then(() => true),
      new Promise<false>((r) => {
        flushTimer = setTimeout(() => r(false), flushBudgetMs);
      }),
    ]);
    if (flushTimer) clearTimeout(flushTimer);
    if (!finished) {
      // The writer may still finish (and append its own `inserted` lines) before the
      // process exits; a reader takes `inserted` over `timeout` for the same file.
      appendTestRunReceipts(process.env, unwrittenReceipts(rows, 'timeout', `flush_budget_${flushBudgetMs}ms`));
    }
  }

  private flushFailureDetails(): void {
    if (this.failureDetailsFlushed) return;
    this.failureDetailsFlushed = true;
    const details = this.failureDetails.splice(0);
    writeFailureDetails(details);
  }

  async onTestRunEnd(): Promise<void> {
    try {
      await this.flushPending();
    } catch {
      /* swallow — D-007 */
    } finally {
      this.flushFailureDetails();
      await (this.pgLease ?? closeSharedPgIfUnheld)();
    }
  }

  async onExit(): Promise<void> {
    try {
      await this.flushPending();
    } catch {
      /* swallow — D-007 */
    } finally {
      this.flushFailureDetails();
      await (this.pgLease ?? closeSharedPgIfUnheld)();
    }
  }
}
