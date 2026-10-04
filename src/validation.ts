import { UserFacingError } from './errors.js';

export const TIME_ZONE = 'America/Costa_Rica';
export const MAX_MONTHS_AHEAD = 18;
export const MIN_NIGHTS = 1;
export const MAX_NIGHTS = 60;
export const MAX_CALENDAR_DAYS = 92;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar date in the property's time zone, as YYYY-MM-DD. */
export function todayInCostaRica(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Strict YYYY-MM-DD parse; returns the UTC midnight timestamp of that calendar day. */
export function parseIsoDate(value: string, field: string): number {
  const m = ISO_DATE.exec(value);
  if (m === null) throw new UserFacingError(`${field} must be a date in YYYY-MM-DD format (got "${truncate(value)}").`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ts = Date.UTC(y, mo - 1, d);
  const check = new Date(ts);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new UserFacingError(`${field} "${value}" is not a real calendar date.`);
  }
  return ts;
}

export function formatIsoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return formatIsoDate(parseIsoDate(iso, 'date') + days * 86_400_000);
}

export function addMonths(iso: string, months: number): string {
  const ts = parseIsoDate(iso, 'date');
  const d = new Date(ts);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  // Clamp to the last day of the target month (e.g. Jan 31 + 1 month -> Feb 28/29).
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return formatIsoDate(target.getTime());
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseIsoDate(toIso, 'to') - parseIsoDate(fromIso, 'from')) / 86_400_000);
}

export function* eachDay(fromIso: string, toIso: string): Generator<string> {
  const start = parseIsoDate(fromIso, 'from');
  const end = parseIsoDate(toIso, 'to');
  for (let ts = start; ts <= end; ts += 86_400_000) yield formatIsoDate(ts);
}

export interface StayRequest {
  readonly arrival: string;
  readonly departure: string;
  readonly guests: number;
  readonly today: string;
  readonly maxGuests: number;
}

export interface ValidatedStay {
  readonly arrival: string;
  readonly departure: string;
  readonly guests: number;
  readonly nights: number;
}

export function validateStay(req: StayRequest): ValidatedStay {
  const arrivalTs = parseIsoDate(req.arrival, 'arrival');
  const departureTs = parseIsoDate(req.departure, 'departure');
  const todayTs = parseIsoDate(req.today, 'today');
  const horizon = parseIsoDate(addMonths(req.today, MAX_MONTHS_AHEAD), 'horizon');

  if (arrivalTs < todayTs) {
    throw new UserFacingError(`arrival ${req.arrival} is in the past. Today in Costa Rica is ${req.today}; arrival must be today or later.`);
  }
  if (arrivalTs > horizon) {
    throw new UserFacingError(
      `arrival ${req.arrival} is too far ahead. Stays can be checked up to ${MAX_MONTHS_AHEAD} months out (until ${formatIsoDate(horizon)}).`,
    );
  }
  const nights = Math.round((departureTs - arrivalTs) / 86_400_000);
  if (nights < MIN_NIGHTS) {
    throw new UserFacingError(`departure ${req.departure} must be after arrival ${req.arrival} (at least ${MIN_NIGHTS} night).`);
  }
  if (nights > MAX_NIGHTS) {
    throw new UserFacingError(`That stay is ${nights} nights; the maximum per request is ${MAX_NIGHTS} nights.`);
  }
  if (!Number.isInteger(req.guests) || req.guests < 1) {
    throw new UserFacingError('guests must be a whole number of at least 1.');
  }
  if (req.guests > req.maxGuests) {
    throw new UserFacingError(`guests must be between 1 and ${req.maxGuests}; ${req.guests} is more than any selected property sleeps.`);
  }
  return { arrival: req.arrival, departure: req.departure, guests: req.guests, nights };
}

export interface CalendarRangeRequest {
  readonly from: string;
  readonly to: string;
  readonly today: string;
}

export interface ValidatedRange {
  readonly from: string;
  readonly to: string;
  /** Number of calendar days, `from` and `to` inclusive. */
  readonly days: number;
}

export function validateCalendarRange(req: CalendarRangeRequest): ValidatedRange {
  const fromTs = parseIsoDate(req.from, 'from');
  const toTs = parseIsoDate(req.to, 'to');
  const todayTs = parseIsoDate(req.today, 'today');
  const horizon = parseIsoDate(addMonths(req.today, MAX_MONTHS_AHEAD), 'horizon');

  if (fromTs < todayTs) {
    throw new UserFacingError(`from ${req.from} is in the past. Today in Costa Rica is ${req.today}; the calendar starts today at the earliest.`);
  }
  if (toTs < fromTs) throw new UserFacingError(`to ${req.to} must be on or after from ${req.from}.`);
  const days = Math.round((toTs - fromTs) / 86_400_000) + 1;
  if (days > MAX_CALENDAR_DAYS) {
    throw new UserFacingError(`That range is ${days} days; get_calendar returns at most ${MAX_CALENDAR_DAYS} days per call. Split it into smaller ranges.`);
  }
  if (toTs > horizon) {
    throw new UserFacingError(`to ${req.to} is too far ahead. The calendar is available up to ${MAX_MONTHS_AHEAD} months out (until ${formatIsoDate(horizon)}).`);
  }
  return { from: req.from, to: req.to, days };
}

function truncate(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
