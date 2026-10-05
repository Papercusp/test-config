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
 * `PC_EXECUTED_SOURCE_MAP_OUT=<path>` also writes the rows as JSON for replay/inspection, and
 * optional `PC_EXECUTED_SOURCE_MAP_RESULT=<path>` receives one appended JSON line per flush
 * saying what the flush DID (`ExecutedSourceMapResult`) — the durable, runner-readable outcome
 * the stderr log line cannot be, since the gate discards task stderr (WI-10003603).
 *
 * Fail-soft throughout (D-007, same contract as admin-test-runs-reporter.ts): nothing here can
 * change a test outcome, and every write is bounded by a timeout.
 */
import type { Reporter, TestModule, Vitest } from 'vitest/node';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { inputsFilePath, PC_EXECUTED_INPUTS_DIR_ENV, type InputsRecord } from './executed-inputs-capture';
import { dirname, isAbsolute, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureWorktreeSnapshot,
  closeSharedPgIfUnheld,
  computeWorktreeDirty,
  retainSharedPg,
  inferWorkspaceRoot,
  isMutationProbeRun,
  tryGetPg,
  type PgHandle,
  type WorktreeGitSnapshot,
} from './admin-test-runs-reporter';
import { executedSourceMapArmed, PC_EXECUTED_SOURCE_ORIGINAL_META } from './vitest-config';

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
  /** Optional OUT-only diagnostics; never a replacement for the clean-checkout reuse stamp. */
  sourceEvidence?: ExecutedSourceEvidence;
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

interface ConfigDepsSource {
  vite?: { config?: { configFileDependencies?: unknown } };
  projects?: Array<{ vite?: { config?: { configFileDependencies?: unknown } } }>;
}

/**
 * gate-test-reuse-yield-2026-10-01 P-001: every vitest config this run loaded, plus the files those
 * configs import by RELATIVE path, as absolute paths — vite's `configFileDependencies` of the root
 * project and of each project. Vite bundles a config's relative imports (recorded) and externalizes
 * its bare ones (not recorded); test-pass-reuse.mjs isGlobalRunnerInput explains why the bare ones
 * are covered. Measured 2026-10-01 (vitest 4.1.8, vite 7.3.5): a workspace config yields
 * `[<its config>]`, and one importing `./helper` yields `[<helper>, <its config>]`.
 *
 * @returns sorted unique absolute paths, or null when no config dependency is visible (an unknown
 *          config, which the caller must treat as opaque — never as "no config input").
 */
