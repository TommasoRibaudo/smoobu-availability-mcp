import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { buildBookingUrl } from '../booking.js';
import { getBookingLinkOutput } from '../schemas.js';
import type { GetBookingLinkOutput } from '../schemas.js';
import { MAX_MONTHS_AHEAD, MAX_NIGHTS, validateStay } from '../validation.js';
import type { ToolDeps } from './shared.js';
import { READ_ONLY_ANNOTATIONS, guarded, ok, requireProperty, today } from './shared.js';

export const GET_BOOKING_LINK_DESCRIPTION = `Build the public booking-page link for a property and stay, with the dates and guest count pre-filled.

This tool does not create a booking and does not check availability; it only returns a URL the guest can open. Call check_availability first to confirm the dates are open.

Arguments:
- property: slug from list_properties.
- arrival / departure: YYYY-MM-DD, today (Costa Rica time) or later, 1 to ${MAX_NIGHTS} nights, at most ${MAX_MONTHS_AHEAD} months ahead.
- guests: number of guests, 1 up to the property's maxGuests.

Example: get_booking_link({ "property": "casa-caribe", "arrival": "2027-02-10", "departure": "2027-02-15", "guests": 2 })`;

export const getBookingLinkInput = {
  property: z.string().max(80).describe('Property slug from list_properties'),
  arrival: z.string().describe('Check-in date, YYYY-MM-DD'),
  departure: z.string().describe('Check-out date, YYYY-MM-DD'),
  guests: z.number().int().min(1).max(50).describe('Number of guests'),
};

export interface GetBookingLinkArgs {
  readonly property: string;
  readonly arrival: string;
  readonly departure: string;
  readonly guests: number;
}

export function runGetBookingLink(deps: ToolDeps, args: GetBookingLinkArgs): GetBookingLinkOutput {
  const property = requireProperty(deps, args.property);
  const stay = validateStay({ arrival: args.arrival, departure: args.departure, guests: args.guests, today: today(deps), maxGuests: property.maxGuests });
  return {
    slug: property.slug,
    name: property.name,
    arrival: stay.arrival,
    departure: stay.departure,
    nights: stay.nights,
    guests: stay.guests,
    url: buildBookingUrl(deps.bookingUrlTemplate, { property: property.slug, arrival: stay.arrival, departure: stay.departure, guests: stay.guests }),
    note: 'Opening this link does not create a booking. Availability and the final price (including taxes) are confirmed on the booking page.',
  };
}

export function registerGetBookingLink(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_booking_link',
    {
      title: 'Get booking link',
      description: GET_BOOKING_LINK_DESCRIPTION,
      inputSchema: getBookingLinkInput,
      outputSchema: getBookingLinkOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args): Promise<CallToolResult> => guarded(deps, () => Promise.resolve(ok(getBookingLinkOutput, runGetBookingLink(deps, args)))),
  );
}
