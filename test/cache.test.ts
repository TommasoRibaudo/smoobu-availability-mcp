import { describe, expect, it, vi } from 'vitest';
import { CachedLoader, MemoryCache, NoopCache } from '../src/cache.js';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('MemoryCache', () => {
  it('returns undefined for an unknown key', async () => {
    expect(await new MemoryCache().get('missing')).toBeUndefined();
  });

  it('stores and returns a value', async () => {
    const cache = new MemoryCache();
    await cache.set('k', { a: 1 }, 1000);
    expect(await cache.get('k')).toEqual({ a: 1 });
  });

  it('expires entries once the ttl has elapsed', async () => {
    const c = clock();
    const cache = new MemoryCache({ now: c.now });
    await cache.set('k', 'v', 1000);
    c.advance(999);
    expect(await cache.get('k')).toBe('v');
    c.advance(1);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('drops an expired entry from size when it is read', async () => {
    const c = clock();
    const cache = new MemoryCache({ now: c.now });
    await cache.set('k', 'v', 10);
    expect(cache.size).toBe(1);
    c.advance(10);
    await cache.get('k');
    expect(cache.size).toBe(0);
  });

  it.each([0, -1, -1000])('stores nothing when ttl is %i', async (ttl) => {
    const cache = new MemoryCache();
    await cache.set('k', 'v', ttl);
    expect(cache.size).toBe(0);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('evicts the oldest key beyond maxEntries', async () => {
    const cache = new MemoryCache({ maxEntries: 2 });
    await cache.set('a', 1, 1000);
    await cache.set('b', 2, 1000);
    await cache.set('c', 3, 1000);
    expect(cache.size).toBe(2);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBe(2);
    expect(await cache.get('c')).toBe(3);
  });

  it('treats re-setting a key as refreshing its age', async () => {
    const cache = new MemoryCache({ maxEntries: 2 });
    await cache.set('a', 1, 1000);
    await cache.set('b', 2, 1000);
    await cache.set('a', 11, 1000);
    await cache.set('c', 3, 1000);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBe(11);
    expect(cache.size).toBe(2);
  });

  it('resets the expiry when a key is overwritten', async () => {
    const c = clock();
    const cache = new MemoryCache({ now: c.now });
    await cache.set('k', 'old', 100);
    c.advance(90);
    await cache.set('k', 'new', 100);
    c.advance(90);
    expect(await cache.get('k')).toBe('new');
  });

  it('reports size', async () => {
    const cache = new MemoryCache();
    expect(cache.size).toBe(0);
    await cache.set('a', 1, 1000);
    await cache.set('b', 2, 1000);
    expect(cache.size).toBe(2);
  });
});

describe('NoopCache', () => {
  it('always misses, even right after a set', async () => {
    const cache = new NoopCache();
    await cache.set();
    expect(await cache.get()).toBeUndefined();
  });
});

describe('CachedLoader', () => {
  it('calls the loader on a miss and stores the result', async () => {
    const cache = new MemoryCache();
    const loader = new CachedLoader(cache);
    const fn = vi.fn(() => Promise.resolve('fresh'));
    const result = await loader.load('k', 1000, fn);
    expect(result).toEqual({ value: 'fresh', hit: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await cache.get('k')).toBe('fresh');
  });

  it('skips the loader on a cache hit', async () => {
    const cache = new MemoryCache();
    await cache.set('k', 'cached', 1000);
    const loader = new CachedLoader(cache);
    const fn = vi.fn(() => Promise.resolve('fresh'));
    const result = await loader.load('k', 1000, fn);
    expect(result).toEqual({ value: 'cached', hit: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it('serves the second call from cache', async () => {
    const loader = new CachedLoader(new MemoryCache());
    const fn = vi.fn(() => Promise.resolve(42));
    await loader.load('k', 1000, fn);
    const second = await loader.load('k', 1000, fn);
    expect(second).toEqual({ value: 42, hit: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reloads after the cached entry expires', async () => {
    const c = clock();
    const loader = new CachedLoader(new MemoryCache({ now: c.now }));
    const fn = vi.fn(() => Promise.resolve('v'));
    await loader.load('k', 1000, fn);
    c.advance(1000);
    const again = await loader.load('k', 1000, fn);
    expect(again.hit).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('is single-flight: 5 concurrent loads for one key call the loader once', async () => {
    const loader = new CachedLoader(new MemoryCache());
    const fn = vi.fn(async () => {
      await tick();
      return 'shared';
    });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => loader.load('k', 1000, fn)));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.value)).toEqual(Array(5).fill('shared'));
    expect(results.filter((r) => !r.hit)).toHaveLength(1);
  });

  it('is single-flight even when the cache never stores (NoopCache)', async () => {
    const loader = new CachedLoader(new NoopCache());
    const fn = vi.fn(async () => {
      await tick();
      return 'v';
    });
    await Promise.all([loader.load('k', 1000, fn), loader.load('k', 1000, fn), loader.load('k', 1000, fn)]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not coalesce different keys', async () => {
    const loader = new CachedLoader(new MemoryCache());
    const fn = vi.fn(async () => {
      await tick();
      return 'v';
    });
    await Promise.all([loader.load('a', 1000, fn), loader.load('b', 1000, fn)]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates a rejection to every concurrent caller', async () => {
    const loader = new CachedLoader(new MemoryCache());
    const fn = vi.fn(async () => {
      await tick();
      throw new Error('boom');
    });
    const settled = await Promise.allSettled([loader.load('k', 1000, fn), loader.load('k', 1000, fn)]);
    expect(fn).toHaveBeenCalledTimes(1);
    for (const s of settled) {
      expect(s.status).toBe('rejected');
      expect((s as PromiseRejectedResult).reason).toEqual(new Error('boom'));
    }
  });

  it('does not poison later calls after a rejected load', async () => {
    const cache = new MemoryCache();
    const loader = new CachedLoader(cache);
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('recovered');

    await expect(loader.load('k', 1000, fn)).rejects.toThrow('boom');
    expect(cache.size).toBe(0);

    const result = await loader.load('k', 1000, fn);
    expect(result).toEqual({ value: 'recovered', hit: false });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('with NoopCache every sequential call invokes the loader', async () => {
    const loader = new CachedLoader(new NoopCache());
    const fn = vi.fn(() => Promise.resolve('v'));
    await loader.load('k', 1000, fn);
    await loader.load('k', 1000, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
