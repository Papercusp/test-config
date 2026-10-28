import { describe, expect, it } from 'vitest';

import {
  MAX_RECORDED_PASSED_CASES,
  TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
  parseTestRunExecutionDetails,
  parseRecordedMeasurementProvenance,
  parseRecordedRubricCheck,
  parseExecutionBoundaryReceipt,
  parseTestBoundaryObservations,
  passedCaseTitlesIncomplete,
  stableRecordedRuntimeEnvironment,
  type TestRunExecutionDetails,
} from './execution-details.ts';

describe('native execution attribution', () => {
  it('preserves exact custody and legacy compatibility', () => {
    const attribution = { ownerId: 'agent-a', workItemId: 'EI-123' };
    expect(parseTestRunExecutionDetails(details({ runGroupId: 'native-group', attribution })))
      .toMatchObject({ attribution });
    expect(parseTestRunExecutionDetails(details())).toBeDefined();
  });
  it('rejects partial, expanded, invalid and groupless custody', () => {
    for (const attribution of [{ ownerId: '', workItemId: 'EI-123' },
      { ownerId: 'agent-a', workItemId: 'other' }, { ownerId: 'agent-a' },
      { ownerId: 'agent-a', workItemId: 'EI-123', trusted: true }])
      expect(parseTestRunExecutionDetails(details({ runGroupId: 'g', attribution }))).toBeUndefined();
    expect(parseTestRunExecutionDetails(details({ runGroupId: null,
      attribution: { ownerId: 'agent-a', workItemId: 'EI-123' } }))).toBeUndefined();
  });
});

describe('recorded requirement realization checks', () => {
  it('roundtrips the canonical check kind without admitting unknown kinds', () => {
    const check = { id: 'R-1:done-when', rubricRef: 'conformance:repo/plan', criterionKey: 'R-1',
      kind: 'requirements', value: 0, unit: 'unrealized requirements' };
    expect(parseRecordedRubricCheck(check)).toEqual(check);
    expect(parseTestRunExecutionDetails(details({ check }))).toMatchObject({ check });
    expect(parseRecordedRubricCheck({ ...check, kind: 'unregistered' })).toBeUndefined();
  });

  it('roundtrips a per-subject check and refuses a malformed subject (crm plan D-049)', () => {
    const check = { id: 'usage:instrument', rubricRef: 'lead-qualification', criterionKey: 'usage',
      kind: 'instrument', value: 40, unit: 'score' };
    for (const subject of [{ ref: 'PER-1' }, { kind: 'person', ref: 'PER-1' }]) {
      expect(parseRecordedRubricCheck({ ...check, subject })).toEqual({ ...check, subject });
      expect(parseTestRunExecutionDetails(details({ check: { ...check, subject } }))).toMatchObject({ check: { subject } });
    }
    for (const subject of [{}, { ref: '' }, { ref: '   ' }, { ref: 'x'.repeat(201) }, { ref: 'PER-1', extra: 1 },
      { kind: '', ref: 'PER-1' }, { kind: 7, ref: 'PER-1' }, 'PER-1', null]) {
      expect(parseRecordedRubricCheck({ ...check, subject })).toBeUndefined();
    }
  });
});

describe('native LLM report identities', () => {
  it('preserves exact report identities and accepts older rows without them', () => {
    expect(parseTestRunExecutionDetails(details({ testLayer: 'llm', llmRunIds: ['run-a', 'run-b'] })))
      .toMatchObject({ llmRunIds: ['run-a', 'run-b'] });
    expect(parseTestRunExecutionDetails(details())).toBeDefined();
  });
  it('rejects duplicate, empty, excessive and incorrectly layered report identities', () => {
    for (const llmRunIds of [[], [''], ['run-a', 'run-a'], [42], Array(1001).fill('run'), ['x'.repeat(201)]]) {
      expect(parseTestRunExecutionDetails(details({ testLayer: 'llm', llmRunIds }))).toBeUndefined();
    }
    expect(parseTestRunExecutionDetails(details({ testLayer: 'unit', llmRunIds: ['run-a'] }))).toBeUndefined();
  });
});

