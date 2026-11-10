import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';

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
  captureCurrentRuntimeProofIdentity?: (options: { root: string; environment?: NodeJS.ProcessEnv }) => RuntimeProofIdentity | null;
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
export function runtimeProofFingerprint(identity: unknown): string | null {
  return hostProof()?.runtimeProofFingerprint?.(identity) ?? null;
}
