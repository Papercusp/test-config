/**
 * cargo-test-reporter.ts — writes cargo test results to harness_shared.test_runs.
 * Parses plain `cargo test` output and records results per-test (not per-file like Vitest).
 *
 * Plan: production-test-readiness-2026-07-06, P-009. Wire Rust/cargo native suite
 * (~258 tests in papercusp-desktop/src-tauri) into harness_shared.test_runs.
 *
 * D-007 fail-soft contract:
 *   - 1s connect timeout; ONE shared pg client reused for the whole run
 *   - swallow every PG / git / fs error; never throw
 *   - never taint test output; never affect the process exit code
 *
 * Usage: called from npm script or CI pipeline to report cargo test runs.
 * Environment variables (same as vitest reporter):
 *   - PAPERCUSP_TEST_RUN_SOURCE: 'ci' | 'local' | 'admin-ui' (default: 'local')
 *   - PAPERCUSP_TEST_RUN_GROUP: run_group_id for grouping (optional)
 *   - PAPERCUSP_TEST_RUN_HARNESS: harness slug for scoped runs (optional)
 *   - PAPERCUSP_WORKSPACE_ID: workspace id for scoped runs (optional)
 *   - PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1: opt-out
 *   - HARNESS_ADMIN_DATABASE_URL: PG connection URL (optional)
 *   - PAPERCUSP_TEST_RUNS_DB_URL: PG connection URL (optional, fallback)
 */

