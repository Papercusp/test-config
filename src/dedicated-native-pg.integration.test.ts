import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { nativePgSettingArgs, resolveNativePgBinDir, startDedicatedNativePg } from './dedicated-native-pg.ts';

function hasNativePg(): boolean {
  try {
    resolveNativePgBinDir();
    return true;
  } catch {
    return false;
  }
}

describe('nativePgSettingArgs', () => {
  it('renders -c name=value pairs in order', () => {
    expect(nativePgSettingArgs({ max_connections: '200', fsync: 'on' })).toEqual([
      '-c', 'max_connections=200', '-c', 'fsync=on',
    ]);
  });
});

describe.skipIf(!hasNativePg())('startDedicatedNativePg (no Docker)', () => {
  it('owns a reachable cluster with the requested settings and removes it on stop', async () => {
    const pg = await startDedicatedNativePg({ settings: { max_connections: '37' } });
    const sql = postgres(pg.getConnectionUri(), { max: 1, onnotice: () => {} });
    try {
      const [row] = await sql<{ mc: string; fsync: string; su: boolean }[]>`
        SELECT current_setting('max_connections') AS mc, current_setting('fsync') AS fsync,
               (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`;
      expect(row).toEqual({ mc: '37', fsync: 'on', su: true });
      await sql`CREATE DATABASE native_pg_probe`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    expect(existsSync(pg.dataDir)).toBe(true);
    await pg.stop();
    expect(existsSync(pg.dataDir)).toBe(false);
    await pg.stop(); // idempotent
  }, 120_000);

  // WI-10004469: a socket in dataDir made startup depend on the base-dir length. PUI
  // rehearsal run 12 used a long TMPDIR; the ~125-byte socket path exceeded the kernel's
  // 107-byte sun_path limit, the postmaster died with "could not create any Unix-domain
  // sockets", and the start waited out its whole readiness budget.
  it('starts under a base dir whose socket path would exceed the 107-byte limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-pg-long-'));
    const baseDir = join(root, 'x'.repeat(80));
    await mkdir(baseDir, { recursive: true });
    let pg: Awaited<ReturnType<typeof startDedicatedNativePg>> | undefined;
    try {
      pg = await startDedicatedNativePg({ baseDir, readyBudgetMs: 20_000 });
      // The precondition that made the old code fail must hold, or this test is vacuous.
      expect(Buffer.byteLength(join(pg.dataDir, `.s.PGSQL.${pg.port}`))).toBeGreaterThan(107);
      const sql = postgres(pg.getConnectionUri(), { max: 1, onnotice: () => {} });
      try {
        const [row] = await sql<{ one: number; sockets: string }[]>`
          SELECT 1 AS one, current_setting('unix_socket_directories') AS sockets`;
        expect(row).toEqual({ one: 1, sockets: '' });
      } finally {
        await sql.end({ timeout: 5 });
      }
    } finally {
      await pg?.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails fast with the server FATAL when the postmaster dies at startup', async () => {
    const startedAt = Date.now();
    const err = await startDedicatedNativePg({
      settings: { shared_buffers: 'not-a-size' },
      readyBudgetMs: 60_000,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsedMs = Date.now() - startedAt;
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('postmaster exited before accepting connections');
    expect(message).toMatch(/invalid value for parameter "shared_buffers"/);
    // initdb runs first (a few seconds under load); the bound is far below the 60s budget.
    expect(elapsedMs).toBeLessThan(30_000);
  }, 120_000);
});
