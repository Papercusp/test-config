import { fileURLToPath } from 'node:url';
import { applyFilterList, defineVitestConfig, readFilterList } from '../../vitest-config.ts';

const include = process.env.PC_COMPLETION_CONTINUATION_FIXTURE === '1'
  ? ['../armed-capture/sample.armed-fixture.ts', 'remaining.fixture.ts']
  : ['../armed-capture/sample.armed-fixture.ts', '../case-ledger/cases.case-fixture.ts', 'collection-error.fixture.ts'];
const filter = readFilterList();
const config = defineVitestConfig({
  layer: 'unit',
  // Fixture files deliberately use non-test suffixes. Apply the maintained
  // explicit-file rule rather than the layer's suffix-glob narrowing rule.
  include: filter ? applyFilterList(include, filter.files, { explicitFiles: true }).include : include,
});

config.test = { ...config.test, name: 'durable-completion-fixture', fileParallelism: false, maxWorkers: 1,
  reporters: [fileURLToPath(new URL('./crash-reporter.fixture.ts', import.meta.url))] };

export default config;
