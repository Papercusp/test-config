/**
 * Executed-source-map reporter — gate-latency-selection-and-retry-policy-2026-09-06, P-002.
 *
 * Records, per test FILE, the modules vitest actually executed for it, so the affected-tests
 * selector (scripts/lib/related-tests.mjs, `pruneWithExecutedMap`) can drop a test the static
 * import closure reaches only through a hub it never loads. Rows land in
 * harness_shared.test_executed_sources (migration 1132), keyed by workspace + test file +
 * recorded sha.
 *
 * What makes a row TRUSTWORTHY, and therefore the three rails below:
 *   • the run must come from a CLEAN checkout — a dirty tree has no sha that describes the
 *     modules that ran, so a dirty run records nothing (the same before/after worktree
 *     snapshot the admin reporter uses; `computeWorktreeDirty`);
 *   • only a PASSED module is recorded — a file that failed or errored part-way may not have
 *     reached every import it would on a green run, and it re-runs anyway;
 *   • the executed set always includes the test file itself, which is how the selector tells a
 *     genuine run of THIS file from a stale or foreign row.
 *
 * Armed by `PC_EXECUTED_SOURCE_MAP_WORKSPACE` (the npm workspace name), stamped by
 * scripts/affected-tests.mjs on the unit vitest tasks it spawns; `defineVitestConfig` wires
 * this reporter AND raises `experimental.importDurations.limit` in the same decision, because
 * vitest reports an EMPTY `importDurations` at its default limit of 0. Optional
 * `PC_EXECUTED_SOURCE_MAP_OUT=<path>` also writes the rows as JSON for replay/inspection.
 *
 * Fail-soft throughout (D-007, same contract as admin-test-runs-reporter.ts): nothing here can
 * change a test outcome, and every write is bounded by a timeout.
 */
import type { Reporter, TestModule, Vitest } from 'vitest/node';
import { writeFileSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureWorktreeSnapshot,
  closeSharedPg,
  computeWorktreeDirty,
  inferWorkspaceRoot,
  isMutationProbeRun,
  tryGetPg,
  type PgHandle,
  type WorktreeGitSnapshot,
} from './admin-test-runs-reporter';
import { executedSourceMapArmed } from './vitest-config';

export interface ExecutedSourceRow {
  workspaceName: string;
  /** repo-root-relative POSIX path of the test file */
  testFile: string;
  /** repo-root-relative POSIX paths, sorted + de-duplicated, test file included */
  executedModules: string[];
}

export interface ExecutedSourceFlush {
  rows: ExecutedSourceRow[];
  recordedSha: string;
  runGroupId: string | null;
}

export type ExecutedSourceRowWriter = (flush: ExecutedSourceFlush) => Promise<void>;
export type WorktreeSnapshotReader = () => Promise<WorktreeGitSnapshot>;

/** Rows per INSERT statement: bounds statement size on a 6,500-file workspace. */
export const EXECUTED_SOURCE_MAP_CHUNK = 250;
/** The whole flush is bounded — a stalled database must not hold a green run's exit. */
export const EXECUTED_SOURCE_MAP_FLUSH_TIMEOUT_MS = 20_000;

type ImportDurationLike = { external?: boolean } | undefined;

/**
 * Normalise one `importDurations` key to a repo-root-relative POSIX path, or `null` when it
 * is not a repo-internal source module. Keys are absolute file paths as vitest's module
 * runner saw them — occasionally a `file://` URL, occasionally carrying a `?v=…` / `?import`
 * query — and node_modules entries are marked `external` but also dropped by path, so an
 * unflagged externalised copy cannot slip in.
 */
export function normalizeExecutedKey(key: string, repoRoot: string): string | null {
  let p = key;
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch {
      return null;
    }
  }
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  if (p.startsWith('/@fs/')) p = p.slice('/@fs'.length);
  if (!isAbsolute(p)) return null;
  const rel = relative(repoRoot, p).split(/[/\\]/).join(posix.sep);
  if (rel.length === 0 || rel.startsWith('..')) return null;
  if (rel.split('/').includes('node_modules')) return null;
  return rel;
}

/**
 * The executed set for one test module. PURE — exported for the unit test. `importDurations`
 * is the raw `TestModule.diagnostic().importDurations` record (values carry an `external`
 * flag at runtime that the public type omits).
 */
