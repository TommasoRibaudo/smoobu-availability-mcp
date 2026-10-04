import { describe, expect, it } from 'vitest';
import {
  buildAuthHeaders,
  buildCanonicalString,
  canonicalQuery,
  formatTimestamp,
  rfc3986,
  sha256Hex,
  signCanonicalString,
} from '../src/smoobu/auth.js';
import type { AuthContext } from '../src/smoobu/auth.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const NONCE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const DOC_EXAMPLE = {
  method: 'GET',
  path: '/api/reservations',
  query: [
    ['to', '2026-04-10'],
    ['from', '2026-04-01'],
  ],
  body: '',
  timestamp: '2026-04-01T12:00:00Z',
  nonce: NONCE,
  apiKey: 'usr_live_abc123',
} as const;

const DOC_CANONICAL = [
  'GET',
  '/api/reservations',
  'from=2026-04-01&to=2026-04-10',
  '2026-04-01T12:00:00Z',
  NONCE,
  EMPTY_SHA256,
  'usr_live_abc123',
].join('\n');

describe('rfc3986', () => {
  it('encodes a space as %20 (not +)', () => {
    expect(rfc3986('a b')).toBe('a%20b');
  });

  it('encodes square brackets', () => {
    expect(rfc3986('apartments[]')).toBe('apartments%5B%5D');
  });

  it("encodes the characters encodeURIComponent leaves alone: !'()*", () => {
    expect(rfc3986("!'()*")).toBe('%21%27%28%29%2A');
  });

  it('leaves unreserved characters untouched', () => {
    expect(rfc3986('AZaz09-_.~')).toBe('AZaz09-_.~');
  });

  it('encodes non-ASCII as UTF-8 percent escapes', () => {
    expect(rfc3986('é')).toBe('%C3%A9');
  });
});

describe('canonicalQuery', () => {
  it('sorts by key', () => {
    expect(
      canonicalQuery([
        ['to', '2026-04-10'],
        ['from', '2026-04-01'],
      ]),
    ).toBe('from=2026-04-01&to=2026-04-10');
  });

  it('keeps repeated keys and sorts them by value', () => {
    expect(
      canonicalQuery([
        ['apartments[]', '30'],
        ['apartments[]', '12'],
        ['apartments[]', '21'],
      ]),
    ).toBe('apartments%5B%5D=12&apartments%5B%5D=21&apartments%5B%5D=30');
  });

  it('sorts on the encoded form, with keys taking priority over values', () => {
    expect(
      canonicalQuery([
        ['b', '1'],
        ['apartments[]', '2'],
        ['a', '9'],
        ['apartments[]', '1'],
      ]),
    ).toBe('a=9&apartments%5B%5D=1&apartments%5B%5D=2&b=1');
  });

  it('encodes keys and values', () => {
    expect(canonicalQuery([['q', 'a b&c']])).toBe('q=a%20b%26c');
  });

  it('returns an empty string for no pairs and does not mutate its input', () => {
    expect(canonicalQuery([])).toBe('');
    const input: [string, string][] = [
      ['b', '1'],
      ['a', '2'],
    ];
    canonicalQuery(input);
    expect(input).toEqual([
      ['b', '1'],
      ['a', '2'],
    ]);
  });
});

describe('sha256Hex', () => {
  it('hashes the empty string to the well-known digest', () => {
    expect(sha256Hex('')).toBe(EMPTY_SHA256);
  });

  it('hashes "abc" to the NIST test vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('buildCanonicalString', () => {
  it("reproduces Smoobu's documented example exactly", () => {
    expect(buildCanonicalString(DOC_EXAMPLE)).toBe(
      'GET\n/api/reservations\nfrom=2026-04-01&to=2026-04-10\n2026-04-01T12:00:00Z\n6ba7b810-9dad-11d1-80b4-00c04fd430c8\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nusr_live_abc123',
    );
  });

  it('hashes a non-empty body into the sixth line', () => {
    const body = '{"a":1}';
    const lines = buildCanonicalString({ ...DOC_EXAMPLE, method: 'POST', body }).split('\n');
    expect(lines[0]).toBe('POST');
    expect(lines[5]).toBe(sha256Hex(body));
  });

  it('has an empty third line when there is no query', () => {
    const lines = buildCanonicalString({ ...DOC_EXAMPLE, query: [] }).split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[2]).toBe('');
  });
});

