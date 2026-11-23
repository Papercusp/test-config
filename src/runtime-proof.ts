import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { isatty } from 'node:tty';
import { dirname, isAbsolute, join } from 'node:path';
import { hashConfigurationValue } from '@papercusp/test-config/configuration-snapshot';
import { pinModuleState } from '@papercusp/module-singleton';

const CAPABILITY_GAPS = ['required-capability-population-unobserved', 'resource-permission-policy-unobserved',
  'native-library-inputs-unobserved', 'runtime-input-closure-unobserved'] as const;

/** Actual Node surface in the original worker. These observations do not
 * enumerate the application's required operations or the host's policy. */
export interface RuntimeCapabilitySnapshot {
  schemaVersion: 'node-runtime-surface-v1';
  scope: 'node-runtime-surface';
  populationStatus: 'unknown';
  values: {
    versions: ReadonlyArray<readonly [string, string]>;
    features: ReadonlyArray<readonly [string, string | boolean]>;
    platform: string;
    arch: string;
    permissions: { available: boolean; fsRead: boolean | null; fsWrite: boolean | null;
      child: boolean | null; worker: boolean | null };
    timeZone: string | null;
  };
  sha256: string;
  missing: readonly string[];
}

export interface RecordedWorkerRuntimeCapabilities {
  schemaVersion: 'worker-runtime-capabilities-v1';
  captureId: string;
  testFile: string;
  before: RuntimeCapabilitySnapshot | null;
  after: RuntimeCapabilitySnapshot | null;
}

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: object, names: string[]) => Object.keys(value).sort().join(',') === names.sort().join(',');
const surfaceText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);

/** Validate hashes and explicit gaps on the existing JSON transport. */
export function parseRuntimeCapabilitySnapshot(value: unknown): RuntimeCapabilitySnapshot | undefined {
  try {
    // Descriptor-aware validation rejects accessors/cycles without invoking them.
    if (hashConfigurationValue(value, 'runtime-surface-validation') === null || !plain(value)
      || !exact(value, ['schemaVersion', 'scope', 'populationStatus', 'values', 'sha256', 'missing'])
      || value.schemaVersion !== 'node-runtime-surface-v1' || value.scope !== 'node-runtime-surface'
      || value.populationStatus !== 'unknown' || !plain(value.values)
      || !exact(value.values, ['versions', 'features', 'platform', 'arch', 'permissions', 'timeZone'])) return undefined;
    const measured = value.values;
    for (const name of ['versions', 'features']) {
      const rows = measured[name];
      if (!Array.isArray(rows) || !rows.length || rows.length > 128) return undefined;
      let previous = '';
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string'
          || !/^[A-Za-z0-9_]{1,128}$/.test(row[0]) || row[0] <= previous
          // Node exposes an empty version for optional components compiled out
          // of this interpreter (for example nghttp3/ngtcp2). Keep that measured
          // absence instead of discarding the whole worker observation.
          || !(surfaceText(row[1]) || (name === 'versions' && row[1] === '')
            || (name === 'features' && typeof row[1] === 'boolean'))) return undefined;
        previous = row[0];
      }
    }
    if (!surfaceText(measured.platform) || !surfaceText(measured.arch)
      || !(measured.timeZone === null || surfaceText(measured.timeZone)) || !plain(measured.permissions)
      || !exact(measured.permissions, ['available', 'fsRead', 'fsWrite', 'child', 'worker'])
      || typeof measured.permissions.available !== 'boolean') return undefined;
    for (const name of ['fsRead', 'fsWrite', 'child', 'worker'])
      if (measured.permissions.available ? typeof measured.permissions[name] !== 'boolean'
        : measured.permissions[name] !== null) return undefined;
    const missing = value.missing;
    if (!Array.isArray(missing) || missing.length !== CAPABILITY_GAPS.length
      || !CAPABILITY_GAPS.every((gap, index) => missing[index] === gap)
      || value.sha256 !== hashConfigurationValue(measured, 'node-runtime-surface-v1')) return undefined;
    return value as unknown as RuntimeCapabilitySnapshot;
  } catch { return undefined; }
}

export function parseRecordedWorkerRuntimeCapabilities(value: unknown): RecordedWorkerRuntimeCapabilities | undefined {
  try {
    if (hashConfigurationValue(value, 'worker-runtime-capabilities-validation') === null || !plain(value)
      || !exact(value, ['schemaVersion', 'captureId', 'testFile', 'before', 'after'])
      || value.schemaVersion !== 'worker-runtime-capabilities-v1'
      || typeof value.captureId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.captureId)
      || typeof value.testFile !== 'string' || value.testFile.length > 8192 || !isAbsolute(value.testFile)
      || value.testFile.includes('\0')
      || [value.before, value.after].some(snapshot => snapshot !== null && !parseRuntimeCapabilitySnapshot(snapshot))) return undefined;
    return value as unknown as RecordedWorkerRuntimeCapabilities;
  } catch { return undefined; }
}

