import { describe, expect, it } from 'vitest';

import {
  MAX_RECORDED_PASSED_CASES,
  REGISTERED_VITEST_FILE_PROJECTS,
  TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
  parseTestRunExecutionDetails,
  parseRecordedMeasurementProvenance,
  parseRecordedRubricCheck,
  parseExecutionBoundaryReceipt,
  parseTestBoundaryObservations,
  parseSqlCoverageExecutionReceipt,
  parseTestSqlCoverageObservations,
  passedCaseTitlesIncomplete,
  isRecordedCaseIdentity,
  isRecordedCaseTitle,
  registeredVitestFileLayer,
  stableRecordedRuntimeEnvironment,
  createRecordedTestPopulation,
  parseRecordedTestPopulation,
  captureRecordedProofContext,
  parseRecordedWorkerRuntime,
  parseRecordedWorkerCompilerInputs,
  parseRecordedWorkerExecution,
  stableRecordedWorkerExecution,
  parseRecordedWorkerDatabaseReset,
  confirmedRecordedWorkerDatabaseReset,
  parseRecordedSourceSubmodules,
  parseSubmoduleCheckoutStatus,
  createSourceByteSnapshot,
  type RecordedPopulationIdentity,
  type RecordedPopulationCase,
  type TestRunExecutionDetails,
} from './execution-details.ts';
import { createProofContextIdentity, proofContextImpact, PROOF_CONTEXT_COMPONENTS,
  observeViteTransformOptions, readViteTransformOptions } from './configuration-snapshot.ts';
import { captureCurrentWorkerProcessIdentity } from './runtime-proof.ts';
import { installAppliedCompilerInputCapture, readAppliedCompilerInputs } from './applied-compiler-inputs.ts';

