/**
 * EI-9990 — bumps @testing-library/dom's OWN internal `waitFor` /
 * `findBy*` / `waitForElementToBeRemoved` polling timeout from its
 * 1000ms default to a shared-box-safe 5000ms.
 *
 * This is the SAME "box weather vs. correctness" class already fixed for
 * vitest's own `testTimeout` in vitest-config.ts (5s → 20s → 60s, see the
 * long comment there) — but that fix does NOT cover this: `waitFor`'s
 * internal poll-timeout is independent of the surrounding test's budget.
 * A test can have 60s of vitest testTimeout headroom and still redden on
 * a `waitFor` that gives up after its own hardcoded 1000ms, if the mocked
 * async chain (a resolved fetch mock, a scheduled microtask, a React
 * state-update flush) is merely SLOW under heavy shared-host CPU
 * contention rather than genuinely hung.
 *
 * Observed live: apps/operator-vite/src/components/adv/LearningTab.test.tsx
 * (EI-9990) red-test-watchdog-flagged 20x across three separate short
 * bursts over 2 days (2026-07-10 19:43, 2026-07-11 23:23-23:26, 2026-07-12
 * 01:09-01:14), each burst self-recovering within minutes with ZERO code
 * change in between and 100% pass in isolation every time re-run — the
 * signature of a timeout tuned for an idle box, not this fleet's box.
 *
 * A GENUINE hang still fails — just after 5s of real waiting instead of 1s;
 * this widens tolerance for load-induced slowness, it does not weaken any
 * assertion.
 *
 * Safe no-op for any package without @testing-library/dom on its dependency
 * graph (most backend/non-UI unit suites don't import it) — resolved
 * dynamically and swallowed if absent, so wiring this into the *default*
 * unit-layer setup (every `defineVitestConfig` caller) is harmless even for
 * packages that never render a component.
 */
try {
  const { configure } = await import('@testing-library/dom');
  configure({ asyncUtilTimeout: 5_000 });
} catch {
  // @testing-library/dom not on this package's dependency graph — nothing to configure.
}
