import { existsSync } from 'node:fs';
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
});
