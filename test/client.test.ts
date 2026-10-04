import { describe, expect, it } from 'vitest';
import { SmoobuShapeError, SmoobuUpstreamError } from '../src/errors.js';
import type { Logger, LogFields } from '../src/log.js';
import { buildCanonicalString, signCanonicalString } from '../src/smoobu/auth.js';
import type { AuthContext } from '../src/smoobu/auth.js';
import { SmoobuClient, retryAfterMs } from '../src/smoobu/client.js';
import type { SmoobuClientOptions } from '../src/smoobu/client.js';
import { POISON_VALUES } from './fixtures/poison.js';
import { MOCK_APARTMENTS } from './helpers.js';
import { MOCK_BASE_URL, createMockSmoobu } from './mockSmoobu.js';
import type { MockSmoobu } from './mockSmoobu.js';

const CASA = 471101;
const STUDIO = 471102;
const NOW = new Date('2026-04-01T12:00:00Z');
const AUTH: AuthContext = { now: () => NOW, nonce: () => 'test-nonce' };

interface Harness {
  readonly mock: MockSmoobu;
  readonly sleeps: number[];
  readonly client: SmoobuClient;
}

function harness(overrides: Partial<SmoobuClientOptions> = {}, mock: MockSmoobu = createMockSmoobu({ apartments: MOCK_APARTMENTS })): Harness {
  const sleeps: number[] = [];
  const client = new SmoobuClient({
    credentials: { apiKey: 'usr_test_key', apiSecret: 'test_secret' },
    customerId: 424242,
    baseUrl: MOCK_BASE_URL,
    fetch: mock.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
    auth: AUTH,
    ...overrides,
  });
  return { mock, sleeps, client };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected promise to reject');
}

const rates = (client: SmoobuClient) => client.getRates([CASA], '2026-12-18', '2026-12-24');

describe('SmoobuClient authentication', () => {
  it('sends the four HMAC headers and no Api-Key when a secret is configured', async () => {
    const { client, mock } = harness();
    await rates(client);
    const headers = mock.calls[0]?.headers;
    expect(headers?.get('x-api-key')).toBe('usr_test_key');
    expect(headers?.get('x-timestamp')).toBe('2026-04-01T12:00:00Z');
    expect(headers?.get('x-nonce')).toBe('test-nonce');
    expect(headers?.get('x-signature')).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(headers?.has('api-key')).toBe(false);
    expect(headers?.get('accept')).toBe('application/json');
  });

  it('signs exactly the request it sends (GET with repeated query keys)', async () => {
    const { client, mock } = harness();
    await client.getRates([CASA, STUDIO], '2026-12-18', '2026-12-24');
    const call = mock.calls[0];
    expect(call).toBeDefined();
    const canonical = buildCanonicalString({
      method: 'GET',
      path: '/api/rates',
      query: [...(call?.query.entries() ?? [])],
      body: '',
      timestamp: '2026-04-01T12:00:00Z',
      nonce: 'test-nonce',
      apiKey: 'usr_test_key',
    });
    expect(call?.headers.get('x-signature')).toBe(signCanonicalString(canonical, 'test_secret'));
  });

  it('signs the exact JSON body of a POST', async () => {
    const { client, mock } = harness();
    await client.checkAvailability({ arrivalDate: '2026-11-02', departureDate: '2026-11-04', apartmentIds: [STUDIO], guests: 2 });
    const call = mock.calls[0];
    const canonical = buildCanonicalString({
      method: 'POST',
      path: '/booking/checkApartmentAvailability',
      query: [],
      body: JSON.stringify(call?.body),
      timestamp: '2026-04-01T12:00:00Z',
      nonce: 'test-nonce',
      apiKey: 'usr_test_key',
    });
    expect(call?.headers.get('x-signature')).toBe(signCanonicalString(canonical, 'test_secret'));
    expect(call?.headers.get('content-type')).toBe('application/json');
  });

  it('uses the legacy Api-Key header when no secret is configured', async () => {
    const { client, mock } = harness({ credentials: { apiKey: 'usr_test_key' } });
    await rates(client);
    const headers = mock.calls[0]?.headers;
    expect(headers?.get('api-key')).toBe('usr_test_key');
    expect(headers?.has('x-signature')).toBe(false);
    expect(headers?.has('x-api-key')).toBe(false);
  });

  it('uses the legacy header when the secret is an empty string', async () => {
    const { client, mock } = harness({ credentials: { apiKey: 'usr_test_key', apiSecret: '' } });
    await rates(client);
    expect(mock.calls[0]?.headers.get('api-key')).toBe('usr_test_key');
  });

  it('generates a fresh signature per attempt when the nonce changes', async () => {
    let n = 0;
    const { client, mock } = harness({ auth: { now: () => NOW, nonce: () => `nonce-${++n}` } });
    mock.failNext(503, 1);
    await rates(client);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]?.headers.get('x-nonce')).toBe('nonce-1');
    expect(mock.calls[1]?.headers.get('x-nonce')).toBe('nonce-2');
    expect(mock.calls[0]?.headers.get('x-signature')).not.toBe(mock.calls[1]?.headers.get('x-signature'));
  });
});

