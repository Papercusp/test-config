import failOnConsole from 'vitest-fail-on-console';

/**
 * Fails any test that produces an unexpected `console.error` /
 * `console.warn`. Closes one of the most common silent-flake sources
 * before it can hide in the suite (testing-spec §1.9).
 *
 * Tests that intentionally trigger a console message can opt out per
 * call via `failOnConsole`'s `silenceMessage` callback below — extend
 * the matcher rather than disabling the check entirely.
 */
failOnConsole({
  shouldFailOnError: true,
  shouldFailOnWarn: true,
  silenceMessage: (msg) => {
    // React 19 hydration noise from third-party libs (Monaco, etc.) —
    // keep this list short and review periodically.
    if (typeof msg !== 'string') return false;
    if (msg.includes('was not wrapped in act(...)')) return true;
    return false;
  },
});
