/**
 * Configuration snapshot recorded on every `harness_shared.test_runs` row (column
 * `configuration_snapshot`, migration 1448). Plan verification-system-improvements-2026-10-10
 * P-011: SPEC-P-011-RUNNER-CAPTURE / SPEC-P-011-MUTATION-CAPTURE.
 *
 * This module is DEPENDENCY-FREE on purpose. The vitest reporter in this package loads it, and
 * this package is consumed by checkouts that do not carry `@papercusp/flags`. So the snapshot
 * records the INPUTS of flag resolution, not resolved flag values: the judge in operator-core
 * resolves a declared flag from `flagEnv` with `@papercusp/flags`' own precedence.
 *
 * - `flagEnv` holds the RAW values of the flag-override env vars (`PAPERCUSP_FLAG_*`,
 *   `PAPERCUSP_PLATFORM_MODE`). Flag resolution needs the value, and these are booleans, not
 *   secrets.
 * - `envSha256` holds a sha256 of EVERY recorded var (`PAPERCUSP_*`, `PC_*`, `NODE_ENV`),
 *   including the flag-override ones. Raw values never leave the process.
 * - `fingerprint` is a sha256 over the canonical form of the two maps, so a row carries one
 *   comparable configuration fingerprint and a hand-edited snapshot no longer reads as valid.
 */
import { createHash } from 'node:crypto';

const definePropertyIntrinsic = Object.defineProperty;

/** Env vars whose (hashed) values are recorded. */
export const CONFIGURATION_SNAPSHOT_ENV_KEY = /^(PAPERCUSP_[A-Z0-9_]+|PC_[A-Z0-9_]+|NODE_ENV)$/;

/** Env vars whose RAW values are also recorded, because flag resolution reads them. */
export const CONFIGURATION_SNAPSHOT_RAW_ENV_KEY = /^(PAPERCUSP_FLAG_[A-Z0-9_]+|PAPERCUSP_PLATFORM_MODE)$/;

export const CONFIGURATION_SNAPSHOT_FINGERPRINT_PREFIX = 'sha256-config-snapshot-v1:';

export interface ConfigurationSnapshot {
  schemaVersion: 1;
  flagEnv: Record<string, string>;
  envSha256: Record<string, string>;
  fingerprint: string;
}

/** Resolved options in the original Vitest worker. Only digests leave it:
 * options can contain credentials in env/defines. This measures test options,
 * not compiler inputs or the implementations of the runtime they configure. */
export interface RecordedWorkerTestConfiguration {
  schemaVersion: 'vitest-worker-configuration-v1';
  before: string | null;
  after: string | null;
}

export function readWorkerTestConfiguration(value: unknown): RecordedWorkerTestConfiguration | null {
  if (!isPlainObject(value) || !exactKeys(value, ['schemaVersion', 'before', 'after'])
    || value.schemaVersion !== 'vitest-worker-configuration-v1'
    || [value.before, value.after].some(hash => hash !== null && !proofHash(hash))) return null;
  return { schemaVersion: value.schemaVersion, before: value.before as string | null,
    after: value.after as string | null };
}

/** Hash the entire serialized worker configuration with explicit type tags.
 * Unsupported objects, functions, accessors, symbols and cycles stay unknown;
 * never invoke application toJSON or silently omit an input.
 * Vitest adds snapshotOptions.snapshotEnvironment as a runtime implementation.
 * Its selector stays in config.snapshotEnvironment; implementation identity is
 * owed separately by behavior, which this capture never supplies. */
export function captureWorkerTestConfiguration(workerState: unknown): string | null {
  try {
    if (!isPlainObject(workerState)) return null;
    const property = Object.getOwnPropertyDescriptor(workerState, 'config');
    const config = property && 'value' in property ? property.value : null;
    if (!isPlainObject(config)) return null;
    const field = (key: string) => Object.getOwnPropertyDescriptor(config, key)?.value;
    if (typeof field('root') !== 'string' || !field('root')
      || typeof field('isolate') !== 'boolean' || typeof field('pool') !== 'string'
      || !Array.isArray(field('setupFiles'))) return null;
    return hashConfigurationValue(config, 'vitest-worker-configuration-v1', true);
  } catch { return null; }
}