describe('original LLM block custody', () => {
  const custody = () => ({ experimentId: 'prospective', blockIndex: 0, scenarioId: 'scenario', arm: 'compact',
    variantId: 'prospective-compact', beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64),
    requestManifestSha256: 'c'.repeat(64), pid: 123, processStartTicks: '456', runIds: ['one', 'two', 'three'] });
  it('preserves exact metadata and leaves legacy rows valid', () => {
    expect(parseTestRunExecutionDetails(details({ llmBlockCustody: custody() }))).toMatchObject({ llmBlockCustody: custody() });
    expect(parseTestRunExecutionDetails(details())).toBeDefined();
  });
  it('rejects missing, expanded, duplicated or malformed identities', () => {
    for (const value of [{ ...custody(), arm: 'unknown' }, { ...custody(), blockIndex: 10 },
      { ...custody(), beforeSha256: '' }, { ...custody(), runIds: ['one', 'one', 'two'] },
      { ...custody(), trusted: true }, { ...custody(), processStartTicks: undefined }])
      expect(parseTestRunExecutionDetails(details({ llmBlockCustody: value }))).toBeUndefined();
  });
});

describe('instrumented boundary custody', () => {
  const receipt = () => ({ boundary: 'graph:query:evidence', callId: 'dispatch-1', workspaceId: 'ws', harness: 'repo',
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16), traceFlags: 1,
    startedAt: 1, endedAt: 2, outcome: 'ok', sourceFingerprint: 'd'.repeat(64), buildSha: 'e'.repeat(40),
    artifactFingerprint: null, environmentFingerprint: 'f'.repeat(64), workflowId: null });
  it('preserves exact module, environment and case identities while rejecting malformed or expanded witnesses', () => {
    expect(parseExecutionBoundaryReceipt(receipt())).toEqual(receipt());
    expect(parseTestBoundaryObservations([{ caseKey: 'suite > test', occurrence: 2, receipt: receipt() }]))
      .toEqual([{ caseKey: 'suite > test', occurrence: 2, receipt: receipt() }]);
    for (const bad of [{ ...receipt(), spanId: receipt().parentSpanId }, { ...receipt(), traceId: '0'.repeat(32) },
      { ...receipt(), observedChild: true }, { ...receipt(), endedAt: 0 }, { ...receipt(), workflowId: 'guessed' }]) {
      expect(parseExecutionBoundaryReceipt(bad)).toBeUndefined();
    }
    expect(parseTestBoundaryObservations([{ caseKey: 'suite > test', occurrence: 0, receipt: receipt() }])).toBeUndefined();
    expect(parseTestBoundaryObservations(Array(33).fill({ caseKey: 'test', occurrence: 1, receipt: receipt() }))).toBeUndefined();
  });
});

describe('bounded historical measurement contract', () => {
  const provenance = () => ({ schemaVersion: 1, startedAt: '2026-10-23T00:00:00Z',
    finishedAt: '2026-10-23T00:00:01Z', procedure: { sha256: 'a'.repeat(64), snapshot: '{"kind":"sql"}' },
    diagnostics: [{ path: '$.rows[0].sample_count', value: 7 }], truncated: false, redacted: false, gaps: [] });
  it('preserves native readings and accepts provenance-absent legacy rows', () => {
    for (const value of [42, '9007199254740993', true, null]) {
      const check = { id: 'c:0', rubricRef: 'r', criterionKey: 'c', kind: 'probe', value, unit: null };
      expect(parseRecordedRubricCheck(check)).toEqual(check);
      expect(parseRecordedRubricCheck({ ...check, provenance: provenance() }))
        .toEqual({ ...check, provenance: provenance() });
    }
  });
  it('rejects malformed, nested, nonfinite, inconsistent and UTF8-over-budget provenance', () => {
    const p = provenance();
    expect(parseRecordedMeasurementProvenance(p)).toEqual(p);
    for (const invalid of [
      { ...p, extra: true }, { ...p, startedAt: '2026-10-24T00:00:00Z' },
      { ...p, procedure: { ...p.procedure, snapshot: JSON.stringify('界'.repeat(3000)) } },
      { ...p, procedure: { ...p.procedure, snapshot: 'broken json' } },
      { ...p, diagnostics: [{ path: '$.n', value: { nested: 1 } }] },
      { ...p, diagnostics: [{ path: '$.n', value: Infinity }] },
      { ...p, diagnostics: [{ path: '$.n', value: 'a'.repeat(257) }] },
      { ...p, diagnostics: Array(65).fill({ path: '$.n', value: 1 }) },
      { ...p, diagnostics: Array.from({ length: 64 }, (_, i) => ({ path: '$.' + i, value: '界'.repeat(256) })) },
      { ...p, redacted: true }, { ...p, truncated: true }, { ...p, gaps: ['invented'] },
    ]) expect(parseRecordedMeasurementProvenance(invalid)).toBeUndefined();
  });
});

