/**
 * Internal, minimal views of Smoobu data. These are built field by field from
 * upstream JSON inside SmoobuClient; the raw JSON never leaves that module.
 */

export interface RateDay {
  /** Nightly price, or null when Smoobu has no price for the day. */
  readonly price: number | null;
  /** Minimum length of stay starting on this day, or null when unrestricted. */
  readonly minLengthOfStay: number | null;
  /** true when Smoobu reports the day as available (1). Booked and blocked both map to false. */
  readonly available: boolean;
}

/** apartmentId -> (YYYY-MM-DD -> RateDay) */
export type RatesByApartment = ReadonlyMap<number, ReadonlyMap<string, RateDay>>;

export type AvailabilityOutcome =
  | { readonly available: true; readonly price: number; readonly currency: string }
  | {
      readonly available: false;
      /** Smoobu rule code (400 guests, 401 min stay, 402 arrival day, 403 lead time, 404 gap). */
      readonly errorCode: number | null;
      readonly minimumLengthOfStay: number | null;
      readonly numberOfGuest: number | null;
      readonly leadTime: number | null;
      readonly minimumLengthBetweenBookings: number | null;
    };

/** apartmentId -> outcome. Every requested id is present. */
export type AvailabilityByApartment = ReadonlyMap<number, AvailabilityOutcome>;

export interface CheckAvailabilityInput {
  readonly arrivalDate: string;
  readonly departureDate: string;
  readonly apartmentIds: readonly number[];
  readonly guests: number;
}