describe('SmoobuClient.getRates', () => {
  it('sends start_date, end_date and one apartments[] per id', async () => {
    const { client, mock } = harness();
    await client.getRates([CASA, STUDIO], '2026-12-18', '2026-12-24');
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.path).toBe('/api/rates');
    expect(call?.query.get('start_date')).toBe('2026-12-18');
    expect(call?.query.get('end_date')).toBe('2026-12-24');
    expect(call?.query.getAll('apartments[]')).toEqual([String(CASA), String(STUDIO)]);
  });

  it('returns a Map keyed by apartment id with RateDay values', async () => {
    const { client } = harness();
    const result = await client.getRates([CASA], '2026-12-19', '2026-12-23');
    expect([...result.keys()]).toEqual([CASA]);
    const days = result.get(CASA);
    expect([...(days?.keys() ?? [])]).toEqual(['2026-12-19', '2026-12-20', '2026-12-21', '2026-12-22', '2026-12-23']);
    expect(days?.get('2026-12-19')).toEqual({ price: 150 + (19 % 5) * 10, minLengthOfStay: 3, available: true });
  });

  it('maps available 0 to false and 1 to true', async () => {
    const { client } = harness();
    const days = (await client.getRates([CASA], '2026-12-19', '2026-12-23')).get(CASA);
    expect([...(days?.values() ?? [])].map((d) => d.available)).toEqual([true, false, false, false, true]);
  });

  it('exposes only the RateDay keys, with no guest data', async () => {
    const { client } = harness();
    const days = (await client.getRates([CASA], '2026-12-19', '2026-12-23')).get(CASA);
    for (const day of days?.values() ?? []) expect(Object.keys(day).sort()).toEqual(['available', 'minLengthOfStay', 'price']);
    expect(JSON.stringify([...(days?.entries() ?? [])])).not.toMatch(new RegExp(POISON_VALUES.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')));
  });

  it('maps ids absent from the upstream data to an empty Map', async () => {
    const { client } = harness();
    const result = await client.getRates([CASA, 999_999], '2026-12-19', '2026-12-20');
    expect(result.get(999_999)).toEqual(new Map());
    expect(result.get(CASA)?.size).toBe(2);
  });

  it('treats missing price / min stay as null and booleans or 1 as available', async () => {
    const upstream = {
      data: { '1': { '2026-12-01': { available: true }, '2026-12-02': { price: null, min_length_of_stay: null, available: 0 }, '2026-12-03': {} } },
    };
    const { client } = harness({ fetch: () => Promise.resolve(new Response(JSON.stringify(upstream), { status: 200 })) });
    const days = (await client.getRates([1], '2026-12-01', '2026-12-03')).get(1);
    expect(days?.get('2026-12-01')).toEqual({ price: null, minLengthOfStay: null, available: true });
    expect(days?.get('2026-12-02')).toEqual({ price: null, minLengthOfStay: null, available: false });
    expect(days?.get('2026-12-03')).toEqual({ price: null, minLengthOfStay: null, available: false });
  });
});

describe('SmoobuClient.checkAvailability', () => {
  it('posts arrivalDate, departureDate, apartments, customerId and guests', async () => {
    const { client, mock } = harness();
    await client.checkAvailability({ arrivalDate: '2026-11-02', departureDate: '2026-11-04', apartmentIds: [CASA, STUDIO], guests: 2 });
    const call = mock.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe('/booking/checkApartmentAvailability');
    expect(call?.body).toEqual({ arrivalDate: '2026-11-02', departureDate: '2026-11-04', apartments: [CASA, STUDIO], customerId: 424242, guests: 2 });
  });

  it('returns price and currency for an available apartment', async () => {
    const { client } = harness();
    const result = await client.checkAvailability({ arrivalDate: '2026-11-02', departureDate: '2026-11-04', apartmentIds: [STUDIO], guests: 2 });
    const outcome = result.get(STUDIO);
    expect(outcome).toEqual({ available: true, price: 80 + 20 + (80 + 30), currency: 'USD' });
    expect(Object.keys(outcome ?? {}).sort()).toEqual(['available', 'currency', 'price']);
  });

  it('turns a minimum-stay rejection into available:false with errorCode 401 and nulls elsewhere', async () => {
    const { client } = harness();
    const result = await client.checkAvailability({ arrivalDate: '2026-11-02', departureDate: '2026-11-04', apartmentIds: [CASA], guests: 2 });
    const outcome = result.get(CASA);
    expect(outcome).toEqual({
      available: false,
      errorCode: 401,
      minimumLengthOfStay: 3,
      numberOfGuest: null,
      leadTime: null,
      minimumLengthBetweenBookings: null,
    });
    expect(Object.keys(outcome ?? {}).sort()).toEqual(['available', 'errorCode', 'leadTime', 'minimumLengthBetweenBookings', 'minimumLengthOfStay', 'numberOfGuest']);
  });

  it('reports the guest limit for a too-large party', async () => {
    const { client } = harness();
    const result = await client.checkAvailability({ arrivalDate: '2026-11-02', departureDate: '2026-11-04', apartmentIds: [STUDIO], guests: 4 });
    expect(result.get(STUDIO)).toMatchObject({ available: false, errorCode: 400, numberOfGuest: 2 });
  });

  it('drops free-text messages and guest data from a booked apartment', async () => {
    const { client } = harness();
    const result = await client.checkAvailability({ arrivalDate: '2026-12-20', departureDate: '2026-12-23', apartmentIds: [CASA], guests: 2 });
    const outcome = result.get(CASA);
    expect(outcome?.available).toBe(false);
    expect(Object.keys(outcome ?? {}).sort()).toEqual(['available', 'errorCode', 'leadTime', 'minimumLengthBetweenBookings', 'minimumLengthOfStay', 'numberOfGuest']);
    const serialized = JSON.stringify(outcome);
    for (const value of POISON_VALUES) expect(serialized).not.toContain(value);
  });

  it('gives an id missing from both lists available:false with errorCode null', async () => {
    const { client } = harness();
    const result = await client.checkAvailability({ arrivalDate: '2026-11-02', departureDate: '2026-11-04', apartmentIds: [STUDIO, 999_999], guests: 2 });
    expect(result.get(999_999)).toEqual({
      available: false,
      errorCode: null,
      minimumLengthOfStay: null,
      numberOfGuest: null,
      leadTime: null,
      minimumLengthBetweenBookings: null,
    });
  });

  it('includes every requested id in the result', async () => {
    const { client } = harness();
    const result = await client.checkAvailability({ arrivalDate: '2026-11-02', departureDate: '2026-11-04', apartmentIds: [CASA, STUDIO, 999_999], guests: 2 });
    expect([...result.keys()]).toEqual([CASA, STUDIO, 999_999]);
  });
});

describe('SmoobuClient retries', () => {
  it('retries 429 twice and then succeeds', async () => {
    const { client, mock } = harness();
    mock.failNext(429, 2);
    const result = await rates(client);
    expect(result.get(CASA)?.size).toBe(7);
    expect(mock.calls).toHaveLength(3);
  });

  it('retries a 5xx and then succeeds', async () => {
    const { client, mock } = harness();
    mock.failNext(500, 1);
    await rates(client);
    expect(mock.calls).toHaveLength(2);
  });

  it('gives up after maxAttempts with a SmoobuUpstreamError that leaks no upstream content', async () => {
    const { client, mock } = harness({ retry: { maxAttempts: 3 } });
    mock.failNext(503, 3);
    const err = await rejection(rates(client));
    expect(err).toBeInstanceOf(SmoobuUpstreamError);
    const upstream = err as SmoobuUpstreamError;
    expect(upstream.status).toBe(503);
    expect(upstream.attempts).toBe(3);
    expect(upstream.message).not.toContain('upstream failure');
    for (const value of POISON_VALUES) expect(upstream.message).not.toContain(value);
    expect(mock.calls).toHaveLength(3);
  });

  it('honours a custom maxAttempts', async () => {
    const { client, mock } = harness({ retry: { maxAttempts: 5 } });
    mock.failNext(502, 10);
    const err = await rejection(rates(client));
    expect(err).toBeInstanceOf(SmoobuUpstreamError);
    expect(mock.calls).toHaveLength(5);
  });

  it.each([400, 401, 403, 404])('does not retry a %i', async (status) => {
    const { client, mock, sleeps } = harness();
    mock.failNext(status, 1);
    const err = await rejection(rates(client));
    expect(err).toBeInstanceOf(SmoobuUpstreamError);
    expect((err as SmoobuUpstreamError).status).toBe(status);
    expect(mock.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('retries a network error and then succeeds', async () => {
    const mock = createMockSmoobu({ apartments: MOCK_APARTMENTS });
    let calls = 0;
    const flaky: typeof fetch = (input, init) => {
      calls++;
      if (calls === 1) return Promise.reject(new TypeError('fetch failed: ECONNRESET secret-host.internal'));
      return mock.fetch(input, init);
    };
    const { client } = harness({ fetch: flaky }, mock);
    const result = await rates(client);
    expect(result.get(CASA)?.size).toBe(7);
    expect(calls).toBe(2);
  });

  it('reports a persistent network failure as an upstream error without a status or the cause', async () => {
    const failing: typeof fetch = () => Promise.reject(new TypeError('fetch failed: secret-host.internal'));
    const { client } = harness({ fetch: failing, retry: { maxAttempts: 2 } });
    const err = await rejection(rates(client));
    expect(err).toBeInstanceOf(SmoobuUpstreamError);
    expect((err as SmoobuUpstreamError).status).toBeUndefined();
    expect((err as SmoobuUpstreamError).message).not.toContain('secret-host');
  });

  it('does not sleep after the final failed attempt', async () => {
    const { client, mock, sleeps } = harness({ retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000 } });
    mock.failNext(503, 3);
    await rejection(rates(client));
    expect(sleeps).toHaveLength(2);
  });
});

describe('SmoobuClient backoff timing', () => {
  const retry = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000 };

  it('doubles the delay: two 503s then success sleeps 100 then 200', async () => {
    const { client, mock, sleeps } = harness({ retry });
    mock.failNext(503, 2);
    await rates(client);
    expect(sleeps).toEqual([100, 200]);
  });

  it('adds up to 25% jitter scaled by random()', async () => {
    const { client, mock, sleeps } = harness({ retry, random: () => 1 });
    mock.failNext(503, 2);
    await rates(client);
    expect(sleeps).toEqual([125, 250]);
  });

  it('honours a Retry-After header in seconds', async () => {
    const { client, mock, sleeps } = harness({ retry });
    mock.failNext(429, 1, { 'Retry-After': '2' });
    await rates(client);
    expect(sleeps).toEqual([2000]);
  });

  it('honours X-RateLimit-Retry-After as a unix timestamp relative to the injected clock', async () => {
    const { client, mock, sleeps } = harness({ retry });
    mock.failNext(429, 1, { 'X-RateLimit-Retry-After': String(Math.floor(NOW.getTime() / 1000) + 5) });
    await rates(client);
    expect(sleeps).toEqual([5000]);
  });

  it('caps computed delays at maxDelayMs', async () => {
    const { client, mock, sleeps } = harness({ retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 250 } });
    mock.failNext(503, 3);
    await rates(client);
    expect(sleeps).toEqual([100, 200, 250]);
  });

  it('fails fast instead of waiting when Retry-After exceeds maxDelayMs, and cools down later calls', async () => {
    const { client, mock, sleeps } = harness({ retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 3000 } });
    mock.failNext(429, 1, { 'Retry-After': '3600' });
    const err = await rejection(rates(client));
    expect(err).toBeInstanceOf(SmoobuUpstreamError);
    expect((err as SmoobuUpstreamError).status).toBe(429);
    expect(sleeps).toEqual([]);
    expect(mock.calls).toHaveLength(1);
    // Smoobu's limit is account-wide: the next call is refused without a network request.
    const second = await rejection(rates(client));
    expect((second as SmoobuUpstreamError).status).toBe(429);
    expect((second as SmoobuUpstreamError).attempts).toBe(0);
    expect(mock.calls).toHaveLength(1);
  });

  it('honours a short Retry-After and does not cool down beyond it', async () => {
    const { client, mock, sleeps } = harness({ retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 3000 } });
    mock.failNext(429, 1, { 'Retry-After': '2' });
    await rates(client);
    expect(sleeps).toEqual([2000]);
    expect(mock.calls).toHaveLength(2);
  });

  it('uses the exponential backoff when Retry-After is unusable', async () => {
    const { client, mock, sleeps } = harness({ retry });
    mock.failNext(429, 1, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    await rates(client);
    expect(sleeps).toEqual([100]);
  });

  it('backs off between network failures too', async () => {
    const mock = createMockSmoobu({ apartments: MOCK_APARTMENTS });
    let calls = 0;
    const flaky: typeof fetch = (input, init) => (++calls <= 2 ? Promise.reject(new TypeError('fetch failed')) : mock.fetch(input, init));
    const { client, sleeps } = harness({ fetch: flaky, retry }, mock);
    await rates(client);
    expect(sleeps).toEqual([100, 200]);
  });
});

