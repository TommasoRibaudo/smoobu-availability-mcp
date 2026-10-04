import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { buildBookingUrl } from '../booking.js';
import type { CatalogProperty } from '../catalog.js';
import { maxGuestsAcross } from '../catalog.js';
import { PRICE_NOTE, checkAvailabilityOutput } from '../schemas.js';
import type { AvailabilityResult, CheckAvailabilityOutput } from '../schemas.js';
import type { AvailabilityOutcome } from '../smoobu/types.js';
import { MAX_MONTHS_AHEAD, MAX_NIGHTS, parseIsoDate, validateStay } from '../validation.js';
import type { ToolDeps } from './shared.js';
import { READ_ONLY_ANNOTATIONS, guarded, ok, requireProperty, roundMoney, today } from './shared.js';

export const CHECK_AVAILABILITY_DESCRIPTION = `Check whether the properties are available for a stay and what it would cost.

Checks arrival/departure/guests against the live booking calendar, applying each property's rules (minimum stay, allowed check-in days, lead time) and any length-of-stay discounts. For each property you get either \`available: true\` with the total price, nightly average and a booking link, or \`available: false\` with a plain-language reason such as "Minimum stay is 3 nights for these dates".

Arguments:
- arrival: check-in date, YYYY-MM-DD. Today (Costa Rica time) or later, at most ${MAX_MONTHS_AHEAD} months ahead.
- departure: check-out date, YYYY-MM-DD. 1 to ${MAX_NIGHTS} nights after arrival.
- guests: number of guests, 1 or more. Properties that sleep fewer guests are reported as unavailable.
- property (optional): a slug from list_properties to check a single property. Omit to check all of them.

Prices exclude taxes and fees. Totals are for the whole stay in the property's currency.

Examples:
- check_availability({ "arrival": "2027-02-10", "departure": "2027-02-15", "guests": 2 })
- check_availability({ "arrival": "2027-02-10", "departure": "2027-02-15", "guests": 4, "property": "casa-caribe" })`;

export const checkAvailabilityInput = {
  arrival: z.string().describe('Check-in date, YYYY-MM-DD'),
  departure: z.string().describe('Check-out date, YYYY-MM-DD'),
  guests: z.number().int().min(1).max(50).describe('Number of guests (1 or more)'),
  property: z.string().max(80).optional().describe('Property slug from list_properties; omit to check every property'),
};

export interface CheckAvailabilityArgs {
  readonly arrival: string;
  readonly departure: string;
  readonly guests: number;
  readonly property?: string | undefined;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Plain-language reason built only from rule codes and numbers, never from Smoobu text. */
export function describeRejection(outcome: Extract<AvailabilityOutcome, { available: false }>, ctx: { arrival: string; nights: number; maxGuests: number }): string {
  switch (outcome.errorCode) {
    case 400:
      return `This property sleeps up to ${outcome.numberOfGuest ?? ctx.maxGuests} guests.`;
    case 401:
      return outcome.minimumLengthOfStay !== null
        ? `Minimum stay is ${outcome.minimumLengthOfStay} nights for these dates (${ctx.nights} requested).`
        : `The stay is shorter than the minimum required for these dates (${ctx.nights} nights requested).`;
    case 402: {
      const weekday = WEEKDAYS[new Date(parseIsoDate(ctx.arrival, 'arrival')).getUTCDay()] ?? 'that day';
      return `Check-in on a ${weekday} is not allowed for this property; try a different arrival date.`;
    }
    case 403:
      return outcome.leadTime !== null
        ? `Arrival is too soon: this property needs at least ${outcome.leadTime} days' notice.`
        : 'Arrival is too soon for this property; try a later arrival date.';
    case 404:
      return outcome.minimumLengthBetweenBookings !== null
        ? `These dates do not leave the required ${outcome.minimumLengthBetweenBookings}-night gap between stays; try shifting arrival or departure.`
        : 'These dates do not leave the required gap between stays; try shifting arrival or departure.';
    default:
      return 'Not available for these dates.';
  }
}

export async function runCheckAvailability(deps: ToolDeps, args: CheckAvailabilityArgs): Promise<CheckAvailabilityOutput> {
  const candidates: readonly CatalogProperty[] = args.property === undefined ? deps.catalog : [requireProperty(deps, args.property)];
  const stay = validateStay({
    arrival: args.arrival,
    departure: args.departure,
    guests: args.guests,
    today: today(deps),
    maxGuests: maxGuestsAcross(candidates),
  });

  const fits = candidates.filter((p) => p.maxGuests >= stay.guests);
  const ids = fits.map((p) => p.smoobuApartmentId).sort((a, b) => a - b);
  const outcomes =
    ids.length === 0
      ? new Map<number, AvailabilityOutcome>()
      : (
          await deps.loader.load(`avail:${ids.join(',')}:${stay.arrival}:${stay.departure}:${stay.guests}`, deps.cacheTtlAvailabilityMs, () =>
            deps.smoobu.checkAvailability({ arrivalDate: stay.arrival, departureDate: stay.departure, apartmentIds: ids, guests: stay.guests }),
          )
        ).value;

  const results: AvailabilityResult[] = candidates.map((p): AvailabilityResult => {
    if (p.maxGuests < stay.guests) {
      return { slug: p.slug, name: p.name, available: false, reason: `This property sleeps up to ${p.maxGuests} guests (${stay.guests} requested).` };
    }
    const outcome = outcomes.get(p.smoobuApartmentId);
    if (outcome === undefined) return { slug: p.slug, name: p.name, available: false, reason: 'Not available for these dates.' };
    if (!outcome.available) {
      return { slug: p.slug, name: p.name, available: false, reason: describeRejection(outcome, { arrival: stay.arrival, nights: stay.nights, maxGuests: p.maxGuests }) };
    }
    if (outcome.currency.trim().toUpperCase() !== p.currency) {
      // The catalog says what currency a property is priced in; a mismatch is an
      // operator configuration problem, not something to pass through.
      deps.log('smoobu.currency_mismatch', {});
      return { slug: p.slug, name: p.name, available: false, reason: 'Pricing is temporarily unavailable for this property.' };
    }
    const total = roundMoney(outcome.price);
    return {
      slug: p.slug,
      name: p.name,
      available: true,
      currency: p.currency,
      total,
      nightlyAverage: roundMoney(total / stay.nights),
      nights: stay.nights,
      pricesExcludeTaxes: true,
      bookingUrl: buildBookingUrl(deps.bookingUrlTemplate, { property: p.slug, arrival: stay.arrival, departure: stay.departure, guests: stay.guests }),
    };
  });

  return {
    arrival: stay.arrival,
    departure: stay.departure,
    nights: stay.nights,
    guests: stay.guests,
    availableCount: results.filter((r) => r.available).length,
    results,
    note: PRICE_NOTE,
  };
}

export function registerCheckAvailability(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'check_availability',
    {
      title: 'Check availability and price',
      description: CHECK_AVAILABILITY_DESCRIPTION,
      inputSchema: checkAvailabilityInput,
      outputSchema: checkAvailabilityOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args): Promise<CallToolResult> => guarded(deps, async () => ok(checkAvailabilityOutput, await runCheckAvailability(deps, args))),
  );
}
