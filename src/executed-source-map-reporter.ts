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
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { inputsFilePath, PC_EXECUTED_INPUTS_DIR_ENV, type InputsRecord } from './executed-inputs-capture';
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
  /** P-009: repo-root-relative paths read at runtime (classified at flush). */
  readPaths?: string[];
  /** P-009: true only when the worker's input capture produced a record for this file. */
  inputsCaptured?: boolean;
  /** P-009: why this pass cannot be reused whatever the drift. */
  opaqueReasons?: string[];
}

export interface ExecutedSourceFlush {
  rows: ExecutedSourceRow[];
  recordedSha: string;
  runGroupId: string | null;
  /** D-004 rule 5: files that FAILED or ERRORED on this clean run; their pass proofs are retired. */
  retiredFiles?: string[];
  /** Workspace the retirements belong to (rows may be empty when only failures were seen). */
  workspaceName?: string;
  runContext?: string | null;
  runnerIdentity?: string | null;
}

// The run context + runner identity a row is stamped with. ONE definition, shared with the
// consumer side (test-pass-reuse-skip.ts re-checks both before skipping a file), so the value
// recorded and the value compared can never drift apart (D-004 rules 1 and 6).
import { executedSourceRunContext, executedSourceRunnerIdentity } from './test-pass-reuse-skip';
export { executedSourceRunContext, executedSourceRunnerIdentity };

/** Cap on how many untracked read paths an opaque reason names (the rest are counted). */
const UNTRACKED_REASON_CAP = 5;

/**
 * Classify a file's runtime reads against the tracked tree. PURE over its seams — exported for
 * the unit test. A read of a TRACKED file or directory is an input a git diff can see. A read of
 * a path that does not exist is an absence input (creating it later shows up in the diff). A read
 * of an existing UNTRACKED path (generated output, a gitignored cache) has content no diff can
 * describe, so it makes the pass opaque.
 */
export function classifyReadPaths(
  reads: string[],
  o: { repoRoot: string; isTracked: (rel: string) => boolean; exists: (abs: string) => boolean },
): { readPaths: string[]; opaqueReasons: string[] } {
  const readPaths = new Set<string>();
  const untracked: string[] = [];
  for (const abs of reads) {
    const rel = normalizeExecutedKey(abs, o.repoRoot);
    if (!rel) continue;
    if (o.isTracked(rel) || !o.exists(abs)) readPaths.add(rel);
    else untracked.push(rel);
  }
  const opaqueReasons: string[] = [];
  untracked.sort();
  for (const rel of untracked.slice(0, UNTRACKED_REASON_CAP)) opaqueReasons.push(`untracked-read:${rel}`);
  if (untracked.length > UNTRACKED_REASON_CAP) {
    opaqueReasons.push(`untracked-read:+${untracked.length - UNTRACKED_REASON_CAP} more`);
  }
  return { readPaths: [...readPaths].sort(), opaqueReasons };
}

/** Build `isTracked` from `git ls-files` output: a tracked file, or a directory holding one. */
export function trackedPredicate(trackedFiles: Iterable<string>): (rel: string) => boolean {
  const set = new Set<string>();
  for (const f of trackedFiles) {
    if (!f) continue;
    set.add(f);
    let i = f.lastIndexOf('/');
    while (i > 0) {
      const dir = f.slice(0, i);
      if (set.has(dir)) break;
      set.add(dir);
      i = dir.lastIndexOf('/');
    }
  }
  return (rel) => rel === '' || set.has(rel.replace(/\/+$/, ''));
}

