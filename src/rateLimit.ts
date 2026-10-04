/**
 * Per-client rate limiting behind an interface.
 *
 * TokenBucketRateLimiter is in-memory and therefore per process / per
 * serverless instance. It blunts abuse from a single caller but is not a
 * global quota; production should back `RateLimiter` with a shared store
 * (e.g. Upstash/Redis) if a strict account-wide budget is required.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until a token is available; only set when denied. */
  readonly retryAfterSeconds?: number;
}

export interface RateLimiter {
  consume(key: string): Promise<RateLimitDecision>;
}

export interface TokenBucketOptions {
  /** Bucket size: how many requests may burst at once. */
  readonly capacity: number;
  /** Sustained rate. */
  readonly refillPerSecond: number;
  readonly now?: () => number;
  /** Bound on tracked keys; least recently seen keys are dropped beyond it. */
  readonly maxKeys?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(opts: TokenBucketOptions) {
    if (opts.capacity < 1) throw new Error('capacity must be >= 1');
    if (opts.refillPerSecond <= 0) throw new Error('refillPerSecond must be > 0');
    this.capacity = opts.capacity;
    this.refillPerSecond = opts.refillPerSecond;
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  consume(key: string): Promise<RateLimitDecision> {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.capacity, updatedAt: now };
    } else {
      const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
      bucket.updatedAt = now;
      this.buckets.delete(key); // re-insert to keep Map in LRU order
    }
    this.buckets.set(key, bucket);
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return Promise.resolve({ allowed: true });
    }
    const deficit = 1 - bucket.tokens;
    return Promise.resolve({ allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(deficit / this.refillPerSecond)) });
  }
}

export class AllowAllRateLimiter implements RateLimiter {
  consume(): Promise<RateLimitDecision> {
    return Promise.resolve({ allowed: true });
  }
}
