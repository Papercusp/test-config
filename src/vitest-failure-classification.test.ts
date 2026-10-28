import { describe, expect, it } from 'vitest';
import { isVitestAssertionFailure } from './vitest-failure-classification.mjs';

describe('isVitestAssertionFailure', () => {
  it('recognizes the serialized Vitest AssertionError header', () => {
    expect(isVitestAssertionFailure([
      'AssertionError: expected false to be true\n    at guard.test.ts:4:3',
    ])).toBe(true);
    expect(isVitestAssertionFailure(['AssertionError [ERR_ASSERTION]: expected value'])).toBe(true);
  });

  it('does not treat runtime exceptions or arbitrary failure text as assertion evidence', () => {
    expect(isVitestAssertionFailure([
      'TypeError: guard is not a function\n    at guard.test.ts:4:3',
    ])).toBe(false);
    expect(isVitestAssertionFailure(['expected false to be true'])).toBe(false);
    expect(isVitestAssertionFailure(null)).toBe(false);
    expect(isVitestAssertionFailure([
      'AssertionError: expected false to be true',
      'TypeError: teardown failed',
    ])).toBe(false);
  });
});