function hashConfigurationValue(config: unknown, namespace: string, omitSnapshotEnvironment = false): string | null {
  try {
    const active = new Set<object>();
    let nodes = 0;
    let textSize = 0;
    const encode = (value: unknown, path: string[], depth: number): unknown => {
      if (++nodes > 10_000 || depth > 32) throw new Error('configuration bound');
      if (value === null) return ['null'];
      switch (typeof value) {
        case 'undefined': return ['undefined'];
        case 'boolean': return ['boolean', value];
        case 'string':
          textSize += value.length;
          if (value.length > 1_048_576 || textSize > 2_097_152) throw new Error('configuration string bound');
          return ['string', value];
        case 'number': return ['number', Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0' : String(value)];
        case 'object': break;
        default: throw new Error('unsupported configuration value');
      }
      const object = value as object;
      if (active.has(object)) throw new Error('cyclic configuration');
      const prototype = Object.getPrototypeOf(object);
      const keys = Reflect.ownKeys(object);
      if (keys.some(key => typeof key !== 'string')) throw new Error('symbol configuration key');
      if (prototype === RegExp.prototype && keys.length === 1 && keys[0] === 'lastIndex')
        return ['regexp', RegExp.prototype.toString.call(object),
          encode(Object.getOwnPropertyDescriptor(object, 'lastIndex')!.value, path, depth + 1)];
      const array = Array.isArray(object);
      if (!array && prototype !== Object.prototype && prototype !== null)
        throw new Error('unsupported configuration object');
      active.add(object);
      const entries: unknown[] = [];
      for (const key of (keys as string[]).sort()) {
        textSize += key.length;
        if (textSize > 2_097_152) throw new Error('configuration key bound');
        if (omitSnapshotEnvironment && path.length === 1 && path[0] === 'snapshotOptions' && key === 'snapshotEnvironment') continue;
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        if (!('value' in descriptor)) throw new Error('configuration accessor');
        entries.push([key, encode(descriptor.value, [...path, key], depth + 1)]);
      }
      active.delete(object);
      return [array ? 'array' : 'object', entries];
    };
    return sha256Hex(JSON.stringify([namespace, encode(config, [], 0)]));
  } catch { return null; }
}

/** Prospective root options at Vite's pre-transform hook. Vite resolves further
 * per-file options and plugins can retain closure state: this is a diagnostic,
 * never a complete compiler identity or an attributed per-test census. */
export interface RecordedViteTransformOptions {
  schemaVersion: 'vite-root-transform-options-v1';
  scope: 'vite-environment-transform-hooks';
  populationStatus: 'unknown';
  optionHashes: Array<string | null>;
  transformCount: number;
  truncated: boolean;
  missing: string[];
}

const VITE_TRANSFORM_OPTIONS = Symbol.for('@papercusp/test-config.vite-transform-options');
const VITE_TRANSFORM_GAPS = ['per-file-tsconfig-unobserved', 'plugin-closures-unobserved',
  'config-to-compiler-arguments-unobserved', 'environment-to-test-attribution-unverified'];
const viteOptionJournals = new WeakMap<object, { hashes: Array<string | null>; count: number; truncated: boolean }>();

/** No raw define/env values leave the compiler process, and no getters or
 * toJSON implementations execute merely to construct an observation. */
export function captureViteTransformOptions(config: unknown): string | null {
  try {
    if (!isPlainObject(config)) return null;
    const selected = Object.create(null) as Record<string, unknown>;
    for (const key of ['root', 'base', 'mode', 'command', 'isProduction', 'esbuild', 'define', 'resolve', 'css', 'json', 'env']) {
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (descriptor && !('value' in descriptor)) return null;
      selected[key] = descriptor ? ['present', descriptor.value] : ['absent'];
    }
    if (typeof Object.getOwnPropertyDescriptor(config, 'root')?.value !== 'string') return null;
    return hashConfigurationValue(selected, 'vite-root-transform-options-v1');
  } catch { return null; }
}

export function parseRecordedViteTransformOptions(value: unknown): RecordedViteTransformOptions | undefined {
  if (!isPlainObject(value) || !exactKeys(value, ['schemaVersion', 'scope', 'populationStatus', 'optionHashes',
    'transformCount', 'truncated', 'missing']) || value.schemaVersion !== 'vite-root-transform-options-v1'
    || value.scope !== 'vite-environment-transform-hooks' || value.populationStatus !== 'unknown'
    || !Array.isArray(value.optionHashes) || value.optionHashes.length < 1 || value.optionHashes.length > 2
    || !value.optionHashes.every(hash => hash === null || proofHash(hash))
    || new Set(value.optionHashes).size !== value.optionHashes.length
    || !Number.isSafeInteger(value.transformCount) || (value.transformCount as number) < value.optionHashes.length
    || (value.transformCount as number) > 1_000_000 || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.missing) || value.missing.length !== VITE_TRANSFORM_GAPS.length
    || !VITE_TRANSFORM_GAPS.every(reason => (value.missing as unknown[]).includes(reason))) return undefined;
  return value as unknown as RecordedViteTransformOptions;
}

