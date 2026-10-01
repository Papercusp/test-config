// Per-test-file PASS reuse — the vitest side (gate-file-level-test-reuse-2026-09-27 P-008,
// WI-10003476).
//
// scripts/affected-tests.mjs decides which selected test files still hold a valid pass proof at
// the judged sha (scripts/lib/test-pass-reuse.mjs, D-004) and hands the result to the
// workspace's vitest config as a content-addressed JSON file named by PC_TEST_REUSE_SKIP_LIST.
// This module turns that file into `exclude` entries.
//
// It re-checks the two proof properties that only the RUNNING vitest can see: the run context
// (green-checkpoint vs clean-local) and the runner identity (node version/platform/arch of the
// process that will execute the files, which forked workers inherit). The selector computed its
// identity from a probe of the node its task would spawn; if that guess was wrong the list is
// dropped here and every file runs. Every failure mode runs MORE tests, never fewer.

import { readFileSync } from 'node:fs';

export const PC_TEST_REUSE_SKIP_LIST_ENV = 'PC_TEST_REUSE_SKIP_LIST';
export const REUSE_SKIP_LIST_SCHEMA = 1;

/** The runner class a pass proof belongs to; reuse only consumes its own context (D-004 rule 1). */
export function executedSourceRunContext(env: NodeJS.ProcessEnv = process.env): string {
  return env.GREEN_CHECKPOINT === '1' ? 'green-checkpoint' : 'clean-local';
}

/**
 * Proof format (gate-test-reuse-yield-2026-10-01 P-001): a `proof-v2` proof records, in readPaths,
 * the vitest config that ran the file plus its relative imports (executed-source-map-reporter.ts),
 * so the selector treats a nested vitest config as a per-proof input rather than a global one.
 * PINNED equal to scripts/lib/test-pass-reuse.mjs REUSE_PROOF_FORMAT (the selector side).
 */
export const REUSE_PROOF_FORMAT = 'proof-v2';

/** Proof format + node version + platform + arch of this process (D-004 rule 6, P-001). */
export function executedSourceRunnerIdentity(): string {
  return `${REUSE_PROOF_FORMAT} ${process.version} ${process.platform} ${process.arch}`;
}

export interface ReuseSkipList {
  schema: number;
  /** Workspace-relative POSIX test paths whose pass proof is still valid. */
  files: string[];
  runContext: string;
  runnerIdentity: string;
  judgedSha: string;
}

export type ReuseSkipDecision =
  | { applied: true; exclude: string[]; skipped: number }
  | { applied: false; reason: string; exclude: [] };

/** Escape picomatch/tinyglobby metacharacters so a path is matched literally. */
export function escapeGlobLiteral(p: string): string {
  return p.replace(/[\\*?[\]{}()!+@]/g, (c) => `\\${c}`);
}

/** Parse and validate a skip list body. Throws on a malformed list. */
export function parseReuseSkipList(body: string): ReuseSkipList {
  const parsed: unknown = JSON.parse(body);
  const o = parsed as Partial<ReuseSkipList> | null;
  if (
    !o ||
    typeof o !== 'object' ||
    o.schema !== REUSE_SKIP_LIST_SCHEMA ||
    !Array.isArray(o.files) ||
    !o.files.every((f) => typeof f === 'string' && f.length > 0) ||
    typeof o.runContext !== 'string' ||
    typeof o.runnerIdentity !== 'string' ||
    typeof o.judgedSha !== 'string'
  ) {
    throw new Error(`not a schema-${REUSE_SKIP_LIST_SCHEMA} reuse skip list`);
  }
  return o as ReuseSkipList;
}

/**
 * Decide the extra `exclude` entries for a skip list. PURE — the rule is unit-tested without
 * spawning vitest. A list recorded for another run context or runner identity is declined.
 */
export function decideReuseSkip(
  list: ReuseSkipList,
  here: { runContext: string; runnerIdentity: string },
): ReuseSkipDecision {
  if (list.runContext !== here.runContext) {
    return { applied: false, reason: `run context ${list.runContext} != ${here.runContext}`, exclude: [] };
  }
  if (list.runnerIdentity !== here.runnerIdentity) {
    return {
      applied: false,
      reason: `runner identity "${list.runnerIdentity}" != "${here.runnerIdentity}"`,
      exclude: [],
    };
  }
  const files = [...new Set(list.files.map((f) => f.replaceAll('\\', '/').replace(/^\.\//, '')))].sort();
  return { applied: true, exclude: files.map(escapeGlobLiteral), skipped: files.length };
}

/**
 * Resolve the reuse `exclude` entries for this vitest invocation from the env channel. Fail-soft
 * toward running everything: no channel, an unreadable/malformed list, or a declined list all
 * return [].
 */
export function resolveReuseSkipExclude(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): string[] {
  const listPath = env[PC_TEST_REUSE_SKIP_LIST_ENV]?.trim();
  if (!listPath) return [];
  let list: ReuseSkipList;
  try {
    list = parseReuseSkipList(readFileSync(listPath, 'utf8'));
  } catch (error) {
    log(
      `[test-pass-reuse] UNREADABLE ${listPath} (${error instanceof Error ? error.message : String(error)}) — ` +
        `running every file (more tests, never fewer)`,
    );
    return [];
  }
  const decision = decideReuseSkip(list, {
    runContext: executedSourceRunContext(env),
    runnerIdentity: executedSourceRunnerIdentity(),
  });
  if (!decision.applied) {
    log(`[test-pass-reuse] DECLINED: ${decision.reason} — running every file`);
    return [];
  }
  log(
    `[test-pass-reuse] skipping ${decision.skipped} file(s) with a valid pass proof at ` +
      `${list.judgedSha.slice(0, 12)} (root=${process.cwd()}) from ${listPath}`,
  );
  return decision.exclude;
}
