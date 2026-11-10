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
