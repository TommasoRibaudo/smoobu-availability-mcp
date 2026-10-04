import { z } from 'zod';

/**
 * Strict output schemas. Every tool result is validated against one of these
 * before it is returned, and `strictObject` rejects any key not listed here.
 * A Smoobu field can therefore only reach a caller if it is named below.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const money = z.number().nonnegative().finite();

export const PRICE_NOTE = 'Prices exclude taxes and any cleaning or service fees; the final total is shown on the booking page.';

export const publicPropertySchema = z.strictObject({
  slug,
  name: z.string().min(1),
  bedrooms: z.number().int().nonnegative(),
  maxGuests: z.number().int().positive(),
});

export const listPropertiesOutput = z.strictObject({
  count: z.number().int().nonnegative(),
  properties: z.array(publicPropertySchema),
  note: z.string(),
});

export const availabilityResultSchema = z.discriminatedUnion('available', [
  z.strictObject({
    slug,
    name: z.string().min(1),
    available: z.literal(true),
    currency,
    total: money,
    nightlyAverage: money,
    nights: z.number().int().positive(),
    pricesExcludeTaxes: z.literal(true),
    bookingUrl: z.string().url(),
  }),
  z.strictObject({
    slug,
    name: z.string().min(1),
    available: z.literal(false),
    reason: z.string().min(1),
  }),
]);

export const checkAvailabilityOutput = z.strictObject({
  arrival: isoDate,
  departure: isoDate,
  nights: z.number().int().positive(),
  guests: z.number().int().positive(),
  availableCount: z.number().int().nonnegative(),
  results: z.array(availabilityResultSchema),
  note: z.string(),
});

export const calendarDaySchema = z.strictObject({
  date: isoDate,
  available: z.boolean(),
  price: money.nullable(),
  minStay: z.number().int().positive().nullable(),
});

export const getCalendarOutput = z.strictObject({
  slug,
  name: z.string().min(1),
  from: isoDate,
  to: isoDate,
  currency,
  days: z.array(calendarDaySchema),
  note: z.string(),
});

export const getBookingLinkOutput = z.strictObject({
  slug,
  name: z.string().min(1),
  arrival: isoDate,
  departure: isoDate,
  nights: z.number().int().positive(),
  guests: z.number().int().positive(),
  url: z.string().url(),
  note: z.string(),
});

export type ListPropertiesOutput = z.infer<typeof listPropertiesOutput>;
export type CheckAvailabilityOutput = z.infer<typeof checkAvailabilityOutput>;
export type AvailabilityResult = z.infer<typeof availabilityResultSchema>;
export type GetCalendarOutput = z.infer<typeof getCalendarOutput>;
export type CalendarDay = z.infer<typeof calendarDaySchema>;
export type GetBookingLinkOutput = z.infer<typeof getBookingLinkOutput>;

/** All tool output schemas, keyed by tool name (used by the privacy test). */
export const toolOutputSchemas = {
  list_properties: listPropertiesOutput,
  check_availability: checkAvailabilityOutput,
  get_calendar: getCalendarOutput,
  get_booking_link: getBookingLinkOutput,
} as const;

export type ToolName = keyof typeof toolOutputSchemas;