describe('signCanonicalString', () => {
  it('matches an independently computed HMAC-SHA256 base64 value', () => {
    // Expected value computed outside this codebase with OpenSSL:
    //   printf 'GET\n/api/reservations\nfrom=2026-04-01&to=2026-04-10\n2026-04-01T12:00:00Z\n6ba7b810-9dad-11d1-80b4-00c04fd430c8\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nusr_live_abc123' \
    //     | openssl dgst -sha256 -hmac 'your_api_secret' -binary | base64
    expect(signCanonicalString(DOC_CANONICAL, 'your_api_secret')).toBe('Bu2/61pneyRyjQejH7PoCJC2P8iRm3NnC9R6CGFOQho=');
  });

  it('produces a different signature for a different secret', () => {
    expect(signCanonicalString(DOC_CANONICAL, 'other_secret')).not.toBe('Bu2/61pneyRyjQejH7PoCJC2P8iRm3NnC9R6CGFOQho=');
  });
});

describe('formatTimestamp', () => {
  it('drops milliseconds and keeps the Z suffix', () => {
    expect(formatTimestamp(new Date('2026-04-01T12:00:00.789Z'))).toBe('2026-04-01T12:00:00Z');
  });
});

describe('buildAuthHeaders', () => {
  const ctx: AuthContext = { now: () => new Date('2026-04-01T12:00:00.456Z'), nonce: () => NONCE };
  const req = { method: 'GET', path: '/api/reservations', query: DOC_EXAMPLE.query, body: '' };

  it('returns the four HMAC headers when a secret is configured, and no Api-Key', () => {
    const headers = buildAuthHeaders({ apiKey: 'usr_live_abc123', apiSecret: 'your_api_secret' }, req, ctx);
    expect(headers).toEqual({
      'X-API-Key': 'usr_live_abc123',
      'X-Timestamp': '2026-04-01T12:00:00Z',
      'X-Nonce': NONCE,
      'X-Signature': 'Bu2/61pneyRyjQejH7PoCJC2P8iRm3NnC9R6CGFOQho=',
    });
    expect(headers).not.toHaveProperty('Api-Key');
  });

  it('formats the timestamp without milliseconds', () => {
    const headers = buildAuthHeaders({ apiKey: 'k', apiSecret: 's' }, req, ctx);
    expect(headers['X-Timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('takes the nonce from the injected context', () => {
    const headers = buildAuthHeaders({ apiKey: 'k', apiSecret: 's' }, req, { ...ctx, nonce: () => 'fixed-nonce' });
    expect(headers['X-Nonce']).toBe('fixed-nonce');
  });

  it('never puts the secret in a header', () => {
    const headers = buildAuthHeaders({ apiKey: 'k', apiSecret: 'super-secret-value' }, req, ctx);
    expect(Object.values(headers).join('|')).not.toContain('super-secret-value');
  });

  it('falls back to the legacy Api-Key header when the secret is undefined', () => {
    expect(buildAuthHeaders({ apiKey: 'usr_live_abc123' }, req, ctx)).toEqual({ 'Api-Key': 'usr_live_abc123' });
    expect(buildAuthHeaders({ apiKey: 'usr_live_abc123', apiSecret: undefined }, req, ctx)).toEqual({ 'Api-Key': 'usr_live_abc123' });
  });

  it('falls back to the legacy Api-Key header when the secret is an empty string', () => {
    expect(buildAuthHeaders({ apiKey: 'usr_live_abc123', apiSecret: '' }, req, ctx)).toEqual({ 'Api-Key': 'usr_live_abc123' });
  });
});
