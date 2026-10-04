import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SMOOBU_ALLOWLIST, SmoobuAllowlistError, assertAllowed, isAllowed } from '../src/smoobu/allowlist.js';
import { SmoobuClient } from '../src/smoobu/client.js';

const FORBIDDEN: readonly (readonly [string, string])[] = [
  ['GET', '/api/reservations'],
  ['POST', '/api/reservations'],
  ['GET', '/api/reservations/55667788'],
  ['PUT', '/api/reservations/55667788'],
  ['DELETE', '/api/reservations/55667788'],
  ['GET', '/api/reservations/55667788/messages'],
  ['POST', '/api/reservations/55667788/messages/send-message-to-guest'],
  ['GET', '/api/guests'],
  ['GET', '/api/guests/1'],
  ['GET', '/api/me'],
  ['GET', '/api/users'],
  ['GET', '/api/apartments/471101'],
  ['POST', '/api/apartments'],
  ['POST', '/api/rates'],
  ['GET', '/api/rates/'],
  ['GET', '/api/rates?apartments[]=1'],
  ['GET', '/booking/checkApartmentAvailability'],
  ['POST', '/booking/createBooking'],
  ['GET', '/api/apartments/'],
  ['get', '/api/apartments'],
  ['GET', 'api/apartments'],
  ['GET', '/API/apartments'],
  ['GET', '/api/apartments/../reservations'],
  ['GET', '/api/online-check-in'],
  ['POST', '/api/webhooks'],
  ['HEAD', '/api/apartments'],
  ['OPTIONS', '/api/apartments'],
  ['GET', ''],
];

describe('Smoobu allowlist', () => {
  it('contains exactly the three read-only endpoints', () => {
    expect(SMOOBU_ALLOWLIST.map((e) => `${e.method} ${e.path}`).sort()).toEqual([
      'GET /api/apartments',
      'GET /api/rates',
      'POST /booking/checkApartmentAvailability',
    ]);
    expect(Object.isFrozen(SMOOBU_ALLOWLIST)).toBe(true);
  });

  it('accepts the allowlisted pairs', () => {
    for (const e of SMOOBU_ALLOWLIST) {
      expect(isAllowed(e.method, e.path)).toBe(true);
      expect(() => assertAllowed(e.method, e.path)).not.toThrow();
    }
  });

  it.each(FORBIDDEN)('refuses %s %s', (method, path) => {
    expect(isAllowed(method, path)).toBe(false);
    expect(() => assertAllowed(method, path)).toThrow(SmoobuAllowlistError);
  });
});

describe('SmoobuClient refuses non-allowlisted calls before any network activity', () => {
  function makeClient(): { client: SmoobuClient; fetchSpy: ReturnType<typeof vi.fn> } {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    const client = new SmoobuClient({
      credentials: { apiKey: 'k', apiSecret: 's' },
      customerId: 1,
      fetch: fetchSpy,
      sleep: () => Promise.resolve(),
    });
    return { client, fetchSpy };
  }

  // `request` is private; reach it the way a careless future edit would.
  type RequestFn = (spec: { method: string; path: string; query?: unknown; body?: unknown }) => Promise<unknown>;
  const rawRequest = (client: SmoobuClient): RequestFn => (client as unknown as { request: RequestFn }).request.bind(client);

  it.each(FORBIDDEN)('%s %s throws SmoobuAllowlistError with zero fetch calls', async (method, path) => {
    const { client, fetchSpy } = makeClient();
    await expect(rawRequest(client)({ method, path })).rejects.toBeInstanceOf(SmoobuAllowlistError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('GET /api/reservations specifically never reaches fetch', async () => {
    const { client, fetchSpy } = makeClient();
    await expect(rawRequest(client)({ method: 'GET', path: '/api/reservations' })).rejects.toThrow(/Refusing non-allowlisted/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('exposes only the three read-only public methods', () => {
    const publicMethods = Object.getOwnPropertyNames(SmoobuClient.prototype).filter((n) => n !== 'constructor' && !['request', 'backoff', 'shapeError'].includes(n));
    expect(publicMethods.sort()).toEqual(['checkAvailability', 'getRates', 'listApartmentIds']);
  });
});

describe('source tree contains no reservation or guest endpoints', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
    });
  }

  const sources = [...walk('src'), ...walk('api')];
  const banned = ['/api/reservations', '/api/guests', '/api/users', '/api/me', 'send-message-to-guest', '/booking/createBooking', 'api/online-check-in', '/api/webhooks'];

  it('has source files to scan', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it.each(sources)('%s does not reference a banned Smoobu path', (file) => {
    const text = readFileSync(file, 'utf8');
    for (const path of banned) expect(text, `${file} references ${path}`).not.toContain(path);
  });

  it('only src/smoobu/client.ts calls fetch', () => {
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      if (file.endsWith('src/smoobu/client.ts')) continue;
      expect(text, `${file} uses fetch`).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
