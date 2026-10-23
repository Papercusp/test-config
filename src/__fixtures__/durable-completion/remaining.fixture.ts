import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('reads its tracked input in the remaining native file', () => {
  expect(readFileSync(new URL('../armed-capture/input.txt', import.meta.url), 'utf8'))
    .toBe('armed-capture-input\n');
});
