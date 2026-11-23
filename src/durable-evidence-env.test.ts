import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DURABLE_EVIDENCE_ENV_KEYS, withholdDurableEvidenceEnv } from './durable-evidence-env.ts';
import { PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV, defineVitestConfig, type TestLayer } from './vitest-config.ts';
import { DURABLE_EVIDENCE_ENV_SETUP, EXECUTED_INPUTS_CAPTURE_SETUP, WORKER_SETUP_FILE_PATHS } from './worker-setup-files.ts';

// WI-6554700010069310: a gate lane's durable-evidence env reached unit tests through the worker and
// made assertPrivateIntegrationEvidence() refuse before the behaviour under test ran.
const laneEnv = (): NodeJS.ProcessEnv => ({
  PC_EXECUTED_SOURCE_MAP_RESULT: '/tmp/lane/result.jsonl',
  PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/lane/map.json',
  PAPERCUSP_TEST_RUN_RECEIPT_FILE: '/tmp/lane/receipts.jsonl',
  UNRELATED: 'kept',
});

describe('withholdDurableEvidenceEnv', () => {
  it('removes every durable-evidence key and leaves other keys alone', () => {
    const env: NodeJS.ProcessEnv = { ...laneEnv(), PAPERCUSP_TEST_RUNS_DB_URL: 'postgres://sink/db' };
    withholdDurableEvidenceEnv(env);
    for (const key of DURABLE_EVIDENCE_ENV_KEYS) expect(key in env).toBe(false);
    expect(env.UNRELATED).toBe('kept');
  });

  it.each(DURABLE_EVIDENCE_ENV_KEYS.map((key) => [key]))('restores %s exactly: set stays set, unset stays absent', (key) => {
    const set: NodeJS.ProcessEnv = { [key]: 'original' };
    withholdDurableEvidenceEnv(set)();
    expect(set[key]).toBe('original');
    const unset: NodeJS.ProcessEnv = {};
    withholdDurableEvidenceEnv(unset)();
    expect(key in unset).toBe(false);
  });

  it('restores the runner values over whatever a test left behind, for the next file in the worker', () => {
    const env = laneEnv();
    const restore = withholdDurableEvidenceEnv(env);
    env.PAPERCUSP_TEST_RUNS_DB_URL = 'postgres://left/by-a-test';
    env.PC_EXECUTED_SOURCE_MAP_OUT = '/tmp/changed';
    restore();
    expect(env).toEqual(laneEnv());
  });
});

describe('the key list covers what assertPrivateIntegrationEvidence reads', () => {
  it('includes the sink and every durable-evidence request key in scripts/test-files.mjs', () => {
    const source = readFileSync(fileURLToPath(new URL('../../../scripts/test-files.mjs', import.meta.url)), 'utf8');
    const body = /export function assertPrivateIntegrationEvidence\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(body, 'assertPrivateIntegrationEvidence not found; update this pin').toBeDefined();
    const requested = /durableEvidenceRequested\s*=\s*\[([^\]]*)\]/.exec(body ?? '')?.[1] ?? '';
    const requestKeys = [...requested.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
    // Positive control: an empty extraction must fail, not pass vacuously.
    expect(requestKeys.length).toBeGreaterThan(0);
    expect(body).toMatch(/const sink = env\.PAPERCUSP_TEST_RUNS_DB_URL;/);
    for (const key of [...requestKeys, 'PAPERCUSP_TEST_RUNS_DB_URL']) expect(DURABLE_EVIDENCE_ENV_KEYS).toContain(key);
  });
});

describe('the worker setup runs after the capture setup that still reads the env', () => {
  it.each<[TestLayer, boolean]>([['unit', false], ['unit', true], ['integration', false], ['integration', true]])(
    '%s config (allowConsoleNoise=%s) hands vitest the setup, declared worker-only, after executed-inputs capture',
    (layer, allowConsoleNoise) => {
      const prev = process.env[PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV];
      process.env[PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV] = 'durable-evidence-env-test';
      try {
        const cfg = defineVitestConfig({ layer, allowConsoleNoise });
        const setupFiles = ((cfg as { test?: { setupFiles?: unknown } }).test?.setupFiles ?? []) as string[];
        const capture = setupFiles.indexOf(EXECUTED_INPUTS_CAPTURE_SETUP);
        expect(capture).toBeGreaterThanOrEqual(0);
        expect(setupFiles.indexOf(DURABLE_EVIDENCE_ENV_SETUP)).toBeGreaterThan(capture);
        expect(WORKER_SETUP_FILE_PATHS).toContain(DURABLE_EVIDENCE_ENV_SETUP);
      } finally {
        if (prev === undefined) delete process.env[PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV];
        else process.env[PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV] = prev;
      }
    },
  );
});