/** Sample before setup and after teardown; never substitute the reporter's
 * process. Unsupported or inaccessible surfaces remain explicit nulls. */
export function captureCurrentRuntimeCapabilities(): RuntimeCapabilitySnapshot | null {
  try {
    if (process.versions.bun) return null;
    const versions = Object.freeze(Object.keys(process.versions).sort().map(name =>
      Object.freeze([name, process.versions[name]!] as const)));
    const features = Object.freeze(Object.keys(process.features).sort().map(name =>
      Object.freeze([name, (process.features as unknown as Record<string, string | boolean>)[name]!] as const)));
    const permission = process.permission;
    const permissions = Object.freeze(permission ? { available: true, fsRead: permission.has('fs.read'),
      fsWrite: permission.has('fs.write'), child: permission.has('child'), worker: permission.has('worker') }
      : { available: false, fsRead: null, fsWrite: null, child: null, worker: null });
    const values = Object.freeze({ versions, features, platform: process.platform, arch: process.arch, permissions,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null });
    const sha256 = hashConfigurationValue(values, 'node-runtime-surface-v1');
    if (!sha256) return null;
    const snapshot = Object.freeze({ schemaVersion: 'node-runtime-surface-v1' as const,
      scope: 'node-runtime-surface' as const, populationStatus: 'unknown' as const, values, sha256,
      missing: Object.freeze([...CAPABILITY_GAPS]) });
    return parseRuntimeCapabilitySnapshot(snapshot) ?? null;
  } catch { return null; }
}

/** A kernel process incarnation, not a reusable PID or a fixture-reset claim. */
export interface WorkerProcessIdentity {
  pid: number;
  threadId: number;
  bootId: string;
  startTicks: string;
}

export function captureCurrentWorkerProcessIdentity(): WorkerProcessIdentity | null {
  if (process.platform !== 'linux') return null;
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const end = stat.lastIndexOf(')');
    const startTicks = stat.slice(end + 2).trim().split(/\s+/)[19];
    if (end < 0 || !stat.startsWith(`${process.pid} (`)
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)
      || !startTicks || !/^\d+$/.test(startTicks)) return null;
    return { pid: process.pid, threadId, bootId, startTicks };
  } catch { return null; }
}

/** Optional host integration. Shared test-config also runs outside Papercusp,
 * where the release pipeline's runtime-proof helper does not exist. Missing
 * proof disables reuse; it must never prevent collecting/running tests. */
export interface RuntimeProofIdentity {
  name: string;
  version: string;
  executable: string;
  binarySha256: string;
  platform: string;
  arch: string;
  nativeDependencyGeneration: string;
  lockfileSha256: string;
  configurationSha256: string;
}
type ProofModule = {
  prepareVerifierRuntimeProof?: (options: { root: string }) => Promise<void>;
  captureCurrentRuntimeProofIdentity?: (options: { root: string; environment?: NodeJS.ProcessEnv }) => RuntimeProofIdentity | null;
  captureRuntimeProofIdentity?: (options: { root: string; cwd?: string; environment?: NodeJS.ProcessEnv;
    executable?: string; execArgv?: string[] }) => RuntimeProofIdentity | null;
  runtimeProofFingerprint?: (identity: unknown) => string | null;
};
const requireHost = createRequire(import.meta.url);
function hostProof(): ProofModule | null {
  try { return requireHost('../../../scripts/lib/runtime-compatibility.mjs') as ProofModule; }
  catch { return null; }
}
export function captureCurrentRuntimeProofIdentity(options: { root: string; environment?: NodeJS.ProcessEnv }): RuntimeProofIdentity | null {
  return hostProof()?.captureCurrentRuntimeProofIdentity?.(options) ?? null;
}
export async function prepareVerifierRuntimeProof(root: string): Promise<void> {
  if (process.env.PAPERCUSP_VERIFIER_RUNTIME_HANDOFF_SHA256)
    await hostProof()?.prepareVerifierRuntimeProof?.({ root });
}
export function runtimeProofFingerprint(identity: unknown): string | null {
  return hostProof()?.runtimeProofFingerprint?.(identity) ?? null;
}