export function resolveConfigDependencies(ctx: unknown): string[] | null {
  const deps = new Set<string>();
  const add = (v: unknown): void => {
    if (!Array.isArray(v)) return;
    for (const p of v) if (typeof p === 'string' && isAbsolute(p)) deps.add(p);
  };
  try {
    const c = ctx as ConfigDepsSource | null | undefined;
    add(c?.vite?.config?.configFileDependencies);
    for (const project of Array.isArray(c?.projects) ? c.projects : []) add(project?.vite?.config?.configFileDependencies);
  } catch {
    return null; // a getter that throws (server not ready) is an unknown config
  }
  return deps.size > 0 ? [...deps].sort() : null;
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

interface SourceFingerprint {
  path: string;
  sha256: string;
  basis?: 'vite-pre-transform';
}

interface CollectedModuleSources {
  sources: SourceFingerprint[];
  reasons: string[];
}

/** Original Vite source-map bytes captured before the test bodies execute. */
export interface CollectedSourceEvidence {
  modules: Map<string, CollectedModuleSources>;
  reasons: string[];
}

export interface ExecutedSourceEvidence {
  schemaVersion: 'vite-collected-source-evidence-v1';
  /** This measures repository worker modules, not native dependencies, runner code or runtime reads. */
  scope: 'repository-worker-vite-original-sources';
  status: 'stable' | 'changed' | 'unknown';
  sources: Array<SourceFingerprint & { currentSha256: string | null }>;
  reasons: string[];
}

interface SourceGraphNode {
  id: string | null;
  meta?: Record<string, unknown>;
  info?: { meta?: Record<string, unknown> };
  transformResult?: { map?: unknown } | null;
}

const sourceHash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Disk observations AFTER Vite loaded its config, never original loaded-source proof. */
export interface ConfigSourceSnapshots {
  schemaVersion: 'vitest-config-disk-snapshots-v1';
  scope: 'repository-vite-config-dependencies';
  basis: 'reporter-init-disk';
  status: 'unchanged' | 'changed' | 'unknown';
  sources: Array<{ path: string; sha256: string | null; currentSha256: string | null }>;
  reasons: string[];
}

interface ConfigSourceCapture {
  sources: Array<{ path: string; sha256: string | null }>;
  reasons: string[];
}

export function captureConfigSources(
  paths: string[] | null,
  o: { repoRoot: string; readSource?: (absolutePath: string) => Buffer },
): ConfigSourceCapture {
  const sources = new Map<string, string | null>();
  const reasons = new Set<string>();
  const readSource = o.readSource ?? readFileSync;
  if (!paths?.length) reasons.add('config-dependencies-unavailable');
  for (const absolute of paths ?? []) {
    const path = normalizeExecutedKey(absolute, o.repoRoot);
    if (!path) { reasons.add(`config-dependency-outside-repository:${absolute}`); continue; }
    try { sources.set(path, sourceHash(readSource(resolve(o.repoRoot, path)))); }
    catch { sources.set(path, null); reasons.add(`config-source-unreadable:${path}`); }
  }
  return { sources: [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 })),
    reasons: [...reasons].sort() };
}

export function qualifyConfigSources(
  captured: ConfigSourceCapture | undefined,
  o: { repoRoot: string; readSource?: (absolutePath: string) => Buffer },
): ConfigSourceSnapshots {
  const reasons = new Set(captured?.reasons ?? ['config-snapshots-unavailable']);
  const readSource = o.readSource ?? readFileSync;
  let changed = false;
  const sources = (captured?.sources ?? []).map(source => {
    let currentSha256: string | null = null;
    try { currentSha256 = sourceHash(readSource(resolve(o.repoRoot, source.path))); }
    catch { reasons.add(`config-source-unreadable:${source.path}`); }
    if (source.sha256 !== null && currentSha256 !== null && source.sha256 !== currentSha256) {
      changed = true;
      reasons.add(`config-source-changed:${source.path}`);
    }
    return { ...source, currentSha256 };
  });
  if (sources.length === 0) reasons.add('config-sources-unavailable');
  return { schemaVersion: 'vitest-config-disk-snapshots-v1', scope: 'repository-vite-config-dependencies',
    basis: 'reporter-init-disk', status: changed ? 'changed' : reasons.size > 0 ? 'unknown' : 'unchanged',
    sources, reasons: [...reasons].sort() };
}

/**
 * EI-24827847586322829: importDurations grows as tests run. Snapshot this module's existing
 * environment graph at collection, then select the actually reported modules at end. Never
 * reconstruct original bytes from end-of-run disk or a graph entry replaced during the test.
 * This diagnostic is deliberately independent of HEAD and never authorizes database reuse.
 */
