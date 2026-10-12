import { describe, expect, it } from 'vitest';

// Run only by test-case-runs.integration.test.ts through this directory's vitest.config.ts.
// One case of each recorded outcome, plus a parameterized pair that shares a fullName.
// The failing case is deliberate: the parent asserts its error tail lands in the ledger.
describe('case ledger fixture', () => {
  it('passes', () => {
    expect(1 + 1).toBe(2);
  });

  it('fails with a readable message', () => {
    expect('case-ledger-actual').toBe('case-ledger-expected');
  });

  it.skip('is skipped', () => {
    expect(true).toBe(false);
  });

  describe('nested', () => {
    for (const n of [1, 2]) {
      it('repeats under one name', () => {
        expect(n).toBeGreaterThan(0);
      });
    }
  });
});
