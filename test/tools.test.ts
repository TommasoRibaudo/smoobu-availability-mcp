import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../src/cache.js';
import { UserFacingError } from '../src/errors.js';
import { describeRejection, runCheckAvailability } from '../src/tools/checkAvailability.js';
import { runGetBookingLink } from '../src/tools/getBookingLink.js';
import { runGetCalendar } from '../src/tools/getCalendar.js';
import { runListProperties } from '../src/tools/listProperties.js';
import { createTestApp } from './helpers.js';

describe('describeRejection maps Smoobu rule codes to fixed sentences', () => {
  const base = { available: false as const, errorCode: null, minimumLengthOfStay: null, numberOfGuest: null, leadTime: null, minimumLengthBetweenBookings: null };
  const ctx = { arrival: '2026-11-08', nights: 2, maxGuests: 4 };

  it.each([
    [{ ...base, errorCode: 400, numberOfGuest: 3 }, 'This property sleeps up to 3 guests.'],
    [{ ...base, errorCode: 400 }, 'This property sleeps up to 4 guests.'],
    [{ ...base, errorCode: 401, minimumLengthOfStay: 3 }, 'Minimum stay is 3 nights for these dates (2 requested).'],
    [{ ...base, errorCode: 401 }, 'The stay is shorter than the minimum required for these dates (2 nights requested).'],
    [{ ...base, errorCode: 402 }, 'Check-in on a Sunday is not allowed for this property; try a different arrival date.'],
    [{ ...base, errorCode: 403, leadTime: 2 }, "Arrival is too soon: this property needs at least 2 days' notice."],
    [{ ...base, errorCode: 403 }, 'Arrival is too soon for this property; try a later arrival date.'],
    [{ ...base, errorCode: 404, minimumLengthBetweenBookings: 1 }, 'These dates do not leave the required 1-night gap between stays; try shifting arrival or departure.'],
    [{ ...base, errorCode: 404 }, 'These dates do not leave the required gap between stays; try shifting arrival or departure.'],
    [{ ...base, errorCode: 500 }, 'Not available for these dates.'],
    [{ ...base }, 'Not available for these dates.'],
  ])('%o', (outcome, expected) => {
    expect(describeRejection(outcome, ctx)).toBe(expected);
  });
});

describe('check_availability', () => {
  it('skips properties that sleep fewer guests without asking Smoobu about them', async () => {
    const { app, mock } = createTestApp();
    const out = await runCheckAvailability(app.deps, { arrival: '2026-11-02', departure: '2026-11-06', guests: 4 });
    expect(mock.calls).toHaveLength(1);
    expect((mock.calls[0]?.body as { apartments: number[] }).apartments).toEqual([471101]);
    expect(out.results.find((r) => r.slug === 'jungle-studio')).toEqual({
      slug: 'jungle-studio',
      name: 'Jungle Studio',
      available: false,
      reason: 'This property sleeps up to 2 guests (4 requested).',
    });
    expect(out.results.find((r) => r.slug === 'casa-caribe')?.available).toBe(true);
  });

  it('does not call Smoobu at all when guests exceed every candidate', async () => {
    const { app, mock } = createTestApp();
    await expect(runCheckAvailability(app.deps, { arrival: '2026-11-02', departure: '2026-11-06', guests: 7 })).rejects.toBeInstanceOf(UserFacingError);
    expect(mock.calls).toHaveLength(0);
  });

  it('uses the property maxGuests when a property is given', async () => {
    const { app } = createTestApp();
    await expect(runCheckAvailability(app.deps, { arrival: '2026-11-02', departure: '2026-11-06', guests: 3, property: 'jungle-studio' })).rejects.toThrow(/between 1 and 2/);
  });

  it('sends arrival, departure, apartments, customerId and guests to Smoobu', async () => {
    const { app, mock } = createTestApp();
    await runCheckAvailability(app.deps, { arrival: '2026-11-02', departure: '2026-11-06', guests: 2 });
    expect(mock.calls[0]?.body).toEqual({ arrivalDate: '2026-11-02', departureDate: '2026-11-06', apartments: [471101, 471102], customerId: 424242, guests: 2 });
  });

  it('caches identical queries and keys the cache on guests too', async () => {
    const { app, mock } = createTestApp({ cache: new MemoryCache() });
    const args = { arrival: '2026-11-02', departure: '2026-11-06', guests: 2 };
    await runCheckAvailability(app.deps, args);
    await runCheckAvailability(app.deps, args);
    expect(mock.calls).toHaveLength(1);
    await runCheckAvailability(app.deps, { ...args, guests: 1 });
    expect(mock.calls).toHaveLength(2);
  });

  it('rounds totals to cents and derives the nightly average', async () => {
    const { app } = createTestApp();
    const out = await runCheckAvailability(app.deps, { arrival: '2026-11-02', departure: '2026-11-05', guests: 2, property: 'casa-caribe' });
    const casa = out.results[0];
    expect(casa?.available).toBe(true);
    if (casa?.available === true) {
      expect(casa.nights).toBe(3);
      expect(casa.total).toBe(150 + 20 + (150 + 30) + (150 + 40));
      expect(casa.nightlyAverage).toBe(Math.round((casa.total / 3) * 100) / 100);
      expect(casa.pricesExcludeTaxes).toBe(true);
    }
  });
});

