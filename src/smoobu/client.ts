import { z } from 'zod';
import { SmoobuShapeError, SmoobuUpstreamError } from '../errors.js';
import type { Logger } from '../log.js';
import { silentLogger } from '../log.js';
import type { RateLimiter } from '../rateLimit.js';
import { assertAllowed } from './allowlist.js';
import type { AuthContext, QueryPairs, SmoobuCredentials } from './auth.js';
import { buildAuthHeaders, canonicalQuery, defaultAuthContext } from './auth.js';
import type { AvailabilityByApartment, AvailabilityOutcome, CheckAvailabilityInput, RateDay, RatesByApartment } from './types.js';

export const SMOOBU_BASE_URL = 'https://login.smoobu.com';

export interface RetryPolicy {
  /** Total attempts including the first one. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 4000 };

export interface SmoobuClientOptions {
  readonly credentials: SmoobuCredentials;
  /** Smoobu customer id, required by checkApartmentAvailability. */
  readonly customerId: number;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly retry?: Partial<RetryPolicy>;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly auth?: AuthContext;
  readonly log?: Logger;
  /**
   * Account-wide budget for outgoing Smoobu calls (all callers together), in
   * addition to the per-IP limit at the HTTP layer. Denied => upstream error.
   */
  readonly upstreamLimiter?: RateLimiter;
  /** Longest pause honoured after a 429 before calls are refused outright. */
  readonly maxCooldownMs?: number;
}

interface RequestSpec {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query?: QueryPairs;
  readonly body?: unknown;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- upstream shape schemas: only the fields we rely on ---------- */

const apartmentsSchema = z.looseObject({
  apartments: z.array(z.looseObject({ id: z.number().int(), name: z.string() })),
});

const rateDaySchema = z.looseObject({
  price: z.number().nullable().optional(),
  min_length_of_stay: z.number().nullable().optional(),
  available: z.union([z.number(), z.boolean()]).nullable().optional(),
});
const ratesSchema = z.looseObject({
  data: z.record(z.string(), z.record(z.string(), rateDaySchema)),
});

const availabilitySchema = z.looseObject({
  // Always present in Smoobu's response; its absence means we are not looking at the expected payload.
  availableApartments: z.array(z.union([z.number(), z.string()])),
  prices: z.record(z.string(), z.looseObject({ price: z.number(), currency: z.string() })).optional(),
  errorMessages: z
    .record(
      z.string(),
      z.looseObject({
        errorCode: z.number().int().optional(),
        minimumLengthOfStay: z.number().optional(),
        numberOfGuest: z.number().optional(),
        leadTime: z.number().optional(),
        minimumLengthBetweenBookings: z.number().optional(),
      }),
    )
    .optional(),
});

/**
 * Read-only Smoobu client limited to three allowlisted endpoints.
 *
 * Invariants (covered by tests):
 *  - every call goes through `request()`, which checks the allowlist before
 *    touching the network;
 *  - response bodies are parsed, reduced to the fields in ./types.ts and
 *    discarded; they are never logged or returned raw;
 *  - 429 / 5xx / network failures are retried with exponential backoff.
 */
export class SmoobuClient {
  private readonly credentials: SmoobuCredentials;
  private readonly customerId: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryPolicy;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly auth: AuthContext;
  private readonly log: Logger;
  private readonly upstreamLimiter: RateLimiter | undefined;
  private readonly maxCooldownMs: number;
  /** While now < cooldownUntil, Smoobu asked us to back off and every call fails fast. */
  private cooldownUntil = 0;

