import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminTestRunsReporter from './admin-test-runs-reporter.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_RUN_READER_CONTRACT_ENV, TEST_RUN_READER_REFUSAL_PATH_ENV, testRunExecutionDetailsReaderContract,
  testRunExecutionDetailsReaderMismatch, parseTestRunExecutionDetails } from './execution-details.ts';

afterEach(() => vi.unstubAllEnvs());

describe('reporter / serving-reader field contract preflight', () => {
  const current = () => JSON.parse(testRunExecutionDetailsReaderContract());

  it('refuses an older reader before acquiring resources or measuring source', async () => {
    const reader = current();
    reader.fields = reader.fields.filter((field: string) => !['population', 'proofContext', 'sourceSubmodules'].includes(field));
    vi.stubEnv(TEST_RUN_READER_CONTRACT_ENV, JSON.stringify(reader));
    const snapshot = vi.fn(), write = vi.fn(), runtime = vi.fn();
    const reporter = new AdminTestRunsReporter(snapshot, undefined, write, runtime);
    await expect(reporter.onInit({} as never)).rejects.toThrow(
      'TEST_FILE_READER_INCOMPATIBLE reader-missing-fields:population,proofContext,sourceSubmodules');
    expect(snapshot).not.toHaveBeenCalled();
    expect(runtime).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    await reporter.onTestRunEnd();
    await reporter.onExit();
    expect(write).not.toHaveBeenCalled();
  });

  it('accepts an equal or expanded reader envelope without claiming result validity', () => {
    expect(testRunExecutionDetailsReaderMismatch(testRunExecutionDetailsReaderContract())).toBeUndefined();
    expect(testRunExecutionDetailsReaderMismatch(JSON.stringify({ ...current(),
      fields: [...current().fields, 'futureField'] }))).toBeUndefined();
    expect(parseTestRunExecutionDetails({ futureField: true })).toBeUndefined();
  });

  it('records the exact reader contract in the caller-owned refusal sidecar before throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reporter-reader-contract-'));
    const path = join(dir, 'refusal.json');
    vi.stubEnv(TEST_RUN_READER_CONTRACT_ENV, '{}');
    vi.stubEnv(TEST_RUN_READER_REFUSAL_PATH_ENV, path);
    try {
      await expect(new AdminTestRunsReporter().onInit({} as never)).rejects.toThrow('TEST_FILE_READER_INCOMPATIBLE');
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schemaVersion: 1,
        readerContract: '{}', reason: 'invalid-reader-contract' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['', '{', 'null', '{}', JSON.stringify({ ...current(), schemaVersion: 2 }),
    JSON.stringify({ ...current(), fields: ['*'] }),
    JSON.stringify({ ...current(), fields: [...current().fields, 'population'] }),
    JSON.stringify({ ...current(), extra: true })])('fails closed for a malformed explicit reader contract %s', encoded => {
    expect(testRunExecutionDetailsReaderMismatch(encoded)).toBe('invalid-reader-contract');
  });
});
