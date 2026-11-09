import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  captureConfigurationSnapshot,
  configurationSnapshotFingerprint,
  readConfigurationSnapshot,
  observeConfigurationReads,
  readConfigurationReadObservation,
  configurationReadLimits,
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

describe('observed JavaScript configuration reads', () => {
  it('retains consumed hashes in order, including mutation and unset values, without sampling unread keys', () => {
    const original = { PAPERCUSP_TOKEN: 'secret-before', PAPERCUSP_UNREAD: 'unread-secret', UNRELATED: 'ignored' };
    const observed = observeConfigurationReads(original);
    expect(observed.environment.PAPERCUSP_TOKEN).toBe('secret-before');
    observed.environment.PAPERCUSP_TOKEN = 'secret-after';
    expect(observed.environment.PAPERCUSP_TOKEN).toBe('secret-after');
    expect(observed.environment.PAPERCUSP_MISSING).toBeUndefined();
    expect(observed.environment.UNRELATED).toBe('ignored');
    const receipt = observed.finish(observed.environment);
    expect(receipt).toMatchObject({ captureComplete: true, activeAtTermination: true, populationStatus: 'unknown',
      reads: [{ key: 'PAPERCUSP_TOKEN', sha256: sha('secret-before') },
        { key: 'PAPERCUSP_TOKEN', sha256: sha('secret-after') }, { key: 'PAPERCUSP_MISSING', sha256: null }] });
    expect(JSON.stringify(receipt)).not.toMatch(/secret-before|secret-after|unread-secret|PAPERCUSP_UNREAD/);
    expect(original.PAPERCUSP_TOKEN).toBe('secret-after');
    expect(readConfigurationReadObservation(receipt)).toEqual(receipt);
  });

  it('forwards actual process environment reads, writes, deletion and enumeration', () => {
    const original = process.env, key = 'PAPERCUSP_CONFIGURATION_READ_TEST', previous = original[key];
    const observed = observeConfigurationReads(original);
    let receipt: ReturnType<typeof observed.finish>;
    try {
      process.env = observed.environment;
      process.env[key] = 'process-value';
      const actual = process.env[key], present = key in process.env && Object.keys(process.env).includes(key);
      delete process.env[key];
      const absent = process.env[key];
      receipt = observed.finish(process.env);
      expect(actual).toBe('process-value'); expect(present).toBe(true); expect(absent).toBeUndefined();
    } finally {
      process.env = original;
      if (previous === undefined) delete original[key]; else original[key] = previous;
    }
    expect(receipt!.reads.filter(row => row.key === key)).toEqual([
      { key, sha256: sha('process-value') }, { key, sha256: null }]);
    expect(receipt!.activeAtTermination).toBe(true);
  });

  it('marks bounded or replaced captures without changing reads or claiming closure', () => {
    const observed = observeConfigurationReads({ PAPERCUSP_X: 'value' });
    for (let i = 0; i <= configurationReadLimits.reads; i++) expect(observed.environment.PAPERCUSP_X).toBe('value');
    const receipt = observed.finish({});
    expect(receipt.reads).toHaveLength(configurationReadLimits.reads);
    expect(receipt).toMatchObject({ captureComplete: false, activeAtTermination: false, populationStatus: 'unknown' });
    expect(readConfigurationReadObservation(receipt)).toEqual(receipt);
  });

  it('preserves property errors and stops observing after finish', () => {
    const failure = new Error('original getter');
    const target = Object.defineProperty({}, 'PAPERCUSP_THROW', { get() { throw failure; } });
    const observed = observeConfigurationReads(target);
    expect(() => observed.environment.PAPERCUSP_THROW).toThrow(failure);
    const first = observed.finish(observed.environment);
    expect(first.captureComplete).toBe(false);
    observed.environment.PAPERCUSP_LATER = 'later';
    expect(observed.environment.PAPERCUSP_LATER).toBe('later');
    expect(observed.finish(observed.environment).reads).toEqual(first.reads);
  });

  it('rejects malformed, unbounded and falsely complete-population receipts', () => {
    const observed = observeConfigurationReads({ PAPERCUSP_X: 'value' });
    void observed.environment.PAPERCUSP_X;
    const receipt = observed.finish(observed.environment);
    expect(readConfigurationReadObservation(receipt)).toEqual(receipt);
    for (const invalid of [null, {}, { ...receipt, populationStatus: 'complete' },
      { ...receipt, captureComplete: 'true' }, { ...receipt, activeAtTermination: 1 },
      { ...receipt, limits: { ...receipt.limits, reads: 9999 } },
      { ...receipt, reads: Array(513).fill(receipt.reads[0]) },
      { ...receipt, reads: [{ key: 'UNRELATED', sha256: sha('value') }] },
      { ...receipt, reads: [{ key: 'PAPERCUSP_X', sha256: 'raw-secret' }] }])
      expect(readConfigurationReadObservation(invalid)).toBeNull();
  });
});
