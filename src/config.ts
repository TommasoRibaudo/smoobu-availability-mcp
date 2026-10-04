import { validateBookingUrlTemplate } from './booking.js';

export interface AppConfig {
  readonly smoobuApiKey: string;
  readonly smoobuApiSecret: string | undefined;
  readonly smoobuCustomerId: number;
  readonly smoobuBaseUrl: string | undefined;
  readonly bookingUrlTemplate: string;
  readonly rateLimitPerMinute: number;
  readonly rateLimitBurst: number;
  readonly cacheTtlRatesMs: number;
  readonly cacheTtlAvailabilityMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (v === undefined || v.length === 0) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function optionalInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name]?.trim();
  if (v === undefined || v.length === 0) return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer`);
  return Number(v);
}

/** Reads and validates configuration. Error messages name variables, never values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const customerIdRaw = required(env, 'SMOOBU_CUSTOMER_ID');
  if (!/^[1-9]\d*$/.test(customerIdRaw)) throw new Error('SMOOBU_CUSTOMER_ID must be a positive integer');
  const bookingUrlTemplate = required(env, 'BOOKING_URL_TEMPLATE');
  validateBookingUrlTemplate(bookingUrlTemplate);
  const secret = env['SMOOBU_API_SECRET']?.trim();

  return {
    smoobuApiKey: required(env, 'SMOOBU_API_KEY'),
    smoobuApiSecret: secret !== undefined && secret.length > 0 ? secret : undefined,
    smoobuCustomerId: Number(customerIdRaw),
    smoobuBaseUrl: env['SMOOBU_BASE_URL']?.trim() || undefined,
    bookingUrlTemplate,
    rateLimitPerMinute: optionalInt(env, 'RATE_LIMIT_PER_MINUTE', 60),
    rateLimitBurst: optionalInt(env, 'RATE_LIMIT_BURST', 20),
    cacheTtlRatesMs: optionalInt(env, 'CACHE_TTL_RATES_SECONDS', 300) * 1000,
    cacheTtlAvailabilityMs: optionalInt(env, 'CACHE_TTL_AVAILABILITY_SECONDS', 120) * 1000,
  };
}
