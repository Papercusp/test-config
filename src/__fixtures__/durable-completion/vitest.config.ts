import { fileURLToPath } from 'node:url';
import { defineVitestConfig } from '../../vitest-config.ts';

const config = defineVitestConfig({
  layer: 'unit',
  include: process.env.PC_COMPLETION_CONTINUATION_FIXTURE === '1'
    ? ['../armed-capture/sample.armed-fixture.ts', 'remaining.fixture.ts']
    : ['../armed-capture/sample.armed-fixture.ts', '../case-ledger/cases.case-fixture.ts', 'collection-error.fixture.ts'],
});

config.test = { ...config.test, name: 'durable-completion-fixture', fileParallelism: false, maxWorkers: 1,
  reporters: [fileURLToPath(new URL('./crash-reporter.fixture.ts', import.meta.url))] };

export default config;
