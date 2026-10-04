import { createApp } from '../src/app.js';
import type { App, AppOverrides } from '../src/app.js';
import { NoopCache } from '../src/cache.js';
import type { CatalogProperty } from '../src/catalog.js';
import type { AppConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import { AllowAllRateLimiter } from '../src/rateLimit.js';
import type { MockApartment } from './mockSmoobu.js';
import { MOCK_BASE_URL, createMockSmoobu } from './mockSmoobu.js';
import type { MockSmoobu } from './mockSmoobu.js';

/** Fixed "now": 2026-10-04 12:00 in Costa Rica (UTC-6) => 18:00Z. */
export const FIXED_NOW = new Date('2026-10-04T18:00:00Z');
export const TODAY = '2026-10-04';

export const TEST_CATALOG: readonly CatalogProperty[] = [
  { slug: 'casa-caribe', name: 'Casa Caribe', bedrooms: 3, maxGuests: 6, currency: 'USD', smoobuApartmentId: 471101 },
  { slug: 'jungle-studio', name: 'Jungle Studio', bedrooms: 1, maxGuests: 2, currency: 'USD', smoobuApartmentId: 471102 },
];

export const MOCK_APARTMENTS: readonly MockApartment[] = [
  { id: 471101, maxGuests: 6, minStay: 3, nightly: 150, unavailableDates: ['2026-12-20', '2026-12-21', '2026-12-22', '2027-01-05'], noArrivalDays: [], currency: 'USD' },
  { id: 471102, maxGuests: 2, minStay: 2, nightly: 80, unavailableDates: ['2026-11-10', '2026-11-11'], noArrivalDays: [0], currency: 'USD' },
];

export const TEST_CONFIG: AppConfig = {
  smoobuApiKey: 'usr_test_key',
  smoobuApiSecret: 'test_secret',
  smoobuCustomerId: 424242,
  smoobuBaseUrl: MOCK_BASE_URL,
  bookingUrlTemplate: 'https://example.com/book?property={property}&from={arrival}&to={departure}&guests={guests}',
  rateLimitPerMinute: 60,
  rateLimitBurst: 20,
  cacheTtlRatesMs: 300_000,
  cacheTtlAvailabilityMs: 120_000,
};

export interface TestApp {
  readonly app: App;
  readonly mock: MockSmoobu;
}

export function createTestApp(overrides: AppOverrides = {}, config: Partial<AppConfig> = {}): TestApp {
  const mock = createMockSmoobu({ apartments: MOCK_APARTMENTS });
  const app = createApp(
    { ...TEST_CONFIG, ...config },
    {
      fetch: mock.fetch,
      catalog: TEST_CATALOG,
      log: silentLogger,
      now: () => FIXED_NOW,
      rateLimiter: new AllowAllRateLimiter(),
      cache: new NoopCache(),
      ...overrides,
    },
  );
  return { app, mock };
}
