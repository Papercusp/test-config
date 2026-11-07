import { expect, it } from "vitest";
import { getContainerRuntimeClient } from "testcontainers";
import postgres from "postgres";
import { assertLocalDockerBridgeReady, startDedicatedTestPg } from "./pg-container.ts";

// A Docker info/network record alone did not catch the deleted docker0 bridge.
// This contract exercises a fresh owned endpoint and host TCP SQL, without
// touching shared clusters or executing a child inside a PID-1 postmaster.
it("starts an owned PostgreSQL container and answers SQL through the selected Docker network", async () => {
  await assertLocalDockerBridgeReady(await getContainerRuntimeClient());
  const pg = await startDedicatedTestPg({ readyBudgetMs: 30_000 });
  const sql = postgres(pg.getConnectionUri(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ value: number; version: number }[]>`
      SELECT 1::integer AS value, current_setting('server_version_num')::integer AS version`;
    expect(row?.value).toBe(1);
    expect(row?.version).toBeGreaterThanOrEqual(180000);
  } finally {
    try { await sql.end({ timeout: 5 }); }
    finally { await pg.stop(); }
  }
}, 120_000);