export function collectExecutedModules(
  importDurations: Record<string, ImportDurationLike> | undefined,
  o: { repoRoot: string; testFile: string },
): string[] {
  const out = new Set<string>();
  const self = normalizeExecutedKey(o.testFile, o.repoRoot);
  if (self) out.add(self);
  for (const [key, info] of Object.entries(importDurations ?? {})) {
    if (info && info.external === true) continue;
    const rel = normalizeExecutedKey(key, o.repoRoot);
    if (rel) out.add(rel);
  }
  return [...out].sort();
}

/** Only a module vitest reports as PASSED is recorded (see the header). */
export function shouldRecordModule(state: string): boolean {
  return state === 'passed';
}

/**
 * Whether the project this module ran in isolates each file's module registry. PURE over the
 * resolved project config, exported for the unit test; an ABSENT flag reads as not isolated,
 * because "cannot tell" must fall toward recording nothing (see onTestModuleEnd).
 */
export function isolatedByConfig(config: { isolate?: unknown } | undefined | null): boolean {
  return config?.isolate === true;
}

function moduleIsIsolated(testModule: TestModule): boolean {
  try {
    return isolatedByConfig((testModule.project as { config?: { isolate?: unknown } } | undefined)?.config);
  } catch {
    return false;
  }
}

/**
 * Default writer: one bounded transaction per chunk. The upsert keeps the newest observation
 * for (workspace, file, sha); the trailing delete retires rows at OTHER shas for the same
 * files, so the table holds one row per test file per workspace rather than one per gate run.
 */
export async function writeExecutedSourceRows(flush: ExecutedSourceFlush, pg?: PgHandle): Promise<void> {
  const handle = pg ?? (await tryGetPg());
  if (!handle) return;
  const { sql } = handle;
  for (let i = 0; i < flush.rows.length; i += EXECUTED_SOURCE_MAP_CHUNK) {
    const chunk = flush.rows.slice(i, i + EXECUTED_SOURCE_MAP_CHUNK);
    const files = chunk.map((r) => r.testFile);
    const modules = chunk.map((r) => JSON.stringify(r.executedModules));
    const workspaceName = chunk[0]!.workspaceName;
    await sql`
      INSERT INTO harness_shared.test_executed_sources
        (workspace_name, test_file, recorded_sha, executed_modules, module_count, run_group_id)
      SELECT ${workspaceName}, u.f, ${flush.recordedSha},
             ARRAY(SELECT jsonb_array_elements_text(u.m::jsonb)),
             jsonb_array_length(u.m::jsonb),
             ${flush.runGroupId}
        FROM unnest(${files}::text[], ${modules}::text[]) AS u(f, m)
      ON CONFLICT (workspace_name, test_file, recorded_sha) DO UPDATE
        SET executed_modules = EXCLUDED.executed_modules,
            module_count = EXCLUDED.module_count,
            run_group_id = EXCLUDED.run_group_id,
            recorded_at = now()
    `;
    await sql`
      DELETE FROM harness_shared.test_executed_sources
       WHERE workspace_name = ${workspaceName}
         AND test_file = ANY(${files}::text[])
         AND recorded_sha <> ${flush.recordedSha}
    `;
  }
}

function log(line: string): void {
  process.stderr.write(`[executed-source-map] ${line}\n`);
}

export default class ExecutedSourceMapReporter implements Reporter {
  private readonly armed = executedSourceMapArmed();
  private readonly repoRoot = inferWorkspaceRoot();
  private readonly readWorktreeSnapshot: WorktreeSnapshotReader;
  private readonly writeRows: ExecutedSourceRowWriter;
  private worktreeBefore: Promise<WorktreeGitSnapshot> | null = null;
  private pending: ExecutedSourceRow[] = [];
  private skipped = 0;
  private flushed = false;

  constructor(
    readWorktreeSnapshotOrOptions?: WorktreeSnapshotReader | Record<string, unknown>,
    writeRows?: ExecutedSourceRowWriter,
  ) {
    // Vitest constructs reporters with its options object; the unit suite injects seams.
    this.readWorktreeSnapshot =
      typeof readWorktreeSnapshotOrOptions === 'function' ? readWorktreeSnapshotOrOptions : captureWorktreeSnapshot;
    this.writeRows = writeRows ?? ((flush) => writeExecutedSourceRows(flush));
  }

  onInit(_ctx: Vitest): void {
    if (!this.armed) return;
    this.worktreeBefore = this.readWorktreeSnapshot();
    this.pending = [];
    this.skipped = 0;
    this.flushed = false;
  }

