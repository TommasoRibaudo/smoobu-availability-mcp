/**
 * Pluggable cache. The in-memory implementation is per process; on Vercel each
 * function instance has its own, which is fine for a small public read-only
 * service. Swap in a shared store (Redis, Vercel KV) by implementing `Cache`.
 */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
}

export interface MemoryCacheOptions {
  readonly now?: () => number;
  /** Oldest entries are evicted beyond this size. */
  readonly maxEntries?: number;
}

export class MemoryCache implements Cache {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(opts: MemoryCacheOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxEntries = opts.maxEntries ?? 5000;
  }

  get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return Promise.resolve(undefined);
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value as T);
  }

  set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return Promise.resolve();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return Promise.resolve();
  }

  get size(): number {
    return this.entries.size;
  }
}

export class NoopCache implements Cache {
  get<T>(): Promise<T | undefined> {
    return Promise.resolve(undefined);
  }
  set(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Read-through helper with single-flight: concurrent misses for the same key
 * share one loader call, so a burst of identical requests costs one upstream hit.
 */
export class CachedLoader {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly cache: Cache) {}

  async load<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
    const cachedValue = await this.cache.get<T>(key);
    if (cachedValue !== undefined) return { value: cachedValue, hit: true };

    const existing = this.inflight.get(key);
    if (existing !== undefined) return { value: (await existing) as T, hit: true };

    const promise = (async () => {
      try {
        const value = await loader();
        await this.cache.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return { value: await promise, hit: false };
  }
}
