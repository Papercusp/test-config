/** Keeps @vitest/coverage-v8's remapping/reporting; observes each isolated test FILE. */
import v8 from '@vitest/coverage-v8';
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js';
import type { ReportContext } from 'vitest/node';
import type { Sql } from 'postgres';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readExecutedSourceOriginals } from './vitest-config.ts';
import { inferWorkspaceRoot, isMutationProbeRun, resolveTestRunHarnessSlug,
  resolveTestRunWorkspaceId, tryGetPg } from './admin-test-runs-reporter.ts';
import { COVERAGE_MAX_FILES, coverageHash, coverageLines, coveragePath, parseTestCoverage,
  parseCoverageCollectionScope, qualifyCoverageSnapshots,
  type TestCoverageSnapshot } from './test-coverage-map.ts';
import { writeTestCoverage } from './test-coverage-store.ts';

export class TestFileCoverageProvider extends V8CoverageProvider {
  constructor(private readonly publish: (snapshots: TestCoverageSnapshot[]) => Promise<void> = persistSnapshots) { super(); }
  // Keep declaration emission independent of the donor node_modules realpath
  // when the maintained committed verifier links dependencies into its clone.
  override async generateCoverage(context: ReportContext): Promise<Awaited<ReturnType<V8CoverageProvider['generateCoverage']>>> {
    const original = this.coverageFiles;
    const cleanOnRerun = this.options.cleanOnRerun;
    const snapshots: TestCoverageSnapshot[] = [];
    const rejected = { sharedBatch: 0, receipts: 0, source: 0, test: 0, schema: 0, unmeasuredSources: 0 };
    const observedAt = new Date().toISOString();
    try {
      const root = inferWorkspaceRoot(this.ctx.config.root);
      const specs = await this.ctx.globTestSpecifications();
      const population = await Promise.all(specs.slice(0, COVERAGE_MAX_FILES).map(async spec => ({
        path: coveragePath(root, spec.moduleId)!, sha256: coverageHash(await readFile(spec.moduleId)),
      })));
      const files = this.ctx.state.getFiles();
      const complete = specs.length > 0 && specs.length <= COVERAGE_MAX_FILES
        && files.length === specs.length && files.every(f => f.result?.state === 'pass')
        && !this.ctx.config.testNamePattern && !this.ctx.config.changed && !this.ctx.config.related?.length
        && this.ctx.state.getUnhandledErrors().length === 0
        && files.every(f => !hasSkipped(f));
      this.options.cleanOnRerun = true;
      for (const [project, modes] of original) for (const [mode, suites] of Object.entries(modes)) {
        const environment = mode as keyof typeof modes;
        for (const [tests, rawFile] of Object.entries(suites)) {
          const testFiles = tests.split(',');
          // A shared worker batch cannot establish which file executed a line.
          if (testFiles.length !== 1 || snapshots.length >= COVERAGE_MAX_FILES) { rejected.sharedBatch++; continue; }
          this.coverageFiles = new Map([[project, { [environment]: { [tests]: rawFile } } as typeof modes]]);
          const converted = await super.generateCoverage({ allTestsRun: false });
          const activeProject = this.ctx.getProjectByName(typeof project === 'string' ? project : '');
          const receipts = readExecutedSourceOriginals(activeProject.vite.environments[mode]);
          const hashes = new Map<string, Set<string>>();
          for (const receipt of receipts ?? []) {
            const set = hashes.get(receipt.id) ?? new Set<string>(); set.add(receipt.sha256); hashes.set(receipt.id, set);
          }
          // Ordinary LCOV includes unloaded files as zero-hit entries. They have no
          // execution receipt and must remain unknown in the per-test observation.
          const mappedPaths = converted.files();
          const paths = mappedPaths.filter(absolute => hashes.has(absolute));
          rejected.unmeasuredSources += mappedPaths.length - paths.length;
          if (!receipts || paths.length > COVERAGE_MAX_FILES) { rejected.receipts++; continue; }
          const sources = await Promise.all(paths.map(async absolute => {
            const path = coveragePath(root, absolute);
            const sha256 = coverageHash(await readFile(absolute));
            if (!path || hashes.get(absolute)?.size !== 1 || !hashes.get(absolute)?.has(sha256)) return null;
            return { path, sha256, ...coverageLines(converted.fileCoverageFor(absolute)) };
          }));
          // Vitest stores suite keys relative to the owning project, while original
          // transform receipts and test specifications use absolute module IDs.
          const testAbsolute = resolve(activeProject.config.root, testFiles[0]!);
          const testFile = coveragePath(root, testAbsolute);
          const test = population.find(s => s.path === testFile);
          if (sources.some(s => s === null)) { rejected.source++; continue; }
          if (!test || hashes.get(testAbsolute)?.size !== 1 || !hashes.get(testAbsolute)?.has(test.sha256)) {
            rejected.test++; continue;
          }
          const snapshot = parseTestCoverage({ schemaVersion: 1, root, scopeRoot: this.ctx.config.root,
            testFile, testSha256: test.sha256, observedAt,
            populationComplete: complete, population, sources });
          if (snapshot) snapshots.push(snapshot); else rejected.schema++;
        }
      }
      if (snapshots.length && !isMutationProbeRun()) {
        await this.publish(snapshots);
      }
      if (original.size && !snapshots.length) this.ctx.logger.warn(`[test-file-coverage] no qualified observations: ${JSON.stringify(rejected)}`);
      if (snapshots.length && rejected.unmeasuredSources) this.ctx.logger.log(
        `[test-file-coverage] unmeasured sources without original execution receipts: ${rejected.unmeasuredSources}`);
    } catch (error) {
      // Optional data must never change test outcomes; a missing observation is unknown.
      this.ctx.logger.warn(`[test-file-coverage] unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.coverageFiles = original;
      this.options.cleanOnRerun = cleanOnRerun;
    }
    return super.generateCoverage(context);
  }
}
async function persistSnapshots(snapshots: TestCoverageSnapshot[]): Promise<void> {
  const rawScope = process.env.PC_TEST_FILE_COVERAGE_SCOPE;
  const scope = parseCoverageCollectionScope(rawScope);
  if (rawScope && !scope) throw new Error('Invalid gate coverage scope');
  if (process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1' && !scope) return;
  const qualified = scope ? await qualifyCoverageSnapshots(snapshots, scope) : snapshots;
  const pg = await tryGetPg();
  // Coverage and test_runs must share the reporter's ledger-only overrides.
  // Private native runtimes intentionally inherit a different caller harness.
  const workspace = scope?.workspaceId ?? resolveTestRunWorkspaceId();
  const harness = scope?.harnessSlug ?? resolveTestRunHarnessSlug();
  if (!pg || !workspace || !harness) throw new Error('Coverage persistence scope or sink unavailable');
  await writeTestCoverage(pg.sql as unknown as Sql, workspace, harness, qualified,
    process.env.PAPERCUSP_TEST_RUN_GROUP ?? null);
}
function hasSkipped(task: { mode: string; tasks?: readonly unknown[] }): boolean {
  return task.mode === 'skip' || task.mode === 'todo'
    || Boolean(task.tasks?.some(t => hasSkipped(t as Parameters<typeof hasSkipped>[0])));
}
export default { ...v8, getProvider: () => new TestFileCoverageProvider() };
