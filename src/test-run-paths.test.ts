import { describe, expect, it } from 'vitest';
import {
  isRestoredCheckoutPath,
  normalizeStoredTestRunPath,
  storedTestRunPathPattern,
} from './test-run-paths';

describe('test-run path normalization', () => {
  it('normalizes an alternate install root when its root is supplied', () => {
    const root = '/srv/acme/test-workspace';
    expect(normalizeStoredTestRunPath(
      '/srv/acme/test-workspace/portal/packages/example.test.ts',
      root,
    )).toBe('packages/example.test.ts');
    expect(normalizeStoredTestRunPath(
      'test-workspace/portal/packages/example.test.ts',
      root,
    )).toBe('packages/example.test.ts');
  });

  it('keeps repo-relative paths and unknown absolute paths intact', () => {
    expect(normalizeStoredTestRunPath('packages/example.test.ts')).toBe('packages/example.test.ts');
    expect(normalizeStoredTestRunPath('/tmp/fake.test.ts', '/srv/acme/test-workspace')).toBe('/tmp/fake.test.ts');
  });

  it('recognizes preserved checkout names independently of their parent dirname', () => {
    expect(isRestoredCheckoutPath('custom-root/papercup-checkpoint/packages/example.test.ts')).toBe(true);
    expect(isRestoredCheckoutPath('custom-root/papercusp-checkpoint/packages/example.test.ts')).toBe(true);
    expect(isRestoredCheckoutPath('custom-root/papercup-staging/packages/example.test.ts')).toBe(true);
    expect(isRestoredCheckoutPath('packages/example.test.ts')).toBe(false);
  });

  it('emits a pattern usable by SQL regexp_replace and !~ predicates', () => {
    const pattern = new RegExp(storedTestRunPathPattern('/srv/acme/test-workspace'));
    expect('/srv/acme/test-workspace/portal/packages/example.test.ts'.replace(pattern, '')).toBe('packages/example.test.ts');
    expect('custom-root/papercup-checkpoint/packages/example.test.ts'.replace(pattern, '')).toBe('packages/example.test.ts');
  });
});
