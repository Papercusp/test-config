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
import type { Reporter, TestModule, TestRunEndReason, TestSpecification, Vitest } from 'vitest/node';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { inputsFilePath, PC_EXECUTED_INPUTS_DIR_ENV, type InputsRecord } from './executed-inputs-capture';
import { dirname, isAbsolute, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as runtimeProof from '../../../scripts/lib/runtime-compatibility.mjs';
import { completionSnapshotChunks } from '../../../scripts/lib/completion-snapshot.mjs';

import {
  captureWorktreeSnapshot,
  closeSharedPgIfUnheld,
  computeWorktreeDirty,
  collectModuleExecution,
  collectTestCases,
  retainSharedPg,
  trackSharedPgOperation,
  inferWorkspaceRoot,
  isMutationProbeRun,
  tryGetPg,
  type PgHandle,
  type WorktreeGitSnapshot,
} from './admin-test-runs-reporter';
import { executedSourceMapArmed, PC_EXECUTED_SOURCE_ORIGINAL_META, readExecutedSourceOriginals,
  type ExecutedOriginalSource } from './vitest-config';
import { qualifyLoadedConfigSources, qualifyLoadedMainProcessSources } from './executed-config-load-capture.ts';

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
  /** Prospective evaluator argument hashes. Explicit gaps prevent a full-closure claim. */
  moduleEvaluations?: InputsRecord['moduleEvaluations'];
}

export interface ExecutedSourceFlush {
  rows: ExecutedSourceRow[];
  recordedSha: string;
  /** WI-6554700010019324: the object store recordedSha lives in (resolveRecordedGitDir). Every
   *  DELETE this flush runs is scoped to it, so a sibling install's proofs are never touched. */
  recordedGitDir: string;
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
import { executedSourceRunContext, executedSourceRunnerIdentity, REUSE_PROOF_FORMAT } from './test-pass-reuse-skip';
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
  vite?: { config?: { configFileDependencies?: unknown; configFile?: unknown } };
  projects?: Array<{ vite?: { config?: { configFileDependencies?: unknown; configFile?: unknown } } }>;
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

/** Resolved entrypoints for OUT-only native-load observations. An entrypoint
 * alone is never a dependency population or reusable-pass input closure. */
export function resolveConfigEntries(ctx: unknown): string[] | null {
  const entries = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && isAbsolute(value)) entries.add(value);
  };
  try {
    const source = ctx as ConfigDepsSource | null | undefined;
    add(source?.vite?.config?.configFile);
    for (const project of Array.isArray(source?.projects) ? source.projects : []) add(project?.vite?.config?.configFile);
  } catch { return null; }
  return entries.size ? [...entries].sort() : null;
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

/**
 * WI-6554700010019324: the object store a proof's recorded_sha lives in, as the realpath of the
 * checkout's git common dir. A linked worktree (the gate's checkpoint tree, the release checkout)
 * shares its main repository's, so every checkout of one install agrees; a separate clone of the
 * same repository (a pr-drill install) differs, which is what keeps one install's retention from
 * deleting another's proofs. Null when git cannot answer. PINNED equal to resolveRecordedGitDir in
 * scripts/lib/executed-source-map.mjs (the reader side).
 */
export function resolveRecordedGitDir(repoRoot: string): string | null {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    return out ? realpathSync(out) : null;
  } catch {
    return null;
  }
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

/** Public Vitest diagnostics stop at collection. Union the final worker observation and
 * make older/unavailable handoffs explicitly opaque rather than claiming a complete radius. */
export function completeModuleImports(
  collection: Record<string, ImportDurationLike> | undefined,
  inputs: InputsRecord | null,
): { imports: Record<string, ImportDurationLike>; reasons: string[] } {
  const imports = { ...collection };
  const final = inputs?.moduleImports;
  if (!final || typeof final !== 'object' || Array.isArray(final) ||
      !inputs?.testFile || final[inputs.testFile]?.external !== false) {
    return { imports, reasons: ['worker-module-imports-unavailable'] };
  }
  for (const [path, info] of Object.entries(final)) {
    if (!isAbsolute(path) || typeof info?.external !== 'boolean') {
      return { imports, reasons: ['worker-module-imports-unavailable'] };
    }
    imports[path] = info;
  }
  return { imports, reasons: [] };
}