  onTestModuleEnd(testModule: TestModule): void {
    if (!this.armed) return;
    try {
      if (isMutationProbeRun()) return;
      let state = 'error';
      try {
        state = testModule.state();
      } catch {
        /* fail-soft: treat as not recordable */
      }
      if (!shouldRecordModule(state)) {
        this.skipped += 1;
        return;
      }
      // A NON-ISOLATED file (the pure lane, isolate:false — see vitest-config.ts) shares a
      // fork's module registry with the files before it, so a module it imports that an earlier
      // file already evaluated is NOT re-executed and may be missing from its record. That is an
      // UNDER-estimate — the one direction the selector must never see — so such a file gets no
      // row and stays in the static selection.
      if (!moduleIsIsolated(testModule)) {
        this.skipped += 1;
        return;
      }
      let importDurations: Record<string, ImportDurationLike> | undefined;
      try {
        importDurations = testModule.diagnostic().importDurations as Record<string, ImportDurationLike> | undefined;
      } catch {
        importDurations = undefined;
      }
      const testFile = normalizeExecutedKey(testModule.moduleId, this.repoRoot);
      if (!testFile) return; // outside the repo — never a selectable test
      // No import record at all (limit not raised, or an unsupported pool) is a recording gap,
      // not an empty executed set: a row saying "this test loads nothing" would be a lie the
      // selector might act on. Record nothing.
      if (!importDurations || Object.keys(importDurations).length === 0) {
        this.skipped += 1;
        return;
      }
      const executedModules = collectExecutedModules(importDurations, { repoRoot: this.repoRoot, testFile: testModule.moduleId });
      this.pending.push({ workspaceName: this.armed.workspaceName, testFile, executedModules });
    } catch {
      /* swallow — D-007 */
    }
  }

  private async flushPending(): Promise<void> {
    if (!this.armed || this.flushed) return;
    this.flushed = true;
    const rows = this.pending.splice(0);
    let worktreeDirty = true;
    let recordedSha: string | null = null;
    try {
      const before = this.worktreeBefore ? await this.worktreeBefore : await this.readWorktreeSnapshot();
      const after = await this.readWorktreeSnapshot();
      worktreeDirty = computeWorktreeDirty(before, after);
      recordedSha = after.commit;
    } catch {
      worktreeDirty = true; // no proof of stability is dirty, never a false clean
    }
    const summary = `ws=${this.armed.workspaceName} rows=${rows.length} skipped=${this.skipped} sha=${recordedSha ?? 'unknown'} dirty=${worktreeDirty}`;
    if (this.armed.outPath) {
      try {
        writeFileSync(
          this.armed.outPath,
          JSON.stringify({ workspaceName: this.armed.workspaceName, recordedSha, worktreeDirty, skipped: this.skipped, rows }, null, 1),
        );
      } catch (e) {
        log(`out-file write failed (${e instanceof Error ? e.message : String(e)}) ${summary}`);
      }
    }
    if (rows.length === 0) {
      log(`nothing to record ${summary}`);
      return;
    }
    if (worktreeDirty || !recordedSha) {
      log(`NOT persisted — dirty or sha-less checkout has no sha that describes what ran ${summary}`);
      return;
    }
    const runGroupId = process.env.PAPERCUSP_TEST_RUN_GROUP ?? null;
    const outcome = await Promise.race([
      this.writeRows({ rows, recordedSha, runGroupId }).then(
        () => 'written',
        (e: unknown) => `failed (${e instanceof Error ? e.message : String(e)})`,
      ),
      new Promise<string>((r) => setTimeout(r, EXECUTED_SOURCE_MAP_FLUSH_TIMEOUT_MS, 'timed out')),
    ]);
    log(`${outcome} ${summary}`);
  }

  async onTestRunEnd(): Promise<void> {
    try {
      await this.flushPending();
    } catch {
      /* swallow — D-007 */
    } finally {
      await closeSharedPg();
    }
  }

  async onExit(): Promise<void> {
    try {
      await this.flushPending();
    } catch {
      /* swallow — D-007 */
    } finally {
      await closeSharedPg();
    }
  }
}

/** Resolve a possibly-relative path against the repo root (used by the replay tooling). */
export function resolveInRepo(p: string, repoRoot = inferWorkspaceRoot()): string {
  return resolve(repoRoot, p);
}