describe('get_calendar', () => {
  it('reports days missing from the upstream response as unavailable with null price', async () => {
    const { app } = createTestApp({
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ data: { '471101': { '2026-11-01': { price: 100, min_length_of_stay: 2, available: 1 } } } }), { status: 200 })),
    });
    const out = await runGetCalendar(app.deps, { property: 'casa-caribe', from: '2026-11-01', to: '2026-11-03' });
    expect(out.days).toEqual([
      { date: '2026-11-01', available: true, price: 100, minStay: 2 },
      { date: '2026-11-02', available: false, price: null, minStay: null },
      { date: '2026-11-03', available: false, price: null, minStay: null },
    ]);
  });

  it('treats null/zero min stay as unrestricted and null price as null', async () => {
    const { app } = createTestApp({
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: { '471102': { '2026-11-01': { price: null, min_length_of_stay: 0, available: 0 }, '2026-11-02': { price: 99.999, min_length_of_stay: null, available: 1 } } } }), {
            status: 200,
          }),
        ),
    });
    const out = await runGetCalendar(app.deps, { property: 'jungle-studio', from: '2026-11-01', to: '2026-11-02' });
    expect(out.days).toEqual([
      { date: '2026-11-01', available: false, price: null, minStay: null },
      { date: '2026-11-02', available: true, price: 100, minStay: null },
    ]);
  });

  it('caches by property and range', async () => {
    const { app, mock } = createTestApp({ cache: new MemoryCache() });
    await runGetCalendar(app.deps, { property: 'casa-caribe', from: '2026-11-01', to: '2026-11-10' });
    await runGetCalendar(app.deps, { property: 'casa-caribe', from: '2026-11-01', to: '2026-11-10' });
    await runGetCalendar(app.deps, { property: 'jungle-studio', from: '2026-11-01', to: '2026-11-10' });
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]?.query.getAll('apartments[]')).toEqual(['471101']);
    expect(mock.calls[0]?.query.get('start_date')).toBe('2026-11-01');
    expect(mock.calls[0]?.query.get('end_date')).toBe('2026-11-10');
  });
});

describe('list_properties and get_booking_link', () => {
  it('list_properties exposes exactly slug, name, bedrooms, maxGuests', () => {
    const { app } = createTestApp();
    const out = runListProperties(app.deps);
    expect(out.count).toBe(2);
    for (const p of out.properties) expect(Object.keys(p).sort()).toEqual(['bedrooms', 'maxGuests', 'name', 'slug']);
  });

  it('get_booking_link validates the stay against the property and never touches Smoobu', () => {
    const { app, mock } = createTestApp();
    const out = runGetBookingLink(app.deps, { property: 'jungle-studio', arrival: '2026-11-02', departure: '2026-11-05', guests: 2 });
    expect(out.url).toBe('https://example.com/book?property=jungle-studio&from=2026-11-02&to=2026-11-05&guests=2');
    expect(out.nights).toBe(3);
    expect(mock.calls).toHaveLength(0);
    expect(() => runGetBookingLink(app.deps, { property: 'jungle-studio', arrival: '2026-11-02', departure: '2026-11-05', guests: 3 })).toThrow(UserFacingError);
  });
});
