import { relative } from 'node:path';
import type { TestProject } from 'vitest/node';
import type postgres from 'postgres';
import {
  inferWorkspaceRoot, resolveTestRunsPgUrl, resolveTestRunWorkspaceId, resolveTestRunHarnessSlug,
} from './admin-test-runs-reporter.ts';
import { testTimingRuntimeIdentity, type TestTimeoutHistorySnapshot } from './test-timeout-runtime.ts';
import type { TestTimingSample } from './test-timeout-history.ts';

/** Read once in Vitest's main process, before the unit workers forbid real PG. */
export default async function setup(project: TestProject): Promise<void> {
  const root = inferWorkspaceRoot(project.config.root);
  const runnerIdentity = testTimingRuntimeIdentity();
  const snapshot: TestTimeoutHistorySnapshot = {
    schema: 1, root, runnerIdentity, observedAtMs: Date.now(), samples: [],
  };
  const files = project.vitest.state.getPaths().map(file => relative(root, file).replaceAll('\\', '/'));
  if (files.length && runnerIdentity) {
    // This is a read-only advisory source. A missing/old ledger uses the policy's
    // finite fallback. Server statement_timeout plus client destruction bounds
    // this read without leaving a timed-out query queued behind the reporter.
    let sql: ReturnType<typeof postgres> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { default: postgres } = await import('postgres');
      sql = postgres(resolveTestRunsPgUrl(), {
        max: 1, fetch_types: false, connect_timeout: 1,
        connection: { statement_timeout: 3_000 }, onnotice: () => {},
      });
      const client = sql;
      timer = setTimeout(() => { void client.end({ timeout: 0 }).catch(() => {}); }, 5_000);
      timer.unref();
      const rows = await sql`
        SELECT r.file_path, r.id::text AS run_id, r.duration_ms AS file_duration_ms,
               extract(epoch FROM r.finished_at) * 1000 AS observed_at_ms,
               c.case_key, c.occurrence, c.duration_ms AS case_duration_ms
        FROM unnest(${sql.array(files)}::text[]) AS selected(file_path)
        CROSS JOIN LATERAL (
          SELECT * FROM harness_shared.test_runs r
          WHERE r.file_path = selected.file_path AND r.framework = 'vitest'
            AND r.status = 'pass' AND r.worktree_dirty = false AND r.is_scratch_config = false
            AND r.source IN ('ci', 'local')
            AND r.workspace_id IS NOT DISTINCT FROM ${resolveTestRunWorkspaceId()}
            AND r.harness_slug IS NOT DISTINCT FROM ${resolveTestRunHarnessSlug()}
            AND r.execution_details->>'testLayer' = ${String(project.config.provide.papercuspTestLayer)}
            AND r.execution_details->>'testTimingRuntimeIdentity' = ${runnerIdentity}
            AND r.finished_at >= now() - interval '14 days'
          ORDER BY r.finished_at DESC LIMIT 20
        ) r
        LEFT JOIN harness_shared.test_case_runs c ON c.test_run_id = r.id AND c.status = 'pass'
      `;
      snapshot.samples = rows.map(row => ({
        file: row.file_path, caseKey: row.case_key ?? '', occurrence: Number(row.occurrence ?? 0),
        layer: String(project.config.provide.papercuspTestLayer), runnerIdentity,
        runId: row.run_id, observedAtMs: Number(row.observed_at_ms), status: 'pass', clean: true,
        caseDurationMs: row.case_duration_ms == null ? null : Number(row.case_duration_ms),
        fileDurationMs: row.file_duration_ms == null ? null : Number(row.file_duration_ms),
      } satisfies TestTimingSample));
      snapshot.readStatus = 'loaded';
    } catch (error) {
      snapshot.readStatus = 'unavailable';
      const code = (error as { code?: unknown })?.code;
      if (typeof code === 'string' && /^[A-Z0-9_]{1,50}$/.test(code)) snapshot.readErrorCode = code;
      // Old schemas and unavailable history do not suppress any tests.
    } finally {
      clearTimeout(timer);
      await sql?.end({ timeout: 0 }).catch(() => {});
    }
  }
  project.provide('papercuspTestTimeoutHistory', snapshot);
}
