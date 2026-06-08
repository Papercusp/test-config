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
 *
 * Vitest 4 API: onTestModuleEnd (per file) + onTestRunEnd (flush). Older
 * onFinished/onTaskUpdate names from Vitest 1-3 are NOT called.
 */

import type { Reporter, TestModule, Vitest } from 'vitest/node';
import { exec } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';

// ── inlined: inferWorkspaceRoot — find the true SUPERPROJECT root so recorded
//    file paths are monorepo-relative (the tab's registry globs expect that). ──
let _cachedRoot: string | null = null;
function inferWorkspaceRoot(from = process.cwd()): string {
  if (_cachedRoot) return _cachedRoot;
  // Walk up to the first ancestor whose `.git` is a DIRECTORY — the superproject
  // root. CRITICAL: a git SUBMODULE carries a `.git` FILE (a gitlink), which we
  // must SKIP. The old `existsSync('.git')` check stopped at the submodule, so a
  // submodule workspace recorded SUBMODULE-relative paths (e.g.
  // `packages/orchestrator/…` or `grid-core/src/…`) instead of the monorepo-
  // relative `libs/papercusp/packages/orchestrator/…` / `libs/generic/papergrid/
  // grid-core/src/…` the tab globs match → those rows were invisible in the tab.
  let dir = resolve(from);
  while (true) {
    try {
      if (statSync(join(dir, '.git')).isDirectory()) {
        _cachedRoot = dir;
        return dir;
      }
    } catch {
      /* no `.git` at this level — keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  _cachedRoot = from;
  return from;
}

// ── inlined: resolveTestRunSource (was testing-run-source.ts). ──
type TestRunSource = 'ci' | 'local' | 'admin-ui';
const VALID_SOURCES: ReadonlySet<TestRunSource> = new Set(['ci', 'local', 'admin-ui']);
function resolveTestRunSource(): TestRunSource {
  const override = process.env.PAPERCUSP_TEST_RUN_SOURCE;
  if (override && VALID_SOURCES.has(override as TestRunSource)) return override as TestRunSource;
  return process.env.CI ? 'ci' : 'local';
}

// ── inlined: resolveGitContext (was testing-branch-resolve.ts). 200ms timeout,
//    cached 30s, fail-soft → {branch:null,commit:null}. ──
interface GitContext { branch: string | null; commit: string | null; }
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

interface TestRunRow {
  filePath: string; // workspace-relative POSIX
  status: 'pass' | 'fail' | 'skip' | 'cancelled' | 'error';
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  outputTail: string | null;
}

function toWorkspaceRel(absPath: string): string {
  const root = inferWorkspaceRoot();
  return relative(root, absPath).split(/[/\\]/).join(posix.sep);
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

  try {
    await Promise.race([
      pg.sql`
        INSERT INTO harness_shared.test_runs
          (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha)
        VALUES
          (${row.filePath}, 'vitest', ${row.status}, ${row.durationMs}, ${row.startedAt},
           ${row.finishedAt}, ${row.outputTail}, ${runGroupId}, ${source}, ${branch}, ${commit})
      `,
      new Promise((_, reject) => setTimeout(() => reject(new Error('pg_insert_timeout')), 1000)),
    ]).catch(() => {
      /* swallow — D-007 */
    });
  } catch {
    /* swallow — D-007 */
  }
}

export default class AdminTestRunsReporter implements Reporter {
  private pending: Promise<void>[] = [];

  onInit(_ctx: Vitest): void {
    void _ctx;
  }

  /** Per-module hook — fire-and-forget the insert; onTestRunEnd awaits them. */
  onTestModuleEnd(testModule: TestModule): void {
    try {
      const filePath = toWorkspaceRel(testModule.moduleId);
      const status = moduleStatus(testModule);
      let durationMsRaw = 0;
      try {
        durationMsRaw = testModule.diagnostic().duration ?? 0;
      } catch { /* fail-soft */ }
      const finishedAt = new Date();
      const durationMs = Math.round(durationMsRaw);
      const startedAt = new Date(finishedAt.getTime() - durationMs);

      let outputTail: string | null = null;
      try {
        const errs = testModule.errors?.() ?? [];
        if (errs.length > 0) {
          outputTail = errs.map((e: unknown) => (e instanceof Error ? e.message : String(e))).join('\n').slice(-4000);
        }
      } catch { /* fail-soft */ }

      this.pending.push(
        insertRow({ filePath, status, durationMs, startedAt, finishedAt, outputTail }),
      );
    } catch {
      /* swallow — D-007 */
    }
  }

  async onTestRunEnd(): Promise<void> {
    try {
      await Promise.race([
        Promise.allSettled(this.pending),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch {
      /* swallow — D-007 */
    } finally {
      await closeSharedPg();
    }
  }

  async onExit(): Promise<void> {
    try {
      await Promise.race([
        Promise.allSettled(this.pending),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch {
      /* swallow — D-007 */
    } finally {
      await closeSharedPg();
    }
  }
}