/** Parent identity alone cannot establish the interpreter that executed a file. */
export function completeWorkerRuntime(inputs: InputsRecord | null, reporterIdentity: string | null): string[] {
  const before = runtimeProof.runtimeProofFingerprint?.(inputs?.runtime?.before) ?? null;
  const after = runtimeProof.runtimeProofFingerprint?.(inputs?.runtime?.after) ?? null;
  if (!before || !after || !reporterIdentity) return ['worker-runtime-unavailable'];
  const reasons: string[] = [];
  if (before !== after) reasons.push('worker-runtime-changed');
  if (`${REUSE_PROOF_FORMAT} ${before}` !== reporterIdentity ||
      `${REUSE_PROOF_FORMAT} ${after}` !== reporterIdentity) reasons.push('worker-runtime-mismatch');
  return reasons;
}

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

/** Compare captured originals with disk; late imports require prospective transform receipts. */
export function qualifyCollectedSources(
  collected: CollectedSourceEvidence | undefined,
  importDurations: Record<string, ImportDurationLike> | undefined,
  o: { repoRoot: string; testFile: string; readSource?: (absolutePath: string) => Buffer;
    originals?: readonly ExecutedOriginalSource[] },
): ExecutedSourceEvidence {
  const reasons = new Set(collected?.reasons ?? ['collection-evidence-unavailable']);
  const fingerprints = new Map<string, SourceFingerprint>();
  const readSource = o.readSource ?? readFileSync;
  if (!importDurations || Object.keys(importDurations).length === 0) reasons.add('import-record-unavailable');
  const modules = collectExecutedModules(importDurations, o);
  const executed = new Set(modules);
  const originals = new Map<string, SourceFingerprint[]>();
  for (const receipt of o.originals ?? []) {
    const path = normalizeExecutedKey(receipt.id, o.repoRoot);
    if (!path || !executed.has(path)) continue; // transformed is not evidence of executed
    if (receipt.version !== 1 || !/^[a-f0-9]{64}$/.test(receipt.sha256)) {
      reasons.add(`invalid-transform-receipt:${path}`);
      continue;
    }
    const sources = originals.get(path) ?? [];
    sources.push({ path, sha256: receipt.sha256, basis: 'vite-pre-transform' });
    originals.set(path, sources);
  }
  if (modules.length === 0) reasons.add('repository-modules-unavailable');
  for (const [key, info] of Object.entries(importDurations ?? {})) {
    const path = normalizeExecutedKey(key, o.repoRoot);
    if (path && info?.external === true) reasons.add(`repository-external:${path}`);
  }
  for (const path of modules) {
    const entry = collected?.modules.get(path);
    const prospective = originals.get(path) ?? [];
    if (!entry && prospective.length === 0) {
      reasons.add(`module-not-captured-at-collection:${path}`);
      continue;
    }
    for (const reason of entry?.reasons ?? []) reasons.add(reason);
    for (const source of [...(entry?.sources ?? []), ...prospective]) {
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
 * runtime's rows at OTHER shas for the same files. A result from another interpreter must never
 * retire this runtime's proofs, even when both run in the same install and context.
 */
export async function writeExecutedSourceRows(flush: ExecutedSourceFlush, pg?: PgHandle): Promise<void> {
  const handle = pg ?? (await tryGetPg());
  if (!handle) return;
  const { sql } = handle;
  for (let i = 0; i < flush.rows.length; i += EXECUTED_SOURCE_MAP_CHUNK) {
    const chunk = flush.rows.slice(i, i + EXECUTED_SOURCE_MAP_CHUNK);
    // The shared reporter deliberately disables postgres.js type discovery. Raw
    // JS arrays then serialize as scalars, even with a ::text[] SQL cast. Pass
    // scalar JSON instead so both client modes preserve arrays and booleans.
    const files = JSON.stringify(chunk.map((r) => r.testFile));
    const rows = JSON.stringify(chunk.map((r) => ({
      f: r.testFile, m: r.executedModules, r: r.readPaths ?? [],
      c: r.inputsCaptured === true, o: r.opaqueReasons ?? [],
    })));
    const workspaceName = chunk[0]!.workspaceName;
    // WI-10004880: replace only THIS context's row at this sha, then insert with a target-less
    // ON CONFLICT DO NOTHING. The old `ON CONFLICT (workspace_name, test_file, recorded_sha) DO
    // UPDATE SET run_context = EXCLUDED.run_context` let a clean-local run at a gate candidate sha
    // flip the gate's pass proof to clean-local, hiding it from loadReuseProofs. The target-less
    // form is deliberately schema-agnostic: under today's 3-column key a cross-context collision
    // keeps the existing row, and once the key gains run_context both contexts' rows coexist,
    // with no writer change and no deploy-ordering window in which writes fail.
    // WI-6554700010019324: every DELETE here is scoped to recorded_git_dir. Two installs that
    // clone one repository share workspace names and run contexts, so the unscoped form let each
    // install's recording delete the other's proofs (migration 1552).
    await sql`
      DELETE FROM harness_shared.test_executed_sources
       WHERE workspace_name = ${workspaceName}
         AND test_file = ANY(ARRAY(SELECT jsonb_array_elements_text(${files}::text::jsonb)))
         AND recorded_sha = ${flush.recordedSha}
         AND run_context IS NOT DISTINCT FROM ${flush.runContext ?? null}::text
         AND recorded_git_dir = ${flush.recordedGitDir}
         AND runner_identity IS NOT DISTINCT FROM ${flush.runnerIdentity ?? null}::text
    `;
    await sql`
      INSERT INTO harness_shared.test_executed_sources
        (workspace_name, test_file, recorded_sha, executed_modules, module_count, run_group_id,
         read_paths, inputs_captured, opaque_reasons, run_context, runner_identity, recorded_git_dir)
      SELECT ${workspaceName}, u.f, ${flush.recordedSha},
             ARRAY(SELECT jsonb_array_elements_text(u.m::jsonb)),
             jsonb_array_length(u.m::jsonb),
             ${flush.runGroupId},
             ARRAY(SELECT jsonb_array_elements_text(u.r::jsonb)),
             u.c::boolean,
             ARRAY(SELECT jsonb_array_elements_text(u.o::jsonb)),
             ${flush.runContext ?? null},
             ${flush.runnerIdentity ?? null},
             ${flush.recordedGitDir}
        FROM jsonb_to_recordset(${rows}::text::jsonb) AS u(f text, m jsonb, r jsonb, c boolean, o jsonb)
      ON CONFLICT DO NOTHING
    `;
    // Scoped to this run context (plus legacy pre-1236 NULL rows): a clean-local recording must
    // not erase the green-checkpoint's pass proof for the same file, since reuse only ever
    // consumes a proof from its own context (gate-file-level-test-reuse-2026-09-27 D-004 rule 1).
    // Pre-1552 rows (recorded_git_dir NULL) are left alone: nothing says whose they are, and a
    // reader prefers this install's own row over them.
    await sql`
      DELETE FROM harness_shared.test_executed_sources
       WHERE workspace_name = ${workspaceName}
         AND test_file = ANY(ARRAY(SELECT jsonb_array_elements_text(${files}::text::jsonb)))
         AND recorded_sha <> ${flush.recordedSha}
         AND (run_context IS NULL OR run_context IS NOT DISTINCT FROM ${flush.runContext ?? null}::text)
         AND recorded_git_dir = ${flush.recordedGitDir}
         AND runner_identity IS NOT DISTINCT FROM ${flush.runnerIdentity ?? null}::text
    `;
  }
  // D-004 rule 5 applies to this runtime. A Bun failure says nothing about a Node pass. Unknown
  // runtime identity can retire only unknown-identity proofs; absence is never a wildcard.
  if (flush.retiredFiles && flush.retiredFiles.length > 0 && flush.workspaceName) {
    await sql`
      DELETE FROM harness_shared.test_executed_sources
       WHERE workspace_name = ${flush.workspaceName}
         AND test_file = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(flush.retiredFiles)}::text::jsonb)))
         AND (recorded_git_dir = ${flush.recordedGitDir} OR recorded_git_dir IS NULL)
         AND runner_identity IS NOT DISTINCT FROM ${flush.runnerIdentity ?? null}::text
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
  /** Named results from THIS Vitest process, independent of proof persistence.
   * The launcher must snapshot its initial result file before any separate retry. */
  fileResults?: {
    version: 1;
    runnerIdentity: string | null;
    runContext: string;
    runGroupId: string | null;
    files: Array<{ testFile: string; verdict: 'pass' | 'fail' | 'unknown' }>;
  };
}

const RESULT_ERROR_MAX_CHARS = 500;

/** A final passing module is insufficient: skips and retries can hide its first attempt. */
function firstAttemptModuleVerdict(testModule: TestModule, state: string): 'pass' | 'fail' | 'unknown' {
  if (state === 'failed') return 'fail';
  const execution = collectModuleExecution(testModule);
  if (execution?.failed || execution?.collectionFailed) return 'fail';
  let unmeasured = false;
  try {
    if (typeof testModule.children?.allTests !== 'function') return 'unknown';
    for (const test of testModule.children.allTests()) {
      const diagnostic = test.diagnostic();
      if (!diagnostic) { unmeasured = true; continue; }
      // Vitest retries only after a failed attempt. A later pass cannot erase that miss.
      if (diagnostic.flaky === true || diagnostic.retryCount > 0) return 'fail';
      if (!Number.isSafeInteger(diagnostic.retryCount) || diagnostic.retryCount !== 0 ||
          diagnostic.flaky !== false) unmeasured = true;
    }
  } catch {
    return 'unknown';
  }
  return state === 'passed' && execution && execution.passed > 0 && execution.skipped === 0 && !unmeasured
    ? 'pass' : 'unknown';
}

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

export function writeExecutedSourceMapSnapshot(path: string, payload: unknown): void {
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    for (const chunk of completionSnapshotChunks(payload)) writeFileSync(descriptor, chunk);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

/** Keep disk synchronization off the controller's fork-stop callback path. */
export async function writeExecutedSourceMapSnapshotAsync(path: string, payload: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  try {
    descriptor = await open(temporary, 'wx', 0o600);
    for (const chunk of completionSnapshotChunks(payload)) await descriptor.writeFile(chunk);
    await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;
    await rename(temporary, path);
  } finally {
    try { if (descriptor !== undefined) await descriptor.close(); }
    finally { await rm(temporary, { force: true }); }
  }
}

type SnapshotWriter = (path: string, payload: unknown) => void | Promise<void>;

export default class ExecutedSourceMapReporter implements Reporter {
  private readonly armed = executedSourceMapArmed();
  private readonly repoRoot = inferWorkspaceRoot();
  private readonly readWorktreeSnapshot: WorktreeSnapshotReader;
  private readonly writeRows: ExecutedSourceRowWriter;
  private readonly resolveGitDir: (repoRoot: string) => string | null;
  private readonly writeSnapshot: SnapshotWriter;
  private worktreeBefore: Promise<WorktreeGitSnapshot> | null = null;
  private checkpointWrites: Promise<void> = Promise.resolve();
  private acknowledgedCompletionIds = new Set<string>();
  private readonly completionContext = {
    schemaVersion: 1,
    qualificationAttemptId: process.env.PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID?.trim() || null,
    runGroupId: process.env.PAPERCUSP_TEST_RUN_GROUP ?? null,
    runContext: executedSourceRunContext(),
    runnerIdentity: executedSourceRunnerIdentity(),
  };
  private pending: ExecutedSourceRow[] = [];
  private retired: string[] = [];
  private readonly inputsDir = process.env[PC_EXECUTED_INPUTS_DIR_ENV]?.trim() || null;
  private skipped = 0;
  private flushed = false;
  private collectedSources = new WeakMap<TestModule, CollectedSourceEvidence>();
  // OUT diagnostics describe executions, including failed or incomplete ones.
  // They never enter the reusable-pass table or the selector's rows.
  private diagnostics: Array<{ testFile: string; state: string; sourceEvidence: ExecutedSourceEvidence;
    moduleEvaluations?: InputsRecord['moduleEvaluations'] }> = [];
  private fileResults: NonNullable<ExecutedSourceMapResult['fileResults']>['files'] = [];
  // Extend the existing OUT diagnostics with actual reporter outcomes. These
  // observations include failed/skipped runs and never become reusable passes.
  private nativeRun: {
    schemaVersion: 'native-vitest-run-v1';
    scope: 'vitest-reporter-callbacks';
    pid: number; ppid: number; startedAtMs: number; finishedAtMs: number | null;
    terminalHook: 'onTestRunEnd' | 'onExit' | null;
    reason: TestRunEndReason | null; unhandledErrorCount: number | null;
    reportedModulePaths: Array<string | null> | null;
    modulePopulationMatched: boolean;
    selectedManifest: { sha256: string; specifications: Array<{
      testFile: string | null; projectName: string | null; pool: string;
      testNamePattern: string | null; testLines: number[] | null; testIds: string[] | null; testTagsFilter: string[] | null;
    }> } | null;
    files: Array<{ testFile: string; state: string; observedAtMs: number;
      completionId: string;
      projectName: string | null;
      firstAttemptVerdict: 'pass' | 'fail' | 'unknown';
      proof: { inputs: InputsRecord | null; sourceEvidence: ExecutedSourceEvidence | null };
      execution: ReturnType<typeof collectModuleExecution>; cases: ReturnType<typeof collectTestCases> }>;
    gaps: string[];
  } | null = null;

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
    resolveGitDir?: (repoRoot: string) => string | null,
    writeSnapshot?: SnapshotWriter,
  ) {
    // Vitest constructs reporters with its options object; the unit suite injects seams.
    this.readWorktreeSnapshot =
      typeof readWorktreeSnapshotOrOptions === 'function' ? readWorktreeSnapshotOrOptions : captureWorktreeSnapshot;
    // A flush timeout releases the reporter lease, but the default writer can
    // still be between SQL chunks. Keep the whole write alive until settlement.
    this.writeRows = writeRows ?? ((flush) => trackSharedPgOperation(writeExecutedSourceRows(flush)));
    this.resolveGitDir = resolveGitDir ?? resolveRecordedGitDir;
    this.writeSnapshot = writeSnapshot ?? writeExecutedSourceMapSnapshotAsync;
  }

  /** WI-10003715: lease on the shared PG client, so the sibling test-runs reporter's concurrent
   *  onTestRunEnd cannot end it while this reporter's chunked flush is still writing. */
  private pgLease: (() => Promise<void>) | null = null;

  /** P-001: absolute paths of the vitest config(s) this run loaded + their relative imports; null = unknown. */
  private configDeps: string[] | null = null;
  private configEntries: string[] | null = null;
  private configSourceCapture: ConfigSourceCapture | undefined;

  onInit(ctx: Vitest): void {
    if (!this.armed) return;
    this.completionContext.runnerIdentity = executedSourceRunnerIdentity();
    this.configDeps = resolveConfigDependencies(ctx);
    this.configEntries = resolveConfigEntries(ctx);
    this.configSourceCapture = this.armed.outPath
      ? captureConfigSources(this.configDeps, { repoRoot: this.repoRoot }) : undefined;
    this.pgLease ??= retainSharedPg();
    this.worktreeBefore = this.readWorktreeSnapshot();
    this.checkpointWrites = Promise.resolve();
    this.acknowledgedCompletionIds.clear();
    this.pending = [];
    this.retired = [];
    this.skipped = 0;
    this.flushed = false;
    this.collectedSources = new WeakMap();
    this.diagnostics = [];
    this.fileResults = [];
    this.nativeRun = this.armed.outPath ? {
      schemaVersion: 'native-vitest-run-v1', scope: 'vitest-reporter-callbacks',
      pid: process.pid, ppid: process.ppid, startedAtMs: Date.now(), finishedAtMs: null,
      terminalHook: null, reason: null, unhandledErrorCount: null,
      reportedModulePaths: null, modulePopulationMatched: false, selectedManifest: null, files: [], gaps: [],
    } : null;
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    if (!this.nativeRun) return;
    try {
      const selected = specifications.map(specification => ({
        testFile: normalizeExecutedKey(specification.moduleId, this.repoRoot),
        projectName: specification.project.name ?? null,
        pool: specification.pool,
        testNamePattern: specification.testNamePattern?.toString() ?? null,
        testLines: specification.testLines ? [...specification.testLines] : null,
        testIds: specification.testIds ? [...specification.testIds] : null,
        testTagsFilter: specification.testTagsFilter ? [...specification.testTagsFilter] : null,
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      this.nativeRun.selectedManifest = {
        sha256: createHash('sha256').update(JSON.stringify(selected)).digest('hex'),
        specifications: selected,
      };
    } catch {
      this.nativeRun.selectedManifest = null;
      this.nativeRun.gaps.push('selected-module-population-unreadable');
    }
  }

  onTestModuleCollected(testModule: TestModule): void {
    // Fingerprinting has a cost. Only the existing optional diagnostic OUT channel requests it.
    if (!this.armed?.outPath) return;
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

  async onTestModuleEnd(testModule: TestModule): Promise<void> {
    if (!this.armed) return;
    try {
      let collectionImports: Record<string, ImportDurationLike> | undefined;
      try { collectionImports = testModule.diagnostic().importDurations as typeof collectionImports; } catch { /* unknown */ }
      const inputs = readInputsRecord(this.inputsDir, testModule.moduleId);
      const observed = completeModuleImports(collectionImports, inputs);
      const runtimeReasons = completeWorkerRuntime(inputs, this.completionContext.runnerIdentity);
      // A mixed or unmeasured worker population cannot stamp a reusable checkpoint
      // or retire the reporter runtime's proofs. Null scopes retirement to unknown rows.
      if (runtimeReasons.length) this.completionContext.runnerIdentity = null;
      let sourceEvidence: ExecutedSourceEvidence | undefined;
      let nativeFile: NonNullable<typeof this.nativeRun>['files'][number] | undefined;
      let state = 'error';
      try {
        state = testModule.state();
      } catch {
        /* fail-soft: treat as not recordable */
      }
      const resultFile = normalizeExecutedKey(testModule.moduleId, this.repoRoot);
      if (resultFile) {
        const verdict = firstAttemptModuleVerdict(testModule, state);
        this.fileResults.push({ testFile: resultFile, verdict });
        if (this.nativeRun) {
          const execution = collectModuleExecution(testModule), cases = collectTestCases(testModule);
          nativeFile = { testFile: resultFile, state, observedAtMs: Date.now(),
            completionId: randomUUID(), projectName: testModule.project.name ?? null,
            firstAttemptVerdict: verdict, execution, cases,
            proof: { inputs, sourceEvidence: null } };
          this.nativeRun.files.push(nativeFile);
          if (execution === null || cases === null)
            this.nativeRun.gaps.push(`module-cases-unmeasured:${resultFile}`);
        }
      } else this.nativeRun?.gaps.push('module-path-outside-repository');
      if (this.armed.outPath) {
        const testFile = normalizeExecutedKey(testModule.moduleId, this.repoRoot);
        if (testFile) {
          let originals: readonly ExecutedOriginalSource[] | undefined;
          try { originals = readExecutedSourceOriginals(testModule.viteEnvironment); } catch { /* retain collection-only gaps */ }
          sourceEvidence = qualifyCollectedSources(this.collectedSources.get(testModule), observed.imports,
            { repoRoot: this.repoRoot, testFile: testModule.moduleId, originals });
          if (observed.reasons.length) {
            sourceEvidence.status = sourceEvidence.status === 'changed' ? 'changed' : 'unknown';
            sourceEvidence.reasons.push(...observed.reasons);
          }
          if (!moduleIsIsolated(testModule)) {
            sourceEvidence.status = sourceEvidence.status === 'changed' ? 'changed' : 'unknown';
            sourceEvidence.reasons.push('worker-not-isolated');
          }
          this.diagnostics.push({ testFile, state, sourceEvidence,
            ...(inputs?.moduleEvaluations ? { moduleEvaluations: inputs.moduleEvaluations } : {}) });
          if (nativeFile) nativeFile.proof.sourceEvidence = sourceEvidence;
        }
      }
      // Mutation phases can report optional diagnostics and named verdicts, but must never
      // create reusable pass rows or retire ordinary proofs, including from clean baselines.
      if (isMutationProbeRun()) {
        this.discardInputs(testModule.moduleId);
        return;
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
      const importDurations = observed.imports;
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
        opaqueReasons: [...(inputs?.opaque ?? []), ...observed.reasons, ...runtimeReasons,
          ...(configDeps === null ? ['config-deps-unavailable'] : [])],
        ...(sourceEvidence ? { sourceEvidence } : {}),
        ...(this.armed.outPath && inputs?.moduleEvaluations ? { moduleEvaluations: inputs.moduleEvaluations } : {}),
      });
    } catch {
      /* swallow — D-007 */
    } finally {
      try {
        await this.checkpointCompletedModules();
      } catch (error) {
        log(`completion checkpoint failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  private checkpointCompletedModules(): Promise<void> {
    const armed = this.armed;
    if (!armed?.outPath || !this.nativeRun?.files.length ||
      this.nativeRun.files.every(file => this.acknowledgedCompletionIds.has(file.completionId)))
      return this.checkpointWrites;
    const payload = structuredClone({
      workspaceName: armed.workspaceName,
      rows: this.pending,
      diagnostics: this.diagnostics,
      nativeRun: this.nativeRun,
      skipped: this.skipped,
      configSources: qualifyConfigSources(this.configSourceCapture, { repoRoot: this.repoRoot }),
      configLoadedSources: qualifyLoadedConfigSources(this.configDeps, this.repoRoot, this.configEntries),
      mainProcessLoadedSources: qualifyLoadedMainProcessSources(this.configDeps, this.repoRoot, this.configEntries),
      completionCheckpoint: {
        ...this.completionContext,
        state: 'partial',
        noPersist: armed.noPersist,
      },
    });
    this.checkpointWrites = this.checkpointWrites.then(async () => {
      const before = this.worktreeBefore ? await this.worktreeBefore : null;
      const after = await this.readWorktreeSnapshot();
      const checkpoint = {
        ...payload,
        recordedSha: after.commit,
        sourceSnapshot: before,
        recordedGitDir: this.resolveGitDir(this.repoRoot),
        worktreeDirty: before === null || computeWorktreeDirty(before, after),
      };
      await this.writeSnapshot(armed.outPath!, checkpoint);
      const completionIds = payload.nativeRun.files.map(file => file.completionId)
        .filter(completionId => !this.acknowledgedCompletionIds.has(completionId));
      for (const completionId of completionIds) this.acknowledgedCompletionIds.add(completionId);
      if (completionIds.length)
        log(`COMPLETION_ACK ids=${JSON.stringify(completionIds)} path=${JSON.stringify(armed.outPath)}`);
    }).catch(error => {
      log(`completion checkpoint failed (${error instanceof Error ? error.message : String(error)})`);
    });
    return this.checkpointWrites;
  }

  private async flushPending(): Promise<void> {
    if (!this.armed || this.flushed) return;
    this.flushed = true;
    await this.checkpointWrites;
    const rows = this.pending.splice(0);
    if (executedSourceRunnerIdentity() !== this.completionContext.runnerIdentity)
      this.completionContext.runnerIdentity = null;
    if (!this.completionContext.runnerIdentity) {
      for (const row of rows) row.opaqueReasons = [...new Set([
        ...(row.opaqueReasons ?? []), 'worker-runtime-unavailable',
      ])];
    }
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
        await this.writeSnapshot(
          this.armed.outPath,
          { workspaceName: this.armed.workspaceName, recordedSha, worktreeDirty,
            recordedGitDir: this.resolveGitDir(this.repoRoot),
            completionCheckpoint: {
              ...this.completionContext,
              state: this.nativeRun?.terminalHook === 'onTestRunEnd' ? 'terminal' : 'partial',
              noPersist: this.armed.noPersist,
            },
            skipped: this.skipped, rows, diagnostics: this.diagnostics,
            ...(this.nativeRun ? { nativeRun: this.nativeRun } : {}),
            configSources: qualifyConfigSources(this.configSourceCapture, { repoRoot: this.repoRoot }),
            configLoadedSources: qualifyLoadedConfigSources(this.configDeps, this.repoRoot, this.configEntries),
            mainProcessLoadedSources: qualifyLoadedMainProcessSources(this.configDeps, this.repoRoot, this.configEntries) },
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
        fileResults: {
          version: 1,
          runnerIdentity: this.completionContext.runnerIdentity,
          runContext: executedSourceRunContext(),
          runGroupId: process.env.PAPERCUSP_TEST_RUN_GROUP ?? null,
          files: [...this.fileResults],
        },
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
    // WI-6554700010019324: an unscoped write could not be told apart from a sibling install's, and
    // its DELETEs could not be scoped, so a row with no object store is never written.
    const recordedGitDir = this.resolveGitDir(this.repoRoot);
    if (!recordedGitDir) {
      log(`NOT persisted — git common dir unresolvable, so the rows cannot be scoped to this install ${summary}`);
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
        rows: rows.map(({ sourceEvidence: _sourceEvidence, moduleEvaluations: _moduleEvaluations, ...row }) => row),
        recordedSha,
        recordedGitDir,
        runGroupId,
        retiredFiles,
        workspaceName: armed.workspaceName,
        runContext: executedSourceRunContext(),
        runnerIdentity: this.completionContext.runnerIdentity,
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

  async onTestRunEnd(
    testModules?: ReadonlyArray<TestModule>,
    unhandledErrors?: ReadonlyArray<unknown>,
    reason?: TestRunEndReason,
  ): Promise<void> {
    try {
      if (this.nativeRun && !this.flushed) {
        this.nativeRun.finishedAtMs = Date.now();
        this.nativeRun.terminalHook = 'onTestRunEnd';
        this.nativeRun.reason = reason ?? null;
        this.nativeRun.unhandledErrorCount = unhandledErrors?.length ?? null;
        if (!unhandledErrors) this.nativeRun.gaps.push('run-errors-unobserved');
        try {
          this.nativeRun.reportedModulePaths = testModules?.map(module =>
            normalizeExecutedKey(module.moduleId, this.repoRoot)) ?? null;
        } catch {
          this.nativeRun.gaps.push('terminal-module-population-unreadable');
        }
        const reported = this.nativeRun.reportedModulePaths;
        // Compare multisets: repeated files from separate projects are distinct
        // observations, and a missing callback cannot disappear through a Set.
        this.nativeRun.modulePopulationMatched = reported !== null && reported.every(path => path !== null) &&
          JSON.stringify([...reported].sort()) ===
            JSON.stringify(this.nativeRun.files.map(file => file.testFile).sort());
        if (!this.nativeRun.modulePopulationMatched) this.nativeRun.gaps.push('terminal-module-population-unmatched');
        if (!reason) this.nativeRun.gaps.push('run-end-reason-unobserved');
        if (!this.nativeRun.files.length) this.nativeRun.gaps.push('no-module-results');
      }
      await this.flushPending();
    } catch {
      /* swallow — D-007 */
    } finally {
      await (this.pgLease ?? closeSharedPgIfUnheld)();
    }
  }

  async onExit(): Promise<void> {
    try {
      if (this.nativeRun && !this.flushed) {
        this.nativeRun.finishedAtMs = Date.now();
        this.nativeRun.terminalHook = 'onExit';
        this.nativeRun.gaps.push('run-end-unobserved');
      }
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
