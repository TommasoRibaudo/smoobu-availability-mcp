import { createHash, createHmac, randomUUID } from 'node:crypto';

/**
 * Smoobu authentication.
 *
 * HMAC (recommended, used when an API secret is configured):
 *   X-API-Key, X-Timestamp, X-Nonce, X-Signature where the signature is
 *   base64(HMAC-SHA256(secret, canonicalString)) and canonicalString is
 *     METHOD \n /path \n sortedQuery \n TIMESTAMP \n NONCE \n sha256hex(body) \n API_KEY
 *
 * Legacy (`Api-Key` header) is used only when no secret is configured.
 * Smoobu sunsets legacy keys on 2026-10-31.
 */
export interface SmoobuCredentials {
  readonly apiKey: string;
  readonly apiSecret?: string | undefined;
}

export type QueryPairs = readonly (readonly [string, string])[];

/** RFC 3986 encoding: like encodeURIComponent but also escapes !'()* */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Query string as sent on the wire and as used in the canonical string (sorted). */
export function canonicalQuery(pairs: QueryPairs): string {
  return [...pairs]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface SigningInput {
  readonly method: string;
  readonly path: string;
  readonly query: QueryPairs;
  readonly body: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly apiKey: string;
}

export function buildCanonicalString(input: SigningInput): string {
  return [
    input.method,
    input.path,
    canonicalQuery(input.query),
    input.timestamp,
    input.nonce,
    sha256Hex(input.body),
    input.apiKey,
  ].join('\n');
}

export function signCanonicalString(canonical: string, apiSecret: string): string {
  return createHmac('sha256', apiSecret).update(canonical, 'utf8').digest('base64');
}

export interface AuthContext {
  readonly now: () => Date;
  readonly nonce: () => string;
}

export const defaultAuthContext: AuthContext = {
  now: () => new Date(),
  nonce: () => randomUUID(),
};

/** ISO 8601 UTC with second precision, as in Smoobu's examples. */
export function formatTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildAuthHeaders(
  creds: SmoobuCredentials,
  req: { method: string; path: string; query: QueryPairs; body: string },
  ctx: AuthContext = defaultAuthContext,
): Record<string, string> {
  if (creds.apiSecret === undefined || creds.apiSecret.length === 0) {
    return { 'Api-Key': creds.apiKey };
  }
  const timestamp = formatTimestamp(ctx.now());
  const nonce = ctx.nonce();
  const canonical = buildCanonicalString({ ...req, timestamp, nonce, apiKey: creds.apiKey });
  return {
    'X-API-Key': creds.apiKey,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signCanonicalString(canonical, creds.apiSecret),
  };
}
