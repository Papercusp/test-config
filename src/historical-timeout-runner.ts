import { relative } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { VitestTestRunner } from 'vitest/runners';
import type { RunnerTestCase, RunnerTestFile, TestContext } from 'vitest';
import { historicalTestTimeout, type HistoricalTestTimeout } from './test-timeout-history.ts';
import { testTimingRuntimeIdentity, type TestTimeoutHistorySnapshot } from './test-timeout-runtime.ts';

/**
 * Native Vitest captures its default timeout while collecting each callback.
 * Disable that uniform default BEFORE collection, then use the runner callback
 * and the SAME cancellation signal consumed by Vitest's fixture/assertion wrapper.
 * Explicit author-supplied timeouts still apply. No run-level timer is installed.
 */
export default class HistoricalTimeoutRunner extends VitestTestRunner {
  private readonly controllers = new WeakMap<RunnerTestCase, AbortController>();
  private readonly budgets = new WeakMap<RunnerTestCase, HistoricalTestTimeout>();
  private readonly runtimeIdentity = testTimingRuntimeIdentity();
  private readonly defaultHookTimeout: number;

  constructor(config: ConstructorParameters<typeof VitestTestRunner>[0]) {
    super({ ...config, testTimeout: 0 });
    this.defaultHookTimeout = config.hookTimeout;
  }

  override extendTaskContext(context: TestContext): TestContext {
    const controller = new AbortController();
    this.controllers.set(context.task, controller);
    // Retain Vitest's own cancellation (including explicit author deadlines).
    Object.defineProperty(context, 'signal', {
      value: AbortSignal.any([context.signal, controller.signal]), enumerable: true,
    });
    return super.extendTaskContext(context);
  }

  private history(): TestTimeoutHistorySnapshot | undefined {
    const value = this.injectValue('papercuspTestTimeoutHistory') as TestTimeoutHistorySnapshot | undefined;
    return value?.schema === 1 && value.runnerIdentity === this.runtimeIdentity ? value : undefined;
  }

  override onCollectStart(file: RunnerTestFile): void {
    super.onCollectStart(file);
    const history = this.history();
    const path = relative(history?.root ?? this.config.root, file.filepath).replaceAll('\\', '/');
    // Hooks are collected before test callbacks run. A file's measured duration
    // is the conservative history fallback for setup/teardown, including beforeAll.
    this.config.hookTimeout = historicalTestTimeout({
      file: path, caseKey: '', occurrence: 0, layer: String(this.injectValue('papercuspTestLayer')),
      runnerIdentity: this.runtimeIdentity,
    }, history?.samples ?? [], Date.now(), this.defaultHookTimeout).timeoutMs;
  }

  onCollected(files: RunnerTestFile[]): void {
    const history = this.history();
    for (const file of files) {
      const occurrences = new Map<string, number>();
      const visit = (tasks: RunnerTestFile['tasks']): void => {
        for (const task of tasks) {
          if (task.type === 'suite') { visit(task.tasks); continue; }
          // Reporter TestCase.fullName omits the file name.
          const caseKey = task.fullTestName.slice(0, 2_000);
          const occurrence = (occurrences.get(caseKey) ?? 0) + 1;
          occurrences.set(caseKey, occurrence);
          const budget = historicalTestTimeout({
            file: relative(history?.root ?? this.config.root, file.filepath).replaceAll('\\', '/'),
            caseKey, occurrence, layer: String(this.injectValue('papercuspTestLayer')),
            runnerIdentity: this.runtimeIdentity,
          }, history?.samples ?? [], Date.now());
          this.budgets.set(task, budget);
          if (!task.timeout) task.timeout = budget.timeoutMs;
        }
      };
      visit(file.tasks);
    }
  }

  async runTask(test: RunnerTestCase): Promise<void> {
    const budget = this.budgets.get(test) ?? { timeoutMs: 180_000, basis: 'fallback' };
    const timeoutMs = Math.min(test.timeout || budget.timeoutMs, budget.timeoutMs);
    const controller = this.controllers.get(test)!;
    const started = performance.now();
    const timeout = () => controller.abort(new Error(
      `Test timed out in ${timeoutMs}ms (${budget.basis}): ${test.fullTestName}`,
    ));
    const timer = setTimeout(timeout, timeoutMs);
    timer.unref();
    try {
      await VitestTestRunner.getTestFn(test)();
      // A microtask-only loop can starve timers and still eventually return.
      if (performance.now() - started >= timeoutMs) {
        timeout();
        throw controller.signal.reason;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
