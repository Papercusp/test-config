/** P016 optional telemetry beside test_runs; one bounded latest observation per test file. */
import type { Sql } from 'postgres';
import { COVERAGE_MAX_ROWS, COVERAGE_RETENTION_MS, parseTestCoverage, type TestCoverageSnapshot } from './test-coverage-map.ts';

export async function writeTestCoverage(sql: Sql, workspace: string, harness: string,
  snapshots: readonly TestCoverageSnapshot[], runGroup: string | null = null): Promise<void> {
  const valid = snapshots.filter(s => parseTestCoverage(s));
  if (!valid.length || valid.length !== snapshots.length || valid.length > 200) throw new Error('Invalid coverage snapshot batch');
  await sql.begin(async tx => {
    await tx`SET LOCAL statement_timeout = '1500ms'`;
    await tx`SET LOCAL lock_timeout = '100ms'`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`test-coverage:${workspace}:${harness}`}, 0))`;
    const rows = valid.map(snapshot => ({ workspace_id: workspace, harness_slug: harness,
      root_path: snapshot.root, scope_root: snapshot.scopeRoot, test_file: snapshot.testFile,
      observed_at: snapshot.observedAt, run_group_id: runGroup,
      snapshot: tx.json(JSON.parse(JSON.stringify(snapshot))) }));
    await tx`INSERT INTO harness_shared.test_coverage_maps ${tx(rows, 'workspace_id', 'harness_slug', 'root_path',
      'scope_root', 'test_file', 'observed_at', 'run_group_id', 'snapshot')}
      ON CONFLICT (workspace_id, harness_slug, root_path, scope_root, test_file) DO UPDATE
      SET observed_at = EXCLUDED.observed_at, run_group_id = EXCLUDED.run_group_id, snapshot = EXCLUDED.snapshot
      WHERE test_coverage_maps.observed_at <= EXCLUDED.observed_at`;
    await tx`DELETE FROM harness_shared.test_coverage_maps WHERE workspace_id = ${workspace} AND harness_slug = ${harness}
      AND (observed_at < ${new Date(Date.now() - COVERAGE_RETENTION_MS).toISOString()}::timestamptz
        OR (root_path, scope_root, test_file) IN (
          SELECT root_path, scope_root, test_file FROM harness_shared.test_coverage_maps
          WHERE workspace_id = ${workspace} AND harness_slug = ${harness}
          ORDER BY observed_at DESC, root_path, scope_root, test_file OFFSET ${COVERAGE_MAX_ROWS}))`;
  });
}

export async function readTestCoverage(sql: Sql, workspace: string, harness: string, root: string,
  paths: readonly string[], runGroup?: string): Promise<TestCoverageSnapshot[]> {
  if (!paths.length || paths.length > 50) return [];
  if (runGroup !== undefined && !runGroup.trim()) return [];
  const rows = await sql<{ snapshot: unknown }[]>`SELECT snapshot FROM harness_shared.test_coverage_maps
    WHERE workspace_id = ${workspace} AND harness_slug = ${harness} AND root_path = ${root}
      AND (${runGroup ?? null}::text IS NULL OR run_group_id = ${runGroup ?? null})
      AND observed_at > ${new Date(Date.now() - COVERAGE_RETENTION_MS).toISOString()}::timestamptz
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot->'sources') s WHERE s->>'path' = ANY(${[...paths]}::text[]))
    ORDER BY observed_at DESC LIMIT 200`;
  return rows.flatMap(row => { const parsed = parseTestCoverage(row.snapshot); return parsed ? [parsed] : []; });
}