export function observeViteTransformOptions(environment: object, config: unknown): void {
  try {
    let journal = viteOptionJournals.get(environment);
    if (!journal) {
      journal = { hashes: [], count: 0, truncated: false };
      const entries = journal;
      Object.defineProperty(environment, VITE_TRANSFORM_OPTIONS, { value: () => Object.freeze({
        schemaVersion: 'vite-root-transform-options-v1', scope: 'vite-environment-transform-hooks',
        populationStatus: 'unknown', optionHashes: Object.freeze([...entries.hashes]),
        transformCount: entries.count, truncated: entries.truncated, missing: Object.freeze([...VITE_TRANSFORM_GAPS]),
      }) });
      viteOptionJournals.set(environment, journal);
    }
    if (journal.count >= 1_000_000) { journal.truncated = true; return; }
    journal.count++;
    const hash = captureViteTransformOptions(config);
    if (!journal.hashes.includes(hash)) {
      if (journal.hashes.length < 2) journal.hashes.push(hash);
      else journal.truncated = true;
    }
  } catch { /* Optional diagnostics never change a transform result. */ }
}

export function readViteTransformOptions(environment: object | undefined): RecordedViteTransformOptions | undefined {
  try {
    const reader = environment && Object.getOwnPropertyDescriptor(environment, VITE_TRANSFORM_OPTIONS)?.value;
    return typeof reader === 'function' ? parseRecordedViteTransformOptions(reader()) : undefined;
  } catch { return undefined; }
}

/** One field on existing qualification/repair/results, not another proof store.
 * Digests identify measured inputs; they never grant execution or reuse authority.
 * Null is an explicit missing measurement, including a relevant unknown graph.
 */
export const PROOF_CONTEXT_COMPONENTS = ['source', 'submodules', 'dependencies',
  'compilerConfiguration', 'testConfiguration', 'runtimeCapabilities', 'generatedAssets',
  'schema', 'fixtures', 'behavior', 'selectionGraph', 'population'] as const;
export type ProofContextComponent = (typeof PROOF_CONTEXT_COMPONENTS)[number];
export interface ProofContextIdentity {
  schemaVersion: 'proof-context-v1';
  components: Record<ProofContextComponent, string | null>;
  fingerprint: string;
}
export interface ProofContextReach {
  schemaVersion: 'reach-v1';
  component: ProofContextComponent;
  before: string;
  after: string;
  /** Versioned complete OLD and NEW graph/consumer censuses, not a radius label. */
  provenance: { version: string; before: string; after: string; complete: true };
  tests: string[];
  legs: string[];
}
export interface ProofContextComparison {
  before: unknown;
  after: unknown;
  reach?: unknown;
}

const proofHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Canonical across JSONB key order. Unknown inputs remain in the identity as null. */
export function createProofContextIdentity(
  components: Record<ProofContextComponent, string | null>,
): ProofContextIdentity | null {
  if (!isPlainObject(components) || !exactKeys(components, PROOF_CONTEXT_COMPONENTS)
    || PROOF_CONTEXT_COMPONENTS.some(key => components[key] !== null && !proofHash(components[key]))) return null;
  const entries = PROOF_CONTEXT_COMPONENTS.map(key => [key, components[key]] as const);
  return { schemaVersion: 'proof-context-v1', components: Object.fromEntries(entries) as ProofContextIdentity['components'],
    fingerprint: `sha256-proof-context-v1:${sha256Hex(JSON.stringify(['proof-context-v1', entries]))}` };
}

/** Recompute persisted identity; a hash or a truthy completeness label is insufficient. */
export function readProofContextIdentity(value: unknown): ProofContextIdentity | null {
  if (!isPlainObject(value) || !exactKeys(value, ['schemaVersion', 'components', 'fingerprint'])
    || value.schemaVersion !== 'proof-context-v1' || !isPlainObject(value.components)) return null;
  const rebuilt = createProofContextIdentity(value.components as ProofContextIdentity['components']);
  return rebuilt && rebuilt.fingerprint === value.fingerprint ? rebuilt : null;
}

/** Producers obtain reach provenance from actual old/new graph/consumer censuses.
 * This parser cannot mint it from source drift or a caller's radius label.
 */
