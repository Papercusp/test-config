import { defineVitestConfig } from '../../vitest-config.ts';

// Fixture config for executed-inputs-capture-armed-run.test.ts (WI-10003670). The parent test
// arms the executed-source map through the environment, so defineVitestConfig wires the P-009
// capture setup exactly as it does for a green-checkpoint task. PC_ARMED_CAPTURE_FIXTURE_EXTRA_SETUP
// adds one more setup file; the parent uses it to run the deliberately broken control.
const extraSetup = process.env.PC_ARMED_CAPTURE_FIXTURE_EXTRA_SETUP?.trim();

export default defineVitestConfig({
  layer: 'unit',
  include: ['sample.armed-fixture.ts'],
  setupFiles: extraSetup ? [extraSetup] : [],
});
