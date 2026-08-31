/**
 * admin-test-runs-reporter.ts — custom Vitest reporter that writes one row per
 * test FILE to harness_shared.test_runs. Powers the /admin/testing (+ /adv) status
 * chips without parsing Vitest output.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-010. Lifted into
 * @papercusp/test-config and AUTO-WIRED by defineVitestConfig (2026-06-08) so EVERY
 * workspace records — not just apps/operator + operator-core. Self-contained on
 * purpose (only node: builtins + a LAZY postgres import) so it can never fail to
 * LOAD in a lib that lacks operator-core; the 3 helpers it used to import
 * (resolveGitContext / inferWorkspaceRoot / resolveTestRunSource) are inlined below.
 *
 * D-007 fail-soft contract — LOAD-BEARING:
 *   - 1s connect timeout; ONE shared pg client reused for the whole run
 *   - swallow every PG / git / fs error; never throw out of any hook
 *   - never taint test output; never affect the process exit code
 *
 * Opt-out via PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1 (defineVitestConfig drops it).
 * Mutation probes set PAPERCUSP_MUTATION_PROBE=1; those deliberate baseline and
 * mutant outcomes are falsifiability evidence, not repository-health evidence,
 * so this reporter skips them entirely.
 *
 * Vitest 4 API: onTestModuleEnd (per file) + onTestRunEnd (flush). Older
 * onFinished/onTaskUpdate names from Vitest 1-3 are NOT called.
 */

import type { Reporter, TestModule, Vitest } from 'vitest/node';
import { exec } from 'node:child_process';
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';

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
    if (gitdir.includes('/worktrees/')) return 'root';
    return 'skip'; // `/modules/` (submodule) and every unrecognised shape
  } catch {
    return 'skip';
  }
}