export function proofContextImpact(value: ProofContextComparison | null | undefined):
  { status: 'known'; tests: string[]; legs: string[]; changed: ProofContextComponent[] }
  | { status: 'unknown'; reason: string } {
  const before = readProofContextIdentity(value?.before), after = readProofContextIdentity(value?.after);
  if (!before || !after) return { status: 'unknown', reason: 'proof-context-unmeasured' };
  if (PROOF_CONTEXT_COMPONENTS.some(key => before.components[key] === null || after.components[key] === null))
    return { status: 'unknown', reason: 'proof-context-incomplete' };
  const changed = PROOF_CONTEXT_COMPONENTS.filter(key => before.components[key] !== after.components[key]);
  if (!changed.length) return { status: 'known', tests: [], legs: [], changed };
  if (!Array.isArray(value?.reach) || value.reach.length !== changed.length)
    return { status: 'unknown', reason: 'proof-context-reach-incomplete' };
  const seen = new Set<string>(), tests = new Set<string>(), legs = new Set<string>();
  const ids = (items: unknown): items is string[] => Array.isArray(items)
    && items.every(id => typeof id === 'string' && id.trim().length > 0 && id.trim() === id)
    && new Set(items).size === items.length;
  for (const row of value.reach) {
    if (!isPlainObject(row) || !exactKeys(row, ['schemaVersion', 'component', 'before', 'after', 'provenance', 'tests', 'legs'])
      || row.schemaVersion !== 'reach-v1' || !changed.includes(row.component as ProofContextComponent)
      || seen.has(row.component as string) || row.before !== before.components[row.component as ProofContextComponent]
      || row.after !== after.components[row.component as ProofContextComponent]
      || !isPlainObject(row.provenance) || !exactKeys(row.provenance, ['version', 'before', 'after', 'complete'])
      || typeof row.provenance.version !== 'string' || !row.provenance.version.trim()
      || row.provenance.complete !== true || !proofHash(row.provenance.before) || !proofHash(row.provenance.after)
      || !ids(row.tests) || !ids(row.legs)) return { status: 'unknown', reason: 'proof-context-reach-invalid' };
    seen.add(row.component as string);
    for (const id of row.tests) tests.add(id);
    for (const id of row.legs) legs.add(id);
  }
  if ([...tests].some(id => legs.has(id))) return { status: 'unknown', reason: 'proof-context-reach-ambiguous' };
  return { status: 'known', tests: [...tests].sort(), legs: [...legs].sort(), changed };
}

export const configurationReadLimits = Object.freeze({ reads: 512, keyLength: 256 });

export interface ConfigurationReadObservation {
  schemaVersion: 1;
  scope: 'javascript-configuration-property-gets';
  populationStatus: 'unknown';
  limits: typeof configurationReadLimits;
  reads: Array<{ key: string; sha256: string | null }>;
  captureComplete: boolean;
  activeAtTermination: boolean;
}

/** Observe JavaScript property gets, including unset values and mutations.
 * Native getenv, descriptor access, and resolved configuration remain unknown.
 * Bounds and observation failures never change a property's return or error.
 */
export function observeConfigurationReads(environment: Record<string, string | undefined>) {
  const reads: ConfigurationReadObservation['reads'] = [];
  let captureComplete = true, observing = true;
  const observedEnvironment = new Proxy(environment, {
    set(target, key, value) {
      // Native process.env rejects the partial descriptor produced when a
      // Proxy is the receiver of an overwrite. Forward writes to the original
      // environment so observation preserves its coercion and error behavior.
      return Reflect.set(target, key, value, target);
    },
    get(target, key, receiver) {
      let value: unknown;
      try { value = Reflect.get(target, key, receiver); }
      catch (error) {
        if (observing && typeof key === 'string' && CONFIGURATION_SNAPSHOT_ENV_KEY.test(key)) captureComplete = false;
        throw error;
      }
      if (observing && typeof key === 'string' && CONFIGURATION_SNAPSHOT_ENV_KEY.test(key)) {
        try {
          if (key.length > configurationReadLimits.keyLength || reads.length >= configurationReadLimits.reads)
            captureComplete = false;
          else if (value === undefined || typeof value === 'string')
            reads.push({ key, sha256: value === undefined ? null : sha256Hex(value) });
          else captureComplete = false;
        } catch { captureComplete = false; }
      }
      return value;
    },
  });
  return { environment: observedEnvironment, finish(currentEnvironment: typeof environment): ConfigurationReadObservation {
    observing = false;
    // This receipt can be published after the final coverage sample. Even a
    // retained Array.map would consult an application's constructor/species.
    // Copy own entries without method, species or inherited-setter dispatch.
    const copied: ConfigurationReadObservation['reads'] = [];
    for (let index = 0; index < reads.length; index++) {
      const descriptor = { __proto__: null, configurable: true, enumerable: true,
        writable: true, value: { ...reads[index] } };
      definePropertyIntrinsic(copied, index, descriptor);
    }
    return { schemaVersion: 1, scope: 'javascript-configuration-property-gets', populationStatus: 'unknown',
      limits: { ...configurationReadLimits }, reads: copied, captureComplete,
      activeAtTermination: currentEnvironment === observedEnvironment };
  } };
}

