import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { getContainerRuntimeClient } from 'testcontainers';
import postgres from 'postgres';
import { createBaselineSchemaContainer, runBaselineSetupStage } from './baseline-schema-global-setup.ts';

let pg: StartedPostgreSqlContainer | undefined;
let sql: ReturnType<typeof postgres> | undefined;
const apiTimings: Array<{ stage: string; elapsedMs: number }> = [];
const restoreApi: Array<() => void> = [];

async function timedApi<T>(stage: string, action: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await runBaselineSetupStage(`regression-docker-${stage}`, action);
  } finally {
    const observation = { stage, elapsedMs: Math.round(performance.now() - startedAt) };
    apiTimings.push(observation);
    process.stderr.write(`TEST_PG_DOCKER_API ${JSON.stringify(observation)}\n`);
  }
}

async function dispose() {
  try {
    await runBaselineSetupStage('regression-sql-close', async () => { await sql?.end({ timeout: 5 }); });
    sql = undefined;
  } finally {
    await runBaselineSetupStage('regression-container-remove', async () => { await pg?.stop(); });
    pg = undefined;
  }
}

// Docker creation/start, SQL assertions and owned cleanup have separate budgets.
// A single 120s case deadline could expire after PG was ready, hiding the phase.
beforeAll(async () => {
  const { container } = await getContainerRuntimeClient();
  const create = container.create.bind(container);
  const start = container.start.bind(container);
  const stop = container.stop.bind(container);
  const remove = container.remove.bind(container);
  restoreApi.push(
    vi.spyOn(container, 'create').mockImplementation(opts => timedApi('create', () => create(opts))).mockRestore,
    vi.spyOn(container, 'start').mockImplementation(handle => timedApi('start', () => start(handle))).mockRestore,
    vi.spyOn(container, 'stop').mockImplementation((handle, opts) => timedApi('stop', () => stop(handle, opts))).mockRestore,
    vi.spyOn(container, 'remove').mockImplementation((handle, opts) => timedApi('remove', () => remove(handle, opts))).mockRestore,
  );
  // Exercise the production builder without borrowing or stopping a reused peer.
  pg = await runBaselineSetupStage('regression-container-start', () => createBaselineSchemaContainer(0).start());
  sql = postgres(pg.getConnectionUri(), { max: 1, onnotice: () => {} });
}, 240_000);

afterAll(async () => {
  try {
    await dispose();
  } finally {
    for (const restore of restoreApi) restore();
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

it('keeps owned Docker create, start, stop and removal below thirty seconds per API', async () => {
  await dispose();
  // SQL passing cannot conceal a slow overlay create/unmount (WI-6554700010046431).
  for (const stage of ['create', 'start', 'stop', 'remove']) {
    const observations = apiTimings.filter(entry => entry.stage === stage);
    expect(observations.length, `Docker ${stage} must actually execute`).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(observation.elapsedMs, `Docker ${stage} latency`).toBeLessThan(30_000);
    }
  }
}, 120_000);
