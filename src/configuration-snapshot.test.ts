import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  captureConfigurationSnapshot,
  configurationSnapshotFingerprint,
  readConfigurationSnapshot,
} from './configuration-snapshot';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('configuration snapshot (SPEC-P-011-RUNNER-CAPTURE)', () => {
  it('hashes every recorded var, keeps raw values only for flag-override vars, and ignores the rest', () => {
    const snapshot = captureConfigurationSnapshot({
      PAPERCUSP_FLAG_SOME_FLAG: '1',
      PAPERCUSP_PLATFORM_MODE: 'off',
      PAPERCUSP_API_TOKEN: 'secret-value',
      PC_HEAVY_RELEASE_GATE: '1',
      NODE_ENV: 'test',
      UNRELATED_VAR: 'not recorded',
      PAPERCUSP_UNSET: undefined,
    });
    expect(snapshot.flagEnv).toEqual({ PAPERCUSP_FLAG_SOME_FLAG: '1', PAPERCUSP_PLATFORM_MODE: 'off' });
    expect(snapshot.envSha256).toEqual({
      NODE_ENV: sha('test'),
      PAPERCUSP_API_TOKEN: sha('secret-value'),
      PAPERCUSP_FLAG_SOME_FLAG: sha('1'),
      PAPERCUSP_PLATFORM_MODE: sha('off'),
      PC_HEAVY_RELEASE_GATE: sha('1'),
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-value');
    expect(snapshot.fingerprint).toMatch(/^sha256-config-snapshot-v1:[0-9a-f]{64}$/);
  });

  it('gives the same fingerprint regardless of key order, and a different one when a value changes', () => {
    const a = captureConfigurationSnapshot({ NODE_ENV: 'test', PAPERCUSP_FLAG_X: '1' });
    const b = captureConfigurationSnapshot({ PAPERCUSP_FLAG_X: '1', NODE_ENV: 'test' });
    const c = captureConfigurationSnapshot({ NODE_ENV: 'test', PAPERCUSP_FLAG_X: '0' });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(configurationSnapshotFingerprint(a.flagEnv, a.envSha256)).toBe(a.fingerprint);
  });

  it('reads back a stored snapshot, from an object or a JSON string', () => {
    const snapshot = captureConfigurationSnapshot({ NODE_ENV: 'test', PAPERCUSP_FLAG_X: 'true' });
    expect(readConfigurationSnapshot(snapshot)).toEqual(snapshot);
    expect(readConfigurationSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('returns null for an absent, malformed, or tampered snapshot', () => {
    const snapshot = captureConfigurationSnapshot({ PAPERCUSP_FLAG_X: '0' });
    expect(readConfigurationSnapshot(null)).toBeNull();
    expect(readConfigurationSnapshot(undefined)).toBeNull();
    expect(readConfigurationSnapshot('not json')).toBeNull();
    expect(readConfigurationSnapshot({ ...snapshot, schemaVersion: 2 })).toBeNull();
    expect(readConfigurationSnapshot({ ...snapshot, flagEnv: { PAPERCUSP_FLAG_X: 1 } })).toBeNull();
    expect(readConfigurationSnapshot({ ...snapshot, flagEnv: { PAPERCUSP_FLAG_X: '1' } })).toBeNull();
  });
});
