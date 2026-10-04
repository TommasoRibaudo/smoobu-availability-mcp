import { CachedLoader, MemoryCache } from './cache.js';
import type { Cache } from './cache.js';
import { CATALOG, validateCatalog } from './catalog.js';
import type { CatalogProperty } from './catalog.js';
import type { AppConfig } from './config.js';
import { createMcpHandler } from './http.js';
import type { FetchHandler } from './http.js';
import { consoleLogger } from './log.js';
import type { Logger } from './log.js';
import { TokenBucketRateLimiter } from './rateLimit.js';
import type { RateLimiter } from './rateLimit.js';
import { SmoobuClient } from './smoobu/client.js';
import type { ToolDeps } from './tools/shared.js';

export interface AppOverrides {
  readonly fetch?: typeof fetch;
  readonly cache?: Cache;
  readonly rateLimiter?: RateLimiter;
  readonly catalog?: readonly CatalogProperty[];
  readonly log?: Logger;
  readonly now?: () => Date;
  /** Replaces the retry pause (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly upstreamLimiter?: RateLimiter;
}

export interface App {
  readonly handler: FetchHandler;
  readonly deps: ToolDeps;
}

/** Composition root shared by the local server, the Vercel function and the e2e test. */
export function createApp(config: AppConfig, overrides: AppOverrides = {}): App {
  const log = overrides.log ?? consoleLogger;
  const catalog = overrides.catalog ?? CATALOG;
  validateCatalog(catalog);

  const smoobu = new SmoobuClient({
    credentials: { apiKey: config.smoobuApiKey, apiSecret: config.smoobuApiSecret },
    customerId: config.smoobuCustomerId,
    ...(config.smoobuBaseUrl !== undefined ? { baseUrl: config.smoobuBaseUrl } : {}),
    ...(overrides.fetch !== undefined ? { fetch: overrides.fetch } : {}),
    ...(overrides.sleep !== undefined ? { sleep: overrides.sleep } : {}),
    upstreamLimiter:
      overrides.upstreamLimiter ??
      new TokenBucketRateLimiter({ capacity: config.upstreamRateLimitBurst, refillPerSecond: config.upstreamRateLimitPerMinute / 60 }),
    log,
  });

  const deps: ToolDeps = {
    smoobu,
    catalog,
    loader: new CachedLoader(overrides.cache ?? new MemoryCache()),
    bookingUrlTemplate: config.bookingUrlTemplate,
    cacheTtlRatesMs: config.cacheTtlRatesMs,
    cacheTtlAvailabilityMs: config.cacheTtlAvailabilityMs,
    now: overrides.now ?? (() => new Date()),
    log,
  };

  const rateLimiter =
    overrides.rateLimiter ??
    new TokenBucketRateLimiter({ capacity: config.rateLimitBurst, refillPerSecond: config.rateLimitPerMinute / 60 });

  return { handler: createMcpHandler({ deps, rateLimiter, log }), deps };
}