describe('retryAfterMs', () => {
  it('parses Retry-After seconds', () => {
    expect(retryAfterMs(new Headers({ 'Retry-After': '2' }), NOW)).toBe(2000);
    expect(retryAfterMs(new Headers({ 'Retry-After': '0' }), NOW)).toBe(0);
  });

  it('parses X-RateLimit-Retry-After as unix seconds', () => {
    const at = Math.floor(NOW.getTime() / 1000) + 5;
    expect(retryAfterMs(new Headers({ 'X-RateLimit-Retry-After': String(at) }), NOW)).toBe(5000);
  });

  it('returns 0 when the unix timestamp is already in the past', () => {
    const at = Math.floor(NOW.getTime() / 1000) - 30;
    expect(retryAfterMs(new Headers({ 'X-RateLimit-Retry-After': String(at) }), NOW)).toBe(0);
  });

  it('prefers Retry-After over X-RateLimit-Retry-After', () => {
    const headers = new Headers({ 'Retry-After': '1', 'X-RateLimit-Retry-After': String(Math.floor(NOW.getTime() / 1000) + 50) });
    expect(retryAfterMs(headers, NOW)).toBe(1000);
  });

  it('returns undefined when absent or not numeric', () => {
    expect(retryAfterMs(new Headers(), NOW)).toBeUndefined();
    expect(retryAfterMs(new Headers({ 'Retry-After': 'soon' }), NOW)).toBeUndefined();
    expect(retryAfterMs(new Headers({ 'Retry-After': '-5' }), NOW)).toBeUndefined();
    expect(retryAfterMs(new Headers({ 'Retry-After': '1.5' }), NOW)).toBeUndefined();
    expect(retryAfterMs(new Headers({ 'X-RateLimit-Retry-After': 'abc' }), NOW)).toBeUndefined();
  });
});

