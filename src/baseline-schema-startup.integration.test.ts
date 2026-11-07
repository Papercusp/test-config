import { afterAll, beforeAll, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { getContainerRuntimeClient } from 'testcontainers';
import postgres from 'postgres';
import { createBaselineSchemaContainer, runBaselineSetupStage } from './baseline-schema-global-setup.ts';

let pg: StartedPostgreSqlContainer | undefined;
let sql: ReturnType<typeof postgres> | undefined;

// Docker creation/start, SQL assertions and owned cleanup have separate budgets.
// A single 120s case deadline could expire after PG was ready, hiding the phase.
beforeAll(async () => {
  // Exercise the production builder without borrowing or stopping a reused peer.
  pg = await runBaselineSetupStage('regression-container-start', () => createBaselineSchemaContainer(0).start());
  sql = postgres(pg.getConnectionUri(), { max: 1, onnotice: () => {} });
}, 240_000);

afterAll(async () => {
  try {
    await runBaselineSetupStage('regression-sql-close', async () => { await sql?.end({ timeout: 5 }); });
  } finally {
    await runBaselineSetupStage('regression-container-remove', async () => { await pg?.stop(); });
  }
}, 120_000);

it('starts the baseline PostgreSQL builder with disposable initialization and durability settings', async () => {
  const connection = sql!;
  await runBaselineSetupStage('regression-sql', async () => {
    const [identity] = await connection<{ database: string; version: number }[]>`
      SELECT current_database() AS database, current_setting('server_version_num')::integer AS version`;
    expect(identity?.database).toBe('papercusp_it');
    expect(identity?.version).toBeGreaterThanOrEqual(180000);
    const settings = await connection<{ name: string; setting: string }[]>`
      SELECT name, setting FROM pg_settings
      WHERE name IN ('fsync', 'synchronous_commit', 'full_page_writes')`;
    expect(Object.fromEntries(settings.map(row => [row.name, row.setting]))).toEqual({
      fsync: 'off', synchronous_commit: 'off', full_page_writes: 'off',
    });
    await connection`CREATE TABLE baseline_startup_probe (value integer)`;
    await connection`INSERT INTO baseline_startup_probe VALUES (42)`;
    expect((await connection`SELECT value FROM baseline_startup_probe`)[0]?.value).toBe(42);
  });
  // initdb's startup-only option cannot be observed through pg_settings.
  await runBaselineSetupStage('regression-container-inspect', async () => {
    const runtime = await getContainerRuntimeClient();
    const inspected = await runtime.container.inspect(runtime.container.getById(pg!.getId()));
    expect(inspected.Config.Env).toContain('POSTGRES_INITDB_ARGS=--no-sync');
  });
}, 120_000);