// ── inlined: inferWorkspaceRoot — find the true SUPERPROJECT root so recorded
//    file paths are monorepo-relative (the tab's registry globs expect that). ──
let _cachedRoot: string | null = null;
function inferWorkspaceRoot(from = process.cwd()): string {
  if (_cachedRoot) return _cachedRoot;
  // Walk up to the first ancestor that {@link classifyGitEntry} calls a repo
  // root — a `.git` DIRECTORY, or a linked-WORKTREE gitlink. CRITICAL: a git
  // SUBMODULE also carries a `.git` FILE (a gitlink) and must be SKIPPED. The
  // original `existsSync('.git')` check stopped at the submodule, so a submodule
  // workspace recorded SUBMODULE-relative paths (e.g. `packages/orchestrator/…`
  // or `grid-core/src/…`) instead of the monorepo-relative
  // `libs/papercusp/packages/orchestrator/…` / `libs/generic/papergrid/grid-core/src/…`
  // the tab globs match → those rows were invisible in the tab. The fix for THAT
  // (skip every `.git` file) then over-corrected into the worktree bug described
  // on classifyGitEntry, which is why the two cases are now told apart explicitly.
  let dir = resolve(from);
  while (true) {
    if (classifyGitEntry(dir) === 'root') {
      _cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  _cachedRoot = from;
  return from;
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
type TestRunSource = 'ci' | 'local' | 'admin-ui';
const VALID_SOURCES: ReadonlySet<TestRunSource> = new Set(['ci', 'local', 'admin-ui']);
function resolveTestRunSource(): TestRunSource {
  const override = process.env.PAPERCUSP_TEST_RUN_SOURCE;
  if (override && VALID_SOURCES.has(override as TestRunSource)) return override as TestRunSource;
  return process.env.CI ? 'ci' : 'local';
}

/**
 * Mutation-probe runs deliberately produce a baseline and usually a failing
 * mutant result. Neither is a repository-health measurement, so the reporter
 * must not enqueue either row for harness_shared.test_runs.
 *
 * Exported so the marker contract is unit-testable without connecting to PG.
 */
export function isMutationProbeRun(): boolean {
  return process.env.PAPERCUSP_MUTATION_PROBE === '1';
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

export function computeWorktreeDirty(before: WorktreeGitSnapshot, after: WorktreeGitSnapshot): boolean {
  if (!before.commit || !after.commit) return true;
  if (before.commit !== after.commit) return true;
  if (before.porcelain === null || after.porcelain === null) return true;
  if (before.porcelain.trim().length > 0) return true;
  if (after.porcelain.trim().length > 0) return true;
  return false;
}

let _gitCache: { value: GitContext; expiresAt: number } | null = null;
function runGit(cmd: string, cwd: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolveP) => {
    try {
      const child = exec(cmd, { cwd, timeout: timeoutMs }, (err, stdout) => {
        resolveP(err ? null : stdout.trim());
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
  const root = inferWorkspaceRoot();
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
 * Snapshot the whole shared tree rather than only the currently reported
 * module. Vitest's onInit hook runs before module discovery, and an unrelated
 * generated artifact can still invalidate the commit identity stamped on a
 * row. The fail-safe null handling in computeWorktreeDirty makes git timeout
 * or failure visible as dirty instead of silently restoring the old default.
 */
async function captureWorktreeSnapshot(): Promise<WorktreeGitSnapshot> {
  const root = inferWorkspaceRoot();
  const [commit, porcelain] = await Promise.all([
    runGit('git rev-parse HEAD', root, 2_000),
    runGit('git status --porcelain --untracked-files=all', root, 2_000),
  ]);
  return { commit, porcelain };
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
}

/** A structured assertion detail captured from Vitest's TestCase result. */
export interface TestFailureDetail {
  file: string;
  test: string;
  message?: string;
  actual?: string;
  expected?: string;
}

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

export function captureReporterSaturationSnapshot(): { loopLagP95Ms: number | null; rssMb: number | null } {
  // This reporter is a child process. Its event loop is mostly idle while
  // Vitest workers run, so it cannot measure the operator host loop used by
  // testing:runs' critical-band classifier. Persist no false-provenance
  // sample; the reader will expose saturationSuspect as unknown.
  let rssMb: number | null = null;
  try {
    rssMb = Math.round((process.memoryUsage().rss / 1_048_576) * 10) / 10;
  } catch {
    rssMb = null;
  }
  return { loopLagP95Ms: null, rssMb };
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
  const root = inferWorkspaceRoot();
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
type PgSql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>) & {
  end(opts?: { timeout?: number }): Promise<unknown>;
};
type PgHandle = { sql: PgSql } | null;

// ONE shared pg client reused for EVERY per-file insert across the whole run,
// memoized as a PROMISE so the fire-and-forget per-file inserts can't race into
// creating multiple clients. A fresh client per file exhausted PG's connection
// slots at scale (operator-core ~950 files on a box near max_connections). Closed
// in onTestRunEnd/onExit.
let _pgPromise: Promise<PgHandle> | undefined;

function tryGetPg(): Promise<PgHandle> {
  if (_pgPromise) return _pgPromise;
  _pgPromise = (async (): Promise<PgHandle> => {
    try {
      // `?? mod` handles both the ESM-default and CJS-namespace interop shapes
      // without relying on esModuleInterop in every consumer's tsconfig.
      const mod = (await import('postgres')) as { default?: unknown };
      const pg = (mod.default ?? mod) as (url: string, opts: Record<string, unknown>) => PgSql;
      const url =
        process.env.HARNESS_ADMIN_DATABASE_URL ??
        process.env.PAPERCUSP_TEST_RUNS_DB_URL ??
        'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
      const sql = pg(url, { max: 2, connect_timeout: 1, onnotice: () => {} });
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
  return _pgPromise;
}

async function closeSharedPg(): Promise<void> {
  const p = _pgPromise;
  _pgPromise = undefined;
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
export function resolveTestRunHarnessSlug(): string | null {
  return (
    process.env.PAPERCUSP_TEST_RUN_HARNESS ||
    process.env.HARNESS_SLUG ||
    process.env.PAPERCUSP_HARNESS_SLUG ||
    null
  );
}

/** Sibling of {@link resolveTestRunHarnessSlug} — see its doc comment. */
export function resolveTestRunWorkspaceId(): string | null {
  return process.env.PAPERCUSP_WORKSPACE_ID || process.env.PAPERCUSP_WORKSPACE || null;
}

async function insertRow(row: TestRunRow): Promise<void> {
  let branch: string | null = null;
  let commit: string | null = null;
  try {
    const ctx = await resolveGitContext();
    branch = ctx.branch;
    commit = ctx.commit;
  } catch { /* fail-soft */ }

  const pg = await tryGetPg();
  if (!pg) return;

  const source = resolveTestRunSource();
  const runGroupId = process.env.PAPERCUSP_TEST_RUN_GROUP ?? null;
  const harnessSlug = resolveTestRunHarnessSlug();
  const workspaceId = resolveTestRunWorkspaceId();
  const { loopLagP95Ms, rssMb } = captureReporterSaturationSnapshot();

  try {
    await Promise.race([
      pg.sql`
        INSERT INTO harness_shared.test_runs
          (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha, harness_slug, workspace_id, loop_lag_p95_ms, rss_mb, is_scratch_config, worktree_dirty)
        VALUES
          (${row.filePath}, 'vitest', ${row.status}, ${row.durationMs}, ${row.startedAt},
           ${row.finishedAt}, ${row.outputTail}, ${runGroupId}, ${source}, ${branch}, ${commit}, ${harnessSlug}, ${workspaceId}, ${loopLagP95Ms}, ${rssMb}, ${row.isScratchConfig}, ${row.worktreeDirty})
      `,
      new Promise((_, reject) => setTimeout(() => reject(new Error('pg_insert_timeout')), 1000)),
    ]).catch(() => {
      /* swallow — D-007 */
    });
  } catch {
    /* swallow — D-007 */
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
    return isScratchConfigFile(ctx.vite.config.configFile, inferWorkspaceRoot());
  } catch {
    return false;
  }
}

type PendingTestRunRow = Omit<TestRunRow, 'worktreeDirty'>;

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

  constructor(
    readWorktreeSnapshotOrOptions?: WorktreeSnapshotReader | Record<string, unknown>,
    writeRow?: TestRunRowWriter,
  ) {
    // Vitest constructs reporters with its options object. Keep that runtime
    // contract intact while allowing the unit suite to inject deterministic
    // snapshot/writer seams.
    this.readWorktreeSnapshot =
      typeof readWorktreeSnapshotOrOptions === 'function' ? readWorktreeSnapshotOrOptions : captureWorktreeSnapshot;
    this.writeRow = writeRow ?? insertRow;
  }

  private readonly readWorktreeSnapshot: WorktreeSnapshotReader;
  private readonly writeRow: TestRunRowWriter;

  onInit(ctx: Vitest): void {
    this.isScratchConfig = computeIsScratchConfig(ctx);
    this.worktreeBefore = this.readWorktreeSnapshot();
    this.flushed = false;
    this.failureDetails = [];
    this.failureDetailsFlushed = false;
  }

  /** Per-module hook — queue the row until the end snapshot is available. */
  onTestModuleEnd(testModule: TestModule): void {
    try {
      if (isMutationProbeRun()) return;
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

      this.pending.push({ filePath, status, durationMs, startedAt, finishedAt, outputTail, isScratchConfig: this.isScratchConfig });
    } catch {
      /* swallow — D-007 */
    }
  }

  private async flushPending(): Promise<void> {
    if (this.flushed) return;
    this.flushed = true;
    if (this.pending.length === 0) return;

    let worktreeDirty = true;
    try {
      const before = this.worktreeBefore ? await this.worktreeBefore : await this.readWorktreeSnapshot();
      const after = await this.readWorktreeSnapshot();
      worktreeDirty = computeWorktreeDirty(before, after);
    } catch {
      // D-007: missing proof of stability is dirty, never a false clean.
      worktreeDirty = true;
    }

    const rows = this.pending.splice(0);
    await Promise.race([
      Promise.allSettled(rows.map((row) => this.writeRow({ ...row, worktreeDirty }))),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
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
      await closeSharedPg();
    }
  }

  async onExit(): Promise<void> {
    try {
      await this.flushPending();
    } catch {
      /* swallow — D-007 */
    } finally {
      this.flushFailureDetails();
      await closeSharedPg();
    }
  }
}
