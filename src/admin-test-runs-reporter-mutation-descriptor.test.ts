/**
 * Plan mutation-probe-evidence-value-2026-10-11, R-1 (reporter half): every leg of a
 * mutation-probe invocation persists the probe's descriptor at
 * execution_details.mutation, completed with that row's leg and the sha256 of the test
 * file it ran, and the strict execution-details parser accepts exactly that shape.
 * The probe half (every leg receives the export) lives in
 * packages/operator-core/lib/agent-tools/testing/mutation-probe-descriptor-export.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdminTestRunsReporter, { type TestRunRow } from './admin-test-runs-reporter.ts';
import { parseTestRunExecutionDetails } from './execution-details.ts';
import {
  parseMutationDescriptor, readMutationInvocationDescriptor, type MutationInvocationDescriptor,
} from './mutation-descriptor.ts';

const TEST_CONFIG_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TEST_FILE = join(TEST_CONFIG_ROOT, 'src/admin-test-runs-reporter-mutation-descriptor.test.ts');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const invocation: MutationInvocationDescriptor = {
  schemaVersion: 1,
  probeInvocationId: 'mp-0123456789abcdef',
  mode: 'copy-out',
  subjectPath: 'scripts/example-subject.sh',
  mutateExpression: 's/^exit 0$/exit 1/',
  againstCommit: null,
  subjectBeforeSha256: sha('before'),
  subjectAfterSha256: sha('after'),
  mutantDiff: '--- a/scripts/example-subject.sh\n+++ b/scripts/example-subject.sh\n-exit 0\n+exit 1\n',
  mutantDiffTruncated: false,
  testCommandSha256: sha('npm run test:file -- x'),
};

const ENV_KEYS = ['PAPERCUSP_MUTATION_PROBE', 'PAPERCUSP_MUTATION_PHASE', 'PAPERCUSP_MUTATION_DESCRIPTOR'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function recordOneRow(
  phase: string, descriptor: string | undefined,
  state: 'passed' | 'failed' = phase === 'mutant' ? 'failed' : 'passed',
): Promise<TestRunRow> {
  process.env.PAPERCUSP_MUTATION_PROBE = '1';
  process.env.PAPERCUSP_MUTATION_PHASE = phase;
  if (descriptor === undefined) delete process.env.PAPERCUSP_MUTATION_DESCRIPTOR;
  else process.env.PAPERCUSP_MUTATION_DESCRIPTOR = descriptor;
  const rows: TestRunRow[] = [];
  const reporter = new AdminTestRunsReporter(async () => ({ commit: 'abc', porcelain: '' }), async (row) => { rows.push(row); });
  const fakeModule = {
    state: () => state,
    children: { allTests: () => [{ result: () => ({ state }) }] },
    moduleId: TEST_FILE,
    diagnostic: () => ({ duration: 1 }), errors: () => [],
  } as unknown as Parameters<typeof reporter.onTestModuleEnd>[0];
  reporter.onInit({ config: { root: TEST_CONFIG_ROOT }, vite: { config: { root: TEST_CONFIG_ROOT } } } as never);
  reporter.onTestModuleEnd(fakeModule);
  await reporter.onTestRunEnd();
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('R-1 reporter: execution_details.mutation', () => {
  it('persists the descriptor with the row leg and the sha256 of the test file it ran', async () => {
    const row = await recordOneRow('mutant', JSON.stringify(invocation));
    const details = row.executionDetails as unknown as Record<string, unknown>;
    expect(details.mutation).toEqual({
      ...invocation,
      leg: 'mutant',
      testFileSha256: createHash('sha256').update(readFileSync(TEST_FILE)).digest('hex'),
    });
    // The strict parser — what every deployed reader runs — accepts the row as written.
    expect(parseTestRunExecutionDetails(details)?.mutation?.probeInvocationId).toBe(invocation.probeInvocationId);
  });

  it('gives the baseline and mutant legs of one invocation the same probeInvocationId', async () => {
    const baseline = await recordOneRow('baseline', JSON.stringify(invocation));
    const mutant = await recordOneRow('mutant', JSON.stringify(invocation));
    const legs = [baseline, mutant].map((row) => (row.executionDetails as { mutation: { leg: string; probeInvocationId: string } }).mutation);
    expect(legs.map((m) => m.leg)).toEqual(['baseline', 'mutant']);
    expect(new Set(legs.map((m) => m.probeInvocationId))).toEqual(new Set([invocation.probeInvocationId]));
  });

  it.each([
    ['copy-out', invocation, 'mutant'],
    ['historical', { ...invocation, mode: 'historical', mutateExpression: null, againstCommit: 'a'.repeat(40) }, 'historical'],
  ])('persists a surviving %s mutant and its consumption-control with the baseline invocation descriptor', async (_mode, descriptor, mutantPhase) => {
    const rows = [
      await recordOneRow('baseline', JSON.stringify(descriptor), 'passed'),
      await recordOneRow(mutantPhase, JSON.stringify(descriptor), 'passed'),
      await recordOneRow('consumption-control', JSON.stringify(descriptor), 'failed'),
    ];
    const details = rows.map((row) => parseTestRunExecutionDetails(row.executionDetails));
    expect(details.map((row) => ({ passed: row?.passed, failed: row?.failed }))).toEqual([
      { passed: 1, failed: 0 }, { passed: 1, failed: 0 }, { passed: 0, failed: 1 },
    ]);
    expect(details.map((row) => row?.mutation?.leg)).toEqual(['baseline', mutantPhase, 'consumption-control']);
    for (const row of details) {
      expect(row?.mutation).toEqual({
        ...descriptor, leg: row!.mutation!.leg,
        testFileSha256: createHash('sha256').update(readFileSync(TEST_FILE)).digest('hex'),
      });
    }
    expect(new Set(details.map((row) => row?.mutation?.probeInvocationId))).toEqual(new Set([invocation.probeInvocationId]));
  });

  it('omits the key, and keeps the row parseable, when the export is absent or malformed', async () => {
    for (const env of [undefined, '{not json', JSON.stringify({ ...invocation, extra: 1 })]) {
      const row = await recordOneRow('mutant', env);
      expect(row.executionDetails).not.toHaveProperty('mutation');
      expect(parseTestRunExecutionDetails(row.executionDetails)).toBeDefined();
    }
  });

  it('ignores the export outside a mutation probe', () => {
    expect(readMutationInvocationDescriptor({ PAPERCUSP_MUTATION_DESCRIPTOR: JSON.stringify(invocation) })).toBeNull();
    expect(readMutationInvocationDescriptor({
      PAPERCUSP_MUTATION_PROBE: '1', PAPERCUSP_MUTATION_DESCRIPTOR: JSON.stringify(invocation),
    })).toEqual(invocation);
  });
});

describe('R-1 parser: strict execution_details.mutation', () => {
  const row = { ...invocation, leg: 'mutant', testFileSha256: sha('test file') };
  const baseDetails = {
    schemaVersion: 1, root: TEST_CONFIG_ROOT, filePath: 'src/x.test.ts', runGroupId: null, workspaceId: null,
    harnessSlug: null, testNamePattern: null, passed: 0, failed: 1, skipped: 0, collectionFailed: false,
    mutationPhase: 'mutant', commitSha: null, worktreeDirty: false,
  };

  it('calibration: the base row with a valid descriptor parses, so each refusal below is about the descriptor', () => {
    expect(parseTestRunExecutionDetails(baseDetails)).toBeDefined();
    expect(parseTestRunExecutionDetails({ ...baseDetails, mutation: row })?.mutation).toEqual(row);
  });

  it('accepts the historical shape: full againstCommit, no expression', () => {
    expect(parseMutationDescriptor({ ...row, mode: 'historical', mutateExpression: null, againstCommit: 'a'.repeat(40) }))
      .toBeDefined();
  });

  it('preserves the literal command through the reporter and strict reader, while legacy rows stay readable', async () => {
    const command = 'PROBE_SUBJECT={} npm run test:file -- guard.test.ts';
    const recorded = await recordOneRow('mutant', JSON.stringify({ ...invocation, testCommand: command, testCommandSha256: sha(command) }));
    expect(parseTestRunExecutionDetails(recorded.executionDetails)?.mutation?.testCommand).toBe(command);
    expect(parseMutationDescriptor(row)).toBeDefined();
    expect(parseMutationDescriptor(row)).not.toHaveProperty('testCommand');
  });

  it.each([
    ['an unknown key', { ...row, extra: true }],
    ['a missing mode', (() => { const { mode: _mode, ...rest } = row; return rest; })()],
    ['both an expression and a commit', { ...row, againstCommit: 'a'.repeat(40) }],
    ['neither an expression nor a commit', { ...row, mutateExpression: null }],
    ['historical mode without a commit', { ...row, mode: 'historical' }],
    ['a short commit', { ...row, mode: 'historical', mutateExpression: null, againstCommit: 'a'.repeat(12) }],
    ['a malformed subject hash', { ...row, subjectBeforeSha256: 'xyz' }],
    ['a malformed leg', { ...row, leg: 'Mutant!' }],
    ['an over-long diff', { ...row, mutantDiff: 'x'.repeat(8_001) }],
    ['an empty command', { ...row, testCommand: '' }],
    ['an over-long command', { ...row, testCommand: 'x'.repeat(8_001) }],
    ['a non-string command', { ...row, testCommand: 1 }],
  ])('refuses %s, so the whole row fails the strict parser', (_label, mutation) => {
    expect(parseMutationDescriptor(mutation)).toBeUndefined();
    expect(parseTestRunExecutionDetails({ ...baseDetails, mutation })).toBeUndefined();
  });
});
