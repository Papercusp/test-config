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