function listTrackedFiles(repoRoot: string): string[] | null {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'ls-files', '--recurse-submodules', '-z'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** Read the worker's inputs record for one test file; null when absent or unreadable. */
export function readInputsRecord(dir: string | null | undefined, testFileAbs: string): InputsRecord | null {
  if (!dir) return null;
  try {
    const parsed = JSON.parse(readFileSync(inputsFilePath(dir, testFileAbs), 'utf8')) as InputsRecord;
    if (!parsed || !Array.isArray(parsed.reads) || !Array.isArray(parsed.opaque)) return null;
    return parsed;
  } catch {
    return null;
  }
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
    const reads = chunk.map((r) => JSON.stringify(r.readPaths ?? []));
    const opaque = chunk.map((r) => JSON.stringify(r.opaqueReasons ?? []));
    // Sent as text[] and cast per element: postgres.js serializes a JS boolean[] parameter as a
    // scalar `boolean`, so `${captured}::boolean[]` fails every write with "cannot cast type
    // boolean to boolean[]" (WI-10003597 — it silently recorded zero pass proofs at the gate).
    const captured = chunk.map((r) => (r.inputsCaptured === true ? 'true' : 'false'));
    const workspaceName = chunk[0]!.workspaceName;
    await sql`
      INSERT INTO harness_shared.test_executed_sources
        (workspace_name, test_file, recorded_sha, executed_modules, module_count, run_group_id,
         read_paths, inputs_captured, opaque_reasons, run_context, runner_identity)
      SELECT ${workspaceName}, u.f, ${flush.recordedSha},
             ARRAY(SELECT jsonb_array_elements_text(u.m::jsonb)),
             jsonb_array_length(u.m::jsonb),
             ${flush.runGroupId},
             ARRAY(SELECT jsonb_array_elements_text(u.r::jsonb)),
             u.c::boolean,
             ARRAY(SELECT jsonb_array_elements_text(u.o::jsonb)),
             ${flush.runContext ?? null},
             ${flush.runnerIdentity ?? null}
        FROM unnest(${files}::text[], ${modules}::text[], ${reads}::text[], ${captured}::text[], ${opaque}::text[])
          AS u(f, m, r, c, o)
      ON CONFLICT (workspace_name, test_file, recorded_sha) DO UPDATE
        SET executed_modules = EXCLUDED.executed_modules,
            module_count = EXCLUDED.module_count,
            run_group_id = EXCLUDED.run_group_id,
            read_paths = EXCLUDED.read_paths,
            inputs_captured = EXCLUDED.inputs_captured,
            opaque_reasons = EXCLUDED.opaque_reasons,
            run_context = EXCLUDED.run_context,
            runner_identity = EXCLUDED.runner_identity,
            recorded_at = now()
    `;
    // Scoped to this run context (plus legacy pre-1236 NULL rows): a clean-local recording must
    // not erase the green-checkpoint's pass proof for the same file, since reuse only ever
    // consumes a proof from its own context (gate-file-level-test-reuse-2026-09-27 D-004 rule 1).
    await sql`
      DELETE FROM harness_shared.test_executed_sources
       WHERE workspace_name = ${workspaceName}
         AND test_file = ANY(${files}::text[])
         AND recorded_sha <> ${flush.recordedSha}
         AND (run_context IS NULL OR run_context IS NOT DISTINCT FROM ${flush.runContext ?? null}::text)
    `;
  }
  // D-004 rule 5: a failure on this clean run retires EVERY pass proof for that file.
  if (flush.retiredFiles && flush.retiredFiles.length > 0 && flush.workspaceName) {
    await sql`
      DELETE FROM harness_shared.test_executed_sources
       WHERE workspace_name = ${flush.workspaceName}
         AND test_file = ANY(${flush.retiredFiles}::text[])
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
  private retired: string[] = [];
  private readonly inputsDir = process.env[PC_EXECUTED_INPUTS_DIR_ENV]?.trim() || null;
  private skipped = 0;
  private flushed = false;

  private discardInputs(moduleId: string): void {
    if (!this.inputsDir) return;
    try {
      rmSync(inputsFilePath(this.inputsDir, moduleId), { force: true });
    } catch {
      /* a leftover hand-off file is harmless */
    }
  }

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
    this.retired = [];
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
        // D-004 rule 5: a clean-run FAILURE retires this file's older pass proofs, so an older
        // pass can never mask a failure observed since. (Only a definite 'failed' — an
        // unreadable state is not evidence of anything.)
        if (state === 'failed') {
          const failedFile = normalizeExecutedKey(testModule.moduleId, this.repoRoot);
          if (failedFile) this.retired.push(failedFile);
        }
        this.discardInputs(testModule.moduleId);
        return;
      }
      // A NON-ISOLATED file (the pure lane, isolate:false — see vitest-config.ts) shares a
      // fork's module registry with the files before it, so its record describes the FORK,
      // not the file. MEASURED 2026-09-06 (vitest 4.1.8, forks, --isolate=false, three files
      // in one fork): the record ACCUMULATES — the third file's set contained the first two
      // TEST files — so it is a superset (safe to prune on, but it prunes almost nothing) and,
      // should vitest ever reset it per file instead, an UNDER-estimate. Neither is a map of
      // this file: such a file gets no row and stays in the static selection.
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
      // P-009: the worker's runtime-inputs record. Absent = inputs unknown = never reusable.
      const inputs = readInputsRecord(this.inputsDir, testModule.moduleId);
      this.discardInputs(testModule.moduleId);
      this.pending.push({
        workspaceName: this.armed.workspaceName,
        testFile,
        executedModules,
        inputsCaptured: inputs !== null,
        // Absolute until flush, where classifyReadPaths relativises them against the tracked tree.
        readPaths: inputs?.reads ?? [],
        opaqueReasons: inputs?.opaque ?? [],
      });
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
    const retiredFiles = [...new Set(this.retired.splice(0))].sort();
    if (rows.length === 0 && retiredFiles.length === 0) {
      log(`nothing to record ${summary}`);
      return;
    }
    if (worktreeDirty || !recordedSha) {
      log(`NOT persisted — dirty or sha-less checkout has no sha that describes what ran ${summary}`);
      return;
    }
    // P-009: relativise each captured read and split tracked inputs from opaque untracked reads.
    if (rows.some((r) => r.inputsCaptured)) {
      const tracked = listTrackedFiles(this.repoRoot);
      const isTracked = tracked ? trackedPredicate(tracked) : null;
      for (const row of rows) {
        if (!row.inputsCaptured) continue;
        if (!isTracked) {
          row.readPaths = [];
          row.opaqueReasons = [...(row.opaqueReasons ?? []), 'tracked-list-unavailable'];
          continue;
        }
        const c = classifyReadPaths(row.readPaths ?? [], { repoRoot: this.repoRoot, isTracked, exists: existsSync });
        row.readPaths = c.readPaths;
        row.opaqueReasons = [...new Set([...(row.opaqueReasons ?? []), ...c.opaqueReasons])].sort();
      }
    }
    const runGroupId = process.env.PAPERCUSP_TEST_RUN_GROUP ?? null;
    const outcome = await Promise.race([
      this.writeRows({
        rows,
        recordedSha,
        runGroupId,
        retiredFiles,
        workspaceName: this.armed.workspaceName,
        runContext: executedSourceRunContext(),
        runnerIdentity: executedSourceRunnerIdentity(),
      }).then(
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
