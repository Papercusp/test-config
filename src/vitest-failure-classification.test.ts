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

  it.each(['resolves', 'rejects'] as const)(
    'recognizes an actual %s value assertion after stack serialization',
    async (matcher) => {
      let failure: Error | undefined;
      try {
        if (matcher === 'resolves') {
          await expect(Promise.resolve({ ok: true })).resolves.toMatchObject({ ok: false });
        } else {
          await expect(Promise.reject({ ok: true })).rejects.toMatchObject({ ok: false });
        }
      } catch (error) {
        failure = error as Error;
      }
      expect(failure?.name).toBe('AssertionError');
      const serialized = failure?.stack || failure?.message;
      expect(serialized).toMatch(/^Error: expected /);
      expect(isVitestAssertionFailure([serialized])).toBe(true);
    },
  );

  it('rejects value-like errors without an immediate Vitest promise assertion origin', () => {
    const header = 'Error: expected { ok: true } to match object { ok: false }';
    const frame = '    at _Assertion.__VITEST_RESOLVES__ (file:///repo/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1710:17)';
    expect(isVitestAssertionFailure([`${header}\n(14 matching properties omitted from actual)\n${frame}`])).toBe(true);
    for (const message of [
      header,
      `${header}\n    at beforeAll (file:///repo/hooks.ts:4:3)\n${frame}`,
      `${header}\n    at _Assertion.__VITEST_RESOLVES__ (file:///repo/domain.ts:4:3)`,
      `Error: domain request failed\n${frame}`,
      `TypeError: expected a Promise\n${frame}`,
    ]) expect(isVitestAssertionFailure([message]), message).toBe(false);
    expect(isVitestAssertionFailure([`${header}\n${frame}`, 'Error: afterAll failed'])).toBe(false);
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

  it.each(['Unable to find an element with the text: Authorized document.', 'Found multiple elements with the text: Authorized document.'])(
    'recognizes a Testing Library query assertion: %s', (message) => {
      // The serialized DOM query failure includes the pretty DOM before its stack.
      const serialized = `TestingLibraryElementError: ${message}\n\nIgnored nodes: comments, script, style\n<body><p>This result is unavailable.</p></body>\n    at Object.getElementError (/repo/node_modules/@testing-library/dom/dist/config.js:37:19)\n    at /repo/node_modules/@testing-library/dom/dist/query-helpers.js:76:38\n    at guard.integration.test.tsx:240:19`;
      expect(isVitestAssertionFailure([serialized])).toBe(true);
    },
  );

  it('requires Testing Library query failure identity and its immediate library origin', () => {
    const header = 'TestingLibraryElementError: Unable to find an element with the text: Authorized document.';
    const origin = '    at Object.getElementError (/repo/node_modules/@testing-library/dom/dist/config.js:37:19)';
    for (const message of [
      header,
      `${header}\n    at beforeAll (/repo/hooks.ts:4:3)\n${origin}`,
      `${header}\n    at Object.getElementError (/repo/domain.ts:37:19)`,
      `TypeError: Unable to find an element with the text: Authorized document.\n${origin}`,
      `TestingLibraryElementError: setup failed\n${origin}`,
    ]) expect(isVitestAssertionFailure([message]), message).toBe(false);
    expect(isVitestAssertionFailure([`${header}\n${origin}`, 'Error: afterAll failed'])).toBe(false);
  });
});