/** Validate retained observations; an absent capture is never an empty one. */
export function readConfigurationReadObservation(value: unknown): ConfigurationReadObservation | null {
  if (!isPlainObject(value) || value.schemaVersion !== 1
    || value.scope !== 'javascript-configuration-property-gets' || value.populationStatus !== 'unknown'
    || !isPlainObject(value.limits) || value.limits.reads !== configurationReadLimits.reads
    || value.limits.keyLength !== configurationReadLimits.keyLength
    || typeof value.captureComplete !== 'boolean' || typeof value.activeAtTermination !== 'boolean'
    || !Array.isArray(value.reads) || value.reads.length > configurationReadLimits.reads) return null;
  const reads: ConfigurationReadObservation['reads'] = [];
  for (const row of value.reads) {
    if (!isPlainObject(row) || typeof row.key !== 'string' || row.key.length > configurationReadLimits.keyLength
      || !CONFIGURATION_SNAPSHOT_ENV_KEY.test(row.key)
      || !(row.sha256 === null || typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256))) return null;
    reads.push({ key: row.key, sha256: row.sha256 });
  }
  return { schemaVersion: 1, scope: value.scope, populationStatus: value.populationStatus,
    limits: { ...configurationReadLimits }, reads, captureComplete: value.captureComplete,
    activeAtTermination: value.activeAtTermination };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedEntries(map: Record<string, string>): Array<[string, string]> {
  return Object.keys(map)
    .sort()
    .map((key) => [key, map[key] as string]);
}

/** The fingerprint of a snapshot's two maps. Key order never changes it. */
export function configurationSnapshotFingerprint(
  flagEnv: Record<string, string>,
  envSha256: Record<string, string>,
): string {
  const canonical = JSON.stringify({ flagEnv: sortedEntries(flagEnv), envSha256: sortedEntries(envSha256) });
  return `${CONFIGURATION_SNAPSHOT_FINGERPRINT_PREFIX}${sha256Hex(canonical)}`;
}

/** Capture the configuration a test process runs under. Pass `process.env` in production. */
export function captureConfigurationSnapshot(env: Record<string, string | undefined>): ConfigurationSnapshot {
  const flagEnv: Record<string, string> = {};
  const envSha256: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (typeof value !== 'string' || !CONFIGURATION_SNAPSHOT_ENV_KEY.test(key)) continue;
    envSha256[key] = sha256Hex(value);
    if (CONFIGURATION_SNAPSHOT_RAW_ENV_KEY.test(key)) flagEnv[key] = value;
  }
  return { schemaVersion: 1, flagEnv, envSha256, fingerprint: configurationSnapshotFingerprint(flagEnv, envSha256) };
}

/**
 * Read a stored snapshot (the `configuration_snapshot` column value). Returns null when the
 * value is absent, malformed, or its fingerprint does not match its contents. Null means the
 * run recorded NO usable configuration; it never means "no configuration was required".
 */
export function readConfigurationSnapshot(value: unknown): ConfigurationSnapshot | null {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(raw) || raw.schemaVersion !== 1) return null;
  const { flagEnv, envSha256, fingerprint } = raw;
  if (!isPlainObject(flagEnv) || !isPlainObject(envSha256) || typeof fingerprint !== 'string') return null;
  if (Object.values(flagEnv).some((v) => typeof v !== 'string')) return null;
  if (Object.values(envSha256).some((v) => typeof v !== 'string')) return null;
  const typedFlagEnv = flagEnv as Record<string, string>;
  const typedEnvSha256 = envSha256 as Record<string, string>;
  if (configurationSnapshotFingerprint(typedFlagEnv, typedEnvSha256) !== fingerprint) return null;
  return { schemaVersion: 1, flagEnv: { ...typedFlagEnv }, envSha256: { ...typedEnvSha256 }, fingerprint };
}