describe('SmoobuClient response shape handling', () => {
  it('throws SmoobuShapeError when the rates response has an unexpected shape', async () => {
    const { client, mock } = harness();
    mock.garbageNext();
    const err = await rejection(rates(client));
    expect(err).toBeInstanceOf(SmoobuShapeError);
    expect((err as Error).message).toBe('Unexpected response shape from /api/rates');
    for (const value of POISON_VALUES) expect((err as Error).message).not.toContain(value);
  });

  it('throws SmoobuShapeError when the apartments response has an unexpected shape', async () => {
    const { client, mock } = harness();
    mock.garbageNext();
    expect(await rejection(client.listApartmentIds())).toBeInstanceOf(SmoobuShapeError);
  });

  it('throws SmoobuShapeError (not a raw SyntaxError) for a 200 that is not JSON', async () => {
    const { client } = harness({ fetch: () => Promise.resolve(new Response('<html>oops</html>', { status: 200 })) });
    expect(await rejection(rates(client))).toBeInstanceOf(SmoobuShapeError);
  });

  it('does not retry a shape error', async () => {
    const { client, mock } = harness();
    mock.garbageNext();
    await rejection(rates(client));
    expect(mock.calls).toHaveLength(1);
  });

  it('listApartmentIds returns only the ids', async () => {
    const { client } = harness();
    expect(await client.listApartmentIds()).toEqual([CASA, STUDIO]);
  });
});

