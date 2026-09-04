import { afterAll, beforeAll } from 'vitest';
import failOnConsole from 'vitest-fail-on-console';
import { isSilencedConsoleMessage } from './console-noise-filter.ts';
import {
  recordSilencedMessage,
  resetSilencedConsoleCensus,
  summariseSilencedConsole,
} from './silenced-console-census.ts';

/**
 * Fails any test that produces an unexpected `console.error` /
 * `console.warn`. Closes one of the most common silent-flake sources
 * before it can hide in the suite (testing-spec §1.9).
 *
 * Tests that intentionally trigger a console message can opt out per
 * call via `failOnConsole`'s `silenceMessage` callback below — extend
 * `isSilencedConsoleMessage` (console-noise-filter.ts) rather than
 * disabling the check entirely.
 */
failOnConsole({
  shouldFailOnError: true,
  shouldFailOnWarn: true,
  silenceMessage: (msg) => {
    const silenced = isSilencedConsoleMessage(msg);
    // EI-21253580842180372: a silenced message is swallowed TOTALLY —
    // `vitest-fail-on-console` returns early on silence, so it is neither
    // collected into a failure nor forwarded to the saved original console.
    // Count it here, or the no-real-PG rail keeps blocking connections while
    // reporting nothing anywhere. `isSilencedConsoleMessage` stays a pure
    // predicate (its doc comment promises that, and its unit test relies on it);
    // the state lives in the census module.
    if (silenced) recordSilencedMessage(msg);
    return silenced;
  },
});

// The census counter is pinned to `globalThis`, which OUTLIVES vitest's
// per-file module-registry reset — a worker that runs several files would
// otherwise report each file's count plus every earlier file's. Reset per file
// so the emitted number means "in THIS file".
beforeAll(() => {
  resetSilencedConsoleCensus();
});

afterAll(() => {
  try {
    const summary = summariseSilencedConsole();
    if (!summary) return;
    // stdout, NOT console.*: console is the very thing being policed here, and
    // writing through it would risk tripping the guard this file installs.
    // Vitest forwards worker stdout to the reporter, so this lands in the run's
    // captured output and therefore in `test_runs.output_tail` — the one place
    // a later reader can actually query it.
    process.stdout.write(`${summary}\n`);
  } catch {
    // Observation only. This setup file is loaded by every suite in the repo;
    // it must never be the reason a test fails.
  }
});
