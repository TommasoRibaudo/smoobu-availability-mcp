import { buildCanonicalString, signCanonicalString } from '../src/smoobu/auth.js';
import { POISON } from './fixtures/poison.js';

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  readonly body: unknown;
}

export interface MockApartment {
  readonly id: number;
  readonly maxGuests: number;
  readonly minStay: number;
  /** Nightly base price. */
  readonly nightly: number;
  /** Dates (YYYY-MM-DD) that are booked or blocked. */
  readonly unavailableDates: readonly string[];
  /** Weekdays (0=Sunday) on which arrival is NOT allowed. */
  readonly noArrivalDays: readonly number[];
  readonly currency: string;
}

export interface MockSmoobuOptions {
  readonly apartments: readonly MockApartment[];
  /** When set, HMAC-signed requests must verify against this secret and this key. */
  readonly apiKey?: string;
  readonly apiSecret?: string;
}

export interface MockSmoobu {
  readonly fetch: typeof fetch;
  readonly calls: RecordedCall[];
  /** Make the next `times` responses fail with `status` (after allowlist/auth). */
  failNext(status: number, times: number, headers?: Record<string, string>): void;
  /** Make the next response a 200 with garbage JSON shape. */
  garbageNext(): void;
  /** Make the next availability response carry poison in fields the code DOES read (currency, numeric rule fields). */
  corruptNext(): void;
}

export const MOCK_BASE_URL = 'https://smoobu.mock.invalid';

function guestBlob(): Record<string, unknown> {
  return {
    guest: {
      firstName: POISON.guestFirstName,
      lastName: POISON.guestLastName,
      email: POISON.email,
      phone: POISON.phone,
      phoneDigits: POISON.phoneDigits,
      address: POISON.address,
    },
    reservation: {
      id: POISON.reservationId,
      reference: POISON.reservationRef,
      channel: { id: POISON.channelId, name: POISON.channelName },
      notice: POISON.notice,
      'guest-name': POISON.guestFullName,
    },
    blockReason: POISON.blockReason,
    apartmentName: POISON.internalApartmentName,
    customerId: POISON.customerId,
    apiKey: POISON.apiKeyEcho,
  };
}

function nightsBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function* dates(from: string, to: string): Generator<string> {
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    yield new Date(t).toISOString().slice(0, 10);
  }
}

function priceFor(apt: MockApartment, date: string): number {
  const day = Number(date.slice(8, 10));
  return apt.nightly + (day % 5) * 10; // mild seasonality
}

