import { createRequire } from 'node:module';
import type { TestTimingSample } from './test-timeout-history.ts';

/** Shared by the ledger writer and the worker; unknown runtimes never borrow history. */
export function testTimingRuntimeIdentity(): string {
  try {
    const { version } = createRequire(import.meta.url)('vitest/package.json') as { version: string };
    return typeof version === 'string' && version
      ? `node:${process.versions.node} ${process.platform}/${process.arch} vitest:${version}` : '';
  } catch {
    // Reporter loading is fail-soft. Unknown identity seeds no history.
    return '';
  }
}

export interface TestTimeoutHistorySnapshot {
  schema: 1;
  root: string;
  runnerIdentity: string;
  observedAtMs: number;
  samples: TestTimingSample[];
  readStatus?: 'loaded' | 'unavailable';
  readErrorCode?: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    papercuspTestTimeoutHistory: TestTimeoutHistorySnapshot;
  }
}
