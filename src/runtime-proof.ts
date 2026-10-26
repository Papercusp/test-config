import { createRequire } from 'node:module';

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