export function captureCollectedSources(
  graph: Iterable<SourceGraphNode> | undefined,
  o: { repoRoot: string; readSource?: (absolutePath: string) => Buffer },
): CollectedSourceEvidence {
  const modules = new Map<string, CollectedModuleSources>();
  const readSource = o.readSource ?? readFileSync;
  const reasons: string[] = [];
  if (!graph) return { modules, reasons: ['collection-graph-unavailable'] };
  try {
    for (const node of graph) {
      const rel = node.id && normalizeExecutedKey(node.id, o.repoRoot);
      if (!rel) continue;
      const entry: CollectedModuleSources = { sources: [], reasons: [] };
      const map = node.transformResult?.map as {
        sources?: unknown; sourcesContent?: unknown; sourceRoot?: unknown;
      } | null | undefined;
      const original = node.info?.meta?.[PC_EXECUTED_SOURCE_ORIGINAL_META] as {
        version?: unknown; id?: unknown; sha256?: unknown;
      } | undefined;
      // An erased type-only module has no original map entry. Use the exact transform input
      // receipt when available, never current disk bytes as a substitute for missing originals.
      if ((!map || !Array.isArray(map.sources) || map.sources.length === 0) && original?.version === 1 &&
          typeof original.id === 'string' && normalizeExecutedKey(original.id, o.repoRoot) === rel &&
          typeof original.sha256 === 'string' && /^[a-f0-9]{64}$/.test(original.sha256)) {
        entry.sources.push({ path: rel, sha256: original.sha256, basis: 'vite-pre-transform' });
        try {
          if (sourceHash(readSource(resolve(o.repoRoot, rel))) !== original.sha256) {
            entry.reasons.push(`collection-source-mismatch:${rel}`);
          }
        } catch {
          entry.reasons.push(`collection-source-unreadable:${rel}`);
        }
      } else if (!map || !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)) {
        entry.reasons.push(`source-map-unavailable:${rel}`);
      } else {
        for (let i = 0; i < map.sources.length; i++) {
          const source = map.sources[i];
          const content = map.sourcesContent[i];
          if (typeof source !== 'string' || typeof content !== 'string' ||
              (map.sourceRoot !== undefined && typeof map.sourceRoot !== 'string')) {
            entry.reasons.push(`source-map-content-unavailable:${rel}`);
            continue;
          }
          const abs = source.startsWith('file://') ? source : resolve(
            dirname(resolve(o.repoRoot, rel)), typeof map.sourceRoot === 'string' ? map.sourceRoot : '', source,
          );
          const path = normalizeExecutedKey(abs, o.repoRoot);
          if (!path) {
            entry.reasons.push(`source-map-path-unresolved:${rel}`);
            continue;
          }
          const sha256 = sourceHash(content);
          entry.sources.push({ path, sha256 });
          try {
            if (sourceHash(readSource(resolve(o.repoRoot, path))) !== sha256) {
              entry.reasons.push(`collection-source-mismatch:${path}`);
            }
          } catch {
            entry.reasons.push(`collection-source-unreadable:${path}`);
          }
        }
        if (!entry.sources.some(source => source.path === rel)) {
          entry.reasons.push(`module-source-unresolved:${rel}`);
        }
      }
      const prior = modules.get(rel);
      if (prior) {
        prior.sources.push(...entry.sources);
        prior.reasons.push(...entry.reasons);
      } else modules.set(rel, entry);
    }
  } catch {
    reasons.push('collection-graph-unreadable');
  }
  return { modules, reasons };
}