describe('original worker process custody', () => {
  it('binds source-byte observations independently of commit identity and refuses missing or changed bytes', () => {
    const pin = createSourceByteSnapshot([{ path: 'a.ts', sha256: '1'.repeat(64) }])!;
    const sourceBytes = { schemaVersion: 'source-byte-observation-v1', before: pin, after: pin };
    const input = { commitSha: 'a'.repeat(40), worktreeDirty: false, sourceBytes };
    const proofContext = captureRecordedProofContext(input);
    expect(proofContext.components.source).toBe(pin.sha256);
    expect(captureRecordedProofContext({ ...input, commitSha: 'b'.repeat(40) })).toEqual(proofContext);
    const row = details({ ...input, proofContext });
    expect(parseTestRunExecutionDetails(JSON.parse(JSON.stringify(row)))?.sourceBytes).toEqual(sourceBytes);
    for (const sourceBytes of [{ ...input.sourceBytes, before: null }, { ...input.sourceBytes, after: null },
      { ...input.sourceBytes, after: { ...pin, sha256: '2'.repeat(64) } },
      { ...input.sourceBytes, after: { ...pin, fileCount: 2 } }]) {
      expect(captureRecordedProofContext({ ...input, sourceBytes }).components.source).toBeNull();
      expect(parseTestRunExecutionDetails({ ...row, sourceBytes })).toBeUndefined();
    }
    expect(captureRecordedProofContext({ ...input, worktreeDirty: true }).components.source).toBeNull();
    expect(createSourceByteSnapshot([])).toBeNull();
    expect(createSourceByteSnapshot([{ path: '../escape.ts', sha256: '1'.repeat(64) }])).toBeNull();
    expect(createSourceByteSnapshot([{ path: 'a.ts', sha256: '1'.repeat(64) },
      { path: 'a.ts', sha256: '1'.repeat(64) }])).toBeNull();
  });

  const processIdentity = { pid: 123, threadId: 0, bootId: '01234567-89ab-cdef-0123-456789abcdef', startTicks: '456' };
  const execution = () => ({ schemaVersion: 'worker-execution-v1' as const,
    captureId: '12345678-9abc-def0-1234-56789abcdef0', testFile: '/repo/a.test.ts',
    before: processIdentity, after: { ...processIdentity } });

  it('retains partial compiler inputs without upgrading compiler identity or accepting foreign custody', () => {
    const workerExecution = execution();
    const workerCompilerInputs = { schemaVersion: 'worker-compiler-inputs-v1' as const,
      scope: 'vitest-inlined-vm-calls' as const, populationStatus: 'unknown' as const,
      captureId: workerExecution.captureId, testFile: workerExecution.testFile,
      inputSha256: '1'.repeat(64), vmCallCount: 2,
      missing: ['transform-pipeline-unobserved', 'vm-options-partially-observed'] };
    const row = details({ root: '/repo', filePath: 'a.test.ts', workerExecution, workerCompilerInputs });
    expect(parseTestRunExecutionDetails(JSON.parse(JSON.stringify(row)))?.workerCompilerInputs).toEqual(workerCompilerInputs);
    expect(captureRecordedProofContext({ ...row, workerCompilerInputs } as never).components.compilerConfiguration).toBeNull();
    const environment = {};
    observeViteTransformOptions(environment, { root: '/repo', esbuild: { target: 'esnext' } });
    const viteTransformOptions = readViteTransformOptions(environment)!;
    const withOptions = { ...workerCompilerInputs, viteTransformOptions };
    expect(parseTestRunExecutionDetails(JSON.parse(JSON.stringify({ ...row, workerCompilerInputs: withOptions })))
      ?.workerCompilerInputs).toEqual(withOptions);
    expect(captureRecordedProofContext({ ...row, workerCompilerInputs: withOptions } as never)
      .components.compilerConfiguration).toBeNull();
    expect(parseRecordedWorkerCompilerInputs({ ...withOptions,
      viteTransformOptions: { ...viteTransformOptions, populationStatus: 'complete' } })).toBeUndefined();
    const config = {};
    expect(installAppliedCompilerInputCapture(config)).toBe(true);
    Object.getOwnPropertyDescriptor(config, Symbol.for('@papercusp/test-config.applied-compiler-observer-v1'))!.value({
      version: 1, environment, moduleId: '/repo/a.ts', code: 'export const n = 1',
      options: { target: 'es2022' }, tsconfig: { status: 'not-used', inputs: [] }, implementation: null,
    });
    const appliedCompilerInputs = readAppliedCompilerInputs(environment)!;
    expect(appliedCompilerInputs).toBeDefined();
    const withApplied = { ...withOptions, appliedCompilerInputs };
    expect(parseTestRunExecutionDetails(JSON.parse(JSON.stringify({ ...row, workerCompilerInputs: withApplied })))
      ?.workerCompilerInputs).toEqual(withApplied);
    expect(captureRecordedProofContext({ ...row, workerCompilerInputs: withApplied } as never)
      .components.compilerConfiguration).toBeNull();
    for (const patch of [{ populationStatus: 'complete' }, { missing: [] }, { extra: true }])
      expect(parseRecordedWorkerCompilerInputs({ ...withApplied,
        appliedCompilerInputs: { ...appliedCompilerInputs, ...patch } })).toBeUndefined();
    expect(parseRecordedWorkerCompilerInputs({ ...withApplied, appliedCompilerInputs: {
      ...appliedCompilerInputs, calls: appliedCompilerInputs.calls.map(call => ({ ...call, inputSha256: 'f'.repeat(64) })),
    } })).toBeUndefined();
    expect(parseTestRunExecutionDetails({ ...row, workerCompilerInputs: { ...withOptions,
      captureId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' } })).toBeUndefined();
    for (const patch of [{ populationStatus: 'complete' }, { complete: true }, { missing: [] },
      { vmCallCount: -1 }, { vmCallCount: 0 }, { inputSha256: null }])
      expect(parseRecordedWorkerCompilerInputs({ ...workerCompilerInputs, ...patch })).toBeUndefined();
    for (const patch of [{ captureId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }, { testFile: '/repo/other.test.ts' }])
      expect(parseTestRunExecutionDetails({ ...row, workerCompilerInputs: { ...workerCompilerInputs, ...patch } })).toBeUndefined();
    expect(parseTestRunExecutionDetails({ ...row, workerExecution: undefined })).toBeUndefined();
    const reset = { schemaVersion: 'worker-database-reset-v1' as const, captureId: workerExecution.captureId,
      runGroupId: row.runGroupId, testFile: workerExecution.testFile, databases: [],
      startedAt: '2026-11-12T00:00:00.000Z', finishedAt: '2026-11-12T00:00:01.000Z' };
    const changedCaptureId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const changed = { ...row, workerExecution: { ...workerExecution, captureId: changedCaptureId },
      workerCompilerInputs: { ...workerCompilerInputs, captureId: changedCaptureId },
      workerDatabaseReset: { ...reset, captureId: changedCaptureId } };
    expect(parseTestRunExecutionDetails(changed)).toBeDefined();
    expect(parseTestRunExecutionDetails({ ...changed, workerCompilerInputs })).toBeUndefined();
    expect(parseTestRunExecutionDetails({ ...changed, workerDatabaseReset: reset })).toBeUndefined();
    expect(parseRecordedWorkerCompilerInputs({ ...workerCompilerInputs, inputSha256: null, vmCallCount: 0,
      missing: [...workerCompilerInputs.missing, 'vm-calls-unobserved'] })).toBeDefined();
  });

  it('binds confirmed database reset to the original file, run and stable worker without claiming fixture identity', () => {
    const worker = execution();
    const reset = { schemaVersion: 'worker-database-reset-v1', captureId: worker.captureId,
      runGroupId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', testFile: worker.testFile,
      startedAt: '2026-11-12T00:00:00.000Z', finishedAt: '2026-11-12T00:00:04.000Z',
      databases: [{ allocationId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', name: 'it_0123456789ab', origin: 'empty',
        startedAt: '2026-11-12T00:00:01.000Z', readyAt: '2026-11-12T00:00:02.000Z',
        cleanup: { at: '2026-11-12T00:00:03.000Z', outcome: 'dropped' } }] };
    const confirmed = (value: unknown, current: unknown = worker, group = reset.runGroupId) =>
      confirmedRecordedWorkerDatabaseReset(value, current, group);
    expect(confirmed(reset)).toEqual(reset);
    expect(parseTestRunExecutionDetails(details({ root: '/repo', filePath: 'a.test.ts',
      runGroupId: reset.runGroupId, workerExecution: worker, workerDatabaseReset: reset } as never))?.workerDatabaseReset).toEqual(reset);
    expect(confirmed({ ...reset, databases: [] })).toBeUndefined();
    for (const outcome of ['deferred', 'detached', 'error']) {
      const pending = { ...reset, databases: [{ ...reset.databases[0], cleanup: { ...reset.databases[0]!.cleanup, outcome } }] };
      expect(parseRecordedWorkerDatabaseReset(pending)).toEqual(pending);
      expect(confirmed(pending)).toBeUndefined();
    }
    for (const patch of [{ readyAt: null }, { cleanup: null }])
      expect(confirmed({ ...reset, databases: [{ ...reset.databases[0], ...patch }] })).toBeUndefined();
    expect(confirmed(reset, { ...worker, captureId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })).toBeUndefined();
    expect(confirmed(reset, { ...worker, testFile: '/repo/other.test.ts' })).toBeUndefined();
    expect(confirmed(reset, { ...worker, after: { ...processIdentity, pid: 124 } })).toBeUndefined();
    expect(confirmed(reset, worker, 'ffffffff-ffff-ffff-ffff-ffffffffffff')).toBeUndefined();
    const invalid = [
      { ...reset, complete: true }, { ...reset, runGroupId: '' },
      { ...reset, databases: [reset.databases[0], reset.databases[0]] },
      { ...reset, databases: [{ ...reset.databases[0], readyAt: reset.startedAt }] },
      { ...reset, databases: [{ ...reset.databases[0], cleanup: { at: reset.startedAt, outcome: 'dropped' } }] },
      { ...reset, databases: [{ ...reset.databases[0], cleanup: { at: '2026-11-12T00:00:05.000Z', outcome: 'dropped' } }] },
    ];
    for (const value of invalid) expect(parseRecordedWorkerDatabaseReset(value)).toBeUndefined();
    expect(captureRecordedProofContext({ commitSha: 'a'.repeat(40), worktreeDirty: false,
      workerDatabaseReset: reset } as never).components.fixtures).toBeNull();
  });

  it('retains the actual kernel incarnation independently of input equivalence or fixture reset', () => {
    const current = captureCurrentWorkerProcessIdentity();
    if (process.platform === 'linux') {
      expect(current).toMatchObject({ pid: process.pid, threadId: expect.any(Number),
        bootId: expect.stringMatching(/^[a-f0-9-]{36}$/), startTicks: expect.stringMatching(/^\d+$/) });
      expect(captureCurrentWorkerProcessIdentity()).toEqual(current);
    } else expect(current).toBeNull();
    const original = execution();
    const reverse = { ...original, after: Object.fromEntries(Object.entries(processIdentity).reverse()) };
    expect(stableRecordedWorkerExecution(reverse)).toEqual(original);
    expect(parseTestRunExecutionDetails(details({ root: '/repo', filePath: 'a.test.ts', workerExecution: original }))
      ?.workerExecution).toEqual(original);
    expect(parseTestRunExecutionDetails(details({ root: '/other', filePath: 'a.test.ts', workerExecution: original })))
      .toBeUndefined();
    expect(captureRecordedProofContext({ commitSha: 'a'.repeat(40), worktreeDirty: false,
      workerExecution: original } as never).components.runtimeCapabilities).toBeNull();
    expect(original).not.toHaveProperty('fixtureReset');
  });

  it.each([{ pid: 124 }, { threadId: 1 }, { bootId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
    { startTicks: '457' }])('rejects a different terminal worker incarnation: %j', changed => {
    const value = { ...execution(), after: { ...processIdentity, ...changed } };
    expect(parseRecordedWorkerExecution(value)).toEqual(value);
    expect(stableRecordedWorkerExecution(value)).toBeUndefined();
  });

  it('keeps missing observations unknown and rejects malformed or invented reset assertions', () => {
    for (const value of [undefined, {}, { ...execution(), testFile: 'a.test.ts' },
      { ...execution(), captureId: 'diagnostic-only' }, { ...execution(), fixtureReset: true },
      { ...execution(), before: { ...processIdentity, pid: 0 } },
      { ...execution(), after: { ...processIdentity, threadId: -1 } },
      { ...execution(), after: { ...processIdentity, bootId: 'host-label' } },
      { ...execution(), before: { ...processIdentity, startTicks: '1.1' } }])
      expect(parseRecordedWorkerExecution(value)).toBeUndefined();
    for (const value of [{ ...execution(), before: null }, { ...execution(), after: null }]) {
      expect(parseRecordedWorkerExecution(value)).toEqual(value);
      expect(stableRecordedWorkerExecution(value)).toBeUndefined();
    }
  });
});

describe('original result proof-context capture', () => {
  const identity: RecordedPopulationIdentity = ['unit', 'libs/x/src/a.test.ts', 'case', 1, 'test'];
  const population = createRecordedTestPopulation([{ identity, selected: true, outcome: 'passed' }], [identity])!;
  const input = { commitSha: 'a'.repeat(40), worktreeDirty: false, population };
  const runtime = { name: 'node', version: '25.1.0', executable: '/runtime/node', platform: 'linux', arch: 'x64',
    binarySha256: '1'.repeat(64), lockfileSha256: '2'.repeat(64), nativeDependencyGeneration: '3'.repeat(64),
    configurationSha256: '4'.repeat(64) };

  it('binds stable original worker test options and rejects missing, changed or transplanted observations', () => {
    const workerTestConfiguration = { schemaVersion: 'vitest-worker-configuration-v1' as const,
      before: '1'.repeat(64), after: '1'.repeat(64) };
    const proofContext = captureRecordedProofContext({ ...input, workerTestConfiguration });
    expect(proofContext.components.testConfiguration).toMatch(/^[a-f0-9]{64}$/);
    expect(proofContext.components.compilerConfiguration).toBeNull();
    expect(proofContext.components.behavior).toBeNull();
    const row = details({ ...input, passed: 1, workerTestConfiguration, proofContext });
    expect(parseTestRunExecutionDetails(JSON.parse(JSON.stringify(row)))?.workerTestConfiguration)
      .toEqual(workerTestConfiguration);
    for (const damaged of [undefined, null, {}, { ...workerTestConfiguration, before: null },
      { ...workerTestConfiguration, after: '2'.repeat(64) }, { ...workerTestConfiguration, extra: true }]) {
      expect(captureRecordedProofContext({ ...input, workerTestConfiguration: damaged }).components.testConfiguration).toBeNull();
      expect(parseTestRunExecutionDetails({ ...row, workerTestConfiguration: damaged })).toBeUndefined();
    }
    const changed = { ...workerTestConfiguration, before: '2'.repeat(64), after: '2'.repeat(64) };
    expect(captureRecordedProofContext({ ...input, workerTestConfiguration: changed }).components.testConfiguration)
      .not.toBe(proofContext.components.testConfiguration);
    expect(parseTestRunExecutionDetails({ ...row, workerTestConfiguration: changed })).toBeUndefined();
  });

  it('binds the complete stable recursive submodule checkout census and rejects a retained context after replacement', () => {
    const sourceSubmodules = { schemaVersion: 'submodule-checkouts-v1' as const,
      before: [['libs/z', '1'.repeat(40)], ['libs/a', '2'.repeat(40)]],
      after: [['libs/a', '2'.repeat(40)], ['libs/z', '1'.repeat(40)]] };
    const proofContext = captureRecordedProofContext({ ...input, sourceSubmodules });
    expect(proofContext.components.submodules).toMatch(/^[a-f0-9]{64}$/);
    const row = details({ ...input, passed: 1, sourceSubmodules: parseRecordedSourceSubmodules(sourceSubmodules), proofContext });
    expect(parseTestRunExecutionDetails(JSON.parse(JSON.stringify(row)))?.proofContext).toEqual(proofContext);
    for (const changed of [undefined, { ...sourceSubmodules, before: null },
      { ...sourceSubmodules, after: [['libs/a', 'f'.repeat(40)], ['libs/z', '1'.repeat(40)]] },
      { ...sourceSubmodules, before: [], after: [] }])
      expect(parseTestRunExecutionDetails({ ...row, sourceSubmodules: changed })).toBeUndefined();
    expect(captureRecordedProofContext({ ...input, worktreeDirty: true, sourceSubmodules }).components.submodules).toBeNull();
    expect(captureRecordedProofContext({ ...input,
      sourceSubmodules: { ...sourceSubmodules, before: null } }).components.submodules).toBeNull();
    const empty = captureRecordedProofContext({ ...input,
      sourceSubmodules: { schemaVersion: 'submodule-checkouts-v1', before: [], after: [] } });
    expect(empty.components.submodules).toMatch(/^[a-f0-9]{64}$/);
    expect(empty.components.submodules).not.toBe(proofContext.components.submodules);
    expect(proofContextImpact({ before: proofContext, after: proofContext })).toMatchObject({ status: 'unknown' });
  });

  it('parses actual recursive Git status without turning uninitialized, changed or unreadable entries into an empty census', () => {
    const sha = 'a'.repeat(40);
    expect(parseSubmoduleCheckoutStatus(`${sha} libs/a (heads/main)\n ${sha} libs/a/nested (v1)`))
      .toEqual([['libs/a', sha], ['libs/a/nested', sha]]);
    expect(parseSubmoduleCheckoutStatus('')).toEqual([]);
    for (const raw of [null, undefined, ' ', `-${sha} libs/a`, `+${sha} libs/a`, `U${sha} libs/a`,
      `${sha} libs/a\n ${sha} libs/a`, `${sha} ../escape`, `${sha} /absolute`, `${sha} libs/a with spaces (main)`,
      `${sha} libs/a\ntruncated`, `${sha} libs//a`])
      expect(parseSubmoduleCheckoutStatus(raw), String(raw)).toBeNull();
    for (const damaged of [null, {}, { schemaVersion: 'submodule-checkouts-v1', before: [], after: [], extra: true },
      { schemaVersion: 'submodule-checkouts-v1', before: [['libs/a', sha], ['libs/a', sha]], after: [] },
      { schemaVersion: 'submodule-checkouts-v1', before: [], after: [['libs/a', 'short-sha']] }])
      expect(parseRecordedSourceSubmodules(damaged)).toBeUndefined();
  });

  it('retains qualified dependency inputs from the original worker without granting capability or complete-context credit', () => {
    const workerRuntime = { before: runtime, after: { ...runtime } };
    const proofContext = captureRecordedProofContext({ ...input, workerRuntime });
    expect(proofContext.components.dependencies).toMatch(/^[a-f0-9]{64}$/);
    expect(proofContext.components.runtimeCapabilities).toBeNull();
    expect(proofContextImpact({ before: proofContext, after: proofContext })).toMatchObject({ status: 'unknown' });
    const row = details({ ...input, passed: 1, workerRuntime, proofContext });
    expect(parseTestRunExecutionDetails(JSON.parse(JSON.stringify(row)))?.workerRuntime).toEqual(workerRuntime);
    for (const field of ['lockfileSha256', 'nativeDependencyGeneration'] as const) {
      const changed = { ...runtime, [field]: 'f'.repeat(64) };
      expect(captureRecordedProofContext({ ...input, workerRuntime: { before: changed, after: changed } })
        .components.dependencies).not.toBe(proofContext.components.dependencies);
      expect(parseTestRunExecutionDetails({ ...row, workerRuntime: { before: changed, after: changed } })).toBeUndefined();
    }
    expect(parseTestRunExecutionDetails({ ...row, workerRuntime: undefined })).toBeUndefined();
  });

  it('never substitutes missing, malformed or changed worker identities with the reporter install', () => {
    for (const workerRuntime of [undefined, null, {}, { before: null, after: null },
      { before: runtime, after: null }, { before: runtime, after: { ...runtime, binarySha256: 'f'.repeat(64) } },
      { before: runtime, after: { ...runtime, nativeDependencyGeneration: '' } },
      { before: runtime, after: runtime, extra: true }])
      expect(captureRecordedProofContext({ ...input, workerRuntime }).components.dependencies).toBeNull();
    expect(parseRecordedWorkerRuntime({ before: null, after: null })).toEqual({ before: null, after: null });
    expect(parseRecordedWorkerRuntime({ before: runtime, after: { ...runtime, platform: null } })).toBeUndefined();
  });

  it.each(PROOF_CONTEXT_COMPONENTS)('rejects a canonical but unmeasured/transplanted %s component', component => {
    const workerRuntime = { before: runtime, after: runtime };
    const proofContext = captureRecordedProofContext({ ...input, workerRuntime });
    const forged = createProofContextIdentity({ ...proofContext.components, [component]: 'f'.repeat(64) });
    expect(parseTestRunExecutionDetails(details({ ...input, passed: 1, workerRuntime, proofContext: forged })))
      .toBeUndefined();
  });

  it('binds the actual source and complete population while preserving every unmeasured input', () => {
    const proofContext = captureRecordedProofContext(input);
    expect(proofContext.components.source).toMatch(/^[a-f0-9]{64}$/);
    expect(proofContext.components.population).toMatch(/^[a-f0-9]{64}$/);
    const { source, population: measuredPopulation, ...unknown } = proofContext.components;
    expect(Object.values(unknown)).toEqual(Array(10).fill(null));
    expect(proofContextImpact({ before: proofContext, after: proofContext })).toEqual({
      status: 'unknown', reason: 'proof-context-incomplete' });
    const row = details({ ...input, passed: 1, proofContext });
    expect(parseTestRunExecutionDetails(JSON.parse(JSON.stringify(row)))?.proofContext).toEqual(proofContext);
    expect(parseTestRunExecutionDetails({ ...row, commitSha: 'b'.repeat(40) })).toBeUndefined();
    expect(parseTestRunExecutionDetails({ ...row, worktreeDirty: true })).toBeUndefined();
    const tampered = createProofContextIdentity({ ...proofContext.components, population: 'f'.repeat(64) })!;
    expect(parseTestRunExecutionDetails({ ...row, proofContext: tampered })).toBeUndefined();
  });

  it('keeps dirty, missing and malformed source and population measurements unknown', () => {
    for (const damaged of [{ ...input, worktreeDirty: true }, { ...input, commitSha: null },
      { ...input, commitSha: 'diagnostic-only' }])
      expect(captureRecordedProofContext(damaged).components.source).toBeNull();
    for (const damaged of [undefined, null, { ...population, populationHash: 'f'.repeat(64) }])
      expect(captureRecordedProofContext({ ...input, population: damaged }).components.population).toBeNull();
  });

  it('separates outcome changes from population, selection and observed order changes', () => {
    const before = captureRecordedProofContext(input);
    const failed = createRecordedTestPopulation([{ identity, selected: true, outcome: 'failed' }], [identity])!;
    expect(captureRecordedProofContext({ ...input, population: failed })).toEqual(before);
    const unselected = createRecordedTestPopulation([{ identity, selected: false, outcome: 'skipped' }], [])!;
    expect(captureRecordedProofContext({ ...input, population: unselected }).components.population)
      .not.toBe(before.components.population);
    const repeated = createRecordedTestPopulation(population.cases, [identity, identity])!;
    expect(captureRecordedProofContext({ ...input, population: repeated }).components.population)
      .not.toBe(before.components.population);
    expect(captureRecordedProofContext({ ...input, commitSha: 'b'.repeat(40) }).components.source)
      .not.toBe(before.components.source);
  });
});

describe('registered per-file Vitest projects', () => {
  it('keeps the DB-free PTY process fixture classified as integration', () => {
    const path = 'apps/operator/lib/psu-pty-host-assume-fence.integration.test.ts';
    expect(REGISTERED_VITEST_FILE_PROJECTS.find(project => project.files.some(file => file ===
      'lib/psu-pty-host-assume-fence.integration.test.ts',
    ))).toMatchObject({
      root: 'apps/operator',
      name: 'pty-process-integration',
      layer: 'integration',
      config: 'vitest.pty-process.integration.config.ts',
    });
    expect(registeredVitestFileLayer(path)).toBe('integration');
  });
});

describe('population-v1 complete execution identity', () => {
  const identity = (title: string, occurrence = 1): RecordedPopulationIdentity =>
    ['unit', 'libs/x/src/a.test.ts', title, occurrence, 'test'];
  const a = identity('suite > duplicate');
  const b = identity('suite > duplicate', 2);
  const cases: RecordedPopulationCase[] = [
    { identity: a, selected: true, outcome: 'passed' },
    { identity: b, selected: true, outcome: 'failed' },
  ];

  it('keeps duplicate occurrences, full Unicode titles and an uncapped population', () => {
    const rows: RecordedPopulationCase[] = [...cases, ...Array.from({ length: MAX_RECORDED_PASSED_CASES + 20 },
      (_, i) => ({ identity: identity(`suite > \u03bb-${i}`), selected: true, outcome: 'passed' as const }))];
    const population = createRecordedTestPopulation(rows, rows.map(row => row.identity))!;
    expect(population.cases).toHaveLength(rows.length);
    expect(parseRecordedTestPopulation(population)).toEqual(population);
    // jsonb may reorder object keys; array/identity order remains canonical.
    const reordered = { ...population, cases: population.cases.map(row =>
      ({ outcome: row.outcome, selected: row.selected, identity: row.identity })) };
    expect(parseRecordedTestPopulation(reordered)).toEqual(population);
    expect(parseTestRunExecutionDetails(details({ population, passed: rows.length - 1, failed: 1 })))
      .toMatchObject({ population });
  });

  it('separates collection, selection, outcomes and observed execution order', () => {
    const baseline = createRecordedTestPopulation(cases, [a, b])!;
    const reordered = createRecordedTestPopulation([...cases].reverse(), [b, a])!;
    expect(reordered.populationHash).toBe(baseline.populationHash);
    expect(reordered.outcomesHash).toBe(baseline.outcomesHash);
    expect(reordered.executionOrderHash).not.toBe(baseline.executionOrderHash);
    const changed = createRecordedTestPopulation([cases[0], { ...cases[1], outcome: 'passed' }], [a, b])!;
    expect(changed.populationHash).toBe(baseline.populationHash);
    expect(changed.outcomesHash).not.toBe(baseline.outcomesHash);
    const selected = createRecordedTestPopulation([cases[0], { ...cases[1], selected: false, outcome: 'skipped' }], [a])!;
    expect(selected.populationHash).toBe(baseline.populationHash);
    expect(selected.selectionHash).not.toBe(baseline.selectionHash);
  });

  it('roundtrips full parameterized titles beyond diagnostic caps and refuses unrepresentable or sparse identities', () => {
    const long = identity(`suite > ${'parameter'.repeat(1_000)} \n\t\u001b \ud83d\udc3e`);
    const row: RecordedPopulationCase = { identity: long, selected: true, outcome: 'passed' };
    const population = createRecordedTestPopulation([row], [long])!;
    expect(population, 'complete population must retain the original long case title').toBeDefined();
    expect(population.cases[0].identity[2]).toBe(long[2]);
    expect(parseRecordedTestPopulation(JSON.parse(JSON.stringify(population)))).toEqual(population);
    expect(parseTestRunExecutionDetails(details({ passed: 1, population, populationCaptureStatus: 'captured' })))
      .toBeDefined();
    expect(parseTestRunExecutionDetails(details({ populationCaptureStatus: 'captured' }))).toBeUndefined();
    expect(parseTestRunExecutionDetails(details({ populationCaptureStatus: 'invented' }))).toBeUndefined();
    for (const title of ['a\u0000b', 'a\ud800b', 'a\udc00b']) {
      const id = identity(title);
      expect(createRecordedTestPopulation([{ ...row, identity: id }], [id])).toBeUndefined();
    }
    expect(createRecordedTestPopulation(new Array(1), [])).toBeUndefined();
  });

  it('rejects sampled, tampered, duplicate, incomplete and wrong-file records while retaining legacy rows', () => {
    const population = createRecordedTestPopulation(cases, [a, b])!;
    expect(parseRecordedTestPopulation({ ...population, cases: population.cases.slice(1) })).toBeUndefined();
    expect(parseRecordedTestPopulation({ ...population, outcomesHash: '0'.repeat(64) })).toBeUndefined();
    expect(parseRecordedTestPopulation({ ...population, complete: true })).toBeUndefined();
    expect(createRecordedTestPopulation([cases[0], cases[0]], [a])).toBeUndefined();
    expect(createRecordedTestPopulation(cases, [a])).toBeUndefined();
    expect(createRecordedTestPopulation(cases, [a, b, identity('uncollected')])).toBeUndefined();
    expect(createRecordedTestPopulation([{ ...cases[0], identity: identity('gap', 2) }], [identity('gap', 2)]))
      .toBeUndefined();
    expect(parseTestRunExecutionDetails(details({ population, passed: 1, failed: 1 }))).toBeDefined();
    for (const overrides of [{ passed: 2 }, { collectionFailed: true }, { filePath: 'other.test.ts' }])
      expect(parseTestRunExecutionDetails(details({ population, passed: 1, failed: 1, ...overrides }))).toBeUndefined();
    expect(parseTestRunExecutionDetails(details())).toBeDefined();
  });
});

describe('native execution attribution', () => {
  it('roundtrips timing runtime identity while keeping old rows valid and rejecting malformed identities', () => {
    const testTimingRuntimeIdentity = 'node:25.9.0 linux/x64 vitest:4.1.8';
    expect(parseTestRunExecutionDetails(details({ testTimingRuntimeIdentity })))
      .toMatchObject({ testTimingRuntimeIdentity });
    expect(parseTestRunExecutionDetails(details())).toBeDefined();
    for (const invalid of ['', ' ', 7, 'x'.repeat(301)])
      expect(parseTestRunExecutionDetails(details({ testTimingRuntimeIdentity: invalid }))).toBeUndefined();
  });
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

describe('SQL coverage execution custody', () => {
  const execution = (toolName = 'dev:pg_query', callId = 'sql') => ({ schemaVersion: 1, callId,
    workspaceId: 'ws', harness: 'repo', scopeId: 'a'.repeat(64), toolName, contractRef: 'contract-v1', startedAt: 1, endedAt: 2,
    outcome: 'ok', argsToken: 'b'.repeat(64), resultToken: 'c'.repeat(64), sourceFingerprint: 'd'.repeat(64),
    buildSha: 'e'.repeat(40), artifactFingerprint: 'f'.repeat(64), environmentFingerprint: '1'.repeat(64) });
  const observation = () => ({ caseKey: 'suite > exact fixture', occurrence: 1, fixtureRef: 'fixture:jobs-v1',
    scopeId: 'a'.repeat(64), parserVersion: 'parser-v1', fingerprint: '2'.repeat(64), featuresToken: '3'.repeat(64),
    contractRef: 'contract-v1', verdict: 'exact', missingFeatures: [], sqlExecution: execution(),
    toolExecution: execution('jobs:list', 'tool') });
  it('roundtrips bounded hints in the existing strict ledger while preserving legacy rows', () => {
    const sqlCoverageObservations = [observation()];
    expect(parseSqlCoverageExecutionReceipt(execution())).toEqual(execution());
    expect(parseTestSqlCoverageObservations(sqlCoverageObservations)).toEqual(sqlCoverageObservations);
    expect(parseTestRunExecutionDetails(details({ sqlCoverageObservations }))).toMatchObject({ sqlCoverageObservations });
    expect(parseTestRunExecutionDetails(details())).toBeDefined();
  });
  it('rejects forged, partial, private, cross-scope and drifting execution identities', () => {
    for (const patch of [{ sql: 'private SQL' }, { args: { private: true } }, { outcome: 'error' },
      { argsToken: '' }, { resultToken: 'unkeyed value' }, { artifactFingerprint: null }, { buildSha: 'short' },
      { endedAt: 0 }, { startedAt: 1.5 }, { environmentFingerprint: undefined }])
      expect(parseSqlCoverageExecutionReceipt({ ...execution(), ...patch })).toBeUndefined();
    for (const patch of [{ sql: 'private SQL' }, { occurrence: 0 }, { fingerprint: 'plain SQL' },
      { missingFeatures: ['limit'] }, { featuresToken: '' }, { scopeId: '4'.repeat(64) }, { contractRef: 'forged-contract' },
      { toolExecution: execution('jobs:list', 'sql') },
      { toolExecution: { ...execution('jobs:list', 'tool'), workspaceId: 'foreign' } },
      { toolExecution: { ...execution('jobs:list', 'tool'), buildSha: '4'.repeat(40) } },
      { toolExecution: { ...execution('jobs:list', 'tool'), resultToken: '4'.repeat(64) } }])
      expect(parseTestSqlCoverageObservations([{ ...observation(), ...patch }])).toBeUndefined();
  });
  it('requires measured counterexamples and rejects duplicates or truncated batches', () => {
    const partial = { ...observation(), verdict: 'partial', missingFeatures: ['projection'],
      toolExecution: { ...execution('jobs:list', 'tool'), resultToken: '4'.repeat(64) } };
    expect(parseTestSqlCoverageObservations([partial])).toEqual([partial]);
    expect(parseTestSqlCoverageObservations([{ ...partial, verdict: 'none' }])).toBeDefined();
    expect(parseTestSqlCoverageObservations([{ ...partial, missingFeatures: [] }])).toBeUndefined();
    expect(parseTestSqlCoverageObservations([{ ...partial, missingFeatures: ['limit', 'limit'] }])).toBeUndefined();
    expect(parseTestSqlCoverageObservations([{ ...partial, toolExecution: execution('jobs:list', 'tool') }])).toBeUndefined();
    expect(parseTestSqlCoverageObservations([observation(), observation()])).toBeUndefined();
    expect(parseTestSqlCoverageObservations(Array(33).fill(observation()))).toBeUndefined();
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
  it('roundtrips a scoped scalar without erasing contextual gaps and rejects expanded inputs', () => {
    for (const value of [7, '9007199254740993', false, null]) {
      const p = { ...provenance(), truncated: true, gaps: ['diagnostics-truncated'],
        predicateInput: { path: '$["rows"]["0"]["sample_count"]', value } };
      const check = { id: 'c:0', rubricRef: 'r', criterionKey: 'c', kind: 'probe', value, unit: null, provenance: p };
      expect(parseRecordedRubricCheck(check)).toEqual(check);
      for (const input of [{ path: '$', value: {} }, { path: '$', value: Infinity },
        { path: '$', value: 'x'.repeat(257) }, { path: '$', value: 7, complete: true },
        { path: '', value: 7 }, { path: '$' }]) {
        expect(parseRecordedMeasurementProvenance({ ...p, predicateInput: input })).toBeUndefined();
      }
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
  it('preserves multiline case-ledger identities without relaxing compact title parsing', () => {
    const title = 'suite > parameter: <context>\n\tvalue\r\n</context>';
    expect(isRecordedCaseIdentity(title)).toBe(true);
    expect(isRecordedCaseTitle(title)).toBe(false);
    for (const invalid of [' leading', 'trailing\n', 'case\u0000value', 'case\u001bvalue', 'x'.repeat(2_049)]) {
      expect(isRecordedCaseIdentity(invalid)).toBe(false);
    }
  });
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