  constructor(opts: SmoobuClientOptions) {
    if (!opts.credentials.apiKey) throw new Error('Smoobu API key is required');
    if (!Number.isInteger(opts.customerId) || opts.customerId <= 0) throw new Error('Smoobu customer id must be a positive integer');
    this.credentials = opts.credentials;
    this.customerId = opts.customerId;
    this.baseUrl = (opts.baseUrl ?? SMOOBU_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.auth = opts.auth ?? defaultAuthContext;
    this.log = opts.log ?? silentLogger;
    this.upstreamLimiter = opts.upstreamLimiter;
    this.maxCooldownMs = opts.maxCooldownMs ?? 60_000;
  }

  /** Apartment ids visible to the account. Used only by the catalog check script. */
  async listApartmentIds(): Promise<readonly number[]> {
    const json = await this.request({ method: 'GET', path: '/api/apartments' });
    const parsed = apartmentsSchema.safeParse(json);
    if (!parsed.success) throw this.shapeError('/api/apartments');
    return parsed.data.apartments.map((a) => a.id);
  }

  async getRates(apartmentIds: readonly number[], startDate: string, endDate: string): Promise<RatesByApartment> {
    const query: (readonly [string, string])[] = [
      ['start_date', startDate],
      ['end_date', endDate],
      ...apartmentIds.map((id) => ['apartments[]', String(id)] as const),
    ];
    const json = await this.request({ method: 'GET', path: '/api/rates', query });
    const parsed = ratesSchema.safeParse(json);
    if (!parsed.success) throw this.shapeError('/api/rates');

    const out = new Map<number, Map<string, RateDay>>();
    for (const id of apartmentIds) {
      const days = new Map<string, RateDay>();
      const upstreamDays = parsed.data.data[String(id)] ?? {};
      for (const [date, day] of Object.entries(upstreamDays)) {
        days.set(date, {
          price: typeof day.price === 'number' ? day.price : null,
          minLengthOfStay: typeof day.min_length_of_stay === 'number' ? day.min_length_of_stay : null,
          available: day.available === 1 || day.available === true,
        });
      }
      out.set(id, days);
    }
    return out;
  }

  async checkAvailability(input: CheckAvailabilityInput): Promise<AvailabilityByApartment> {
    const body = {
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      apartments: [...input.apartmentIds],
      customerId: this.customerId,
      guests: input.guests,
    };
    const json = await this.request({ method: 'POST', path: '/booking/checkApartmentAvailability', body });
    const parsed = availabilitySchema.safeParse(json);
    if (!parsed.success) throw this.shapeError('/booking/checkApartmentAvailability');

    const available = new Set(parsed.data.availableApartments.map((v) => Number(v)));
    const prices = parsed.data.prices ?? {};
    const errors = parsed.data.errorMessages ?? {};

    const out = new Map<number, AvailabilityOutcome>();
    for (const id of input.apartmentIds) {
      const price = prices[String(id)];
      if (available.has(id) && price !== undefined) {
        out.set(id, { available: true, price: price.price, currency: price.currency });
        continue;
      }
      const err = errors[String(id)];
      out.set(id, {
        available: false,
        errorCode: saneInt(err?.errorCode, 999),
        minimumLengthOfStay: saneInt(err?.minimumLengthOfStay, 365),
        numberOfGuest: saneInt(err?.numberOfGuest, 100),
        leadTime: saneInt(err?.leadTime, 365),
        minimumLengthBetweenBookings: saneInt(err?.minimumLengthBetweenBookings, 365),
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ */

  private shapeError(endpoint: string): SmoobuShapeError {
    this.log('smoobu.shape_error', {});
    return new SmoobuShapeError(endpoint);
  }

  /**
   * The single network path. The allowlist check is the first statement so
   * that a disallowed call can never reach `fetch`.
   */
  private async request(spec: RequestSpec): Promise<unknown> {
    assertAllowed(spec.method, spec.path);

    const query: QueryPairs = spec.query ?? [];
    const bodyText = spec.body === undefined ? '' : JSON.stringify(spec.body);
    const qs = canonicalQuery(query);
    const url = `${this.baseUrl}${spec.path}${qs.length > 0 ? `?${qs}` : ''}`;

    if (this.auth.now().getTime() < this.cooldownUntil) {
      this.log('smoobu.cooldown', { status: 429 });
      throw new SmoobuUpstreamError(429, 0);
    }
    if (this.upstreamLimiter !== undefined && !(await this.upstreamLimiter.consume('smoobu')).allowed) {
      this.log('ratelimit.upstream_denied', {});
      throw new SmoobuUpstreamError(429, 0);
    }

    let lastStatus: number | undefined;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      attemptsMade = attempt;
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...buildAuthHeaders(this.credentials, { method: spec.method, path: spec.path, query, body: bodyText }, this.auth),
      };
      if (spec.method === 'POST') headers['Content-Type'] = 'application/json';

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: spec.method,
          headers,
          body: spec.method === 'POST' ? bodyText : null,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'error',
        });
      } catch {
        lastStatus = undefined;
        this.log('smoobu.retry', { attempt, network: true });
        if (attempt < this.retry.maxAttempts) await this.sleep(this.backoff(attempt, undefined));
        continue;
      }

      this.log('smoobu.request', { status: response.status, attempt });
      if (response.ok) {
        try {
          return (await response.json()) as unknown;
        } catch {
          throw this.shapeError(spec.path);
        }
      }

      lastStatus = response.status;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) break;
      const hinted = retryAfterMs(response.headers, this.auth.now());
      if (response.status === 429 && hinted !== undefined) {
        // Smoobu's limit is account-wide: pause every caller, not just this call.
        this.cooldownUntil = Math.max(this.cooldownUntil, this.auth.now().getTime() + Math.min(hinted, this.maxCooldownMs));
      }
      if (hinted !== undefined && hinted > this.retry.maxDelayMs) {
        // Smoobu asked for a longer pause than we are willing to hold a request open: fail now, retry later.
        this.log('smoobu.failed', { status: response.status, attempts: attemptsMade, retryAfterTooLong: true });
        throw new SmoobuUpstreamError(response.status, attemptsMade);
      }
      this.log('smoobu.retry', { attempt, status: response.status });
      if (attempt < this.retry.maxAttempts) await this.sleep(this.backoff(attempt, hinted));
    }

    this.log('smoobu.failed', { status: lastStatus ?? -1, attempts: attemptsMade });
    throw new SmoobuUpstreamError(lastStatus, attemptsMade);
  }

  private backoff(attempt: number, hinted: number | undefined): number {
    const exp = this.retry.baseDelayMs * 2 ** (attempt - 1);
    const jitter = exp * 0.25 * this.random();
    const delay = hinted ?? exp + jitter;
    return Math.min(this.retry.maxDelayMs, Math.max(0, delay));
  }
}

/** Upstream numbers only reach rejection texts when they are plausible integers. */
function saneInt(value: number | undefined, max: number): number | null {
  if (value === undefined || !Number.isInteger(value) || value < 0 || value > max) return null;
  return value;
}

/** Honour `Retry-After` (seconds) or Smoobu's `X-RateLimit-Retry-After` (unix seconds). */
export function retryAfterMs(headers: Headers, now: Date): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) return Number(retryAfter) * 1000;
  const smoobu = headers.get('x-ratelimit-retry-after');
  if (smoobu !== null && /^\d+$/.test(smoobu.trim())) {
    const ms = Number(smoobu) * 1000 - now.getTime();
    return ms > 0 ? ms : 0;
  }
  return undefined;
}
