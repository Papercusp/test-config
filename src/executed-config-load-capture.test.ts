import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configBundleSources, qualifyLoadedConfigSources, qualifyLoadedMainProcessSources,
  writeExecutedCaptureDiagnostic, classifyEngineCoverageTargets } from './executed-config-load-capture.ts';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const prefix = (path: string): string => `const __vite_injected_original_dirname = ${JSON.stringify(dirname(path))};` +
  `const __vite_injected_original_filename = ${JSON.stringify(path)};` +
  `const __vite_injected_original_import_meta_url = ${JSON.stringify(pathToFileURL(path).href)};`;
const bundle = (map: unknown): string => '// loaded code\n//# sourceMappingURL=data:application/json;base64,' +
  Buffer.from(JSON.stringify(map)).toString('base64');

describe('exact nested engine target coverage', () => {
  const fixture = () => {
    const root = { startOffset: 10, endOffset: 100 };
    const block = { startOffset: 30, endOffset: 80 };
    const observation = { sourceTextSha256: digest('pinned source'), sourceTextLength: 200,
      functions: [{ functionName: 'target', isBlockCoverage: true,
        ranges: [{ ...root, count: 0 }, { ...block, count: 0 }] }] };
    const expected = { sourceTextSha256: observation.sourceTextSha256, sourceTextLength: 200,
      targets: [{ functionName: 'target', functionRoot: root, ranges: [block] }] };
    return { observation, expected };
  };
  it('requires exact structural zero and leaves runtime qualification unknown', () => {
    const f = fixture();
    expect(classifyEngineCoverageTargets(f.observation, f.expected)).toMatchObject({
      state: 'zero', observedEntry: false, reasons: [], runtimeQualification: 'unknown' });
    // A positive enclosing range is not a positive descendant of the target.
    f.observation.functions[0].ranges[0].count = 1;
    expect(classifyEngineCoverageTargets(f.observation, f.expected).state).toBe('zero');
  });
  it.each(['exact', 'block-descendant', 'nested-function'] as const)(
    'retains positive entry despite an enclosing zero: %s', mode => {
      const f = fixture();
      if (mode === 'exact') f.observation.functions[0].ranges[1].count = 1;
      if (mode === 'block-descendant') f.observation.functions[0].ranges.push({ startOffset: 40, endOffset: 50, count: 1 });
      if (mode === 'nested-function') f.observation.functions.push({ functionName: 'nested', isBlockCoverage: false,
        ranges: [{ startOffset: 40, endOffset: 50, count: 1 }] });
      expect(classifyEngineCoverageTargets(f.observation, f.expected)).toMatchObject({ state: 'entry', observedEntry: true });
    });
  it.each(['absent-script', 'absent-function', 'absent-range', 'containing-range', 'spanning-range',
    'source-sha', 'source-length', 'wrong-root', 'wrong-name', 'uncalibrated-targets'] as const)(
    'never infers zero for missing or mismatched structure: %s', mode => {
      const f = fixture();
      if (mode === 'absent-script') f.observation.functions = [];
      if (mode === 'absent-function') f.observation.functions[0].functionName = 'different';
      if (mode === 'absent-range') f.observation.functions[0].ranges.pop();
      if (mode === 'containing-range') f.expected.targets[0].ranges = [{ startOffset: 35, endOffset: 70 }];
      if (mode === 'spanning-range') f.expected.targets[0].ranges = [{ startOffset: 20, endOffset: 85 }];
      if (mode === 'source-sha') f.observation.sourceTextSha256 = digest('other bytes at same URL');
      if (mode === 'source-length') f.observation.sourceTextLength++;
      if (mode === 'wrong-root') f.expected.targets[0].functionRoot = { startOffset: 0, endOffset: 100 };
      if (mode === 'wrong-name') f.expected.targets[0].functionName = 'other';
      if (mode === 'uncalibrated-targets') f.expected.targets = [];
      expect(classifyEngineCoverageTargets(f.observation, f.expected).state).toBe('unknown');
    });
  it.each(['crossing-blocks', 'crossing-functions', 'duplicate-root', 'duplicate-block', 'negative-count',
    'fractional-count', 'out-of-source', 'out-of-root', 'unordered-blocks', 'duplicate-target'] as const)(
    'refuses malformed or ambiguous range trees: %s', mode => {
      const f = fixture(), fn = f.observation.functions[0];
      if (mode === 'crossing-blocks') fn.ranges.push({ startOffset: 60, endOffset: 90, count: 0 });
      if (mode === 'crossing-functions') f.observation.functions.push({ functionName: 'crossing', isBlockCoverage: false,
        ranges: [{ startOffset: 50, endOffset: 150, count: 0 }] });
      if (mode === 'duplicate-root') f.observation.functions.push(structuredClone(fn));
      if (mode === 'duplicate-block') fn.ranges.push({ ...fn.ranges[1] });
      if (mode === 'negative-count') fn.ranges[1].count = -1;
      if (mode === 'fractional-count') fn.ranges[1].count = 0.5;
      if (mode === 'out-of-source') fn.ranges[0].endOffset = 201;
      if (mode === 'out-of-root') fn.ranges[1].endOffset = 110;
      if (mode === 'unordered-blocks') fn.ranges.push({ startOffset: 20, endOffset: 25, count: 0 });
      if (mode === 'duplicate-target') f.expected.targets.push(structuredClone(f.expected.targets[0]));
      expect(classifyEngineCoverageTargets(f.observation, f.expected).state).toBe('unknown');
    });
  it('discloses known entry while a second missing target keeps the population unknown', () => {
    const f = fixture(); f.observation.functions[0].ranges[1].count = 1;
    f.expected.targets.push({ functionName: 'missing', functionRoot: { startOffset: 120, endOffset: 140 },
      ranges: [{ startOffset: 120, endOffset: 140 }] });
    expect(classifyEngineCoverageTargets(f.observation, f.expected)).toMatchObject({ state: 'unknown', observedEntry: true });
  });
  it.each([null, {}, { functionName: 'target', ranges: [null], isBlockCoverage: true },
    { functionName: 'target', ranges: [], isBlockCoverage: true }])(
    'malformed protocol function data stays unknown without throwing: %j', malformed => {
      const f = fixture();
      f.observation.functions = [malformed] as unknown as typeof f.observation.functions;
      expect(classifyEngineCoverageTargets(f.observation, f.expected).state).toBe('unknown');
    });
});

