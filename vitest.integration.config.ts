import { defineVitestConfig } from './src/vitest-config.ts';

// Integration layer: *.integration.test.ts (real containers via testcontainers).
export default defineVitestConfig({ layer: 'integration' });
