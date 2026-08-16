import failOnConsole from 'vitest-fail-on-console';
import { isSilencedConsoleMessage } from './console-noise-filter.ts';

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
  silenceMessage: (msg) => isSilencedConsoleMessage(msg),
});
