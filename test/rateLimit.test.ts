import { describe, expect, it } from 'vitest';
import { AllowAllRateLimiter, TokenBucketRateLimiter } from '../src/rateLimit.js';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe('TokenBucketRateLimiter', () => {
  it('allows `capacity` immediate requests, then denies', async () => {
    const c = clock();
    const limiter = new TokenBucketRateLimiter({ capacity: 3, refillPerSecond: 1, now: c.now });
    for (let i = 0; i < 3; i++) expect((await limiter.consume('ip')).allowed).toBe(true);
    const denied = await limiter.consume('ip');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('does not set retryAfterSeconds when allowed', async () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 1, now: clock().now });
    const decision = await limiter.consume('ip');
    expect(decision).toEqual({ allowed: true });
  });

  it('rounds retryAfterSeconds up to the time needed for one token', async () => {
    const c = clock();
    // 0.1 tokens/second -> a full token takes 10 seconds.
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0.1, now: c.now });
    await limiter.consume('ip');
    expect((await limiter.consume('ip')).retryAfterSeconds).toBe(10);
    c.advance(4000);
    expect((await limiter.consume('ip')).retryAfterSeconds).toBe(6);
  });

  it('never suggests waiting less than one second', async () => {
    const c = clock();
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 100, now: c.now });
    await limiter.consume('ip');
    expect((await limiter.consume('ip')).retryAfterSeconds).toBe(1);
  });

  it('refills over time', async () => {
    const c = clock();
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 1, now: c.now });
    await limiter.consume('ip');
    await limiter.consume('ip');
    expect((await limiter.consume('ip')).allowed).toBe(false);

    c.advance(1000);
    expect((await limiter.consume('ip')).allowed).toBe(true);
    expect((await limiter.consume('ip')).allowed).toBe(false);
  });

  it('does not refill beyond capacity', async () => {
    const c = clock();
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 1, now: c.now });
    await limiter.consume('ip');
    c.advance(60_000);
    expect((await limiter.consume('ip')).allowed).toBe(true);
    expect((await limiter.consume('ip')).allowed).toBe(true);
    expect((await limiter.consume('ip')).allowed).toBe(false);
  });

  it('survives a clock that moves backwards', async () => {
    const c = clock();
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 1, now: c.now });
    await limiter.consume('ip');
    c.advance(-5000);
    expect((await limiter.consume('ip')).allowed).toBe(false);
  });

  it('tracks keys independently', async () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0.01, now: clock().now });
    expect((await limiter.consume('a')).allowed).toBe(true);
    expect((await limiter.consume('a')).allowed).toBe(false);
    expect((await limiter.consume('b')).allowed).toBe(true);
  });

  it('evicts the least recently seen key beyond maxKeys (which then gets a fresh bucket)', async () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0.001, now: clock().now, maxKeys: 2 });
    await limiter.consume('a');
    await limiter.consume('b');
    expect((await limiter.consume('a')).allowed).toBe(false); // a is now most recent
    await limiter.consume('c'); // evicts b
    expect((await limiter.consume('a')).allowed).toBe(false); // a survived and is still empty
    expect((await limiter.consume('b')).allowed).toBe(true); // b was evicted -> fresh bucket
  });

  it('rejects capacity 0', () => {
    expect(() => new TokenBucketRateLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow(/capacity/);
  });

  it('rejects refillPerSecond 0 and negative values', () => {
    expect(() => new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0 })).toThrow(/refillPerSecond/);
    expect(() => new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: -1 })).toThrow(/refillPerSecond/);
  });
});

describe('AllowAllRateLimiter', () => {
  it('always allows', async () => {
    const limiter = new AllowAllRateLimiter();
    for (let i = 0; i < 1000; i++) expect(await limiter.consume()).toEqual({ allowed: true });
  });
});
