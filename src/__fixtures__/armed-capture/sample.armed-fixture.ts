import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Fixture test run by executed-inputs-capture-armed-run.test.ts inside a child vitest. It reads
// one file so the armed capture has an input to record.
it('reads one input file', () => {
  expect(readFileSync(new URL('./input.txt', import.meta.url), 'utf8')).toBe('armed-capture-input\n');
});