/** Compare captured ORIGINAL bytes with disk; late imports and repository externals are gaps. */
export function qualifyCollectedSources(
  collected: CollectedSourceEvidence | undefined,
  importDurations: Record<string, ImportDurationLike> | undefined,
  o: { repoRoot: string; testFile: string; readSource?: (absolutePath: string) => Buffer },
): ExecutedSourceEvidence {
  const reasons = new Set(collected?.reasons ?? ['collection-evidence-unavailable']);
  const fingerprints = new Map<string, SourceFingerprint>();
  const readSource = o.readSource ?? readFileSync;
  if (!importDurations || Object.keys(importDurations).length === 0) reasons.add('import-record-unavailable');
  const modules = collectExecutedModules(importDurations, o);
  if (modules.length === 0) reasons.add('repository-modules-unavailable');
  for (const [key, info] of Object.entries(importDurations ?? {})) {
    const path = normalizeExecutedKey(key, o.repoRoot);
    if (path && info?.external === true) reasons.add(`repository-external:${path}`);
  }
  for (const path of modules) {
    const entry = collected?.modules.get(path);
    if (!entry) {
      reasons.add(`module-not-captured-at-collection:${path}`);
      continue;
    }
    for (const reason of entry.reasons) reasons.add(reason);
    for (const source of entry.sources) {
      const previous = fingerprints.get(source.path);
      if (previous && previous.sha256 !== source.sha256) reasons.add(`conflicting-source-maps:${source.path}`);
      else fingerprints.set(source.path, source);
    }
  }
  let changed = false;
  const sources = [...fingerprints.values()].sort((a, b) => a.path.localeCompare(b.path)).map(source => {
    const { path, sha256 } = source;
    let currentSha256: string | null = null;
    try {
      currentSha256 = sourceHash(readSource(resolve(o.repoRoot, path)));
      if (currentSha256 !== sha256) {
        changed = true;
        reasons.add(`source-changed:${path}`);
      }
    } catch {
      reasons.add(`source-unreadable:${path}`);
    }
    return { ...source, currentSha256 };
  });
  return {
    schemaVersion: 'vite-collected-source-evidence-v1',
    scope: 'repository-worker-vite-original-sources',
    status: changed ? 'changed' : reasons.size > 0 ? 'unknown' : 'stable',
    sources,
    reasons: [...reasons].sort(),
  };
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
 * Default writer, per chunk: replace this run context's row for (workspace, file, sha) with
 * the newest observation (delete + target-less insert, WI-10004880), then retire this
 * context's rows at OTHER shas for the same files, so the table holds one row per test file
 * per workspace per run context rather than one per gate run.
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
    // WI-10004880: replace only THIS context's row at this sha, then insert with a target-less
    // ON CONFLICT DO NOTHING. The old `ON CONFLICT (workspace_name, test_file, recorded_sha) DO
    // UPDATE SET run_context = EXCLUDED.run_context` let a clean-local run at a gate candidate sha
    // flip the gate's pass proof to clean-local, hiding it from loadReuseProofs. The target-less
    // form is deliberately schema-agnostic: under today's 3-column key a cross-context collision
    // keeps the existing row, and once the key gains run_context both contexts' rows coexist,
    // with no writer change and no deploy-ordering window in which writes fail.
    await sql`
      DELETE FROM harness_shared.test_executed_sources
       WHERE workspace_name = ${workspaceName}
         AND test_file = ANY(${files}::text[])
         AND recorded_sha = ${flush.recordedSha}
         AND run_context IS NOT DISTINCT FROM ${flush.runContext ?? null}::text
    `;
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
      ON CONFLICT DO NOTHING
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

/**
 * What one flush did. `not-persisted` = the run was not clean (a dirty or sha-less checkout) or
 * was armed no-persist (a gate rescue rerun), so nothing it saw may be recorded; `nothing-to-record` = no recordable module and no retirement;
 * `failed` / `timed-out` = the database write did not land (the WI-10003597 class).
 */
export type ExecutedSourceMapOutcome = 'written' | 'failed' | 'timed-out' | 'not-persisted' | 'nothing-to-record';

/** One line of the `PC_EXECUTED_SOURCE_MAP_RESULT` file (JSON, newline-terminated). */
export interface ExecutedSourceMapResult {
  workspaceName: string;
  outcome: ExecutedSourceMapOutcome;
  /** Rows offered to the writer (0 unless the run was clean). */
  rows: number;
  /** Files whose older proofs this flush retires (D-004 rule 5). */
  retired: number;
  skipped: number;
  sha: string | null;
  dirty: boolean;
  /** The writer's error message for `failed`; null otherwise. */
  error: string | null;
}

const RESULT_ERROR_MAX_CHARS = 500;

/** Append the flush outcome to the runner's result file. Fail-soft: a lost line is logged. */
export function appendExecutedSourceMapResult(resultPath: string | null, result: ExecutedSourceMapResult): void {
  if (!resultPath) return;
  try {
    const line: ExecutedSourceMapResult = {
      ...result,
      error: result.error === null ? null : result.error.slice(0, RESULT_ERROR_MAX_CHARS),
    };
    appendFileSync(resultPath, `${JSON.stringify(line)}\n`);
  } catch (e) {
    log(`result-file write failed (${e instanceof Error ? e.message : String(e)})`);
  }
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
  private collectedSources = new WeakMap<TestModule, CollectedSourceEvidence>();
  // OUT diagnostics describe executions, including failed or incomplete ones.
  // They never enter the reusable-pass table or the selector's rows.
  private diagnostics: Array<{ testFile: string; state: string; sourceEvidence: ExecutedSourceEvidence }> = [];

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

  /** WI-10003715: lease on the shared PG client, so the sibling test-runs reporter's concurrent
   *  onTestRunEnd cannot end it while this reporter's chunked flush is still writing. */
  private pgLease: (() => Promise<void>) | null = null;

  /** P-001: absolute paths of the vitest config(s) this run loaded + their relative imports; null = unknown. */
  private configDeps: string[] | null = null;
  private configSourceCapture: ConfigSourceCapture | undefined;

  onInit(ctx: Vitest): void {
    if (!this.armed) return;
    this.configDeps = resolveConfigDependencies(ctx);
    this.configSourceCapture = this.armed.outPath
      ? captureConfigSources(this.configDeps, { repoRoot: this.repoRoot }) : undefined;
    this.pgLease ??= retainSharedPg();
    this.worktreeBefore = this.readWorktreeSnapshot();
    this.pending = [];
    this.retired = [];
    this.skipped = 0;
    this.flushed = false;
    this.collectedSources = new WeakMap();
    this.diagnostics = [];
  }

  onTestModuleCollected(testModule: TestModule): void {
    // Fingerprinting has a cost. Only the existing optional diagnostic OUT channel requests it.
    if (!this.armed?.outPath || isMutationProbeRun()) return;
    try {
      const imports = testModule.diagnostic().importDurations as Record<string, ImportDurationLike> | undefined;
      const reported = new Set(collectExecutedModules(imports, { repoRoot: this.repoRoot, testFile: testModule.moduleId }));
      const graph = testModule.viteEnvironment?.moduleGraph.idToModuleMap;
      // The server graph may contain another file's transforms. Those do not establish when
      // THIS file imported a module; a later import must remain a gap even if already cached.
      const nodes = graph && [...graph.values()].filter(node => {
        const path = node.id && normalizeExecutedKey(node.id, this.repoRoot);
        return path && reported.has(path);
      });
      const captured = captureCollectedSources(nodes, { repoRoot: this.repoRoot });
      if (!imports || Object.keys(imports).length === 0) captured.reasons.push('collection-import-record-unavailable');
      this.collectedSources.set(testModule, captured);
    } catch {
      this.collectedSources.set(testModule, { modules: new Map(), reasons: ['collection-graph-unreadable'] });
    }
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
      if (this.armed.outPath) {
        const testFile = normalizeExecutedKey(testModule.moduleId, this.repoRoot);
        if (testFile) {
          let imports: Record<string, ImportDurationLike> | undefined;
          try { imports = testModule.diagnostic().importDurations as typeof imports; } catch { /* unknown */ }
          const sourceEvidence = qualifyCollectedSources(this.collectedSources.get(testModule), imports,
            { repoRoot: this.repoRoot, testFile: testModule.moduleId });
          if (!moduleIsIsolated(testModule)) {
            sourceEvidence.status = sourceEvidence.status === 'changed' ? 'changed' : 'unknown';
            sourceEvidence.reasons.push('worker-not-isolated');
          }
          this.diagnostics.push({ testFile, state, sourceEvidence });
        }
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
      // P-001 (proof-v2): the config that ran this file is one of its inputs. Without it the
      // selector could not scope a nested vitest config change to the proofs it affects, so a
      // captured row whose config is unknown is made opaque (never reused) rather than recorded
      // as if the config did not matter.
      const configDeps = inputs !== null ? this.configDeps : [];
      this.pending.push({
        workspaceName: this.armed.workspaceName,
        testFile,
        executedModules,
        inputsCaptured: inputs !== null,
        // Absolute until flush, where classifyReadPaths relativises them against the tracked tree.
        readPaths: [...(inputs?.reads ?? []), ...(configDeps ?? [])],
        opaqueReasons: [...(inputs?.opaque ?? []), ...(configDeps === null ? ['config-deps-unavailable'] : [])],
        ...(this.armed.outPath ? { sourceEvidence: qualifyCollectedSources(
          this.collectedSources.get(testModule), importDurations,
          { repoRoot: this.repoRoot, testFile: testModule.moduleId },
        ) } : {}),
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
          JSON.stringify({ workspaceName: this.armed.workspaceName, recordedSha, worktreeDirty,
            skipped: this.skipped, rows, diagnostics: this.diagnostics,
            configSources: qualifyConfigSources(this.configSourceCapture, { repoRoot: this.repoRoot }) }, null, 1),
        );
      } catch (e) {
        log(`out-file write failed (${e instanceof Error ? e.message : String(e)}) ${summary}`);
      }
    }
    const retiredFiles = [...new Set(this.retired.splice(0))].sort();
    const armed = this.armed;
    const report = (outcome: ExecutedSourceMapOutcome, error: string | null = null): void =>
      appendExecutedSourceMapResult(armed.resultPath, {
        workspaceName: armed.workspaceName,
        outcome,
        rows: rows.length,
        retired: retiredFiles.length,
        skipped: this.skipped,
        sha: recordedSha,
        dirty: worktreeDirty,
        error,
      });
    if (rows.length === 0 && retiredFiles.length === 0) {
      log(`nothing to record ${summary}`);
      report('nothing-to-record');
      return;
    }
    // EI-24542010215430349: a rescue rerun runs armed (so a capture-caused red reproduces there
    // instead of passing unarmed) but is not a suite run — nothing it saw becomes a proof, and it
    // retires nothing either. Checked before the clean/dirty verdict so a CLEAN rerun is covered.
    if (armed.noPersist) {
      log(`NOT persisted — no-persist (rescue rerun) ${summary}`);
      report('not-persisted');
      return;
    }
    if (worktreeDirty || !recordedSha) {
      log(`NOT persisted — dirty or sha-less checkout has no sha that describes what ran ${summary}`);
      report('not-persisted');
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race<{ outcome: ExecutedSourceMapOutcome; error: string | null }>([
      this.writeRows({
        // Source diagnostics belong only to OUT. Preserve the existing persisted row contract.
        rows: rows.map(({ sourceEvidence: _sourceEvidence, ...row }) => row),
        recordedSha,
        runGroupId,
        retiredFiles,
        workspaceName: armed.workspaceName,
        runContext: executedSourceRunContext(),
        runnerIdentity: executedSourceRunnerIdentity(),
      }).then(
        () => ({ outcome: 'written' as const, error: null }),
        (e: unknown) => ({ outcome: 'failed' as const, error: e instanceof Error ? e.message : String(e) }),
      ),
      new Promise((r) => {
        timer = setTimeout(r, EXECUTED_SOURCE_MAP_FLUSH_TIMEOUT_MS, { outcome: 'timed-out' as const, error: null });
      }),
    ]);
    if (timer) clearTimeout(timer);
    // The stderr wording predates the result file and is kept verbatim for anyone grepping it.
    const logged =
      settled.outcome === 'failed' ? `failed (${settled.error})` : settled.outcome === 'timed-out' ? 'timed out' : 'written';
    log(`${logged} ${summary}`);
    report(settled.outcome, settled.error);
  }

  async onTestRunEnd(): Promise<void> {
    try {
      await this.flushPending();
    } catch {
      /* swallow — D-007 */
    } finally {
      await (this.pgLease ?? closeSharedPgIfUnheld)();
    }
  }

  async onExit(): Promise<void> {
    try {
      await this.flushPending();
    } catch {
      /* swallow — D-007 */
    } finally {
      await (this.pgLease ?? closeSharedPgIfUnheld)();
    }
  }
}

/** Resolve a possibly-relative path against the repo root (used by the replay tooling). */
export function resolveInRepo(p: string, repoRoot = inferWorkspaceRoot()): string {
  return resolve(repoRoot, p);
}
