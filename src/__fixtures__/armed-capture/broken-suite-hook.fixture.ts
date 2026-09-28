import { afterAll } from 'vitest';

// DELIBERATELY BROKEN — the control for executed-inputs-capture-armed-run.test.ts (WI-10003670).
// This is the suite-hook shape that failed 1,713 green-checkpoint files on 2026-09-28: Vitest 4
// parses a suite hook's FIRST parameter as a fixture pattern and throws FixtureParseError for
// anything but an object pattern. The control run adds this as a setup file and must FAIL, which
// proves the child run's exit status reflects a setup-hook fault. Do not "fix" it.
afterAll((suite?: unknown) => {
  void suite;
});
