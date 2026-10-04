/**
 * The complete set of Smoobu endpoints this codebase may call.
 *
 * The Smoobu API key is account-wide (reservations, guests, payments, ...).
 * Privacy therefore rests on this list: SmoobuClient refuses, before any
 * network activity, every method+path pair that is not listed here.
 */
export type HttpMethod = 'GET' | 'POST';

export interface AllowlistEntry {
  readonly method: HttpMethod;
  readonly path: string;
}

export const SMOOBU_ALLOWLIST: readonly AllowlistEntry[] = Object.freeze([
  { method: 'GET', path: '/api/apartments' },
  { method: 'GET', path: '/api/rates' },
  { method: 'POST', path: '/booking/checkApartmentAvailability' },
]);

export class SmoobuAllowlistError extends Error {
  override readonly name = 'SmoobuAllowlistError';
  constructor(method: string, path: string) {
    super(`Refusing non-allowlisted Smoobu call: ${method} ${path}`);
  }
}

/**
 * Exact-match check. Method is case-sensitive and must be upper case; the path
 * must be the bare pathname (no query string, no trailing slash, no `..`).
 */
export function isAllowed(method: string, path: string): boolean {
  return SMOOBU_ALLOWLIST.some((e) => e.method === method && e.path === path);
}

export function assertAllowed(method: string, path: string): asserts method is HttpMethod {
  if (!isAllowed(method, path)) throw new SmoobuAllowlistError(method, path);
}
