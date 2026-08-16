import { describe, expect, it, vi } from 'vitest';
import { SubstrateCircuitBreaker } from './substrate-circuit-breaker.ts';

const mk = (threshold = 3) => {
  const banners: string[] = [];
  const breaker = new SubstrateCircuitBreaker(threshold, 'getTestPg (test)', (m) => banners.push(m));
  return { breaker, banners };
};

describe('SubstrateCircuitBreaker (EI-11530)', () => {
  it('stays closed and check() is a no-op below the threshold', () => {
    const { breaker, banners } = mk(3);
    breaker.recordFailure(new Error('in recovery mode'));
    breaker.recordFailure(new Error('in recovery mode'));
    expect(breaker.tripped).toBe(false);
    expect(breaker.failureCount).toBe(2);
    expect(() => breaker.check()).not.toThrow();
    expect(banners).toHaveLength(0);
  });

  it('latches on the Nth consecutive failure and check() then fails fast', () => {
    const { breaker, banners } = mk(3);
    breaker.recordFailure(new Error('a'));
    breaker.recordFailure(new Error('b'));
    breaker.recordFailure(new Error('connection refused'));
    expect(breaker.tripped).toBe(true);
    expect(() => breaker.check()).toThrow(/TEST SUBSTRATE DOWN/);
    // the distinct error carries the last cause and the re-run guidance
    expect(() => breaker.check()).toThrow(/connection refused/);
    expect(() => breaker.check()).toThrow(/Re-run once the substrate is healthy/);
    expect(banners).toHaveLength(1);
    expect(banners[0]).toContain('TEST SUBSTRATE DOWN');
  });

  it('a success resets the streak — non-consecutive failures never trip', () => {
    const { breaker } = mk(3);
    breaker.recordFailure(new Error('x'));
    breaker.recordFailure(new Error('x'));
    breaker.recordSuccess(); // substrate came back — streak broken
    expect(breaker.failureCount).toBe(0);
    breaker.recordFailure(new Error('x'));
    breaker.recordFailure(new Error('x'));
    expect(breaker.tripped).toBe(false); // only 2 since the reset
    expect(() => breaker.check()).not.toThrow();
  });

  it('LATCHES — a later success does NOT un-trip (the run verdict stays honest)', () => {
    const { breaker } = mk(2);
    breaker.recordFailure(new Error('x'));
    breaker.recordFailure(new Error('x'));
    expect(breaker.tripped).toBe(true);
    breaker.recordSuccess(); // even if the substrate recovers mid-run
    expect(breaker.tripped).toBe(true); // still latched
    expect(() => breaker.check()).toThrow(/TEST SUBSTRATE DOWN/);
  });

  it('bannner fires exactly once even as more failures arrive after tripping', () => {
    const { breaker, banners } = mk(2);
    breaker.recordFailure(new Error('x'));
    breaker.recordFailure(new Error('x')); // trips → 1 banner
    breaker.recordFailure(new Error('x')); // already latched → no more counting/banner
    breaker.recordFailure(new Error('x'));
    expect(banners).toHaveLength(1);
    expect(breaker.failureCount).toBe(2); // frozen at the trip point
  });

  it('threshold 1 trips on the first failure', () => {
    const { breaker } = mk(1);
    breaker.recordFailure(new Error('boom'));
    expect(breaker.tripped).toBe(true);
    expect(() => breaker.check()).toThrow(/TEST SUBSTRATE DOWN/);
  });

  it('rejects a non-positive / non-integer threshold at construction', () => {
    expect(() => new SubstrateCircuitBreaker(0, 'x')).toThrow(/>= 1/);
    expect(() => new SubstrateCircuitBreaker(-1, 'x')).toThrow(/>= 1/);
    expect(() => new SubstrateCircuitBreaker(2.5, 'x')).toThrow(/integer/);
  });

  it('defaultBanner path (no injected sink) does not throw', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const breaker = new SubstrateCircuitBreaker(1, 'getTestPg (test)');
      expect(() => breaker.recordFailure(new Error('boom'))).not.toThrow();
      expect(spy).toHaveBeenCalledOnce();
      expect(String(spy.mock.calls[0]![0])).toContain('TEST SUBSTRATE DOWN');
    } finally {
      spy.mockRestore();
    }
  });
});