import { exec } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// ── inlined: inferWorkspaceRoot ──
let _cachedRoot: string | null = null;
function inferWorkspaceRoot(from = process.cwd()): string {
  if (_cachedRoot) return _cachedRoot;
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

// ── inlined: resolveTestRunSource ──
type TestRunSource = 'ci' | 'local' | 'admin-ui';
const VALID_SOURCES: ReadonlySet<TestRunSource> = new Set(['ci', 'local', 'admin-ui']);
function resolveTestRunSource(): TestRunSource {
  const override = process.env.PAPERCUSP_TEST_RUN_SOURCE;
  if (override && VALID_SOURCES.has(override as TestRunSource)) return override as TestRunSource;
  return process.env.CI ? 'ci' : 'local';
}

// ── inlined: resolveGitContext ──
interface GitContext {
  branch: string | null;
  commit: string | null;
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

interface TestRunRow {
  filePath: string; // workspace-relative POSIX path to the Cargo.toml
  testName: string; // full test name (e.g., "endpoint_ipc_framing::tests::test_frame_encoding")
  status: 'pass' | 'fail' | 'skip' | 'cancelled' | 'error';
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  outputTail: string | null;
}

let _loopLagMonitor: ReturnType<typeof monitorEventLoopDelay> | null = null;

function ensureLoopLagMonitor(): void {
  if (_loopLagMonitor) return;
  try {
    _loopLagMonitor = monitorEventLoopDelay({ resolution: 20 });
    _loopLagMonitor.enable();
  } catch {
    _loopLagMonitor = null;
  }
}

export function captureReporterSaturationSnapshot(): { loopLagP95Ms: number | null; rssMb: number | null } {
  let loopLagP95Ms: number | null = null;
  try {
    ensureLoopLagMonitor();
    const p95Ns = _loopLagMonitor?.percentile(95);
    if (typeof p95Ns === 'number' && Number.isFinite(p95Ns)) {
      loopLagP95Ms = Math.round((p95Ns / 1_000_000) * 10) / 10;
    }
    _loopLagMonitor?.reset();
  } catch {
    loopLagP95Ms = null;
  }

  let rssMb: number | null = null;
  try {
    rssMb = Math.round((process.memoryUsage().rss / 1_048_576) * 10) / 10;
  } catch {
    rssMb = null;
  }
  return { loopLagP95Ms, rssMb };
}

function toWorkspaceRel(absPath: string): string {
  const root = inferWorkspaceRoot();
  return relative(root, absPath).split(/[/\\]/).join(posix.sep);
}

const NON_SIGNAL_PREFIXES = [
  'papercupai-workspace/papercup-checkpoint/',
  'papercupai-workspace/papercusp-checkpoint/',
  'papercupai-workspace/papercup-staging/',
] as const;

export function shouldRecordTestRunPath(filePath: string): boolean {
  if (filePath.startsWith('_retired/') || filePath.includes('/_retired/')) return false;
  if (filePath.startsWith('.papercusp/scratch/tdg-') || filePath.includes('/.papercusp/scratch/tdg-')) return false;
  if (NON_SIGNAL_PREFIXES.some((prefix) => filePath.startsWith(prefix))) return false;
  return true;
}

type PgSql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>) & {
  end(opts?: { timeout?: number }): Promise<unknown>;
};
type PgHandle = { sql: PgSql } | null;

let _pgPromise: Promise<PgHandle> | undefined;

function tryGetPg(): Promise<PgHandle> {
  if (_pgPromise) return _pgPromise;
  _pgPromise = (async (): Promise<PgHandle> => {
    try {
      const mod = (await import('postgres')) as { default?: unknown };
      const pg = (mod.default ?? mod) as (url: string, opts: Record<string, unknown>) => PgSql;
      const url =
        process.env.HARNESS_ADMIN_DATABASE_URL ??
        process.env.PAPERCUSP_TEST_RUNS_DB_URL ??
        'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
      const sql = pg(url, { max: 2, connect_timeout: 1, onnotice: () => {} });
      return { sql };
    } catch {
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
  } catch {
    /* fail-soft */
  }

  const pg = await tryGetPg();
  if (!pg) return;

  const source = resolveTestRunSource();
  const runGroupId = process.env.PAPERCUSP_TEST_RUN_GROUP ?? null;
  const harnessSlug = process.env.PAPERCUSP_TEST_RUN_HARNESS || null;
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID || null;
  const { loopLagP95Ms, rssMb } = captureReporterSaturationSnapshot();

  try {
    await Promise.race([
      pg.sql`
        INSERT INTO harness_shared.test_runs
          (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha, harness_slug, workspace_id, loop_lag_p95_ms, rss_mb)
        VALUES
          (${row.filePath}, 'cargo', ${row.status}, ${row.durationMs}, ${row.startedAt},
           ${row.finishedAt}, ${row.outputTail}, ${runGroupId}, ${source}, ${branch}, ${commit}, ${harnessSlug}, ${workspaceId}, ${loopLagP95Ms}, ${rssMb})
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
 * Parse `cargo test` output and extract test results.
 * Returns an array of test results parsed from the output.
 *
 * Expected format (simplified):
 *   running 258 tests
 *   test endpoint_ipc_framing::tests::test_frame_encoding ... ok
 *   test custom_protocol::tests::test_custom_protocol_routing ... ok
 *   test pty::tests::test_pty_resize ... FAILED
 *   ...
 *   test result: ok. 256 passed; 1 failed; 0 ignored; 1 filtered out
 */
function parseCargoTestOutput(
  output: string,
  cargoTomlPath: string,
): Array<{ testName: string; status: 'pass' | 'fail' | 'skip'; duration?: number }> {
  const results: Array<{ testName: string; status: 'pass' | 'fail' | 'skip'; duration?: number }> = [];

  // Match lines like: "test module::submodule::test_name ... ok"
  // or: "test module::submodule::test_name ... FAILED"
  // or: "test module::submodule::test_name ... ignored"
  const testLineRegex = /^test\s+([^\s]+)\s+\.\.\.\s+(ok|FAILED|ignored)/gm;
  let match;

  while ((match = testLineRegex.exec(output)) !== null) {
    const testName = match[1];
    const resultStr = match[2];
    let status: 'pass' | 'fail' | 'skip' = 'pass';
    if (resultStr === 'FAILED') status = 'fail';
    if (resultStr === 'ignored') status = 'skip';

    results.push({ testName, status });
  }

  return results;
}

/**
 * Run cargo tests for a given crate and report results.
 * Parses output and inserts into harness_shared.test_runs.
 */
export async function reportCargoTests(crateDir: string, cargoTomlPath: string): Promise<void> {
  if (process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1') {
    return;
  }

  ensureLoopLagMonitor();
  const runStartTime = Date.now();

  const filePath = toWorkspaceRel(cargoTomlPath);
  if (!shouldRecordTestRunPath(filePath)) {
    return;
  }

  return new Promise((resolve) => {
    try {
      const child = exec('cargo test 2>&1', { cwd: crateDir, timeout: 300_000 }, (err, stdout) => {
        try {
          const testResults = parseCargoTestOutput(stdout, cargoTomlPath);

          // For each test result, insert a row
          const insertPromises = testResults.map((result) => {
            const finishedAt = new Date();
            // Distribute durations uniformly across tests for this run
            // In reality, we can't get per-test timing from plain cargo test output,
            // so we estimate: total time / number of tests
            const estimatedDurationMs = Math.max(1, Math.floor((Date.now() - runStartTime) / Math.max(1, testResults.length)));
            const startedAt = new Date(finishedAt.getTime() - estimatedDurationMs);

            // Extract error message if available (last 500 chars of output for failed tests)
            let outputTail: string | null = null;
            if (result.status === 'fail') {
              // Try to find the failure message in the output
              const lines = stdout.split('\n');
              const testNameIndex = lines.findIndex((l) => l.includes(result.testName));
              if (testNameIndex >= 0) {
                // Grab lines around the test name
                const contextLines = lines.slice(Math.max(0, testNameIndex - 5), Math.min(lines.length, testNameIndex + 10));
                outputTail = contextLines.join('\n').slice(-2000);
              }
              if (!outputTail) {
                outputTail = `Test ${result.testName} failed`;
              }
            }

            const row: TestRunRow = {
              filePath,
              testName: result.testName,
              status: result.status,
              durationMs: estimatedDurationMs,
              startedAt,
              finishedAt,
              outputTail,
            };

            return insertRow(row);
          });

          Promise.all(insertPromises)
            .then(() => {
              resolve();
            })
            .catch(() => {
              // D-007: swallow errors
              resolve();
            });
        } catch {
          // D-007: swallow all errors
          resolve();
        }
      });

      // Handle child process errors
      child.on('error', () => {
        // D-007: swallow
        resolve();
      });
    } catch {
      // D-007: swallow
      resolve();
    }
  });
}

/**
 * Main entry point: run cargo tests for papercusp-desktop/src-tauri
 * and report results to the test_runs table.
 */
export async function main(): Promise<void> {
  try {
    const root = inferWorkspaceRoot();
    const cargoDir = join(root, 'papercusp-desktop', 'src-tauri');
    const cargoTomlPath = join(cargoDir, 'Cargo.toml');

    // Check if the crate exists
    try {
      statSync(cargoTomlPath);
    } catch {
      // Crate doesn't exist, skip silently
      return;
    }

    await reportCargoTests(cargoDir, cargoTomlPath);
  } catch {
    // D-007: fail-soft
  } finally {
    await closeSharedPg();
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    /* swallow */
  });
}
