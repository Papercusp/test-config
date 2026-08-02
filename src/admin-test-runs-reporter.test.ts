/**
 * P-044: Fail-soft tests for admin-test-runs-reporter.
 *
 * D-007 contract: reporter MUST never throw, never affect exit code,
 * never poison stdout/stderr, even when PG / git / fs are unavailable.
 *
 * Moved here (2026-06-08) when the reporter was lifted into @papercusp/test-config
 * + auto-wired by defineVitestConfig. Vitest 4 API: onTestModuleEnd / onTestRunEnd /
 * onExit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdminTestRunsReporter, {
  buildOutputTail,
  captureReporterSaturationSnapshot,
  classifyGitEntry,
  computeIsScratchConfig,
  isScratchConfigFile,
  resolveTestRunHarnessSlug,
  resolveTestRunWorkspaceId,
  shouldRecordTestRunPath,
} from './admin-test-runs-reporter';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdminTestRunsReporter fail-soft contract', () => {
  it('constructs without side effects', () => {
    const r = new AdminTestRunsReporter();
    expect(r).toBeDefined();
  });

  it('onInit is a no-op even with a bogus ctx', () => {
    const r = new AdminTestRunsReporter();
    expect(() => r.onInit(null as never)).not.toThrow();
  });

  it('onTestModuleEnd swallows a TestModule whose state() throws', () => {
    const r = new AdminTestRunsReporter();
    const fakeModule = {
      moduleId: '/tmp/fake.test.ts',
      state: () => {
        throw new Error('state-explodes');
      },
      diagnostic: () => ({ duration: 5 }),
      errors: () => [],
    } as unknown as Parameters<typeof r.onTestModuleEnd>[0];
    expect(() => r.onTestModuleEnd(fakeModule)).not.toThrow();
  });

  it('onTestModuleEnd swallows a TestModule with no moduleId', () => {
    const r = new AdminTestRunsReporter();
    const fakeModule = {
      // moduleId: undefined
      state: () => 'passed',
      diagnostic: () => ({ duration: 5 }),
    } as unknown as Parameters<typeof r.onTestModuleEnd>[0];
    expect(() => r.onTestModuleEnd(fakeModule)).not.toThrow();
  });

  it('onTestModuleEnd accepts a realistic passing module without throwing', () => {
    const r = new AdminTestRunsReporter();
    const fakeModule = {
      moduleId: '/tmp/fake.test.ts',
      state: () => 'passed',
      diagnostic: () => ({ duration: 12, environmentSetupDuration: 0, prepareDuration: 0, collectDuration: 0, setupDuration: 0 }),
      errors: () => [],
    } as unknown as Parameters<typeof r.onTestModuleEnd>[0];
    expect(() => r.onTestModuleEnd(fakeModule)).not.toThrow();
  });

  it('captures the reporter saturation fields used by harness_shared.test_runs', () => {
    const snap = captureReporterSaturationSnapshot();
    expect(snap.rssMb).toEqual(expect.any(Number));
    expect(snap.loopLagP95Ms === null || typeof snap.loopLagP95Ms === 'number').toBe(true);
  });

  it('does not record retired, scratch, or sibling-checkout test paths', () => {
    expect(shouldRecordTestRunPath('_retired/snapshot-system/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('libs/papercusp/_retired/orchestrator-run-loop/src/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('.papercusp/scratch/tdg-123/src/x.test.tsx')).toBe(false);
    expect(shouldRecordTestRunPath('apps/operator/.papercusp/scratch/tdg-123/src/x.test.tsx')).toBe(false);
    expect(shouldRecordTestRunPath('papercupai-workspace/papercup-checkpoint/apps/operator/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('papercupai-workspace/papercusp-checkpoint/apps/operator/x.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('papercupai-workspace/papercup-staging/apps/operator/x.test.ts')).toBe(false);
    // `*.flakeproof.test.{ts,tsx}` — reserved flake-soak self-test scratch fixtures,
    // intended REDs, never committed (EI-10761 — a red-test EI on a non-existent file).
    expect(shouldRecordTestRunPath('apps/operator-vite/src/components/left-sidebar/MugTab.flakeproof.test.tsx')).toBe(false);
    expect(shouldRecordTestRunPath('src/x.flakeproof.test.ts')).toBe(false);
    // Cargo/Tauri BUILD-ARTIFACT copies of template checks — the sidecar build
    // copies `templates/<id>/checks/*.test.ts` (which import
    // `@papercusp/template-kit`) into a gitignored cargo target dir where
    // node_modules are NOT linked, so every copy reds with "Cannot find package
    // '@papercusp/template-kit'". Never a source regression (EI-11176).
    expect(shouldRecordTestRunPath('.wi3388-cargo-target/debug/sidecar/templates/papercusp-webapp/checks/composition-integrity.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('papercusp-desktop/src-tauri/target/debug/sidecar/templates/papercusp-webapp/checks/composition-integrity.test.ts')).toBe(false);
    // …but the real SOURCE copies of those same checks still record.
    expect(shouldRecordTestRunPath('templates/papercusp-webapp/checks/composition-integrity.test.ts')).toBe(true);
    expect(shouldRecordTestRunPath('packages/operator-core/lib/testing-orphan-runs.test.ts')).toBe(true);
  });

  it('does not record a path that resolves outside the workspace root (WI-5183)', () => {
    // toWorkspaceRel('/tmp/fake.test.ts') → '../../../../tmp/fake.test.ts' — exactly
    // the moduleId THIS test file's own fixtures above use ('/tmp/fake.test.ts').
    // Never a real repo file; must not be recorded as a flakiness signal.
    expect(shouldRecordTestRunPath('../../../../tmp/fake.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('../outside-repo.test.ts')).toBe(false);
    expect(shouldRecordTestRunPath('..\\windows-outside.test.ts')).toBe(false);
  });

  it('buildOutputTail captures failed TEST-CASE errors when the module has no top-level errors', () => {
    const fakeModule = {
      moduleId: '/tmp/fake.test.ts',
      state: () => 'failed',
      errors: () => [],
      children: {
        allTests: () => [
          {
            fullName: 'suite > passes',
            result: () => ({ state: 'passed', errors: [] }),
          },
          {
            fullName: 'suite > fails',
            result: () => ({ state: 'failed', errors: [{ message: 'expected 1 to be 2' }] }),
          },
        ],
      },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    const tail = buildOutputTail(fakeModule, 'fail');
    expect(tail).toBe('suite > fails: expected 1 to be 2');
  });

  it('buildOutputTail prefers module-level errors and stays null for passing modules', () => {
    const withModuleErr = {
      errors: () => [{ message: 'import boom' }],
      children: { allTests: () => [] },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    expect(buildOutputTail(withModuleErr, 'fail')).toBe('import boom');

    const passing = {
      errors: () => [],
      children: {
        allTests: () => [{ fullName: 'x', result: () => ({ state: 'passed', errors: [] }) }],
      },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    expect(buildOutputTail(passing, 'pass')).toBeNull();
  });

  it('buildOutputTail is fail-soft when the test walk throws', () => {
    const explosive = {
      errors: () => [],
      children: {
        allTests: () => {
          throw new Error('walk-explodes');
        },
      },
    } as unknown as Parameters<typeof buildOutputTail>[0];
    expect(buildOutputTail(explosive, 'fail')).toBeNull();
  });

  it('isScratchConfigFile (EI-18767688096795873): flags a config resolved OUTSIDE the repo tree', () => {
    // Exactly the reported shape: a mutation-testing harness's throwaway config
    // under /tmp, unrelated to the real in-tree repo root.
    expect(isScratchConfigFile('/tmp/mutant-abc123/vitest.mutant.config.ts', '/home/dev/papercup')).toBe(true);
  });

  it('isScratchConfigFile: does NOT flag a canonical in-tree config', () => {
    expect(isScratchConfigFile('/home/dev/papercup/packages/operator-core/vitest.config.ts', '/home/dev/papercup')).toBe(false);
    expect(isScratchConfigFile('/home/dev/papercup/vitest.config.ts', '/home/dev/papercup')).toBe(false);
  });

  it('isScratchConfigFile: defaults to false (trust the run) when there is no configFile at all', () => {
    // A config-less `vitest run` (libs/generic/* shape) resolves configFile to
    // `false` — must never be treated as scratch (that would suppress a real signal).
    expect(isScratchConfigFile(false, '/home/dev/papercup')).toBe(false);
    expect(isScratchConfigFile(undefined, '/home/dev/papercup')).toBe(false);
    expect(isScratchConfigFile('', '/home/dev/papercup')).toBe(false);
  });

  it('isScratchConfigFile: a sibling directory that merely SHARES the repo-root prefix is still outside the tree', () => {
    // '/home/dev/papercup-release' starts with the string '/home/dev/papercup' but
    // is a DIFFERENT directory — relative() must be used, not a string prefix check.
    expect(isScratchConfigFile('/home/dev/papercup-release/vitest.config.ts', '/home/dev/papercup')).toBe(true);
  });

  it('computeIsScratchConfig (EI-18767688096795873): reads ctx.vite.config.configFile, not ctx.config', () => {
    // The resolved config path lives on the underlying Vite dev server's config,
    // not Vitest's own ctx.config (which deliberately omits configFile).
    const scratch = { vite: { config: { configFile: '/tmp/mutant-xyz/vitest.mutant.config.ts' } } } as unknown as Parameters<typeof computeIsScratchConfig>[0];
    expect(computeIsScratchConfig(scratch)).toBe(true);

    const canonical = { vite: { config: { configFile: `${process.cwd()}/vitest.config.ts` } } } as unknown as Parameters<typeof computeIsScratchConfig>[0];
    expect(computeIsScratchConfig(canonical)).toBe(false);
  });

  it('computeIsScratchConfig defaults to false (never throws) on a bogus/missing ctx.vite', () => {
    expect(computeIsScratchConfig({} as unknown as Parameters<typeof computeIsScratchConfig>[0])).toBe(false);
    expect(computeIsScratchConfig(null as unknown as Parameters<typeof computeIsScratchConfig>[0])).toBe(false);
  });

  it('onInit (EI-18767688096795873): wires computeIsScratchConfig without throwing, even on a bogus ctx', () => {
    const r = new AdminTestRunsReporter();
    const fakeCtx = { vite: { config: { configFile: '/tmp/mutant-xyz/vitest.mutant.config.ts' } } } as unknown as Parameters<typeof r.onInit>[0];
    expect(() => r.onInit(fakeCtx)).not.toThrow();
    expect(() => r.onInit(null as never)).not.toThrow();
  });

  it('onTestRunEnd resolves cleanly with no pending work', async () => {
    const r = new AdminTestRunsReporter();
    await expect(r.onTestRunEnd()).resolves.toBeUndefined();
  });

  it('onExit resolves cleanly with no pending work', async () => {
    const r = new AdminTestRunsReporter();
    await expect(r.onExit()).resolves.toBeUndefined();
  });
});

/**
 * EI-19307211919650123 — the root walk must tell a linked WORKTREE apart from a
 * SUBMODULE. Both carry a `.git` FILE, and they need opposite answers:
 *   - worktree  → this dir IS the repo root; stop (paths are relative to it)
 *   - submodule → the superproject above is the root; keep walking
 *
 * The regression this guards is not hypothetical. Treating every `.git` file as
 * "keep walking" made the green gate's checkout (`papercusp-checkpoint`, a linked
 * worktree) resolve its root to a stray `/home/<user>/.git`, so every gate row was
 * stamped `papercupai-workspace/papercusp-checkpoint/…` and then dropped by
 * `shouldRecordTestRunPath` — the release gate recorded nothing at all.
 *
 * Uses a real temp fs rather than mocking `node:fs`, so it exercises the same
 * statSync/readFileSync path production takes.
 */
