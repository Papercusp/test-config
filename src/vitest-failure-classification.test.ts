import { describe, expect, it } from 'vitest';
import { isVitestAssertionFailure } from './vitest-failure-classification.mjs';

describe('isVitestAssertionFailure', () => {
  it('recognizes the serialized Vitest AssertionError header', () => {
    expect(isVitestAssertionFailure([
      'AssertionError: expected false to be true\n    at guard.test.ts:4:3',
    ])).toBe(true);
    expect(isVitestAssertionFailure(['AssertionError [ERR_ASSERTION]: expected value'])).toBe(true);
  });

  it.each(['resolves', 'rejects'] as const)(
    'recognizes the actual Vitest %s settlement assertion after stack serialization',
    async (matcher) => {
      let failure: Error | undefined;
      try {
        if (matcher === 'resolves') {
          await expect(Promise.reject(new Error('caller recovery changed'))).resolves.toBeDefined();
        } else {
          await expect(Promise.resolve('unexpected return')).rejects.toThrow();
        }
      } catch (error) {
        failure = error as Error;
      }
      expect(failure?.name).toBe('AssertionError');
      // Vitest's JSON reporter serializes stack || message, losing .name.
      const serialized = failure?.stack || failure?.message;
      expect(serialized).toMatch(/^Error: promise (rejected|resolved) /);
      expect(isVitestAssertionFailure([serialized])).toBe(true);
    },
  );

  it('requires both the settlement message and the immediate Vitest matcher origin', () => {
    const header = 'Error: promise rejected "Error: caller recovery changed" instead of resolving';
    const frame = '    at _Assertion.__VITEST_RESOLVES__ (file:///repo/node_modules/@vitest/expect/dist/index.js:1710:17)';
    for (const message of [
      header,
      `${header}\n    at beforeAll (file:///repo/hooks.ts:4:3)\n${frame}`,
      `${header}\n    at _Assertion.__VITEST_RESOLVES__ (file:///repo/domain.ts:4:3)`,
      `${header}\n${frame.replace('__VITEST_RESOLVES__', '__VITEST_REJECTS__')}`,
      `Error: domain request failed\n${frame}`,
      `TypeError: You must provide a Promise to expect()\n${frame}`,
    ]) {
      expect(isVitestAssertionFailure([message]), message).toBe(false);
    }
    expect(isVitestAssertionFailure([
      `${header}\n${frame}`,
      'Error: afterAll failed\n    at hooks.ts:4:3',
    ])).toBe(false);
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
