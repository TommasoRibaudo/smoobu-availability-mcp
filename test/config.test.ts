import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const TEMPLATE = 'https://example.com/book?property={property}&from={arrival}&to={departure}&guests={guests}';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    SMOOBU_API_KEY: 'key_value_AAA',
    SMOOBU_API_SECRET: 'secret_value_BBB',
    SMOOBU_CUSTOMER_ID: '424242',
    BOOKING_URL_TEMPLATE: TEMPLATE,
    ...overrides,
  };
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  return out;
}

function errorOf(e: NodeJS.ProcessEnv): Error {
  try {
    loadConfig(e);
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('parses a complete environment', () => {
    const cfg = loadConfig(
      env({
        SMOOBU_BASE_URL: 'https://smoobu.example.test',
        RATE_LIMIT_PER_MINUTE: '30',
        RATE_LIMIT_BURST: '5',
        CACHE_TTL_RATES_SECONDS: '10',
        CACHE_TTL_AVAILABILITY_SECONDS: '20',
      }),
    );
    expect(cfg).toEqual({
      smoobuApiKey: 'key_value_AAA',
      smoobuApiSecret: 'secret_value_BBB',
      smoobuCustomerId: 424242,
      smoobuBaseUrl: 'https://smoobu.example.test',
      bookingUrlTemplate: TEMPLATE,
      rateLimitPerMinute: 30,
      rateLimitBurst: 5,
      cacheTtlRatesMs: 10_000,
      cacheTtlAvailabilityMs: 20_000,
    });
    expect(typeof cfg.smoobuCustomerId).toBe('number');
  });

  it('applies defaults for optional values', () => {
    const cfg = loadConfig(env());
    expect(cfg.rateLimitPerMinute).toBe(60);
    expect(cfg.rateLimitBurst).toBe(20);
    expect(cfg.cacheTtlRatesMs).toBe(300_000);
    expect(cfg.cacheTtlAvailabilityMs).toBe(120_000);
    expect(cfg.smoobuBaseUrl).toBeUndefined();
  });

  it('treats blank optional values as unset', () => {
    const cfg = loadConfig(env({ RATE_LIMIT_PER_MINUTE: '  ', CACHE_TTL_RATES_SECONDS: '', SMOOBU_BASE_URL: ' ' }));
    expect(cfg.rateLimitPerMinute).toBe(60);
    expect(cfg.cacheTtlRatesMs).toBe(300_000);
    expect(cfg.smoobuBaseUrl).toBeUndefined();
  });

  it('accepts 0 for an optional integer (e.g. disabling the cache TTL)', () => {
    expect(loadConfig(env({ CACHE_TTL_RATES_SECONDS: '0' })).cacheTtlRatesMs).toBe(0);
  });

  it('rejects a non-numeric optional integer, naming the variable but not the value', () => {
    const err = errorOf(env({ RATE_LIMIT_PER_MINUTE: 'lots_of_requests' }));
    expect(err.message).toContain('RATE_LIMIT_PER_MINUTE');
    expect(err.message).not.toContain('lots_of_requests');
  });

  it('rejects negative and fractional optional integers', () => {
    expect(() => loadConfig(env({ RATE_LIMIT_BURST: '-1' }))).toThrow(/RATE_LIMIT_BURST/);
    expect(() => loadConfig(env({ CACHE_TTL_AVAILABILITY_SECONDS: '1.5' }))).toThrow(/CACHE_TTL_AVAILABILITY_SECONDS/);
  });

  it('turns an empty SMOOBU_API_SECRET into undefined', () => {
    expect(loadConfig(env({ SMOOBU_API_SECRET: '' })).smoobuApiSecret).toBeUndefined();
    expect(loadConfig(env({ SMOOBU_API_SECRET: '   ' })).smoobuApiSecret).toBeUndefined();
  });

  it('leaves SMOOBU_API_SECRET undefined when absent', () => {
    expect(loadConfig(env({ SMOOBU_API_SECRET: undefined })).smoobuApiSecret).toBeUndefined();
  });

  it('trims surrounding whitespace from values', () => {
    const cfg = loadConfig(env({ SMOOBU_API_KEY: '  key_value_AAA  ', SMOOBU_CUSTOMER_ID: ' 7 ' }));
    expect(cfg.smoobuApiKey).toBe('key_value_AAA');
    expect(cfg.smoobuCustomerId).toBe(7);
  });

  it.each(['SMOOBU_API_KEY', 'SMOOBU_CUSTOMER_ID', 'BOOKING_URL_TEMPLATE'])('throws naming %s when it is missing, without echoing other values', (name) => {
    const err = errorOf(env({ [name]: undefined }));
    expect(err.message).toContain(name);
    for (const secretish of ['key_value_AAA', 'secret_value_BBB', '424242', 'example.com']) {
      expect(err.message).not.toContain(secretish);
    }
  });

  it('treats an empty or whitespace-only required value as missing', () => {
    expect(() => loadConfig(env({ SMOOBU_API_KEY: '' }))).toThrow(/SMOOBU_API_KEY/);
    expect(() => loadConfig(env({ SMOOBU_API_KEY: '   ' }))).toThrow(/SMOOBU_API_KEY/);
  });

  it.each(['abc', '12ab', '-5', '1.5', '4 2'])('rejects non-numeric SMOOBU_CUSTOMER_ID %j without echoing it', (value) => {
    const err = errorOf(env({ SMOOBU_CUSTOMER_ID: value }));
    expect(err.message).toContain('SMOOBU_CUSTOMER_ID');
    expect(err.message).not.toContain(value);
    expect(err.message).not.toContain('key_value_AAA');
  });

  it('rejects an invalid BOOKING_URL_TEMPLATE', () => {
    expect(() => loadConfig(env({ BOOKING_URL_TEMPLATE: 'ftp://example.com/?a={arrival}&d={departure}' }))).toThrow(/BOOKING_URL_TEMPLATE/);
    expect(() => loadConfig(env({ BOOKING_URL_TEMPLATE: 'https://example.com/' }))).toThrow(/BOOKING_URL_TEMPLATE/);
  });
});