describe('classifyGitEntry (worktree vs submodule vs plain repo root)', () => {
  const made: string[] = [];
  function tree(): string {
    const d = mkdtempSync(join(tmpdir(), 'pc-gitentry-'));
    made.push(d);
    return d;
  }
  afterEach(() => {
    while (made.length) {
      try { rmSync(made.pop() as string, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('a `.git` DIRECTORY is a repo root', () => {
    const d = tree();
    mkdirSync(join(d, '.git'));
    expect(classifyGitEntry(d)).toBe('root');
  });

  it('THE REGRESSION: a linked-worktree gitlink is a repo root, not a thing to walk past', () => {
    const d = tree();
    writeFileSync(join(d, '.git'), 'gitdir: /repo/.git/worktrees/papercusp-checkpoint\n');
    expect(classifyGitEntry(d)).toBe('root');
  });

  it('a SUBMODULE gitlink is still skipped — the superproject stays the root', () => {
    const d = tree();
    writeFileSync(join(d, '.git'), 'gitdir: /repo/.git/modules/libs/generic/cache\n');
    expect(classifyGitEntry(d)).toBe('skip');
  });

  it('no `.git` entry at all reports none', () => {
    expect(classifyGitEntry(tree())).toBe('none');
  });

  it('an unrecognised gitlink keeps the previous behaviour (skip), never an invented root', () => {
    const d = tree();
    writeFileSync(join(d, '.git'), 'this is not a gitlink\n');
    expect(classifyGitEntry(d)).toBe('skip');
    const d2 = tree();
    writeFileSync(join(d2, '.git'), 'gitdir: /repo/.git/something-else/x\n');
    expect(classifyGitEntry(d2)).toBe('skip');
  });

  it('tolerates windows-style separators in the gitdir target', () => {
    const d = tree();
    writeFileSync(join(d, '.git'), 'gitdir: C:\\repo\\.git\\worktrees\\wt\n');
    expect(classifyGitEntry(d)).toBe('root');
  });

  it('COMPOSED: the walk stops at a worktree, and its paths survive shouldRecordTestRunPath', () => {
    // Mirrors the real shape: a superproject with a linked worktree beside it.
    const repo = tree();
    mkdirSync(join(repo, '.git'));
    const wt = join(repo, 'checkout');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'checkout')}\n`);

    expect(classifyGitEntry(wt)).toBe('root');
    // Because the walk stops AT the worktree, a test file inside it records as
    // repo-relative (`packages/...`) — the same key a local run in the main tree
    // produces, which is what makes gate-vs-local comparison possible at all.
    expect(shouldRecordTestRunPath('packages/operator-core/lib/foo.test.ts')).toBe(true);
    // Had the walk continued past it, the path would have carried the checkout
    // prefix — the exact shape NON_SIGNAL_PREFIXES drops.
    expect(
      shouldRecordTestRunPath('papercupai-workspace/papercusp-checkpoint/packages/operator-core/lib/foo.test.ts'),
    ).toBe(false);
  });
});

// WI-6583: harness_slug/workspace_id were populated on effectively none of
// 647,266 rows because only ONE naming convention was ever checked. These pin
// the broadened precedence so a future edit can't quietly narrow it back down.
describe('resolveTestRunHarnessSlug / resolveTestRunWorkspaceId (WI-6583)', () => {
  const ATTRIBUTION_KEYS = [
    'PAPERCUSP_TEST_RUN_HARNESS',
    'HARNESS_SLUG',
    'PAPERCUSP_HARNESS_SLUG',
    'PAPERCUSP_WORKSPACE_ID',
    'PAPERCUSP_WORKSPACE',
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ATTRIBUTION_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ATTRIBUTION_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('resolveTestRunHarnessSlug: returns null when nothing is set', () => {
    expect(resolveTestRunHarnessSlug()).toBeNull();
  });

  it('resolveTestRunHarnessSlug: falls back to HARNESS_SLUG (a harness-spawned agent role)', () => {
    process.env.HARNESS_SLUG = 'my-harness';
    expect(resolveTestRunHarnessSlug()).toBe('my-harness');
  });

  it('resolveTestRunHarnessSlug: falls back to PAPERCUSP_HARNESS_SLUG (an interactive su/psu shell)', () => {
    process.env.PAPERCUSP_HARNESS_SLUG = 'papercusp';
    expect(resolveTestRunHarnessSlug()).toBe('papercusp');
  });

  it('resolveTestRunHarnessSlug: PAPERCUSP_TEST_RUN_HARNESS (explicit dogfood override) wins over the others', () => {
    process.env.PAPERCUSP_TEST_RUN_HARNESS = 'explicit';
    process.env.HARNESS_SLUG = 'from-spawn';
    process.env.PAPERCUSP_HARNESS_SLUG = 'from-shell';
    expect(resolveTestRunHarnessSlug()).toBe('explicit');
  });

  it('resolveTestRunHarnessSlug: HARNESS_SLUG wins over PAPERCUSP_HARNESS_SLUG', () => {
    process.env.HARNESS_SLUG = 'from-spawn';
    process.env.PAPERCUSP_HARNESS_SLUG = 'from-shell';
    expect(resolveTestRunHarnessSlug()).toBe('from-spawn');
  });

  it('resolveTestRunWorkspaceId: returns null when nothing is set', () => {
    expect(resolveTestRunWorkspaceId()).toBeNull();
  });

  it('resolveTestRunWorkspaceId: falls back to PAPERCUSP_WORKSPACE (an interactive su/psu shell)', () => {
    process.env.PAPERCUSP_WORKSPACE = 'papercusp-workspace';
    expect(resolveTestRunWorkspaceId()).toBe('papercusp-workspace');
  });

  it('resolveTestRunWorkspaceId: PAPERCUSP_WORKSPACE_ID wins over PAPERCUSP_WORKSPACE', () => {
    process.env.PAPERCUSP_WORKSPACE_ID = 'ws-id';
    process.env.PAPERCUSP_WORKSPACE = 'ws-legacy';
    expect(resolveTestRunWorkspaceId()).toBe('ws-id');
  });
});