describe('precise coverage epoch preparation', () => {
  const run = (mode: string) => {
    const root = mkdtempSync(join(tmpdir(), 'engine-precise-epoch-'));
    const capture = new URL('./executed-config-load-capture.ts', import.meta.url).href;
    const path = join(root, 'pinned.mjs');
    const source = 'function dormant() { return 7; } function entered() { return 8; } entered();';
    const enrollment = { epoch: '5a0abff0-f7d4-484a-8891-bbcebf05d205', admission: 0 };
    const script = `import { Session, open } from 'node:inspector';
      import { Session as PromiseSession } from 'node:inspector/promises';
      const savedOpen = open;
      const fault = ${JSON.stringify(/^(start|take)-(pending|failed|partial)$/.test(mode) ? mode : null)};
      if (fault) {
        const original = Session.prototype.post;
        Session.prototype.post = function(method, ...args) {
          const [phase, kind] = fault.split('-');
          if (method !== 'Profiler.' + phase + 'PreciseCoverage')
            return Reflect.apply(original, this, [method, ...args]);
          const callback = args.at(-1);
          if (kind === 'pending') return;
          callback(kind === 'failed' ? new Error('controlled protocol failure') : null,
            kind === 'partial' ? { result: [] } : undefined);
        };
      }
      const { observeEngineScriptExecution, classifyEngineCoverageTargets } = await import(${JSON.stringify(capture)});
      const source = ${JSON.stringify(source)}, path = ${JSON.stringify(path)}, url = ${JSON.stringify(pathToFileURL(path).href)};
      const runtime = new Session(); runtime.connect();
      const post = (method, params = {}) => { let done = false, error, value;
        runtime.post(method, params, (e, r) => { done = true; error = e; value = r; });
        if (!done || error) throw error ?? new Error('pending fixture request'); return value; };
      post('Runtime.enable');
      const compile = () => post('Runtime.compileScript', { expression: source, sourceURL: url, persistScript: true }).scriptId;
      let scriptId = ${mode === 'pre-arm' ? 'compile()' : 'null'};
      const observer = observeEngineScriptExecution('/unrelated', { repositorySources: false,
        pinnedSources: [{ path, sha256: ${JSON.stringify(digest(source))}, byteLength: Buffer.byteLength(source) }],
        preciseCoverage: ${JSON.stringify(enrollment)} });
      if (!scriptId) scriptId = compile();
      post('Runtime.runScript', { scriptId });
      post('Runtime.evaluate', { expression: 'globalThis.gc()' });
      const rejected = [];
      const attempt = (label, fn) => { try { fn(); rejected.push({ label, rejected: false }); }
        catch { rejected.push({ label, rejected: true }); } };
      ${mode === 'native-public' ? `const v8 = await import('node:v8');
        const nativeConsole = await import('node:console');
        for (const [name, fn] of [['v8.takeCoverage', v8.takeCoverage], ['v8.stopCoverage', v8.stopCoverage],
          ['console.profile', nativeConsole.profile], ['console.profileEnd', nativeConsole.profileEnd]])
          attempt(name, () => fn('foreign-precise-owner'));` : ''}
      ${mode === 'foreign' ? `const other = new Session(); other.connect();
        for (const method of ['Profiler.startPreciseCoverage', 'Profiler.takePreciseCoverage',
          'Profiler.stopPreciseCoverage', 'Profiler.disable']) attempt(method, () => other.post(method));
        const promiseOther = new PromiseSession(); promiseOther.connect();
        try { await promiseOther.post('Profiler.takePreciseCoverage'); rejected.push({ label: 'promise', rejected: false }); }
        catch { rejected.push({ label: 'promise', rejected: true }); }
        attempt('open', () => open(0));
        other.disconnect(); promiseOther.disconnect();` : ''}
      ${mode === 'passive' ? 'observer.snapshot(); observer.snapshot();' : ''}
      ${mode === 'precaptured-open' ? "savedOpen(0, '127.0.0.1');" : ''}
      const terminal = observer.terminalPreciseSnapshot();
      ${mode === 'post-fence' ? "attempt('Runtime.evaluate-after-fence', () => post('Runtime.evaluate', { expression: 'entered()' }));" : ''}
      const duplicate = ${mode === 'duplicate' ? 'observer.terminalPreciseSnapshot()' : 'undefined'};
      const observed = terminal?.scripts.find(row => row.scriptId === scriptId);
      const target = name => { const startOffset = source.indexOf('function ' + name);
        const endOffset = source.indexOf('}', startOffset) + 1;
        return { functionName: name, functionRoot: { startOffset, endOffset }, ranges: [{ startOffset, endOffset }] }; };
      const classify = name => observed ? classifyEngineCoverageTargets(observed, {
        sourceTextSha256: ${JSON.stringify(digest(source))}, sourceTextLength: source.length, targets: [target(name)] }) : null;
      console.log(JSON.stringify({ terminal, duplicate, rejected, dormant: classify('dormant'),
        entered: classify('entered'), status: observer.preciseStatus() }));
      observer.disconnect(); runtime.disconnect();`;
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    for (const key of Object.keys(env)) if (/^PC_/.test(key)) delete env[key];
    if (mode === 'native-auto-coverage') env.NODE_V8_COVERAGE = join(root, 'native-coverage');
    try {
      return JSON.parse(execFileSync(process.execPath, [...(mode === 'external-transport' ? ['--inspect=127.0.0.1:0'] : []),
        '--expose-gc', '--input-type=module', '--eval', script], {
        env, encoding: 'utf8', timeout: 10000,
      }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  it('retains an executed target through explicit GC and a dormant exact zero without claiming runtime admission', () => {
    const result = run('gc');
    expect(result.terminal).toMatchObject({ phase: 'taken', runtimeQualification: 'unknown',
      basis: 'one-start-one-terminal-precise-response', ownership: { enforced: true,
        internalNativeAndPrecapturedAccess: 'unmeasured' }, fence: 'terminal-entered-suffix-unverified' });
    expect(result.entered).toMatchObject({ state: 'entry', observedEntry: true });
    expect(result.dormant).toMatchObject({ state: 'zero', runtimeQualification: 'unknown' });
    expect(result.terminal.scripts[0].compiledBeforePreciseArm).toBe(false);
    expect(result.status.commands.filter((row: { method: string }) => row.method === 'Profiler.startPreciseCoverage')).toHaveLength(1);
    expect(result.status.commands.filter((row: { method: string }) => row.method === 'Profiler.takePreciseCoverage')).toHaveLength(1);
    expect(result.status.commands.every((row: { status: string }) => row.status === 'complete')).toBe(true);
  });
  it('rejects actual competing callback/promise Session mutations and opening a foreign transport', () => {
    const result = run('foreign');
    expect(result.rejected).toHaveLength(6);
    expect(result.rejected.every((row: { rejected: boolean }) => row.rejected)).toBe(true);
    expect(result.status.ownership.rejected).toHaveLength(6);
    expect(result.entered.state).toBe('entry');
    expect(result.dormant.state).toBe('zero');
    expect(result.terminal.runtimeQualification).toBe('unknown');
  });
  it('rejects public native coverage and console profiling helpers during an owned epoch', () => {
    const result = run('native-public');
    expect(result.rejected).toHaveLength(4);
    expect(result.rejected.every((row: { rejected: boolean }) => row.rejected)).toBe(true);
    expect(result.status.ownership.rejected.map((row: { method: string }) => row.method)).toEqual([
      'v8.takeCoverage', 'v8.stopCoverage', 'console.profile', 'console.profileEnd']);
    expect(result.entered.state).toBe('entry');
    expect(result.dormant.state).toBe('zero');
    expect(result.terminal.runtimeQualification).toBe('unknown');
  });
  it('refuses the native automatic coverage collector already armed before JS bootstrap', () => {
    const result = run('native-auto-coverage');
    expect(result.terminal).toBeNull();
    expect(result.status).toMatchObject({ phase: 'invalid', runtimeQualification: 'unknown' });
    expect(result.status.reasons).toContain('engine-native-automatic-coverage');
    expect(result.status.commands).toEqual([]);
  });
  it('pre-arm compilation cannot become qualified merely because a later take sees its ranges', () => {
    const result = run('pre-arm');
    expect(result.terminal.reasons).toContain('engine-target-before-precise-arm');
    expect(result.terminal.scripts[0].compiledBeforePreciseArm).toBe(true);
    expect(result.terminal.runtimeQualification).toBe('unknown');
  });
  it('refuses a duplicate take instead of resetting and accumulating another interval', () => {
    const result = run('duplicate');
    expect(result.duplicate).toBeNull();
    expect(result.status).toMatchObject({ phase: 'invalid' });
    expect(result.status.reasons).toContain('engine-precise-terminal-out-of-order');
    expect(result.status.commands.filter((row: { method: string }) => row.method === 'Profiler.takePreciseCoverage')).toHaveLength(1);
  });
  it('passive snapshots leave the single precise take and its retained counters intact', () => {
    const result = run('passive');
    expect(result.status.commands.filter((row: { method: string }) => row.method === 'Profiler.getBestEffortCoverage')).toHaveLength(2);
    expect(result.status.commands.filter((row: { method: string }) => row.method === 'Profiler.takePreciseCoverage')).toHaveLength(1);
    expect(result.entered.state).toBe('entry');
  });
  it('blocks foreign Inspector target dispatch after terminal entry without claiming an audited application suffix', () => {
    const result = run('post-fence');
    expect(result.rejected).toEqual([{ label: 'Runtime.evaluate-after-fence', rejected: true }]);
    expect(result.status.fence).toBe('terminal-entered-suffix-unverified');
    expect(result.status.runtimeQualification).toBe('unknown');
  });
  it.each(['start-pending', 'start-failed', 'take-pending', 'take-failed', 'take-partial'])(
    'never returns a terminal receipt for an incomplete protocol response (%s)', mode => {
      const result = run(mode);
      expect(result.terminal).toBeNull();
      expect(result.status).toMatchObject({ phase: 'invalid', runtimeQualification: 'unknown' });
      const method = 'Profiler.' + mode.split('-')[0] + 'PreciseCoverage';
      const commands = result.status.commands.filter((row: { method: string }) => row.method === method);
      expect(commands).toHaveLength(1);
      expect(commands[0].status).toBe(mode.endsWith('partial') ? 'complete' : mode.split('-')[1]);
      expect(result.status.reasons).toContain(mode.startsWith('start')
        ? 'engine-inspector-unavailable' : 'engine-precise-terminal-response-unavailable');
      if (mode.startsWith('start'))
        expect(result.status.commands.some((row: { method: string }) =>
          row.method === 'Profiler.takePreciseCoverage')).toBe(false);
    });
  it.each(['external-transport', 'precaptured-open'])(
    'refuses an actual Inspector endpoint before arming or terminal take (%s)', mode => {
      const result = run(mode);
      expect(result.terminal).toBeNull();
      expect(result.status).toMatchObject({ phase: 'invalid', runtimeQualification: 'unknown' });
      expect(result.status.reasons).toContain('engine-external-inspector-endpoint');
      expect(result.status.commands.some((row: { method: string }) =>
        row.method === 'Profiler.takePreciseCoverage')).toBe(false);
      if (mode === 'external-transport')
        expect(result.status.commands).toEqual([]);
    });
});

describe('engine script execution observations', () => {
  it('retains late nested ranges and complete names from an independently pinned script', () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-complete-ranges-'));
    const capture = new URL('./executed-config-load-capture.ts', import.meta.url).href;
    const path = join(root, 'pinned.mjs'), url = pathToFileURL(path).href;
    const lastName = 'late_' + 'x'.repeat(300);
    const source = Array.from({ length: 200 }, (_, index) =>
      `function observed_${index}() { return ${index}; } observed_${index}();`).join('\n') +
      `\nfunction ${lastName}() { return 7; } ${lastName}(); function untouched_suffix() { return 8; }`;
    try {
      writeFileSync(path, 'reporter-time disk bytes are not engine evidence');
      const script = `import { Session } from 'node:inspector';
        const { observeEngineScriptExecution } = await import(${JSON.stringify(capture)});
        const observer = observeEngineScriptExecution('/unrelated-source-root', {
          repositorySources: false, pinnedSources: [{ path: ${JSON.stringify(path)},
            sha256: ${JSON.stringify(digest(source))}, byteLength: ${Buffer.byteLength(source)} }] });
        const runtime = new Session(); runtime.connect();
        const post = (method, params) => { let value, error;
          runtime.post(method, params, (e, r) => { error = e; value = r; });
          if (error) throw error; return value; };
        post('Runtime.enable');
        const { scriptId } = post('Runtime.compileScript', { expression: ${JSON.stringify(source)},
          sourceURL: ${JSON.stringify(url)}, persistScript: true });
        post('Runtime.runScript', { scriptId });
        console.log(JSON.stringify(observer.snapshot())); observer.disconnect(); runtime.disconnect();`;
      const env = { ...process.env }; delete env.NODE_OPTIONS;
      for (const key of Object.keys(env)) if (/^PC_/.test(key)) delete env[key];
      const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        env, encoding: 'utf8', timeout: 10000,
      }));
      const observed = result.scripts.find((row: { path: string }) => row.path === path);
      expect(observed).toMatchObject({ sourceTextSha256: digest(source), execution: 'observed',
        coverageRangesComplete: true });
      expect(observed.coverageRanges.length).toBeGreaterThan(128);
      expect(observed.coverageRanges).toContainEqual(expect.objectContaining({ functionName: lastName, count: 1 }));
      expect(observed.coverageRanges).toContainEqual(expect.objectContaining({ functionName: 'untouched_suffix', count: 0 }));
      expect(result.reasons).not.toContain('engine-execution-range-limit');
      expect(result.populationStatus).toBe('unknown');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('admits only independently pinned external engine text and keeps compilation distinct from execution', () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-external-pin-'));
    const capture = new URL('./executed-config-load-capture.ts', import.meta.url).href;
    const path = join(root, 'private-bundle.mjs'), url = pathToFileURL(path).href;
    const source = 'globalThis.__pinnedMarker = "🌱"; function untouched() { return 7; }';
    try {
      writeFileSync(path, 'disk bytes cannot attest engine execution');
      const script = `import { Session } from 'node:inspector';
        const { observeEngineScriptExecution } = await import(${JSON.stringify(capture)});
        const source = ${JSON.stringify(source)}, path = ${JSON.stringify(path)}, url = ${JSON.stringify(url)};
        const runtime = new Session(); runtime.connect();
        const post = (method, params) => { let value, error;
          runtime.post(method, params, (e, r) => { error = e; value = r; });
          if (error) throw error; return value; };
        post('Runtime.enable');
        const results = [];
        for (const pin of [null, { path, sha256: ${JSON.stringify(digest(source))}, byteLength: Buffer.byteLength(source) },
          { path, sha256: '0'.repeat(64), byteLength: Buffer.byteLength(source) },
          { path, sha256: ${JSON.stringify(digest(source))}, byteLength: Buffer.byteLength(source) + 1 }]) {
          const observer = observeEngineScriptExecution('/unrelated-source-root', {
            repositorySources: false, pinnedSources: pin ? [pin] : [] });
          const { scriptId } = post('Runtime.compileScript', { expression: source, sourceURL: url, persistScript: true });
          const before = observer.snapshot(); post('Runtime.runScript', { scriptId });
          results.push({ scriptId, before, after: observer.snapshot() }); observer.disconnect();
        }
        runtime.disconnect(); console.log(JSON.stringify(results));`;
      const env = { ...process.env }; delete env.NODE_OPTIONS;
      for (const key of Object.keys(env)) if (/^PC_/.test(key)) delete env[key];
      const results = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        env, encoding: 'utf8', timeout: 10000,
      }));
      expect(results[0].after.scripts).toEqual([]);
      const matched = results[1];
      expect(matched.before.scripts).toContainEqual(expect.objectContaining({ scriptId: matched.scriptId,
        path, sourceTextSha256: digest(source), execution: 'unknown', coverageRanges: [] }));
      expect(matched.after.scripts).toContainEqual(expect.objectContaining({ scriptId: matched.scriptId,
        sourceTextSha256: digest(source), execution: 'observed', independentPin: {
          path, sha256: digest(source), byteLength: Buffer.byteLength(source) } }));
      const observed = matched.after.scripts.find((row: { scriptId: string }) => row.scriptId === matched.scriptId);
      expect(observed.coverageRanges).toContainEqual(expect.objectContaining({ functionName: 'untouched', count: 0 }));
      for (const mismatch of results.slice(2)) {
        expect(mismatch.after.scripts.find((row: { scriptId: string }) => row.scriptId === mismatch.scriptId))
          .toMatchObject({ sourceTextSha256: null, execution: 'unknown', coverageRanges: [] });
        expect(mismatch.after.reasons).toContain('engine-pinned-source-mismatch');
      }
      expect(matched.after.populationStatus).toBe('unknown');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('ties coverage to exact transformed script ids while compilation alone stays unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-script-observation-'));
    const capture = new URL('./executed-config-load-capture.ts', import.meta.url).href;
    const url = pathToFileURL(join(root, 'transformed.mjs')).href;
    const compiled = 'globalThis.__engineMarker = 1;';
    const transformed = '(function transformed(){ globalThis.__engineMarker = "🌱"; })';
    const contextSource = 'globalThis.__contextMarker = 3;';
    try {
      // Disk intentionally differs from both compiled forms; engine identity
      // must never be inferred from a URL or a reporter-time disk read.
      writeFileSync(join(root, 'transformed.mjs'), 'export const original = true;');
      const script = `import { Session } from 'node:inspector';
        import vm from 'node:vm';
        const { observeEngineScriptExecution } = await import(${JSON.stringify(capture)});
        const observer = observeEngineScriptExecution(${JSON.stringify(root)});
        const runtime = new Session(); runtime.connect();
        const post = (method, params = {}) => { let value, error, done = false;
          runtime.post(method, params, (e, r) => { error = e; value = r; done = true; });
          if (!done) throw new Error('pending protocol'); if (error) throw error; return value; };
        post('Runtime.enable');
        const { scriptId } = post('Runtime.compileScript', {
          expression: ${JSON.stringify(compiled)}, sourceURL: ${JSON.stringify(url)}, persistScript: true });
        const before = observer.snapshot();
        const beforeMarker = globalThis.__engineMarker ?? null;
        post('Runtime.runScript', { scriptId });
        const after = observer.snapshot();
        const fn = vm.runInThisContext(${JSON.stringify(transformed)}, { filename: ${JSON.stringify(url)} });
        const wrapper = observer.snapshot(); fn(); const called = observer.snapshot();
        const context = vm.createContext({});
        vm.runInContext(${JSON.stringify(contextSource)}, context, { filename: ${JSON.stringify(pathToFileURL(join(root, 'context.mjs')).href)} });
        console.log(JSON.stringify({ scriptId, before, beforeMarker, after, wrapper, called,
          marker: globalThis.__engineMarker, context: observer.snapshot(), contextMarker: context.__contextMarker }));
        observer.disconnect(); runtime.disconnect();`;
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      for (const key of Object.keys(env)) if (/^PC_/.test(key)) delete env[key];
      const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8', timeout: 10000, env,
      }).trim());
      expect(result.beforeMarker).toBeNull();
      expect(result.before.scripts).toContainEqual(expect.objectContaining({ scriptId: result.scriptId,
        sourceTextSha256: digest(compiled), execution: 'unknown', coverageRanges: [] }));
      expect(result.after.scripts).toContainEqual(expect.objectContaining({ scriptId: result.scriptId,
        sourceTextSha256: digest(compiled), execution: 'observed' }));
      const wrapped = result.wrapper.scripts.find((row: { sourceTextSha256: string }) => row.sourceTextSha256 === digest(transformed));
      expect(wrapped.scriptId).not.toBe(result.scriptId);
      expect(wrapped.coverageRanges).toContainEqual(expect.objectContaining({ functionName: 'transformed', count: 0 }));
      const called = result.called.scripts.find((row: { scriptId: string }) => row.scriptId === wrapped.scriptId);
      expect(called.coverageRanges).toContainEqual(expect.objectContaining({ functionName: 'transformed', count: 1 }));
      expect(result.marker).toBe('🌱');
      expect(result.contextMarker).toBe(3);
      expect(result.context.scripts).toContainEqual(expect.objectContaining({ path: 'context.mjs',
        sourceTextSha256: digest(contextSource), execution: 'observed' }));
      expect(result.context).toMatchObject({ populationStatus: 'unknown', offsetUnits: 'utf16-code-units',
        unresolved: expect.arrayContaining(['engine-script-population-unmeasured', 'node-loader-chain-not-closed']) });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('capture diagnostic evidence retention', () => {
  function fixture(mode: 'exit' | 'SIGTERM' | 'SIGINT' = 'SIGTERM') {
    const root = mkdtempSync(join(tmpdir(), 'capture-diagnostic-'));
    const outPath = join(root, 'sources.json');
    const cgroupsPath = join(root, 'cgroups.jsonl');
    const auditPath = join(root, 'committed.jsonl');
    const parentExitsPath = join(root, 'parents.jsonl');
    const summaryPath = join(root, 'summary.json');
    const entry = '/fixture/node_modules/vitest/dist/workers/forks.js';
    const context = { phase: 'preload', pid: 41, cgroupPath: '/task.scope', runGroup: 'diagnostic', deadlineEpochMs: 1234,
      isMainThread: true, vitestFork: true, argv: [entry] };
    const termination = mode === 'exit' ? { phase: 'exit', exitCode: 0, signal: null } :
      { phase: 'signal', exitCode: null, signal: mode };
    const source = { pid: 41, parentPid: 40, isMainThread: true, ...termination };
    const parent = { pid: 41, parentPid: 40, entry, code: termination.exitCode, signal: termination.signal };
    const reporter = { configLoadedSources: { observedSources: [{ path: 'vitest.config.ts', observedSha256: 'a' }] },
      mainProcessLoadedSources: { observedSources: [{ path: 'runner.mjs', observedSha256: 'b' }] } };
    mkdirSync(outPath + '.processes');
    writeFileSync(outPath, JSON.stringify(reporter));
    writeFileSync(join(outPath + '.processes', '41-0.json'), JSON.stringify(source));
    writeFileSync(cgroupsPath, [context, { ...context, ...termination }].map(row => JSON.stringify(row)).join('\n'));
    writeFileSync(parentExitsPath, JSON.stringify(parent));
    writeFileSync(auditPath, JSON.stringify({ path: 'runner.mjs' }));
    const options = { outPath, cgroupsPath, auditPath, parentExitsPath, summaryPath,
      cgroupPath: context.cgroupPath, runGroup: context.runGroup, deadlineEpochMs: context.deadlineEpochMs,
      verifySource: () => {}, child: { code: 0, signal: null,
        resultLine: 'TEST_FILE_RESULT status=passed requested=1 executed=1 matched=1 skippedTests=0' } };
    return { root, options, context, source, parent };
  }

  it.each(['exit', 'SIGTERM', 'SIGINT'] as const)('accepts independently agreeing %s receipts without closing the loader chain', mode => {
    const f = fixture(mode);
    try {
      const result = writeExecutedCaptureDiagnostic(f.options);
      expect(result.failures).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.forkProcessCoverage).toEqual([expect.objectContaining({ pid: 41, terminationVerified: true })]);
      expect(JSON.parse(readFileSync(f.options.summaryPath, 'utf8'))).toEqual(result);
      expect(result.loaderChainAcceptance).toBe('unknown');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('retains the saved receipt when an enrichment write is interrupted', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.options.outPath + '.processes', '41-0.json.pending'), '{"pid":41,');
      const result = writeExecutedCaptureDiagnostic(f.options);
      expect(result.receipts).toEqual([f.source]);
      expect(result.failures).toEqual([]);
      expect(result.forkProcessCoverage).toEqual([expect.objectContaining({ pid: 41, terminationVerified: true })]);
      expect(result.loaderChainAcceptance).toBe('unknown');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each([false, true])('persists exact engine observations without promoting diagnostic authority (source drift=%s)', drift => {
    const f = fixture();
    const engineScripts = {
      schemaVersion: 'node-engine-script-observations-v1',
      basis: 'v8-script-id-source-and-best-effort-coverage',
      scope: 'observed-repository-engine-scripts', sourceEncoding: 'utf8-of-engine-source-text',
      offsetUnits: 'utf16-code-units', populationStatus: 'unknown',
      scripts: [
        { scriptId: '201', url: 'file:///fixture/transformed.ts', path: 'transformed.ts',
          sourceTextSha256: digest('() => "🌱"'), sourceTextLength: 10, execution: 'observed',
          coverageRanges: [{ functionName: 'called', startOffset: 0, endOffset: 10, count: 1 },
            { functionName: 'uncalled', startOffset: 2, endOffset: 8, count: 0 }] },
        { scriptId: '202', url: 'file:///fixture/transformed.ts', path: 'transformed.ts',
          sourceTextSha256: null, sourceTextLength: null, execution: 'unknown', coverageRanges: [] },
      ],
      reasons: ['engine-script-source-unavailable'],
      unresolved: ['engine-script-population-unmeasured', 'node-loader-chain-not-closed'],
    };
    try {
      writeFileSync(join(f.options.outPath + '.processes', '41-0.json'),
        JSON.stringify({ ...f.source, engineScripts }));
      const result = writeExecutedCaptureDiagnostic({ ...f.options,
        verifySource: () => { if (drift) throw new Error('source drift'); },
        details: { loaderChainAcceptance: 'closed', valid: true },
      });
      const saved = JSON.parse(readFileSync(f.options.summaryPath, 'utf8'));
      expect(saved.receipts[0].engineScripts).toEqual(engineScripts);
      expect(saved).toEqual(result);
      expect(saved.valid).toBe(!drift);
      expect(saved.loaderChainAcceptance).toBe('unknown');
      expect(saved.receipts[0].engineScripts.populationStatus).toBe('unknown');
      expect(saved.failures).toEqual(drift ? [{ label: 'post-run-source-guard', error: 'Error: source drift' }] : []);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each(['missing-source', 'malformed-source', 'null-source', 'parent-signal', 'parent-pid',
    'duplicate-parent', 'missing-parent', 'containment-context', 'containment-signal', 'test-skips', 'child-signal'] as const)
    ('rejects %s while persisting the complete failed diagnostic', mode => {
      const f = fixture();
      try {
        const sourcePath = join(f.options.outPath + '.processes', '41-0.json');
        if (mode === 'missing-source') rmSync(sourcePath);
        if (mode === 'malformed-source') writeFileSync(sourcePath, '{');
        if (mode === 'null-source') writeFileSync(sourcePath, 'null');
        if (mode === 'parent-signal') writeFileSync(f.options.parentExitsPath, JSON.stringify({ ...f.parent, signal: 'SIGINT' }));
        if (mode === 'parent-pid') writeFileSync(f.options.parentExitsPath, JSON.stringify({ ...f.parent, parentPid: 39 }));
        if (mode === 'duplicate-parent') writeFileSync(f.options.parentExitsPath,
          [f.parent, f.parent].map(row => JSON.stringify(row)).join('\n'));
        if (mode === 'missing-parent') rmSync(f.options.parentExitsPath);
        if (mode === 'containment-context' || mode === 'containment-signal') writeFileSync(f.options.cgroupsPath,
          [f.context, { ...f.context, ...f.source,
            ...(mode === 'containment-context' ? { cgroupPath: '/other.scope' } : { signal: 'SIGINT' }) }]
            .map(row => JSON.stringify(row)).join('\n'));
        if (mode === 'test-skips') f.options.child.resultLine = f.options.child.resultLine.replace('skippedTests=0', 'skippedTests=1');
        const child = mode === 'child-signal' ? { ...f.options.child, code: null, signal: 'SIGTERM' } : f.options.child;
        const result = writeExecutedCaptureDiagnostic({ ...f.options, child });
        expect(result.valid).toBe(false);
        expect(result.failures.length).toBeGreaterThan(0);
        const saved = JSON.parse(readFileSync(f.options.summaryPath, 'utf8'));
        expect(saved).toEqual(result);
        expect(saved.audit).toHaveLength(1);
        expect(saved.reporter.configLoadedSources.observedSources).toHaveLength(1);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });

  it('records all unavailable artifacts, source drift and spawn failure before returning invalid', () => {
    const f = fixture();
    try {
      rmSync(f.options.outPath); rmSync(f.options.cgroupsPath); rmSync(f.options.auditPath);
      rmSync(f.options.parentExitsPath); rmSync(f.options.outPath + '.processes', { recursive: true });
      const result = writeExecutedCaptureDiagnostic({ ...f.options,
        verifySource: () => { throw new Error('source drift'); },
        child: { code: null, signal: null, resultLine: '', spawnFailure: 'ENOENT' } });
      expect(result.valid).toBe(false);
      expect(result.failures.map(row => row.label)).toEqual(expect.arrayContaining([
        'post-run-source-guard', 'child-spawn', 'cgroup-artifact', 'reporter-artifact',
        'process-directory', 'committed-loader-artifact', 'parent-exit-artifact', 'test-result',
      ]));
      expect(JSON.parse(readFileSync(f.options.summaryPath, 'utf8'))).toEqual(result);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe('original config load evidence', () => {
  it('retains unknown native observations from an older preload singleton', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-config-old-state-'));
    const capture = new URL('./executed-config-load-capture.ts', import.meta.url).href;
    const singleton = pathToFileURL(createRequire(import.meta.url).resolve('@papercusp/module-singleton')).href;
    const config = join(root, 'config.mjs');
    const source = 'export default {};\n';
    try {
      writeFileSync(config, source);
      const script = `const { pinModuleState } = await import(${JSON.stringify(singleton)});
        pinModuleState('@papercusp/test-config.original-config-loads', () => ({ capture: null })).capture = {
          sources: new Map([[${JSON.stringify(config)}, new Set([${JSON.stringify(digest(source))}])]]),
          reasons: new Set(), preloads: [] };
        const { qualifyLoadedConfigSources } = await import(${JSON.stringify(capture)});
        console.log(JSON.stringify(qualifyLoadedConfigSources([], ${JSON.stringify(root)}, [${JSON.stringify(config)}])));`;
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      for (const key of Object.keys(env)) if (/^PC_/.test(key)) delete env[key];
      const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8', timeout: 10000, env,
      }).trim());
      expect(result).toMatchObject({ status: 'unknown', importPopulation: {
        paths: ['config.mjs'], unresolved: expect.arrayContaining(['config-import-resolve-capture-unavailable']),
      } });
      expect(result.observedSources).toEqual([{ path: 'config.mjs', observedSha256: digest(source) }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([true, false])('retains native Vite config import observations (armed=%s)', armed => {
    const root = mkdtempSync(join(tmpdir(), 'native-config-population-'));
    const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
    const vite = pathToFileURL(createRequire(import.meta.url).resolve('vite')).href;
    const config = join(root, 'vite.config.mjs');
    const helper = 'export const value = 7;\n';
    try {
      writeFileSync(config, "import { value } from './helper.mjs'; export default { define: { captured: value } };\n");
      writeFileSync(join(root, 'helper.mjs'), helper);
      writeFileSync(join(root, 'unloaded.mjs'), 'export const unused = true;\n');
      const script = `const { loadConfigFromFile } = await import(${JSON.stringify(vite)});
        const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' },
          ${JSON.stringify(config)}, ${JSON.stringify(root)}, 'silent', undefined, 'native');
        const { qualifyLoadedConfigSources, qualifyLoadedMainProcessSources } =
          await import(${JSON.stringify(pathToFileURL(capture).href)});
        console.log(JSON.stringify({ dependencies: loaded.dependencies, value: loaded.config.define.captured,
          config: qualifyLoadedConfigSources(loaded.dependencies, ${JSON.stringify(root)}, [loaded.path]),
          main: qualifyLoadedMainProcessSources(loaded.dependencies, ${JSON.stringify(root)}, [loaded.path]) }));`;
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL/.test(key) ||
          /^(PC_|VITEST|PAPERCUSP_TEST_|PAPERCUSP_MUTATION_|AFFECTED_)/.test(key) || key === 'NODE_OPTIONS') delete env[key];
      const result = JSON.parse(execFileSync(process.execPath,
        ['--import', capture, '--input-type=module', '--eval', script], {
          cwd: root, encoding: 'utf8', timeout: 30000,
          env: { ...env, PC_EXECUTED_SOURCE_MAP_PRELOAD: armed ? '1' : '0',
            PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'native-config-population',
            PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'out.json') },
        }).trim());
      expect(result.dependencies).toEqual([]);
      expect(result.value).toBe(7);
      expect(result.config.status).toBe('unknown');
      expect(result.config.importPopulation).toMatchObject({
        basis: 'node-resolve-and-load-observations', status: 'unknown',
        entrypoints: ['vite.config.mjs'], paths: armed ? ['helper.mjs', 'vite.config.mjs'] : [],
        unresolved: expect.arrayContaining(['config-import-population-unmeasured', 'node-loader-chain-not-closed']),
      });
      if (armed) {
        expect(result.config.observedSources).toEqual(expect.arrayContaining([
          { path: 'helper.mjs', observedSha256: digest(helper) },
        ]));
        const mainPaths = result.main.sources.map((source: { path: string }) => source.path);
        expect(mainPaths).not.toContain('helper.mjs');
        expect(mainPaths).not.toContain('vite.config.mjs');
      } else {
        expect(result.config.observedSources).toEqual([]);
        expect(result.config.reasons).toContain('config-node-load-capture-unavailable');
      }
      expect(result.config.importPopulation.paths).not.toContain('unloaded.mjs');
      expect(result.config.loaderChain.status).toBe('unknown');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'linux').each(['native snapshot', 'slow snapshot'] as const)
    ('retains real Vitest fork termination receipts (%s)', mode => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const dir = mkdtempSync(join(tmpdir(), 'vitest-fork-termination-'));
    const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
    const containment = join(root, 'scripts/lib/managed-test-cgroup-preload.mjs');
    const committedLoader = join(root, 'scripts/lib/committed-source-loader.mjs');
    const fixture = fileURLToPath(new URL('./__fixtures__/armed-capture/', import.meta.url));
    const bin = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
    const out = join(dir, 'sources.json');
    const cgroups = join(dir, 'cgroups.jsonl');
    const exits = join(dir, 'child-exits.jsonl');
    const evaluatorInputs = join(dir, 'evaluator-inputs.jsonl');
    const sample = join(fixture, 'sample.armed-fixture.ts');
    const parentObserver = join(dir, 'parent-observer.mjs');
    const snapshotObserver = join(dir, 'snapshot-observer.mjs');
    const snapshotEvents = join(dir, 'snapshot-events.jsonl');
    const cgroupPath = readFileSync('/proc/self/cgroup', 'utf8').split('\n')
      .find(line => line.startsWith('0::'))?.slice(3);
    expect(cgroupPath).toBeTruthy();
    try {
      // Observe the actual parent-side exit event independently of child preloads.
      writeFileSync(parentObserver, `import cp from 'node:child_process';
        import vm from 'node:vm';
        import { createHash } from 'node:crypto';
        import { appendFileSync } from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const original = cp.fork;
        cp.fork = (...args) => {
          const child = original(...args);
          child.once('exit', (code, signal) => appendFileSync(${JSON.stringify(exits)},
            JSON.stringify({ pid: child.pid, parentPid: process.pid, entry: args[0], code, signal }) + '\\n'));
          return child;
        };
        // Observe the actual evaluator argument independently of inspector
        // source retrieval. Return its compiled function unchanged; execution
        // is established separately by the named fixture's coverage range.
        const originalVm = vm.runInThisContext;
        vm.runInThisContext = function (code, options, ...rest) {
          const result = originalVm.call(this, code, options, ...rest);
          if (options?.filename === ${JSON.stringify(sample)}) appendFileSync(${JSON.stringify(evaluatorInputs)},
            JSON.stringify({ pid: process.pid, filename: options.filename,
              sha256: createHash('sha256').update(code).digest('hex'), length: code.length }) + '\\n');
          return result;
        };
        syncBuiltinESMExports();\n`);
      // Only the actual Vitest fork is delayed, at the inspector snapshot seam.
      // The parent retains Vitest's real 500 ms SIGTERM -> SIGKILL escalation.
      // This distinguishes an interrupted snapshot from an unarmed preload;
      // neither observation attributes the historical TDZ or missing receipt.
      writeFileSync(snapshotObserver, `import { Session } from 'node:inspector';
        import { appendFileSync } from 'node:fs';
        const original = Session.prototype.post;
        Session.prototype.post = function (method, ...args) {
          if (method === 'Profiler.getBestEffortCoverage' &&
              process.argv[1]?.replaceAll('\\\\', '/').endsWith('/vitest/dist/workers/forks.js')) {
            appendFileSync(${JSON.stringify(snapshotEvents)}, JSON.stringify({ pid: process.pid, phase: 'started' }) + '\\n');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
            appendFileSync(${JSON.stringify(snapshotEvents)}, JSON.stringify({ pid: process.pid, phase: 'finished' }) + '\\n');
          }
          return original.call(this, method, ...args);
        };\n`);
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL/.test(key) ||
          /^(PC_|VITEST|PAPERCUSP_TEST_|PAPERCUSP_MUTATION_|AFFECTED_)/.test(key) || key === 'NODE_OPTIONS') delete env[key];
      execFileSync(process.execPath, ['--import', parentObserver, bin, 'run', '--root', fixture,
        '--config', join(fixture, 'vitest.config.ts'), '--configLoader', 'native',
        '--pool=forks', '--maxWorkers=1', '--no-file-parallelism'], {
        cwd: root, encoding: 'utf8', timeout: 90000,
        env: { ...env, NODE_OPTIONS: `--import=${pathToFileURL(committedLoader).href}` +
          ` --import=${pathToFileURL(capture).href} --import=${pathToFileURL(containment).href}` +
          ` --import=${pathToFileURL(parentObserver).href}` +
          (mode === 'slow snapshot' ? ` --import=${pathToFileURL(snapshotObserver).href}` : ''),
          PC_EXECUTED_SOURCE_MAP_PRELOAD: '1', PC_EXECUTED_SOURCE_MAP_WORKSPACE: '@papercusp/armed-capture-fixture',
          PC_EXECUTED_SOURCE_MAP_ROOT: root, PC_EXECUTED_SOURCE_MAP_OUT: out, PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1',
          HARNESS_ADMIN_DATABASE_URL: 'postgresql://127.0.0.1:1/termination-fixture',
          PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://127.0.0.1:1/termination-fixture',
          PAPERCUSP_TEST_CGROUP_CONTEXT: JSON.stringify({ runGroup: 'fork-termination-regression',
            deadlineEpochMs: Date.now() + 90000, cgroupPath, evidencePath: cgroups }),
        },
      });
      const membership = readFileSync(cgroups, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const forks = membership.filter(row => row.vitestFork && row.phase === 'preload');
      const parentExits = readFileSync(exits, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(forks).toHaveLength(1);
      const pid = forks[0].pid;
      // Vitest 4 tears a fork down gracefully (exit code 0, no signal); only the
      // interrupted slow snapshot is escalated to SIGKILL by the parent.
      const expectedExit = mode === 'slow snapshot' ? { code: null, signal: 'SIGKILL' } : { code: 0, signal: null };
      expect(parentExits, `fork ${pid} exit not observed as expected; parent=${JSON.stringify(parentExits)}`)
        .toContainEqual(expect.objectContaining({ pid, ...expectedExit }));
      const receipt = join(`${out}.processes`, `${pid}-0.json`);
      if (mode === 'slow snapshot') {
        expect(readFileSync(snapshotEvents, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
          .toEqual([{ pid, phase: 'started' }]);
        expect(existsSync(receipt), `interrupted snapshot lost termination receipt; parent=${JSON.stringify(parentExits)}`).toBe(true);
        expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ pid, isMainThread: true,
          // Vitest 4 tears the fork down gracefully before the parent's SIGKILL.
          phase: 'exit', exitCode: 0, signal: null, status: 'unknown', engineScripts: null,
          reasons: expect.arrayContaining(['process-source-snapshot-incomplete', 'process-engine-snapshot-incomplete']),
        });
        const result = writeExecutedCaptureDiagnostic({ outPath: out, cgroupsPath: cgroups,
          auditPath: join(dir, 'absent-loader-audit.jsonl'), parentExitsPath: exits,
          summaryPath: join(dir, 'summary.json'), cgroupPath: cgroupPath!, runGroup: forks[0].runGroup,
          deadlineEpochMs: forks[0].deadlineEpochMs, verifySource: () => {},
          child: { code: 0, signal: null, resultLine: '' },
        });
        // A SIGTERM observation must never attest the parent's SIGKILL outcome.
        expect(result.forkProcessCoverage).toEqual([expect.objectContaining({ pid, terminationVerified: false })]);
        expect(result.valid).toBe(false);
        expect(result.loaderChainAcceptance).toBe('unknown');
        return;
      }
      expect(existsSync(receipt), `missing worker receipt for ${pid}; parent=${JSON.stringify(parentExits)}`).toBe(true);
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ pid, isMainThread: true,
        phase: 'exit', exitCode: 0, signal: null, observedSources: expect.any(Array),
        engineScripts: { populationStatus: 'unknown', scripts: expect.arrayContaining([
          expect.objectContaining({ execution: 'observed', sourceTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        ]) },
      });
      const inputs = readFileSync(evaluatorInputs, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ pid, filename: sample });
      expect(inputs[0].sha256).not.toBe(digest(readFileSync(sample, 'utf8')));
      const engine = JSON.parse(readFileSync(receipt, 'utf8')).engineScripts;
      const evaluated = engine.scripts.filter((row: { sourceTextSha256: string }) =>
        row.sourceTextSha256 === inputs[0].sha256);
      expect(evaluated).toHaveLength(1);
      expect(evaluated[0]).toMatchObject({
        path: 'libs/test-config/src/__fixtures__/armed-capture/sample.armed-fixture.ts',
        sourceTextLength: inputs[0].length, execution: 'observed',
        coverageRanges: expect.arrayContaining([
          expect.objectContaining({ functionName: 'readFixtureInput', count: 1 }),
        ]),
      });
      expect(membership).toContainEqual(expect.objectContaining({ pid, vitestFork: true,
        phase: 'exit', exitCode: 0, signal: null, cgroupPath,
      }));
      // The diagnostic persists the actual transformed-script association even
      // when a stopped worker leaves the diagnostic's acceptance checks invalid.
      const summaryPath = join(dir, 'summary.json');
      const result = writeExecutedCaptureDiagnostic({ outPath: out, cgroupsPath: cgroups,
        auditPath: join(dir, 'absent-loader-audit.jsonl'), parentExitsPath: exits, summaryPath,
        cgroupPath: cgroupPath!, runGroup: forks[0].runGroup, deadlineEpochMs: forks[0].deadlineEpochMs,
        verifySource: () => {}, child: { code: 0, signal: null, resultLine: '' },
      });
      const saved = JSON.parse(readFileSync(summaryPath, 'utf8'));
      expect(saved).toEqual(result);
      expect(saved.valid).toBe(false);
      expect(saved.loaderChainAcceptance).toBe('unknown');
      expect(saved.receipts.find((row: { pid: number }) => row.pid === pid).engineScripts).toEqual(engine);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);

  it.each((['SIGTERM', 'SIGINT', 'application-handler', 'observer-failure', 'SIGKILL', 'exit'] as const)
    .flatMap(mode => [false, true].map(keepAlive => ({ mode, keepAlive }))))
    ('preserves process termination semantics and duplicate observer delivery ($mode, keepAlive=$keepAlive)', ({ mode, keepAlive }) => {
      const dir = mkdtempSync(join(tmpdir(), 'termination-semantics-'));
      const events = join(dir, 'events.jsonl');
      const helper = new URL('./process-termination-observer.mjs', import.meta.url).href;
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      for (const key of Object.keys(env)) if (/^PC_/.test(key)) delete env[key];
      try {
        writeFileSync(events, '');
        const script = `import { appendFileSync } from 'node:fs';
          const first = await import(${JSON.stringify(helper)});
          const duplicate = await import(${JSON.stringify(helper + '?duplicate')});
          const record = tag => event => appendFileSync(${JSON.stringify(events)},
            JSON.stringify({ tag, ...event }) + '\\n');
          first.observeProcessTermination(record('first'));
          duplicate.observeProcessTermination(record('duplicate'));
          ${mode === 'observer-failure' ? "first.observeProcessTermination(() => { throw new Error('fixture observer failure'); });" : ''}
          ${mode === 'application-handler' ? "process.once('SIGTERM', () => process.exit(23));" : ''}
          ${mode === 'exit' ? 'process.exitCode = 7;' : `process.kill(process.pid, ${JSON.stringify(mode === 'SIGINT' || mode === 'SIGKILL' ? mode : 'SIGTERM')});
            ${keepAlive ? 'setInterval(() => {}, 1000);' : ''}`}`;
        const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
          env, encoding: 'utf8', timeout: 10000,
        });
        const rows = readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        expect(run.error).toBeUndefined();
        if (mode === 'application-handler' || mode === 'exit') {
          expect(run.signal).toBeNull();
          expect(run.status).toBe(mode === 'exit' ? 7 : 23);
          expect(rows.filter(row => row.phase === 'exit')).toEqual([
            { tag: 'first', phase: 'exit', exitCode: run.status, signal: null },
            { tag: 'duplicate', phase: 'exit', exitCode: run.status, signal: null },
          ]);
        } else {
          expect(run.status).toBeNull();
          expect(run.signal).toBe(mode === 'SIGKILL' || mode === 'SIGINT' ? mode : 'SIGTERM');
          expect(rows).toEqual(mode === 'SIGKILL' ? [] : [
            { tag: 'first', phase: 'signal', exitCode: null, signal: run.signal },
            { tag: 'duplicate', phase: 'signal', exitCode: null, signal: run.signal },
          ]);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

  it.each(['SIGKILL', 9, 'observer-failure'] as const)(
    'observes opt-in self-kill requests without changing the native outcome (%s)', mode => {
      const dir = mkdtempSync(join(tmpdir(), 'termination-self-kill-'));
      const path = join(dir, 'requests.jsonl');
      const helper = new URL('./process-termination-observer.mjs', import.meta.url).href;
      const signal = mode === 'observer-failure' ? 'SIGKILL' : mode;
      try {
        const source = `import { appendFileSync } from 'node:fs';
          const first = await import(${JSON.stringify(helper)});
          const duplicate = await import(${JSON.stringify(helper + '?self-kill-duplicate')});
          const save = tag => request => appendFileSync(${JSON.stringify(path)}, JSON.stringify({tag, ...request}) + '\\n');
          first.observeProcessTermination(save('ordinary'));
          first.observeProcessTermination(() => {}, { beforeSelfKill: save('first') });
          duplicate.observeProcessTermination(() => {}, { beforeSelfKill: save('duplicate') });
          ${mode === 'observer-failure' ? "first.observeProcessTermination(() => {}, { beforeSelfKill() { throw new Error('fixture failure'); } });" : ''}
          process.stdout.write('before kill');
          process.kill(process.pid, ${JSON.stringify(signal)});`;
        const observed = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
          env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000,
        });
        const native = spawnSync(process.execPath, ['--input-type=module', '-e',
          `process.stdout.write('before kill'); process.kill(process.pid, ${JSON.stringify(signal)});`], {
          env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000,
        });
        expect(observed.error).toBeUndefined();
        expect(observed.status).toBe(native.status);
        expect(observed.signal).toBe(native.signal);
        expect(observed.signal).toBe('SIGKILL');
        expect(observed.stdout).toBe(native.stdout);
        expect(observed.stderr).toBe(native.stderr);
        const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(rows).toEqual(['first', 'duplicate'].map(tag => ({ tag, phase: 'self-kill-request',
          exitCode: null, signal: 'SIGKILL', pid: rows[0].pid })));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

  it.each(['first', 'last'] as const)('self-kill boundary runs after every ordinary observer (%s)', order => {
    const dir = mkdtempSync(join(tmpdir(), 'termination-self-kill-boundary-'));
    const path = join(dir, 'requests.jsonl');
    const helper = new URL('./process-termination-observer.mjs', import.meta.url).href;
    try {
      const source = `import { appendFileSync } from 'node:fs';
        const first = await import(${JSON.stringify(helper)});
        const duplicate = await import(${JSON.stringify(helper + '?boundary-duplicate')});
        const save = tag => () => appendFileSync(${JSON.stringify(path)}, JSON.stringify(tag) + '\\n');
        const boundary = () => first.observeProcessTermination(() => {}, {
          beforeSelfKill: save('terminal'), selfKillBoundary: true,
        });
        ${order === 'first' ? 'boundary();' : ''}
        first.observeProcessTermination(() => {}, { beforeSelfKill: save('ordinary-first') });
        duplicate.observeProcessTermination(() => {}, { beforeSelfKill: save('ordinary-duplicate') });
        ${order === 'last' ? 'boundary();' : ''}
        process.kill(process.pid, 'SIGKILL');`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal, result.stderr).toBe('SIGKILL');
      expect(readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
        .toEqual(['ordinary-first', 'ordinary-duplicate', 'terminal']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('self-kill boundary delegates without invoking a mutable native function call property', () => {
    const dir = mkdtempSync(join(tmpdir(), 'termination-self-kill-call-'));
    const path = join(dir, 'requests.jsonl');
    const helper = new URL('./process-termination-observer.mjs', import.meta.url).href;
    try {
      const source = `import { appendFileSync } from 'node:fs';
        const nativeKill = process.kill;
        const { observeProcessTermination } = await import(${JSON.stringify(helper)});
        const record = tag => appendFileSync(${JSON.stringify(path)}, JSON.stringify(tag) + '\\n');
        observeProcessTermination(() => {}, { beforeSelfKill() { record('terminal'); }, selfKillBoundary: true });
        nativeKill.call = function(...args) {
          record('after-terminal-call-property'); return Reflect.apply(nativeKill, args[0], args.slice(1));
        };
        process.kill(process.pid, 'SIGKILL');`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal, result.stderr).toBe('SIGKILL');
      expect(readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual(['terminal']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves native kill arguments, receiver, return value and thrown error', () => {
    const helper = new URL('./process-termination-observer.mjs', import.meta.url).href;
    const source = `import assert from 'node:assert/strict';
      const original = process.kill, receiver = {}, value = {}, failure = new Error('native failure');
      const calls = [], requests = [];
      process.kill = function(...args) {
        calls.push({ receiver: this, args });
        if (args[1] === 'invalid-signal') throw failure;
        return value;
      };
      const { observeProcessTermination } = await import(${JSON.stringify(helper)});
      observeProcessTermination(() => {}, { beforeSelfKill(request) { requests.push(request); throw new Error('diagnostic failure'); } });
      assert.equal(process.kill.call(receiver, process.pid, 9, 'extra'), value);
      assert.equal(process.kill.call(receiver, process.pid + 1, 'SIGKILL'), value);
      assert.equal(process.kill.call(receiver, process.pid, 0), value);
      assert.throws(() => process.kill.call(receiver, process.pid, 'invalid-signal'), error => error === failure);
      assert.deepEqual(calls.map(call => call.args), [[process.pid, 9, 'extra'],
        [process.pid + 1, 'SIGKILL'], [process.pid, 0], [process.pid, 'invalid-signal']]);
      assert.ok(calls.every(call => call.receiver === receiver));
      assert.deepEqual(requests, [{ phase: 'self-kill-request', exitCode: null, signal: 'SIGKILL', pid: process.pid }]);
      process.kill = original;
      process.stdout.write('native contract retained');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('native contract retained');
    expect(result.stderr).toBe('');
  });

  it('reports duplicate capture modules while sharing one hook and the loaded inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'duplicate-original-load-'));
    const capture = new URL('./executed-config-load-capture.ts', import.meta.url);
    const singleton = new URL('../../generic/module-singleton/src/index.ts', import.meta.url);
    const helper = join(root, 'helper.mjs');
    const source = 'export const value = 3;\n';
    try {
      writeFileSync(helper, source);
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL/.test(key) ||
          key === 'NODE_OPTIONS') delete env[key];
      const script = `const before = process.listenerCount('exit');
        const first = await import(${JSON.stringify(capture.href)});
        await import(${JSON.stringify(`${capture.href}?duplicate`)});
        await import(${JSON.stringify(pathToFileURL(helper).href)});
        const { moduleEvaluationCount, listModuleDuplications } = await import(${JSON.stringify(singleton.href)});
        const key = '@papercusp/test-config.original-config-loads';
        console.log(JSON.stringify({ evaluations: moduleEvaluationCount(key),
          duplicate: listModuleDuplications().find(entry => entry.key === key),
          exitListenersAdded: process.listenerCount('exit') - before,
          evidence: first.qualifyLoadedConfigSources([${JSON.stringify(helper)}], ${JSON.stringify(root)}) }));`;
      const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'duplicate-load-test',
          PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'out.json'), PC_EXECUTED_SOURCE_MAP_ROOT: root,
          PC_EXECUTED_SOURCE_MAP_PRELOAD: '1' },
      });
      expect(JSON.parse(out.trim())).toMatchObject({ evaluations: 2,
        duplicate: { key: '@papercusp/test-config.original-config-loads', evaluations: 2 },
        exitListenersAdded: 1,
        evidence: { status: 'stable', sources: [{ path: 'helper.mjs', sha256: digest(source),
          currentSha256: digest(source) }] },
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps real worker-thread observations separate from the parent with the same PID', () => {
    const root = mkdtempSync(join(tmpdir(), 'thread-original-load-'));
    const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
    const outPath = join(root, 'out.json');
    const source = 'export const value = 1;\n';
    try {
      writeFileSync(join(root, 'helper.mjs'), source);
      writeFileSync(join(root, 'child.mjs'), "import { value } from './helper.mjs'; console.log(value);\n");
      writeFileSync(join(root, 'parent.mjs'), "import { Worker } from 'node:worker_threads'; new Worker(new URL('./child.mjs', import.meta.url));\n");
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL/.test(key) ||
          key === 'NODE_OPTIONS') delete env[key];
      const output = execFileSync(process.execPath, ['parent.mjs'], { cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'thread-load-test', PC_EXECUTED_SOURCE_MAP_OUT: outPath,
          PC_EXECUTED_SOURCE_MAP_ROOT: root, PC_EXECUTED_SOURCE_MAP_PRELOAD: '1',
          NODE_OPTIONS: `--import=${pathToFileURL(capture).href}` },
      });
      expect(output.trim()).toBe('1');
      const receipts = readdirSync(`${outPath}.processes`).map(file =>
        JSON.parse(readFileSync(join(`${outPath}.processes`, file), 'utf8')));
      expect(receipts).toHaveLength(2);
      expect(new Set(receipts.map(receipt => receipt.pid)).size).toBe(1);
      const thread = receipts.find(receipt => receipt.isMainThread === false);
      expect(thread).toMatchObject({ entrypoint: null, status: 'unknown', threadId: expect.any(Number),
        reasons: expect.arrayContaining(['process-worker-thread-entrypoint-unmeasured']),
        sources: expect.arrayContaining([{ path: 'helper.mjs', sha256: digest(source), currentSha256: digest(source) }]),
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['stable', 'self-restoring', 'commonjs', 'overriding-loader', 'mutated-argv'] as const)
    ('retains original inputs from a real parent and child command at exit (%s)', kind => {
      const root = mkdtempSync(join(tmpdir(), 'command-original-load-'));
      const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
      const outPath = join(root, 'out.json');
      const extension = kind === 'commonjs' ? 'cjs' : 'mjs';
      const stable = kind === 'commonjs' ? 'exports.value = 1;\n' : 'export const value = 1;\n';
      const helper = join(root, `helper.${extension}`);
      const loaded = kind === 'self-restoring' ? `import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(helper)}, ${JSON.stringify(stable)});
        export const value = 2;\n` : stable;
      try {
        writeFileSync(helper, loaded);
        writeFileSync(join(root, 'child.mjs'), `import { value } from './helper.${extension}';
          ${kind === 'mutated-argv' ? "process.argv[1] = 'helper.mjs';" : ''}
          console.log(value);\n`);
        writeFileSync(join(root, 'parent.mjs'), `import { spawnSync } from 'node:child_process';
          const child = spawnSync(process.execPath, ['child.mjs'], { stdio: 'inherit', env: process.env });
          process.exit(child.status ?? 1);\n`);
        const loader = join(root, 'loader.mjs');
        if (kind === 'overriding-loader') writeFileSync(loader, `import { registerHooks } from 'node:module';
          registerHooks({ load(url, context, nextLoad) {
            const result = nextLoad(url, context);
            return url.endsWith('/helper.mjs') ? { ...result, source: 'export const value = 2;\\n' } : result;
          } });\n`);
        const env = { ...process.env };
        for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL/.test(key) ||
            key === 'NODE_OPTIONS') delete env[key];
        const output = execFileSync(process.execPath, ['parent.mjs'], { cwd: root, encoding: 'utf8', timeout: 30000,
          env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'command-load-test',
            PC_EXECUTED_SOURCE_MAP_OUT: outPath, PC_EXECUTED_SOURCE_MAP_ROOT: root,
            PC_EXECUTED_SOURCE_MAP_PRELOAD: '1', NODE_OPTIONS: `--import=${pathToFileURL(capture).href}` +
              (kind === 'overriding-loader' ? ` --import=${pathToFileURL(loader).href}` : '') },
        });
        expect(output.trim()).toBe(kind === 'self-restoring' || kind === 'overriding-loader' ? '2' : '1');
        expect(existsSync(`${outPath}.processes`)).toBe(true);
        const receipts = readdirSync(`${outPath}.processes`).map(file =>
          JSON.parse(readFileSync(join(`${outPath}.processes`, file), 'utf8')));
        expect(receipts.map(receipt => receipt.entrypoint).sort()).toEqual(['child.mjs', 'parent.mjs']);
        const child = receipts.find(receipt => receipt.entrypoint === 'child.mjs');
        expect(child).toMatchObject({ schemaVersion: 'node-loaded-process-sources-v1',
          scope: 'repository-node-process-sources', basis: 'node-load-hook',
          sources: expect.arrayContaining([{ path: `helper.${extension}`,
            sha256: kind === 'commonjs' || kind === 'overriding-loader' ? null : digest(loaded), currentSha256: digest(stable) }]),
          unresolved: expect.arrayContaining(['node-process-descendant-population-unmeasured', 'node-preload-self-unmeasured']),
        });
        expect(child.status).toBe(kind === 'stable' || kind === 'mutated-argv' ? 'stable' : kind === 'self-restoring' ? 'changed' : 'unknown');
        expect(child.observedSources).toEqual(expect.arrayContaining([{ path: `helper.${extension}`,
          observedSha256: kind === 'commonjs' ? null : digest(loaded) }]));
        if (kind === 'overriding-loader') expect(child.loaderChain).toMatchObject({
          scope: 'declared-node-preloads', status: 'unknown',
          preloads: expect.arrayContaining([expect.objectContaining({
            kind: 'import', path: loader, capture: false,
            observedSha256: digest(readFileSync(loader, 'utf8')),
          })]),
        });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

  it('keeps a missing preload unknown instead of reading the original from disk', () => {
    expect(qualifyLoadedConfigSources(['/repo/config.mjs'], '/repo')).toMatchObject({
      status: 'unknown', sources: [{ path: 'config.mjs', sha256: null, currentSha256: null }],
      reasons: expect.arrayContaining(['config-node-load-capture-unavailable', 'config-original-load-unavailable:config.mjs']),
    });
    expect(qualifyLoadedMainProcessSources(['/repo/config.mjs'], '/repo')).toMatchObject({
      status: 'unknown', sources: [], reasons: expect.arrayContaining(['main-process-node-load-capture-unavailable']),
    });
  });

  it.each(['before', 'after'] as const)
    ('retains observed preload bytes without closing a harmless loader chain (%s capture)', order => {
      const root = mkdtempSync(join(tmpdir(), 'preload-original-load-'));
      const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
      const preload = join(root, 'preload.mjs');
      const helper = join(root, 'helper.mjs');
      const preloadSource = 'export const preload = true;\n';
      const helperSource = 'export const value = 1;\n';
      try {
        writeFileSync(preload, preloadSource);
        writeFileSync(helper, helperSource);
        const script = `await import(${JSON.stringify(pathToFileURL(helper).href)});
          const { qualifyLoadedConfigSources } = await import(${JSON.stringify(pathToFileURL(capture).href)});
          console.log(JSON.stringify(qualifyLoadedConfigSources([${JSON.stringify(helper)}], ${JSON.stringify(root)})));`;
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        const imports = order === 'before' ? [capture, preload] : [preload, capture];
        const out = execFileSync(process.execPath, [...imports.flatMap(path => ['--import', path]),
          '--input-type=module', '--eval', script], { cwd: root, encoding: 'utf8', timeout: 30000,
          env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'preload-load-test',
            PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'out.json'), PC_EXECUTED_SOURCE_MAP_PRELOAD: '1' },
        });
        expect(JSON.parse(out.trim())).toMatchObject({ status: 'unknown',
          reasons: expect.arrayContaining(['node-loader-chain-unmeasured']),
          sources: [{ path: 'helper.mjs', sha256: null, currentSha256: digest(helperSource) }],
          observedSources: [{ path: 'helper.mjs', observedSha256: digest(helperSource) }],
          loaderChain: { status: 'unknown', scope: 'declared-node-preloads',
            preloads: expect.arrayContaining([
              { kind: 'import', path: capture, capture: true, observedSha256: null },
              { kind: 'import', path: preload, capture: false,
                observedSha256: order === 'before' ? digest(preloadSource) : null },
            ]), unresolved: expect.arrayContaining(['node-loader-chain-not-closed', 'node-preload-self-unmeasured']) },
        });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

  it.each(['before', 'after'] as const)
    ('keeps an overriding preload unknown even when its observed boundary matches disk (%s capture)', order => {
      const root = mkdtempSync(join(tmpdir(), 'overriding-original-load-'));
      const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
      const loader = join(root, 'loader.mjs');
      const helper = join(root, 'helper.mjs');
      const original = 'export const value = 1;\n';
      const replaced = 'export const value = 2;\n';
      try {
        writeFileSync(helper, original);
        writeFileSync(loader, `import { registerHooks } from 'node:module';
          registerHooks({ load(url, context, nextLoad) {
            const result = nextLoad(url, context);
            return url.endsWith('/helper.mjs') ? { ...result, source: ${JSON.stringify(replaced)} } : result;
          } });\n`);
        const script = `const { value } = await import(${JSON.stringify(pathToFileURL(helper).href)});
          const { qualifyLoadedConfigSources } = await import(${JSON.stringify(pathToFileURL(capture).href)});
          console.log(JSON.stringify({ value, evidence:
            qualifyLoadedConfigSources([${JSON.stringify(helper)}], ${JSON.stringify(root)}) }));`;
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        const imports = order === 'before' ? [capture, loader] : [loader, capture];
        const out = execFileSync(process.execPath, [...imports.flatMap(path => ['--import', path]),
          '--input-type=module', '--eval', script], { cwd: root, encoding: 'utf8', timeout: 30000,
          env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'overriding-load-test',
            PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'out.json'), PC_EXECUTED_SOURCE_MAP_PRELOAD: '1' },
        });
        expect(JSON.parse(out.trim())).toMatchObject({ value: 2, evidence: { status: 'unknown',
          reasons: expect.arrayContaining(['node-loader-chain-unmeasured']),
          sources: [{ path: 'helper.mjs', sha256: null, currentSha256: digest(original) }],
          observedSources: [{ path: 'helper.mjs', observedSha256: digest(order === 'before' ? original : replaced) }],
          loaderChain: { status: 'unknown' },
        } });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

  it.each((['stable', 'self-restoring', 'commonjs', 'outside', 'reloaded'] as const)
    .flatMap(kind => [false, true].map(ambientPreload => ({ kind, ambientPreload }))))
    ('retains actual native main-process inputs separately from config inputs ($kind, ambientPreload=$ambientPreload)', ({ kind, ambientPreload }) => {
      const base = mkdtempSync(join(tmpdir(), 'main-original-load-'));
      const root = join(base, 'repo');
      mkdirSync(root);
      const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
      const config = join(root, 'config.mjs');
      const helper = join(kind === 'outside' ? base : root, kind === 'commonjs' ? 'helper.cjs' : 'helper.mjs');
      const stable = kind === 'commonjs' ? 'exports.value = 1;\n' : 'export const value = 1;\n';
      const loaded = kind === 'self-restoring' ? `import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(helper)}, ${JSON.stringify(stable)});
        export const value = 2;\n` : stable;
      try {
        const preload = join(base, 'ambient-preload.mjs');
        writeFileSync(preload, 'export const ambient = true;\n');
        const env = { ...process.env, ...(ambientPreload ? { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } : {}) };
        // This control measures the plain native loader. Calibration and
        // overriding-preload cases below exercise the instrumented alternatives.
        delete env.NODE_OPTIONS;
        writeFileSync(config, 'export default {};\n');
        writeFileSync(helper, loaded);
        const script = `import { writeFileSync } from 'node:fs';
          await import(${JSON.stringify(pathToFileURL(config).href)});
          await import(${JSON.stringify(pathToFileURL(helper).href)});
          ${kind === 'reloaded' ? `writeFileSync(${JSON.stringify(helper)}, 'export const value = 3;');
            await import(${JSON.stringify(pathToFileURL(helper).href + '?second')});` : ''}
          const { qualifyLoadedMainProcessSources } = await import(${JSON.stringify(pathToFileURL(capture).href)});
          console.log(JSON.stringify(qualifyLoadedMainProcessSources([${JSON.stringify(config)}], ${JSON.stringify(root)})));`;
        const out = execFileSync(process.execPath, ['--import', capture, '--input-type=module', '--eval', script], {
          encoding: 'utf8', timeout: 30000, cwd: root,
          env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'main-load-test', PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'out.json'),
            PC_EXECUTED_SOURCE_MAP_PRELOAD: '1' },
        });
        const evidence = JSON.parse(out.trim());
        expect(evidence).toMatchObject({ basis: 'node-load-hook', scope: 'repository-node-main-process-sources' });
        expect(evidence.sources.map((source: { path: string }) => source.path)).not.toContain('config.mjs');
        if (kind === 'stable') expect(evidence).toMatchObject({ status: 'stable', reasons: [],
          sources: [{ path: 'helper.mjs', sha256: digest(loaded), currentSha256: digest(stable) }] });
        else if (kind === 'self-restoring') expect(evidence).toMatchObject({ status: 'changed',
          sources: [{ path: 'helper.mjs', sha256: digest(loaded), currentSha256: digest(stable) }] });
        else {
          expect(evidence.status).toBe('unknown');
          if (kind === 'outside') expect(evidence.sources).toEqual([]);
          else expect(evidence.sources[0].sha256).toBeNull();
        }
      } finally { rmSync(base, { recursive: true, force: true }); }
    });

  it('retains source and containment receipts with the actual calibration preloads', () => {
    const root = mkdtempSync(join(tmpdir(), 'calibration-original-load-'));
    const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
    const committed = fileURLToPath(new URL('../../../scripts/lib/committed-source-loader.mjs', import.meta.url));
    const containment = fileURLToPath(new URL('../../../scripts/lib/managed-test-cgroup-preload.mjs', import.meta.url));
    const outPath = join(root, 'out.json');
    const cgroups = join(root, 'cgroups.jsonl');
    const entry = join(root, 'entry.mjs');
    const entrySource = 'export const value = 1;\n';
    try {
      writeFileSync(entry, entrySource);
      const cgroupPath = /^0::(.+)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
      expect(cgroupPath).toBeTruthy();
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      const runGroup = 'capture-calibration-test';
      const deadlineEpochMs = Date.now() + 30000;
      execFileSync(process.execPath, ['--import', committed, entry], { cwd: root,
        encoding: 'utf8', timeout: 30000,
        env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'calibration-load-test',
          PC_EXECUTED_SOURCE_MAP_ROOT: root, PC_EXECUTED_SOURCE_MAP_OUT: outPath,
          PC_EXECUTED_SOURCE_MAP_PRELOAD: '1',
          NODE_OPTIONS: `--import=${pathToFileURL(capture).href} --import=${pathToFileURL(containment).href}`,
          PAPERCUSP_COMMITTED_SOURCE_AUDIT: join(root, 'committed.jsonl'),
          PAPERCUSP_TEST_CGROUP_CONTEXT: JSON.stringify({ runGroup, deadlineEpochMs, cgroupPath, evidencePath: cgroups }),
        },
      });
      const receipts = readdirSync(`${outPath}.processes`).map(file =>
        JSON.parse(readFileSync(join(`${outPath}.processes`, file), 'utf8')));
      const receipt = receipts.find(receipt => receipt.entrypoint === 'entry.mjs' && receipt.isMainThread);
      expect(receipt).toMatchObject({ status: 'unknown', exitCode: 0,
        sources: expect.arrayContaining([{ path: 'entry.mjs', sha256: null, currentSha256: digest(entrySource) }]),
        observedSources: expect.arrayContaining([{ path: 'entry.mjs', observedSha256: digest(entrySource) }]),
        loaderChain: { status: 'unknown', preloads: expect.arrayContaining([
          expect.objectContaining({ path: committed, capture: false, observedSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
          expect.objectContaining({ path: containment, capture: false, observedSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        ]) },
        unresolved: expect.arrayContaining(['node-process-descendant-population-unmeasured', 'node-loader-chain-not-closed']),
      });
      const membership = readFileSync(cgroups, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const ownMembership = membership.filter(row => row.pid === receipt.pid && row.isMainThread);
      expect(ownMembership.map(row => row.phase)).toEqual(['preload', 'exit']);
      for (const row of ownMembership) expect(row).toMatchObject({ runGroup, deadlineEpochMs, cgroupPath });
      const committedLoads = readFileSync(join(root, 'committed.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(committedLoads).toEqual(expect.arrayContaining([expect.objectContaining({
        file: entry, returnedSha256: digest(entrySource), boundary: 'node-esm-load-return',
      })]));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not break test:file TypeScript loading when capture is supplied through NODE_OPTIONS', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const root = mkdtempSync(join(tmpdir(), 'committed-source-capture-order-'));
    const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
    const committed = resolve(repoRoot, 'scripts/lib/committed-source-loader.mjs');
    const source = resolve(repoRoot, 'libs/test-config/src/tmpdir-guard.ts');
    const entry = join(root, 'entry.mjs');
    const outPath = join(root, 'sources.json');
    try {
      const testFileScript = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts['test:file'];
      expect(testFileScript).toContain(
        'NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}"',
      );
      writeFileSync(entry, `import { tmpdirNeedsOverride } from ${JSON.stringify(pathToFileURL(source).href)};
        if (typeof tmpdirNeedsOverride !== 'function') throw new Error('TypeScript module was not loaded');
        console.log('committed-source TypeScript load succeeded');\n`);
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL/.test(key) ||
          /^(PC_|VITEST|PAPERCUSP_TEST_|PAPERCUSP_MUTATION_|AFFECTED_)/.test(key) || key === 'NODE_OPTIONS') delete env[key];
      const launch = (withCapture: boolean) => spawnSync(process.execPath, ['--import', committed, entry], {
        cwd: repoRoot, encoding: 'utf8', timeout: 30000,
        env: { ...env,
          NODE_OPTIONS: `--import=${committed} --import=tsx${withCapture ? ` --import=${pathToFileURL(capture).href}` : ''}`,
          ...(withCapture ? { PC_EXECUTED_SOURCE_MAP_PRELOAD: '1',
            PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'capture-order-regression',
            PC_EXECUTED_SOURCE_MAP_ROOT: repoRoot, PC_EXECUTED_SOURCE_MAP_OUT: outPath } : {}),
        },
      });
      const control = launch(false);
      const captured = launch(true);
      expect(control.status, control.stderr).toBe(0);
      expect(captured.status, captured.stderr).toBe(0);
      expect(captured.stdout).toContain('committed-source TypeScript load succeeded');
      const receipts = readdirSync(`${outPath}.processes`).map(file =>
        JSON.parse(readFileSync(join(`${outPath}.processes`, file), 'utf8')));
      const receipt = receipts.find(row => row.isMainThread &&
        row.observedSources?.some((loaded: { path: string }) => loaded.path === 'libs/test-config/src/tmpdir-guard.ts'));
      expect(receipt).toMatchObject({ status: 'unknown',
        reasons: expect.arrayContaining(['node-loader-chain-unmeasured']),
        observedSources: expect.arrayContaining([expect.objectContaining({
          path: 'libs/test-config/src/tmpdir-guard.ts', observedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        })]),
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['plain', 'shebang'] as const)('uses only embedded originals with exact Vite scope injection (%s)', (mode) => {
    const path = '/repo/config.mjs';
    const original = (mode === 'shebang' ? '#!/usr/bin/env node\n' : '') + 'export default {};\n';
    const at = mode === 'shebang' ? original.indexOf('\n') + 1 : 0;
    expect(configBundleSources(bundle({ sourceRoot: 'file:///repo/', sources: ['config.mjs'],
      sourcesContent: [original.slice(0, at) + prefix(path) + original.slice(at)] })))
      .toEqual([{ path, sha256: digest(original) }]);
  });

  it('keeps null and unsupported compiler input forms unknown', () => {
    expect(configBundleSources(bundle({ sourceRoot: 'file:///repo/', sources: ['config.mjs', 'helper.mjs'],
      sourcesContent: [null, prefix('/repo/helper.mjs') + 'const __vite_injected_original_import_meta_resolve = unknown;code'] })))
      .toEqual([{ path: '/repo/config.mjs', sha256: null }, { path: '/repo/helper.mjs', sha256: null }]);
    expect(configBundleSources(bundle({ sourceRoot: 'file:///repo/', sources: ['config.mjs'],
      sourcesContent: ['unrecognized injection;code'] }))).toEqual([{ path: '/repo/config.mjs', sha256: null }]);
  });

  it.each([{}, { sourceRoot: 'file:///repo/', sources: ['config.mjs'], sourcesContent: [] },
    { sourceRoot: '../relative/', sources: ['config.mjs'], sourcesContent: ['code'] }])
    ('rejects an incomplete source map %j', map => expect(configBundleSources(bundle(map))).toBeNull());

  it.each((['native', 'native-ts', 'bundle', 'runner', 'commonjs-bundle'] as const)
    .flatMap(kind => [false, true].map(ambientPreload => ({ kind, ambientPreload }))))
    ('observes actual Vite config evaluation ($kind loader, ambientPreload=$ambientPreload)', ({ kind, ambientPreload }) => {
    const root = mkdtempSync(join(tmpdir(), 'config-original-load-'));
    const capture = fileURLToPath(new URL('./executed-config-load-capture.ts', import.meta.url));
    const vite = import.meta.resolve('vite');
    const loader = kind === 'native-ts' ? 'native' : kind === 'commonjs-bundle' ? 'bundle' : kind;
    const cjs = kind === 'commonjs-bundle';
    const extension = kind === 'native-ts' ? 'ts' : cjs ? 'cjs' : 'mjs';
    const original = cjs ? 'exports.count = 1;\n' : `export const count${kind === 'native-ts' ? ': number' : ''} = 1;\n`;
    const restored = cjs ? 'exports.count = 2;\n' : `export const count${kind === 'native-ts' ? ': number' : ''} = 2;\n`;
    try {
      const preload = join(root, 'ambient-preload.mjs');
      writeFileSync(preload, 'export const ambient = true;\n');
      const env = { ...process.env, ...(ambientPreload ? { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } : {}) };
      delete env.NODE_OPTIONS;
      const helper = join(root, `helper.${extension}`);
      const configPath = join(root, `config.${extension}`);
      writeFileSync(helper, original);
      writeFileSync(configPath, cjs ? `const { count } = require('./helper.cjs');
        require('node:fs').writeFileSync(${JSON.stringify(helper)}, ${JSON.stringify(restored)});
        module.exports = { test: { count } };` : `import { count } from './helper.${extension}';
        import { writeFileSync } from 'node:fs';
        writeFileSync(new URL('./helper.${extension}', import.meta.url), ${JSON.stringify(restored)});
        export default { test: { count } };`);
      const script = `import { loadConfigFromFile } from ${JSON.stringify(vite)};
        const config = await loadConfigFromFile({ command: 'serve', mode: 'test' }, ${JSON.stringify(configPath)}, ${JSON.stringify(root)}, undefined, undefined, ${JSON.stringify(loader)});
        const { qualifyLoadedConfigSources } = await import(${JSON.stringify(pathToFileURL(capture).href)});
        console.log(JSON.stringify({ count: config.config.test.count,
          evidence: qualifyLoadedConfigSources([${JSON.stringify(configPath)}, ${JSON.stringify(helper)}], ${JSON.stringify(root)}) }));`;
      const out = execFileSync(process.execPath, ['--import', capture, '--input-type=module', '--eval', script], {
        encoding: 'utf8', timeout: 30000, cwd: root,
        env: { ...env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'load-test', PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'out.json'),
          PC_EXECUTED_SOURCE_MAP_PRELOAD: '1' },
      });
      const result = JSON.parse(out.trim());
      expect(result.count).toBe(1);
      if (loader === 'runner' || cjs) expect(result.evidence.status).toBe('unknown');
      else expect(result.evidence).toMatchObject({ basis: 'node-load-hook', status: 'changed',
        sources: expect.arrayContaining([{ path: `helper.${extension}`, sha256: digest(original), currentSha256: digest(restored) }]),
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
