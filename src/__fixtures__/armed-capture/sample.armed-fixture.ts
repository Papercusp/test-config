import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

// Fixture test run by executed-inputs-capture-armed-run.test.ts inside a child vitest. It reads
// one file so the armed capture has an input to record.
function readFixtureInput() {
  expect(readFileSync(new URL('./input.txt', import.meta.url), 'utf8')).toBe('armed-capture-input\n');
}
it('reads one input file', readFixtureInput);

it('executes a route imported after collection and resetModules with a mocked dependency', async () => {
  vi.resetModules();
  vi.doMock('./dynamic-dependency.fixture.ts', () => ({ value: 'mocked' }));
  const { route } = await import('./dynamic-route.fixture.ts');
  expect(route()).toBe('mocked');
});
