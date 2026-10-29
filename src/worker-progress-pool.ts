import { relative } from 'node:path';
import { ForksPoolWorker, type PoolOptions, type PoolRunnerInitializer, type PoolWorker,
  type Reporter, type TestCase, type TestModule, type TestProject } from 'vitest/node';
import { historicalTestTimeout } from './test-timeout-history.ts';
import type { TestTimeoutHistorySnapshot } from './test-timeout-runtime.ts';

/** The config loader and reporter may evaluate separate copies of this module.
 * Keep the registry on Vitest's public project object, shared by both copies. */
const WORKERS = Symbol.for('@papercusp/test-config.worker-progress');
interface WorkerProgress {
  files: Set<string>;
  advance: (budgetMs?: number) => void;
}
function workers(project: TestProject): Set<WorkerProgress> {
  const target = project as TestProject & { [WORKERS]?: Set<WorkerProgress> };
  return target[WORKERS] ??= new Set();
}

/** A parent-owned inactivity timer. Only this worker's lifecycle can reset it;
 * stdout, CPU activity and other workers never count as completed test work. */
export function createWorkerProgressLease(onStall: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline = 0;
  let budget = 180_000;
  const stop = () => { clearTimeout(timer); timer = undefined; };
  const expire = () => {
    const remaining = deadline - performance.now();
    if (remaining > 0) { timer = setTimeout(expire, remaining); timer.unref(); return; }
    timer = undefined;
    onStall();
  };
  return {
    advance(budgetMs = budget) {
      if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Invalid worker inactivity budget');
      stop();
      budget = budgetMs;
      deadline = performance.now() + budget;
      timer = setTimeout(expire, budget);
      timer.unref();
    },
    stop,
  };
}

function fileBudget(project: TestProject, file: string): number {
  const provided = project.getProvidedContext();
  const history = provided.papercuspTestTimeoutHistory as TestTimeoutHistorySnapshot | undefined;
  return historicalTestTimeout({
    file: relative(history?.root ?? project.config.root, file).replaceAll('\\', '/'),
    caseKey: '', occurrence: 0, layer: String(provided.papercuspTestLayer),
    runnerIdentity: history?.runnerIdentity ?? '',
  }, history?.samples ?? [], Date.now()).timeoutMs;
}

/** Extend Vitest's maintained fork implementation, including its TERM/KILL
 * escalation. No private worker fields, custom IPC, or run-duration cap. */
export function createProgressForksPool({ idleTimeoutMs }: { idleTimeoutMs?: number } = {}): PoolRunnerInitializer {
  return {
    // Vitest dispatches built-in names before consulting a custom initializer.
    name: 'papercusp-progress-forks',
    createPoolWorker(options: PoolOptions): PoolWorker {
      const delegate = new ForksPoolWorker(options);
      let stopping: Promise<void> | undefined;
      const lease = createWorkerProgressLease(() => {
        const error = new Error(`Vitest worker made no test progress: ${[...progress.files].join(', ')}`);
        options.project.vitest.state.catchError(error, 'Worker no-progress');
        void stop().catch(error => options.project.vitest.state.catchError(error, 'Worker cleanup'));
      });
      const progress: WorkerProgress = {
        files: new Set(),
        advance: budget => lease.advance(idleTimeoutMs ?? budget),
      };
      // Pool shutdown and the stall path can meet. Stop the official worker once.
      const stop = () => stopping ??= (async () => {
        lease.stop();
        workers(options.project).delete(progress);
        await delegate.stop();
      })();
      return {
        name: delegate.name, cacheFs: delegate.cacheFs,
        on: (event, callback) => delegate.on(event, callback),
        off: (event, callback) => delegate.off(event, callback),
        deserialize: data => delegate.deserialize(data),
        async start() {
          stopping = undefined;
          await delegate.start();
          delegate.on('exit', () => { lease.stop(); workers(options.project).delete(progress); });
          delegate.on('message', message => {
            if (message?.__vitest_worker_response__ && message.type === 'testfileFinished') lease.stop();
          });
        },
        send(message) {
          if (message.type === 'run' || message.type === 'collect') {
            progress.files = new Set(message.context.files.map(file => file.filepath));
            workers(options.project).add(progress);
            progress.advance(Math.max(...[...progress.files].map(file => fileBudget(options.project, file)), 180_000));
          }
          delegate.send(message);
        },
        stop,
      };
    },
  };
}

function advance(module: TestModule, caseTimeout = 0): void {
  // A case can include beforeEach + test + afterEach. Keep parent recovery
  // outside their legitimate budgets; native case/hook cancellation fires first.
  const budget = Math.max(fileBudget(module.project, module.moduleId),
    caseTimeout, module.project.config.hookTimeout) * 3 + 10_000;
  for (const worker of workers(module.project)) {
    if (worker.files.has(module.moduleId)) worker.advance(budget);
  }
}

export default class WorkerProgressReporter implements Reporter {
  onTestModuleQueued(module: TestModule): void { advance(module); }
  onTestModuleCollected(module: TestModule): void { advance(module); }
  onTestModuleStart(module: TestModule): void { advance(module); }
  onTestModuleEnd(module: TestModule): void { advance(module); }
  onTestCaseReady(test: TestCase): void { advance(test.module, test.options.timeout); }
  onTestCaseResult(test: TestCase): void { advance(test.module); }
  onHookEnd(hook: Parameters<NonNullable<Reporter['onHookEnd']>>[0]): void {
    advance(hook.entity.type === 'module' ? hook.entity : hook.entity.module);
  }
}