describe('SmoobuClient logging', () => {
  it('only ever logs numbers and booleans for a 429-then-success sequence', async () => {
    const recorded: { event: string; fields: LogFields | undefined }[] = [];
    const log: Logger = (event, fields) => {
      recorded.push({ event, fields });
    };
    const { client, mock } = harness({ log });
    mock.failNext(429, 1);
    await rates(client);

    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.map((r) => r.event)).toEqual(['smoobu.request', 'smoobu.retry', 'smoobu.request']);
    for (const { fields } of recorded) {
      for (const [key, value] of Object.entries(fields ?? {})) {
        expect(['number', 'boolean'], `field ${key}`).toContain(typeof value);
      }
    }
    expect(recorded[0]?.fields).toEqual({ status: 429, attempt: 1 });
    expect(recorded[2]?.fields).toEqual({ status: 200, attempt: 2 });
  });

  it('logs only numbers and booleans when the request finally fails', async () => {
    const recorded: (LogFields | undefined)[] = [];
    const { client, mock } = harness({ log: (_event, fields) => void recorded.push(fields), retry: { maxAttempts: 2 } });
    mock.failNext(503, 2);
    await rejection(rates(client));
    for (const fields of recorded) for (const value of Object.values(fields ?? {})) expect(['number', 'boolean']).toContain(typeof value);
    expect(recorded.at(-1)).toEqual({ status: 503, attempts: 2 });
  });

  it('never logs credentials or upstream text', async () => {
    const lines: string[] = [];
    const { client, mock } = harness({ log: (event, fields) => void lines.push(JSON.stringify({ event, ...fields })) });
    mock.failNext(429, 1);
    await rates(client);
    const all = lines.join('\n');
    expect(all).not.toContain('usr_test_key');
    expect(all).not.toContain('test_secret');
    expect(all).not.toContain('upstream failure');
    for (const value of POISON_VALUES) expect(all).not.toContain(value);
  });
});
