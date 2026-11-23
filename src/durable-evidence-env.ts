/**
 * The outer test runner's durable-evidence contract, as code under test must NOT see it.
 *
 * A gate lane (scripts/affected-tests.mjs) exports PC_EXECUTED_SOURCE_MAP_OUT / _RESULT for its
 * OWN executed-source-map capture, and PAPERCUSP_TEST_RUN_RECEIPT_FILE / PAPERCUSP_TEST_RUNS_DB_URL
 * are the receipt file and sink of the same contract. Their consumers are the reporters in the
 * vitest MAIN process. Workers inherit all four, and product code that prepares a private
 * integration run (`assertPrivateIntegrationEvidence` in scripts/test-files.mjs) reads them as a
 * request for ITS OWN durable receipts — refusing with "PAPERCUSP_TEST_RUNS_DB_URL is required
 * for durable isolated test receipts" when the sink is unset, which a gate lane leaves unset by
 * design. On the frozen candidate that refusal masked 70 unit cases across 5 operator-core files
 * that pass under a clean env (WI-6554700010069310).
 *
 * Keep this list a superset of the keys that assertion reads; durable-evidence-env.test.ts pins it
 * against the script's source.
 */
export const DURABLE_EVIDENCE_ENV_KEYS = Object.freeze([
  'PAPERCUSP_TEST_RUN_RECEIPT_FILE',
  'PC_EXECUTED_SOURCE_MAP_RESULT',
  'PC_EXECUTED_SOURCE_MAP_OUT',
  'PAPERCUSP_TEST_RUNS_DB_URL',
] as const);

/**
 * Remove every durable-evidence key from `env` and return a function that restores exactly the
 * values that were present (a key that was unset is deleted again, never set to "undefined").
 * Restoring overwrites whatever a test left behind, so the next file in a reused worker sees the
 * runner's original contract.
 */
export function withholdDurableEvidenceEnv(env: NodeJS.ProcessEnv): () => void {
  const saved = DURABLE_EVIDENCE_ENV_KEYS.map(key => [key, env[key]] as const);
  for (const [key] of saved) delete env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  };
}
