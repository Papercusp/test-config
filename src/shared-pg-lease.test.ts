/**
 * WI-10003715 — the shared PG client must be LEASED, never closed out from under a sibling.
 *
 * Vitest runs every reporter's onTestRunEnd concurrently (Vitest.report → Promise.all). The
 * test-runs reporter and the executed-source-map reporter share one postgres.js client, and each
 * used to call closeSharedPg() in its finally. Whichever finished first ended the client while the
 * other was mid-flush, so the pass-proof writer's next chunk failed with CONNECTION_ENDED — the
 * largest workspaces lost every pass proof at the first green gate that recorded any.
 *
 * No real database here: a fake handle is installed in the SAME pinned slot the reporters use,
 * and it rejects any query issued after end() exactly the way postgres.js does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pinModuleState } from '@papercusp/module-singleton';

import { closeSharedPg, closeSharedPgIfUnheld, retainSharedPg, tryGetPg, type PgHandle } from './admin-test-runs-reporter.ts';

const shared = pinModuleState('@papercusp/test-config.shared-pg', () => ({
  promise: undefined as Promise<PgHandle> | undefined,
  holders: 0,
}));

function installFakeClient() {
  const state = { ended: false, queries: 0 };
  const end = vi.fn(async () => {
    state.ended = true;
  });
  const sql = (async () => {
    await new Promise((r) => setTimeout(r, 1));
    if (state.ended) throw new Error('write CONNECTION_ENDED localhost:5432');
    state.queries += 1;
    return [];
  }) as unknown as NonNullable<PgHandle>['sql'];
  (sql as unknown as { end: typeof end }).end = end;
  shared.promise = Promise.resolve({ sql } as PgHandle);
  return { state, end };
}

/** The executed-source-map writer's shape: a loop of chunked queries through the shared handle. */
async function chunkedWrite(chunks: number): Promise<void> {
  const handle = await tryGetPg();
  const q = handle!.sql as unknown as () => Promise<unknown>;
  for (let i = 0; i < chunks; i += 1) await q();
}

afterEach(async () => {
  shared.holders = 0;
  shared.promise = undefined;
});

describe('shared PG lease (WI-10003715)', () => {
  it('control: the OLD unconditional close from a sibling breaks an in-flight chunked write', async () => {
    const { state } = installFakeClient();
    const write = chunkedWrite(20);
    await new Promise((r) => setTimeout(r, 3));
    await closeSharedPg(); // the sibling reporter's former finally
    await expect(write).rejects.toThrow(/CONNECTION_ENDED/);
    expect(state.queries).toBeGreaterThan(0);
    expect(state.queries).toBeLessThan(20);
  });

  it('a sibling releasing its lease mid-flush does not end the client; the last release does', async () => {
    const { state, end } = installFakeClient();
    const siblingLease = retainSharedPg(); // test-runs reporter
    const writerLease = retainSharedPg(); // executed-source-map reporter
    const write = chunkedWrite(20);
    await new Promise((r) => setTimeout(r, 3));
    await siblingLease(); // sibling finishes its onTestRunEnd first
    expect(end).not.toHaveBeenCalled();
    await expect(write).resolves.toBeUndefined();
    expect(state.queries).toBe(20);
    await writerLease();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('release is idempotent (onTestRunEnd then onExit) and never over-decrements a sibling', async () => {
    const { end } = installFakeClient();
    const a = retainSharedPg();
    const b = retainSharedPg();
    await a();
    await a(); // onExit after onTestRunEnd
    expect(shared.holders).toBe(1);
    expect(end).not.toHaveBeenCalled();
    await b();
    expect(shared.holders).toBe(0);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('an unleased reporter (closeSharedPgIfUnheld) cannot end a client someone else holds', async () => {
    const { end } = installFakeClient();
    const held = retainSharedPg();
    await closeSharedPgIfUnheld();
    expect(end).not.toHaveBeenCalled();
    await held();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