describe('recorded operational command scope', () => {
  it('preserves exact producer, install and window arguments while accepting legacy rows without them', () => {
    const operational = { schemaVersion: 1, command: ['executeGreenMainAdmissionWindow',
      'workspace-test', 'install-test', '1791000000000', '1791604800000'] };
    expect(parseTestRunExecutionDetails(details({ operational })))
      .toMatchObject({ operational });
    expect(parseTestRunExecutionDetails(details())).not.toHaveProperty('operational');
  });

  it('rejects malformed or extended command metadata rather than treating it as scoped proof', () => {
    for (const operational of [null, { schemaVersion: 2, command: ['native'] },
      { schemaVersion: 1, command: [] }, { schemaVersion: 1, command: [''] },
      { schemaVersion: 1, command: [42] }, { schemaVersion: 1, command: Array(51).fill('x') },
      { schemaVersion: 1, command: ['x'.repeat(1001)] },
      { schemaVersion: 1, command: ['native'], trusted: true }]) {
      expect(parseTestRunExecutionDetails(details({ operational }))).toBeUndefined();
    }
  });
});

describe('recorded runtime execution witnesses', () => {
  it('accepts exact original integration receipts and rejects missing hashes, extensions and duplicate runs', () => {
    const receipt = { runId: '20261008T000000Z-100', resultSha256: 'a'.repeat(64),
      sourceSha256: 'b'.repeat(64), lifecycleSha256: 'c'.repeat(64) };
    expect(parseTestRunExecutionDetails(details({ isolatedRuntimeReceipts: [receipt] })))
      .toMatchObject({ isolatedRuntimeReceipts: [receipt] });
    for (const receipts of [[], [receipt, receipt], [{ ...receipt, trusted: true }],
      [{ ...receipt, lifecycleSha256: '' }], [{ ...receipt, runId: '../other' }]]) {
      expect(parseTestRunExecutionDetails(details({ isolatedRuntimeReceipts: receipts }))).toBeUndefined();
    }
  });
  const before = { schemaVersion: 1, units: ['bg-host', 'desktop'], fingerprint: 'a'.repeat(64),
    observedAt: '2026-10-07T00:00:00Z' };
  const after = { ...before, units: ['desktop', 'bg-host'], observedAt: '2026-10-07T00:01:00Z' };
  it('requires independently recorded matching observations around execution', () => {
    expect(stableRecordedRuntimeEnvironment(before, after)).toEqual(before);
    expect(stableRecordedRuntimeEnvironment(before, undefined)).toBeUndefined();
    expect(stableRecordedRuntimeEnvironment(undefined, after)).toBeUndefined();
    expect(stableRecordedRuntimeEnvironment(before, { ...after, fingerprint: 'b'.repeat(64) })).toBeUndefined();
    expect(stableRecordedRuntimeEnvironment(before, { ...after, units: ['bg-host'] })).toBeUndefined();
    expect(stableRecordedRuntimeEnvironment(before, { ...after, observedAt: '2026-10-06T00:00:00Z' })).toBeUndefined();
  });
  it('rejects incomplete, duplicate-unit and caller-extended witnesses in the strict persisted contract', () => {
    expect(parseTestRunExecutionDetails(details({ runtimeEnvironmentBefore: before, runtimeEnvironmentAfter: after })))
      .toMatchObject({ runtimeEnvironmentBefore: before, runtimeEnvironmentAfter: after });
    for (const value of [{ ...before, fingerprint: 'claimed' }, { ...before, units: [] },
      { ...before, units: ['bg-host', 'bg-host'] }, { ...before, observedAt: '' }, { ...before, trusted: true }]) {
      expect(parseTestRunExecutionDetails(details({ runtimeEnvironmentBefore: value }))).toBeUndefined();
    }
  });
  it('validates runtime capture statuses and keeps each status consistent with its witness', () => {
    const row = details({
      runtimeEnvironmentBefore: before,
      runtimeEnvironmentAfterCaptureStatus: 'timed-out',
      runtimeEnvironmentBeforeCaptureStatus: 'captured',
    });
    expect(parseTestRunExecutionDetails(row)).toMatchObject({
      runtimeEnvironmentBefore: before,
      runtimeEnvironmentBeforeCaptureStatus: 'captured',
      runtimeEnvironmentAfterCaptureStatus: 'timed-out',
    });
    expect(parseTestRunExecutionDetails(details({ runtimeEnvironmentBeforeCaptureStatus: 'captured' }))).toBeUndefined();
    expect(parseTestRunExecutionDetails(details({ runtimeEnvironmentAfter: after,
      runtimeEnvironmentAfterCaptureStatus: 'timed-out' }))).toBeUndefined();
    expect(parseTestRunExecutionDetails(details({ runtimeEnvironmentAfterCaptureStatus: 'silent' }))).toBeUndefined();
  });
});

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
    { failed: 64, failedCaseTitles: Array.from({ length: 65 }, (_, i) => `case ${i}`) },
    { failed: 1, failedCaseTitles: null },
  ])('rejects malformed or contradictory identities: %j', overrides => {
    expect(parseTestRunExecutionDetails({ ...details(), ...overrides })).toBeUndefined();
  });

  it('accepts every failed case title of a failing row: failed identities are not capped (P-017, D-005)', () => {
    const titles = Array.from({ length: 300 }, (_, i) => `suite > failing case ${i}`);
    const parsed = parseTestRunExecutionDetails({ ...details(), failed: 300, failedCaseTitles: titles });
    expect(parsed?.failedCaseTitles).toEqual(titles);
  });

  it('accepts exact measured passing identities without changing legacy rows', () => {
    const row = { ...details(), passedCaseTitles: ['suite > passed case', 'suite — second: passed'] };
    expect(parseTestRunExecutionDetails(row)).toMatchObject({ passedCaseTitles: row.passedCaseTitles });
    expect(parseTestRunExecutionDetails(JSON.stringify(row))).toMatchObject({ passedCaseTitles: row.passedCaseTitles });
    expect(parseTestRunExecutionDetails(details())).toBeDefined();
  });

  it('marks capped passed-title sets incomplete and infers the same for legacy rows', () => {
    const titles = Array.from({ length: MAX_RECORDED_PASSED_CASES }, (_, index) => 'suite > current case ' + index);
    const marked = parseTestRunExecutionDetails(details({
      passed: MAX_RECORDED_PASSED_CASES + 1, passedCaseTitles: titles, passedCaseTitlesTruncated: true,
    }));
    expect(marked?.passedCaseTitlesTruncated).toBe(true);
    expect(passedCaseTitlesIncomplete(marked!)).toBe(true);

    const legacyTitles = Array.from({ length: 64 }, (_, index) => 'suite > legacy case ' + index);
    const legacy = parseTestRunExecutionDetails(details({ passed: 65, passedCaseTitles: legacyTitles }));
    expect(passedCaseTitlesIncomplete(legacy!)).toBe(true);
    expect(parseTestRunExecutionDetails(details({
      passed: 64, passedCaseTitles: legacyTitles, passedCaseTitlesTruncated: true,
    }))).toBeUndefined();
    expect(passedCaseTitlesIncomplete(parseTestRunExecutionDetails(details({
      passed: 65, passedCaseTitlesTruncated: true,
    }))!)).toBe(true);
  });
  it('infers incomplete identity proof from any measured-count mismatch', () => {
    const legacy = parseTestRunExecutionDetails(details({
      passed: 29,
      passedCaseTitles: Array.from({ length: 28 }, (_, index) => `suite > case ${index}`),
    }));
    expect(legacy).toBeDefined();
    expect(legacy?.passedCaseTitlesTruncated).toBeUndefined();
    expect(passedCaseTitlesIncomplete(legacy!)).toBe(true);
  });

  it.each([
    { passed: 0, passedCaseTitles: ['not a passed test'] },
    { passed: 1, collectionFailed: true, passedCaseTitles: ['setup is not an assertion'] },
    { passed: 2, passedCaseTitles: ['same title', 'same title'] },
    { passed: 1, passedCaseTitles: [' leading space'] },
    { passed: 1, passedCaseTitles: ['multiline\nDOM'] },
    { passed: 1, passedCaseTitles: ['x'.repeat(2_049)] },
    { passed: MAX_RECORDED_PASSED_CASES + 1,
      passedCaseTitles: Array.from({ length: MAX_RECORDED_PASSED_CASES + 1 }, (_, i) => 'case ' + i) },
    { passed: 1, passedCaseTitles: null },
    { failed: 1, failedCaseTitles: ['suite > case'], passedCaseTitles: ['suite > case'] },
  ])('rejects malformed or contradictory passing identities: %j', overrides => {
    expect(parseTestRunExecutionDetails({ ...details(), ...overrides })).toBeUndefined();
  });
});