export function createMockSmoobu(opts: MockSmoobuOptions): MockSmoobu {
  const calls: RecordedCall[] = [];
  const failures: { status: number; headers: Record<string, string> }[] = [];
  let garbage = false;
  let corrupt = false;
  const byId = new Map(opts.apartments.map((a) => [a.id, a]));

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  // eslint-disable-next-line @typescript-eslint/require-await -- must match the async `typeof fetch` signature
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const body = rawBody !== undefined && rawBody.length > 0 ? (JSON.parse(rawBody) as unknown) : undefined;
    calls.push({ method, path: url.pathname, query: url.searchParams, headers, body });

    const hasAuth = headers.has('api-key') || (headers.has('x-api-key') && headers.has('x-signature') && headers.has('x-timestamp') && headers.has('x-nonce'));
    if (!hasAuth) return json(401, { title: 'Error occurred', detail: 'verification error', ...guestBlob() });
    if (headers.has('x-signature') && opts.apiSecret !== undefined) {
      const query = [...url.searchParams.entries()].map(([k, v]) => [k, v] as const);
      const canonical = buildCanonicalString({
        method,
        path: url.pathname,
        query,
        body: rawBody ?? '',
        timestamp: headers.get('x-timestamp') ?? '',
        nonce: headers.get('x-nonce') ?? '',
        apiKey: headers.get('x-api-key') ?? '',
      });
      const expected = signCanonicalString(canonical, opts.apiSecret);
      const keyOk = opts.apiKey === undefined || headers.get('x-api-key') === opts.apiKey;
      if (!keyOk || headers.get('x-signature') !== expected) return json(401, { title: 'Error occurred', detail: 'bad signature', ...guestBlob() });
    }

    const failure = failures.shift();
    if (failure !== undefined) return json(failure.status, { title: 'Error occurred', detail: 'upstream failure', ...guestBlob() }, failure.headers);
    if (garbage) {
      garbage = false;
      return json(200, { totally: 'unexpected', ...guestBlob() });
    }

    if (method === 'GET' && url.pathname === '/api/apartments') {
      return json(200, {
        apartments: opts.apartments.map((a) => ({ id: a.id, name: `${POISON.internalApartmentName} ${a.id}`, ...guestBlob() })),
        ...guestBlob(),
      });
    }

    if (method === 'GET' && url.pathname === '/api/rates') {
      const start = url.searchParams.get('start_date');
      const end = url.searchParams.get('end_date');
      const ids = url.searchParams.getAll('apartments[]').map(Number);
      if (start === null || end === null || ids.length === 0) return json(400, { detail: 'bad request', ...guestBlob() });
      const data: Record<string, Record<string, unknown>> = {};
      for (const id of ids) {
        const apt = byId.get(id);
        if (apt === undefined) continue;
        const days: Record<string, unknown> = {};
        for (const d of dates(start, end)) {
          const unavailable = apt.unavailableDates.includes(d);
          days[d] = {
            price: priceFor(apt, d),
            min_length_of_stay: apt.minStay,
            available: unavailable ? 0 : 1,
            // poison inside every day object
            reservation: unavailable ? { id: POISON.reservationId, guestName: POISON.guestFullName, email: POISON.email, channel: POISON.channelName } : null,
            blockReason: unavailable ? POISON.blockReason : null,
          };
        }
        data[String(id)] = days;
      }
      return json(200, { data, ...guestBlob() });
    }

    if (method === 'POST' && url.pathname === '/booking/checkApartmentAvailability') {
      const req = body as { arrivalDate: string; departureDate: string; apartments: number[]; customerId: number; guests?: number };
      const nights = nightsBetween(req.arrivalDate, req.departureDate);
      const availableApartments: number[] = [];
      const prices: Record<string, unknown> = {};
      const errorMessages: Record<string, unknown> = {};
      for (const id of req.apartments) {
        const apt = byId.get(id);
        if (apt === undefined) continue;
        const arrivalDow = new Date(`${req.arrivalDate}T00:00:00Z`).getUTCDay();
        if (req.guests !== undefined && req.guests > apt.maxGuests) {
          errorMessages[String(id)] = { errorCode: 400, message: 'The number of guests exceeds the limit of the apartment.', numberOfGuest: apt.maxGuests, ...guestBlob() };
          continue;
        }
        if (nights < apt.minStay) {
          errorMessages[String(id)] = { errorCode: 401, message: 'The duration of the booking is too short.', minimumLengthOfStay: apt.minStay, ...guestBlob() };
          continue;
        }
        if (apt.noArrivalDays.includes(arrivalDow)) {
          errorMessages[String(id)] = { errorCode: 402, message: 'The chosen day of arrival is not available', arrivalDays: [1, 2, 3, 4, 5, 6], ...guestBlob() };
          continue;
        }
        const stayNights = [...dates(req.arrivalDate, req.departureDate)].slice(0, -1);
        if (stayNights.some((d) => apt.unavailableDates.includes(d))) {
          // Smoobu simply leaves booked apartments out of availableApartments; we add poison anyway.
          errorMessages[String(id)] = { errorCode: 500, message: `Booked by ${POISON.guestFullName} via ${POISON.channelName}`, ...guestBlob() };
          continue;
        }
        const total = stayNights.reduce((sum, d) => sum + priceFor(apt, d), 0);
        availableApartments.push(id);
        prices[String(id)] = { price: total, currency: corrupt ? POISON.guestFullName : apt.currency, ...guestBlob() };
      }
      if (corrupt) {
        corrupt = false;
        for (const key of Object.keys(errorMessages)) {
          errorMessages[key] = { ...(errorMessages[key] as object), errorCode: 401, minimumLengthOfStay: POISON.reservationId, numberOfGuest: POISON.customerId };
        }
      }
      return json(200, { availableApartments, prices, errorMessages, ...guestBlob() });
    }

    // Any other endpoint: answer with a pile of guest data so a leak would be loud.
    return json(200, { reservations: [guestBlob(), guestBlob()], ...guestBlob() });
  };

  return {
    fetch: fetchImpl,
    calls,
    failNext: (status, times, headers = {}) => {
      for (let i = 0; i < times; i++) failures.push({ status, headers });
    },
    garbageNext: () => {
      garbage = true;
    },
    corruptNext: () => {
      corrupt = true;
    },
  };
}
