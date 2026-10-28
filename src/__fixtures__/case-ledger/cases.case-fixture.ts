import { describe, expect, it } from 'vitest';

// Run only by test-case-runs.integration.test.ts through this directory's vitest.config.ts.
// One case of each recorded outcome, plus a parameterized pair that shares a fullName.
// The deliberate failure and dynamic skip both carry diagnostics for the parent to verify.
describe('case ledger fixture', () => {
  it('passes', () => {
    expect(1 + 1).toBe(2);
  });

  it('fails with a readable message', () => {
    throw new Error('case-ledger-expected' + String.fromCharCode(0) + 'binary-bytes');
  });

  it('is dynamically skipped with a provider reason', (ctx) => {
    ctx.skip('case-ledger-provider-refusal TEST_FILE_NAME_FILTER_NO_MATCH testsExecuted=0');
  });

  describe('nested', () => {
    for (const n of [1, 2]) {
      it('repeats under one name', () => {
        expect(n).toBeGreaterThan(0);
      });
    }
  });
});
