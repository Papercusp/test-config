import { defineVitestConfig } from './src/vitest-config.ts';

// Unit layer: *.test.ts (excludes *.integration.test.ts). test-config dogfoods
// its own defineVitestConfig.
export default defineVitestConfig({ layer: 'unit' });
