import { describe, expect, it } from 'vitest';

import {
  TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
  parseTestRunExecutionDetails,
  type TestRunExecutionDetails,
} from './execution-details.ts';

function details(overrides: Partial<Record<keyof TestRunExecutionDetails, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
    root: '/repo',
    filePath: 'libs/x/src/a.test.ts',
    runGroupId: 'run-1',
    workspaceId: 'ws',
    harnessSlug: 'papercusp',
    testNamePattern: null,
    passed: 3,
    failed: 0,
    skipped: 0,
    collectionFailed: false,
    mutationPhase: null,
    commitSha: 'abc123',
    worktreeDirty: false,
    ...overrides,
  };
}

describe('parseTestRunExecutionDetails — worktreeDirtyReason (WI-10004866)', () => {
  it('accepts rows written before the field existed, clean or dirty', () => {
    expect(parseTestRunExecutionDetails(details())).toMatchObject({ worktreeDirty: false });
    expect(parseTestRunExecutionDetails(details({ worktreeDirty: true }))).toMatchObject({ worktreeDirty: true });
  });

  it('accepts a dirty row that names its reason, including the jsonb-string storage shape', () => {
    const row = details({ worktreeDirty: true, worktreeDirtyReason: '1 porcelain line(s) after the run: ?? leaked.json' });
    expect(parseTestRunExecutionDetails(row)?.worktreeDirtyReason).toBe('1 porcelain line(s) after the run: ?? leaked.json');
    expect(parseTestRunExecutionDetails(JSON.stringify(row))?.worktreeDirtyReason).toBe(
      '1 porcelain line(s) after the run: ?? leaked.json',
    );
  });

  it('rejects a reason on a clean row: a cause for dirt that did not happen is a contradiction', () => {
    expect(parseTestRunExecutionDetails(details({ worktreeDirty: false, worktreeDirtyReason: 'HEAD moved a -> b' }))).toBeUndefined();
  });

  it('rejects an empty or non-string reason', () => {
    expect(parseTestRunExecutionDetails(details({ worktreeDirty: true, worktreeDirtyReason: '' }))).toBeUndefined();
    expect(parseTestRunExecutionDetails(details({ worktreeDirty: true, worktreeDirtyReason: 42 }))).toBeUndefined();
    expect(parseTestRunExecutionDetails(details({ worktreeDirty: true, worktreeDirtyReason: null }))).toBeUndefined();
  });

  it('still rejects any other unknown key (the parser stays strict)', () => {
    expect(parseTestRunExecutionDetails({ ...details({ worktreeDirty: true }), dirtReason: 'x' })).toBeUndefined();
  });
});

describe('parseTestRunExecutionDetails — runStartedAt (EI-24827834166866368)', () => {
  it('accepts rows written before the field existed', () => {
    expect(parseTestRunExecutionDetails(details())?.runStartedAt).toBeUndefined();
  });

  it('accepts a recorded run start, including the jsonb-string storage shape', () => {
    const row = details({ worktreeDirty: true, runStartedAt: '2026-10-02T01:00:00.000Z' });
    expect(parseTestRunExecutionDetails(row)?.runStartedAt).toBe('2026-10-02T01:00:00.000Z');
    expect(parseTestRunExecutionDetails(JSON.stringify(row))?.runStartedAt).toBe('2026-10-02T01:00:00.000Z');
  });

  it('rejects a run start that is not a parseable instant: an unreadable bound must not pass as one', () => {
    expect(parseTestRunExecutionDetails(details({ runStartedAt: '' }))).toBeUndefined();
    expect(parseTestRunExecutionDetails(details({ runStartedAt: 'not-a-date' }))).toBeUndefined();
    expect(parseTestRunExecutionDetails(details({ runStartedAt: 1790900000000 }))).toBeUndefined();
    expect(parseTestRunExecutionDetails(details({ runStartedAt: null }))).toBeUndefined();
  });
});

describe('parseTestRunExecutionDetails — measured case identities', () => {
  it('accepts exact structured identities and stored JSON strings without changing legacy rows', () => {
    const row = { ...details({ failed: 2 }), failedCaseTitles: ['suite — fails: with a colon', 'suite > also fails'] };
    expect(parseTestRunExecutionDetails(row)).toMatchObject({ failedCaseTitles: row.failedCaseTitles });
    expect(parseTestRunExecutionDetails(JSON.stringify(row))).toMatchObject({ failedCaseTitles: row.failedCaseTitles });
    expect(parseTestRunExecutionDetails(details())).toBeDefined();
  });

  it.each([
    { failed: 0, failedCaseTitles: ['not a failed test'] },
    { failed: 1, collectionFailed: true, failedCaseTitles: ['setup is not an assertion'] },
    { failed: 2, failedCaseTitles: ['same title', 'same title'] },
    { failed: 1, failedCaseTitles: [' leading space'] },
    { failed: 1, failedCaseTitles: ['multiline\nDOM'] },
    { failed: 1, failedCaseTitles: ['\u001b[36mDOM'] },
    { failed: 1, failedCaseTitles: ['x'.repeat(2_049)] },
    { failed: 65, failedCaseTitles: Array.from({ length: 65 }, (_, i) => `case ${i}`) },
    { failed: 1, failedCaseTitles: null },
  ])('rejects malformed or contradictory identities: %j', overrides => {
    expect(parseTestRunExecutionDetails({ ...details(), ...overrides })).toBeUndefined();
  });

  it('accepts exact measured passing identities without changing legacy rows', () => {
    const row = { ...details(), passedCaseTitles: ['suite > passed case', 'suite — second: passed'] };
    expect(parseTestRunExecutionDetails(row)).toMatchObject({ passedCaseTitles: row.passedCaseTitles });
    expect(parseTestRunExecutionDetails(JSON.stringify(row))).toMatchObject({ passedCaseTitles: row.passedCaseTitles });
    expect(parseTestRunExecutionDetails(details())).toBeDefined();
  });

  it.each([
    { passed: 0, passedCaseTitles: ['not a passed test'] },
    { passed: 1, collectionFailed: true, passedCaseTitles: ['setup is not an assertion'] },
    { passed: 2, passedCaseTitles: ['same title', 'same title'] },
    { passed: 1, passedCaseTitles: [' leading space'] },
    { passed: 1, passedCaseTitles: ['multiline\nDOM'] },
    { passed: 1, passedCaseTitles: ['x'.repeat(2_049)] },
    { passed: 65, passedCaseTitles: Array.from({ length: 65 }, (_, i) => `case ${i}`) },
    { passed: 1, passedCaseTitles: null },
    { failed: 1, failedCaseTitles: ['suite > case'], passedCaseTitles: ['suite > case'] },
  ])('rejects malformed or contradictory passing identities: %j', overrides => {
    expect(parseTestRunExecutionDetails({ ...details(), ...overrides })).toBeUndefined();
  });
});