export const PROGRESS_FORKS_POOL_NAME = 'papercusp-progress-forks';
type ForksLauncher = { name: string; createPoolWorker: unknown };
// Config bundling and reporters can load separate copies in the same host, so the
// registry is pinned through the shared primitive (reported by listModuleDuplications).
const forksLauncherState = pinModuleState('@papercusp/test-config.forks-launchers',
  () => ({ launchers: new WeakSet<object>() }));
function forksLaunchers(): WeakSet<object> {
  return forksLauncherState.launchers;
}

/** Only the maintained progress pool registers its unchanged ForksPoolWorker
 * launcher. The name alone cannot establish a custom pool's invocation. */
export function registerProgressForksLauncher<T extends ForksLauncher>(pool: T): T {
  if (pool.name !== PROGRESS_FORKS_POOL_NAME || typeof pool.createPoolWorker !== 'function')
    throw new TypeError('Invalid progress forks launcher');
  // Vitest clones the config object, preserving the original launch function.
  forksLaunchers().add(pool.createPoolWorker);
  return pool;
}

/** The resolved project inputs used by Vitest's Node pool launcher. */
export interface VitestWorkerProject {
  config: { pool: string; poolRunner?: ForksLauncher; execArgv: string[];
    env?: NodeJS.ProcessEnv; browser?: { enabled?: boolean } };
  vitest: { config: { env?: NodeJS.ProcessEnv; watch?: boolean } };
  vite: { config: { isProduction: boolean; ssr: { resolve?: { conditions?: string[] } } } };
}

/** Version-bound adapter for Vitest resolveOptions/resolveConditions and VM pool
 * constructors. Unknown launchers decline reuse. Never infer the intended argv
 * from a worker's own observation: a wrong worker must fail the comparison. */
export function resolveVitestWorkerInvocation(project: VitestWorkerProject):
  { execArgv: string[]; environment: NodeJS.ProcessEnv } | null {
  try {
    const vitestPackage = requireHost.resolve('vitest/package.json');
    const vitePackage = createRequire(vitestPackage).resolve('vite/package.json');
    if (JSON.parse(readFileSync(vitestPackage, 'utf8')).version !== '4.1.8'
      || JSON.parse(readFileSync(vitePackage, 'utf8')).version !== '7.3.5'
      || process.versions.bun || process.versions.pnp || 'Deno' in globalThis) return null;
    const { config, vite } = project;
    const progressForks = config.pool === PROGRESS_FORKS_POOL_NAME
      && config.poolRunner?.name === config.pool && typeof config.poolRunner.createPoolWorker === 'function'
      && forksLaunchers().has(config.poolRunner.createPoolWorker);
    if (config.browser?.enabled || (!['forks', 'threads', 'vmForks', 'vmThreads'].includes(config.pool) && !progressForks)
      || !Array.isArray(config.execArgv) || !config.execArgv.every(arg => typeof arg === 'string')
      || typeof vite.config.isProduction !== 'boolean') return null;
    const conditions = vite.config.ssr.resolve?.conditions ?? [];
    if (!Array.isArray(conditions) || !conditions.every(condition => typeof condition === 'string')) return null;
    const execArgv = [
      ...process.execArgv.filter(arg => arg.startsWith('--cpu-prof') || arg.startsWith('--heap-prof')
        || arg.startsWith('--diagnostic-dir')),
      '--experimental-import-meta-resolve', '--require', join(dirname(vitestPackage), 'suppress-warnings.cjs'),
      ...[...new Set(conditions)].filter(condition => condition !== 'production' || vite.config.isProduction)
        .filter(condition => condition !== 'development' || !vite.config.isProduction)
        .map(condition => condition === 'development|production'
          ? vite.config.isProduction ? 'production' : 'development' : condition)
        .flatMap(condition => ['--conditions', condition]),
      ...config.execArgv,
      ...(config.pool.startsWith('vm') ? ['--experimental-vm-modules'] : []),
    ];
    const environment: NodeJS.ProcessEnv = { ...process.env, TEST: 'true', VITEST: 'true',
      NODE_ENV: process.env.NODE_ENV || 'test', VITEST_MODE: project.vitest.config.watch ? 'WATCH' : 'RUN',
      FORCE_TTY: isatty(1) ? 'true' : '',
      ...project.vitest.config.env, ...config.env };
    if (process.platform === 'win32') for (const name of Object.keys(environment))
      environment[name.toUpperCase()] = environment[name];
    return { execArgv, environment };
  } catch { return null; }
}

export function captureVitestWorkerProofIdentity(options: { root: string; project: VitestWorkerProject }): RuntimeProofIdentity | null {
  const invocation = resolveVitestWorkerInvocation(options.project);
  return invocation ? hostProof()?.captureRuntimeProofIdentity?.({ root: options.root,
    executable: process.execPath, ...invocation }) ?? null : null;
}
