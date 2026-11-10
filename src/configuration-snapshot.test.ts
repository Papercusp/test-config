import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  PROOF_CONTEXT_COMPONENTS, createProofContextIdentity, readProofContextIdentity, proofContextImpact,
  type ProofContextIdentity, type ProofContextReach,
  captureConfigurationSnapshot,
  configurationSnapshotFingerprint,
  readConfigurationSnapshot,
  observeConfigurationReads,
  readConfigurationReadObservation,
  configurationReadLimits,
} from './configuration-snapshot';

describe('complete proof context and proportional reach', () => {
  const components = () => Object.fromEntries(PROOF_CONTEXT_COMPONENTS.map(key => [key, sha(key)])) as ProofContextIdentity['components'];
  const context = () => createProofContextIdentity(components())!;
  const reach = (before: ProofContextIdentity, after: ProofContextIdentity, component: ProofContextReach['component']): ProofContextReach => ({
    schemaVersion: 'reach-v1', component, before: before.components[component]!, after: after.components[component]!,
    provenance: { version: 'selected-consumers-v1', before: sha('old graph'), after: sha('new graph'), complete: true },
    tests: ['pkg/affected.test.ts'], legs: ['lint:affected'],
  });

  it('roundtrips JSONB ordering, rejects tampering, and treats equal known inputs as reusable without a reach query', () => {
    const before = context();
    const after = { ...before, components: Object.fromEntries(Object.entries(before.components).reverse()) };
    expect(readProofContextIdentity(JSON.parse(JSON.stringify(after)))).toEqual(before);
    expect(proofContextImpact({ before, after })).toEqual({ status: 'known', changed: [], tests: [], legs: [] });
    expect(readProofContextIdentity({ ...before, components: { ...before.components, behavior: sha('changed') } })).toBeNull();
    expect(readProofContextIdentity({ ...before, extra: true })).toBeNull();
    expect(createProofContextIdentity({ ...before.components, schema: 'not a hash' })).toBeNull();
  });

  it.each(PROOF_CONTEXT_COMPONENTS)('refuses an unknown %s even when the two identities compare equal', component => {
    const partial = createProofContextIdentity({ ...components(), [component]: null });
    expect(readProofContextIdentity(partial)).not.toBeNull();
    expect(proofContextImpact({ before: partial, after: partial })).toEqual({ status: 'unknown', reason: 'proof-context-incomplete' });
    const missing = { ...components() };
    delete (missing as Partial<typeof missing>)[component];
    expect(createProofContextIdentity(missing)).toBeNull();
  });

  it.each(PROOF_CONTEXT_COMPONENTS)('binds changed %s to exact old/new complete reach', component => {
    const before = context(), after = createProofContextIdentity({ ...components(), [component]: sha('changed') })!;
    const row = reach(before, after, component);
    expect(proofContextImpact({ before, after, reach: [row] })).toEqual({ status: 'known', changed: [component],
      tests: ['pkg/affected.test.ts'], legs: ['lint:affected'] });
    for (const rows of [undefined, [], [row, row], [{ ...row, before: sha('unrelated') }],
      [{ ...row, provenance: { ...row.provenance, complete: false } }],
      [{ ...row, provenance: { ...row.provenance, after: null } }],
      [{ ...row, tests: ['pkg/affected.test.ts', 'pkg/affected.test.ts'] }],
      [{ ...row, legs: row.tests }]]) {
      expect(proofContextImpact({ before, after, reach: rows }).status).toBe('unknown');
    }
  });

  it('refuses absent identities and duplicate reach that would hide another changed component', () => {
    expect(proofContextImpact(undefined).status).toBe('unknown');
    const before = context(), after = createProofContextIdentity({ ...components(), schema: sha('new schema'), behavior: sha('new behavior') })!;
    const row = reach(before, after, 'schema');
    expect(proofContextImpact({ before, after, reach: [row, row] }).status).toBe('unknown');
    expect(proofContextImpact({ before, after, reach: [row, reach(before, after, 'behavior')] }).status).toBe('known');
  });
});

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
  it('finishes without application array method, species or index callbacks', () => {
    const source = new URL('./configuration-snapshot.ts', import.meta.url).href;
    const script = `const { observeConfigurationReads } = await import(${JSON.stringify(source)});
      const observer = observeConfigurationReads({ PAPERCUSP_TOKEN: 'private-value' });
      void observer.environment.PAPERCUSP_TOKEN;
      const defineOwn = Object.defineProperty, apply = Reflect.apply;
      const map = Array.prototype.map, species = Object.getOwnPropertyDescriptor(Array, Symbol.species);
      const index = Object.getOwnPropertyDescriptor(Array.prototype, '0');
      let callbacks = 0;
      defineOwn(Array.prototype, 'map', { configurable: true, writable: true, value: function() {
        callbacks++; return apply(map, this, arguments);
      } });
      defineOwn(Array, Symbol.species, { configurable: true, get() { callbacks++; return Array; } });
      defineOwn(Array.prototype, '0', { configurable: true, set(value) {
        callbacks++; defineOwn(this, '0', { configurable: true, enumerable: true, writable: true, value });
      } });
      const receipt = observer.finish(observer.environment);
      defineOwn(Array.prototype, 'map', { configurable: true, writable: true, value: map });
      defineOwn(Array, Symbol.species, species);
      if (index) defineOwn(Array.prototype, '0', index); else delete Array.prototype[0];
      console.log(JSON.stringify({ callbacks, receipt }));`;
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      env, encoding: 'utf8', timeout: 10000,
    }));
    expect(result.callbacks).toBe(0);
    expect(result.receipt).toMatchObject({ captureComplete: true, activeAtTermination: true,
      populationStatus: 'unknown', reads: [{ key: 'PAPERCUSP_TOKEN', sha256: sha('private-value') }] });
    expect(JSON.stringify(result.receipt)).not.toContain('private-value');
  });

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

  it('preserves native environment overwrites and coercion in a fresh Node process', () => {
    // Vitest can replace process.env with a plain object. A private native
    // child exercises the exotic Node setter that rejects a Proxy receiver.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { observeConfigurationReads } = await import(process.argv[1]);
      const key = 'PAPERCUSP_CONFIGURATION_READ_NATIVE_TEST';
      const observed = observeConfigurationReads(process.env);
      process.env = observed.environment;
      const before = process.env[key];
      process.env[key] = 'after';
      const after = process.env[key];
      Reflect.set(process.env, key, 42);
      const coerced = process.env[key];
      process.env.PAPERCUSP_CONFIGURATION_CREATED = 'created';
      const created = process.env.PAPERCUSP_CONFIGURATION_CREATED;
      const enumerated = Object.keys(process.env).includes(key);
      let descriptorError;
      try { Object.defineProperty(process.env, key, { value: 'invalid' }); }
      catch (error) { descriptorError = error.code; }
      delete process.env[key];
      const absent = process.env[key] === undefined;
      console.log(JSON.stringify({ before, after, coerced, created, enumerated,
        absent, descriptorError, receipt: observed.finish(process.env) }));
    `, new URL('./configuration-snapshot.ts', import.meta.url).href], {
      env: { PAPERCUSP_CONFIGURATION_READ_NATIVE_TEST: 'before' },
      encoding: 'utf8', timeout: 10_000,
    });
    const result = JSON.parse(output);
    expect(result).toMatchObject({ before: 'before', after: 'after', coerced: '42', created: 'created',
      enumerated: true, absent: true, descriptorError: 'ERR_INVALID_OBJECT_DEFINE_PROPERTY',
      receipt: { captureComplete: true, activeAtTermination: true, populationStatus: 'unknown' } });
    expect(result.receipt.reads).toEqual([
      { key: 'PAPERCUSP_CONFIGURATION_READ_NATIVE_TEST', sha256: sha('before') },
      { key: 'PAPERCUSP_CONFIGURATION_READ_NATIVE_TEST', sha256: sha('after') },
      { key: 'PAPERCUSP_CONFIGURATION_READ_NATIVE_TEST', sha256: sha('42') },
      { key: 'PAPERCUSP_CONFIGURATION_CREATED', sha256: sha('created') },
      { key: 'PAPERCUSP_CONFIGURATION_READ_NATIVE_TEST', sha256: null },
    ]);
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
