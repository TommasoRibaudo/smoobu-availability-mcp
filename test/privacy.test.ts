/**
 * THE privacy test.
 *
 * The mock Smoobu plants guest-like data in every response (see
 * test/fixtures/poison.ts). Every tool is called across valid, invalid and
 * upstream-failure inputs, and every result (success or error) is checked for:
 *   - any fixture poison value,
 *   - any email or phone-like pattern,
 *   - any Smoobu apartment id or the customer id,
 *   - any key that is not part of the strict output schema.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/server.js';
import { toolOutputSchemas } from '../src/schemas.js';
import type { ToolName } from '../src/schemas.js';
import { POISON, POISON_VALUES } from './fixtures/poison.js';
import { MOCK_APARTMENTS, TEST_CATALOG, TODAY, createTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

/** Keys that may appear anywhere in a tool's structured output (independent of the zod schema). */
const ALLOWED_KEYS: Record<ToolName, readonly string[]> = {
  list_properties: ['count', 'properties', 'slug', 'name', 'bedrooms', 'maxGuests', 'note'],
  check_availability: [
    'arrival', 'departure', 'nights', 'guests', 'availableCount', 'results', 'note',
    'slug', 'name', 'available', 'currency', 'total', 'nightlyAverage', 'pricesExcludeTaxes', 'bookingUrl', 'reason',
  ],
  get_calendar: ['slug', 'name', 'from', 'to', 'currency', 'days', 'note', 'date', 'available', 'price', 'minStay'],
  get_booking_link: ['slug', 'name', 'arrival', 'departure', 'nights', 'guests', 'url', 'note'],
};

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /\+\d{1,3}[\s-]?\d{3,4}[\s-]?\d{4}/;
const LONG_DIGIT_RUN = /\d{7,}/; // reservation ids, phone digits; prices and dates are shorter
const SMOOBU_IDS = [...TEST_CATALOG.map((p) => String(p.smoobuApartmentId)), ...MOCK_APARTMENTS.map((a) => String(a.id))];

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      into.add(k);
      collectKeys(v, into);
    }
  }
}

function assertClean(tool: ToolName, result: CallToolResult, label: string): void {
  const serialized = JSON.stringify(result);
  const lower = serialized.toLowerCase();
  for (const poison of POISON_VALUES) {
    expect(lower, `${label}: contains fixture value "${poison}"`).not.toContain(poison.toLowerCase());
  }
  expect(serialized, `${label}: contains an email address`).not.toMatch(EMAIL);
  expect(serialized, `${label}: contains a phone number`).not.toMatch(PHONE);
  expect(serialized, `${label}: contains a long digit run`).not.toMatch(LONG_DIGIT_RUN);
  for (const id of SMOOBU_IDS) expect(serialized, `${label}: contains Smoobu apartment id ${id}`).not.toContain(id);
  expect(serialized, `${label}: mentions a stack frame`).not.toMatch(/\bat [\w.<>[\] ]+\(?.*\.[tj]s:\d+/);
  expect(lower, `${label}: mentions smoobu`).not.toContain('smoobu');

  if (result.isError) {
    expect(result.structuredContent, `${label}: error results must not carry structured data`).toBeUndefined();
    const text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
    expect(text.length, `${label}: error text empty`).toBeGreaterThan(10);
    return;
  }

  const structured = result.structuredContent;
  expect(structured, `${label}: success without structuredContent`).toBeDefined();
  // 1) strict schema: unknown keys are rejected by zod
  expect(() => toolOutputSchemas[tool].parse(structured), `${label}: strict schema rejected output`).not.toThrow();
  // 2) independent key allowlist
  const keys = new Set<string>();
  collectKeys(structured, keys);
  for (const key of keys) expect(ALLOWED_KEYS[tool], `${label}: unexpected key "${key}"`).toContain(key);
  // 3) the text block is exactly the structured content
  const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
  expect(JSON.parse(text)).toEqual(structured);
}

interface Case {
  readonly tool: ToolName;
  readonly args: Record<string, unknown>;
  readonly label: string;
  readonly expectError?: boolean;
}

const CASES: readonly Case[] = [
  { tool: 'list_properties', args: {}, label: 'list' },

  { tool: 'check_availability', args: { arrival: '2026-11-02', departure: '2026-11-04', guests: 2 }, label: 'avail: studio ok, casa min stay' },
  { tool: 'check_availability', args: { arrival: '2026-11-02', departure: '2026-11-06', guests: 2 }, label: 'avail: both ok' },
  { tool: 'check_availability', args: { arrival: '2026-11-02', departure: '2026-11-06', guests: 4 }, label: 'avail: studio too small' },
  { tool: 'check_availability', args: { arrival: '2026-11-09', departure: '2026-11-13', guests: 2 }, label: 'avail: studio booked' },
  { tool: 'check_availability', args: { arrival: '2026-12-19', departure: '2026-12-26', guests: 2 }, label: 'avail: casa booked' },
  { tool: 'check_availability', args: { arrival: '2026-11-08', departure: '2026-11-12', guests: 1 }, label: 'avail: sunday arrival rejected for studio' },
  { tool: 'check_availability', args: { arrival: TODAY, departure: '2026-10-07', guests: 2, property: 'casa-caribe' }, label: 'avail: today, single property' },
  { tool: 'check_availability', args: { arrival: '2028-04-04', departure: '2028-04-08', guests: 2 }, label: 'avail: horizon edge' },
  { tool: 'check_availability', args: { arrival: '2026-11-02', departure: '2026-11-06', guests: 2, property: 'jungle-studio' }, label: 'avail: property given' },
  { tool: 'check_availability', args: { arrival: '2020-01-01', departure: '2020-01-05', guests: 2 }, label: 'avail: past', expectError: true },
  { tool: 'check_availability', args: { arrival: '2026-11-02', departure: '2026-11-02', guests: 2 }, label: 'avail: zero nights', expectError: true },
  { tool: 'check_availability', args: { arrival: '2026-11-02', departure: '2027-01-15', guests: 2 }, label: 'avail: too long', expectError: true },
  { tool: 'check_availability', args: { arrival: '2026-11-02', departure: '2026-11-06', guests: 9 }, label: 'avail: too many guests', expectError: true },
  { tool: 'check_availability', args: { arrival: '2026-11-02', departure: '2026-11-06', guests: 2, property: POISON.internalApartmentName }, label: 'avail: unknown property', expectError: true },
  { tool: 'check_availability', args: { arrival: '2026-11-02', departure: '2026-11-06', guests: 2, property: '471101' }, label: 'avail: smoobu id as property', expectError: true },
  { tool: 'check_availability', args: { arrival: 'next friday', departure: '2026-11-06', guests: 2 }, label: 'avail: bad date', expectError: true },
  { tool: 'check_availability', args: { arrival: '2026-11-02', departure: '2026-11-06', guests: 'two' }, label: 'avail: wrong type', expectError: true },
  // Unknown arguments are ignored by the MCP SDK; they must not be echoed either.
  { tool: 'check_availability', args: { arrival: '2026-11-02', departure: '2026-11-06', guests: 2, apartmentId: 471101, includeGuests: true, guestName: POISON.guestFullName }, label: 'avail: extra args' },

  { tool: 'get_calendar', args: { property: 'casa-caribe', from: '2026-12-15', to: '2026-12-31' }, label: 'cal: casa with booked days' },
  { tool: 'get_calendar', args: { property: 'jungle-studio', from: '2026-11-01', to: '2027-01-31' }, label: 'cal: 92 days' },
  { tool: 'get_calendar', args: { property: 'jungle-studio', from: TODAY, to: TODAY }, label: 'cal: single day' },
  { tool: 'get_calendar', args: { property: 'jungle-studio', from: '2026-11-01', to: '2027-02-01' }, label: 'cal: 93 days', expectError: true },
  { tool: 'get_calendar', args: { property: 'jungle-studio', from: '2026-01-01', to: '2026-01-10' }, label: 'cal: past', expectError: true },
  { tool: 'get_calendar', args: { property: 'nope', from: '2026-11-01', to: '2026-11-10' }, label: 'cal: unknown property', expectError: true },
  { tool: 'get_calendar', args: { property: 'casa-caribe', from: '2026-11-10', to: '2026-11-01' }, label: 'cal: reversed', expectError: true },

  { tool: 'get_booking_link', args: { property: 'casa-caribe', arrival: '2027-02-10', departure: '2027-02-15', guests: 6 }, label: 'link: ok' },
  { tool: 'get_booking_link', args: { property: 'casa-caribe', arrival: '2027-02-10', departure: '2027-02-15', guests: 7 }, label: 'link: too many guests', expectError: true },
  { tool: 'get_booking_link', args: { property: 'casa-caribe', arrival: '2027-02-10', departure: '2027-02-10', guests: 1 }, label: 'link: zero nights', expectError: true },
  { tool: 'get_booking_link', args: { property: POISON.email, arrival: '2027-02-10', departure: '2027-02-12', guests: 1 }, label: 'link: poison property', expectError: true },
];

describe('privacy: no Smoobu data ever leaves the server', () => {
  let testApp: TestApp;
  let client: Client;

  beforeAll(async () => {
    testApp = createTestApp();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(testApp.app.deps);
    await server.connect(serverTransport);
    client = new Client({ name: 'privacy-test', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
  });

  it('sanity: the mock really plants poison in every allowlisted response', async () => {
    const rates = await testApp.mock.fetch('https://smoobu.mock.invalid/api/rates?start_date=2026-12-20&end_date=2026-12-21&apartments%5B%5D=471101', {
      headers: { 'Api-Key': 'x' },
    });
    const ratesText = await rates.text();
    const avail = await testApp.mock.fetch('https://smoobu.mock.invalid/booking/checkApartmentAvailability', {
      method: 'POST',
      headers: { 'Api-Key': 'x' },
      body: JSON.stringify({ arrivalDate: '2026-11-02', departureDate: '2026-11-04', apartments: [471101, 471102], customerId: 1, guests: 2 }),
    });
    const availText = await avail.text();
    for (const text of [ratesText, availText]) {
      for (const poison of POISON_VALUES) expect(text).toContain(poison);
      expect(text).toMatch(EMAIL);
      expect(text).toMatch(PHONE);
    }
  });

  for (const c of CASES) {
    it(`${c.label} (${c.tool})`, async () => {
      const result = (await client.callTool({ name: c.tool, arguments: c.args })) as CallToolResult;
      if (c.expectError === true) expect(result.isError, `${c.label}: expected an error result`).toBe(true);
      else expect(result.isError, `${c.label}: unexpected error ${JSON.stringify(result.content)}`).toBeFalsy();
      assertClean(c.tool, result, c.label);
    });
  }

  it('upstream failures produce a generic error with nothing from the response body', async () => {
    testApp.mock.failNext(500, 3);
    const failed = (await client.callTool({ name: 'get_calendar', arguments: { property: 'casa-caribe', from: '2026-11-01', to: '2026-11-05' } })) as CallToolResult;
    expect(failed.isError).toBe(true);
    assertClean('get_calendar', failed, 'upstream 500');

    testApp.mock.failNext(429, 3);
    const limited = (await client.callTool({ name: 'check_availability', arguments: { arrival: '2026-11-02', departure: '2026-11-06', guests: 2 } })) as CallToolResult;
    expect(limited.isError).toBe(true);
    assertClean('check_availability', limited, 'upstream 429');

    testApp.mock.garbageNext();
    const garbage = (await client.callTool({ name: 'check_availability', arguments: { arrival: '2026-11-02', departure: '2026-11-06', guests: 2 } })) as CallToolResult;
    expect(garbage.isError).toBe(true);
    assertClean('check_availability', garbage, 'garbage shape');
  });

  it('calendar days are available true/false only, with no reason for unavailable days', async () => {
    const result = (await client.callTool({ name: 'get_calendar', arguments: { property: 'casa-caribe', from: '2026-12-19', to: '2026-12-23' } })) as CallToolResult;
    const out = result.structuredContent as { days: Record<string, unknown>[] };
    const unavailable = out.days.filter((d) => d['available'] === false);
    expect(unavailable.length).toBe(3);
    for (const day of unavailable) expect(Object.keys(day).sort()).toEqual(['available', 'date', 'minStay', 'price']);
  });

  it('a booked property is reported with a neutral reason, not who booked it or through which channel', async () => {
    const result = (await client.callTool({ name: 'check_availability', arguments: { arrival: '2026-11-09', departure: '2026-11-13', guests: 2 } })) as CallToolResult;
    const out = result.structuredContent as { results: Record<string, unknown>[] };
    const studio = out.results.find((r) => r['slug'] === 'jungle-studio');
    expect(studio?.['available']).toBe(false);
    expect(studio?.['reason']).toBe('Not available for these dates.');
  });

  it('only allowlisted endpoints were called during the whole suite', () => {
    const seen = new Set(testApp.mock.calls.map((c) => `${c.method} ${c.path}`));
    expect([...seen].sort()).toEqual(['GET /api/rates', 'POST /booking/checkApartmentAvailability']);
  });

  it('tool descriptions and the server instructions do not leak internal identifiers', async () => {
    const { tools } = await client.listTools();
    const text = JSON.stringify(tools).toLowerCase();
    for (const id of SMOOBU_IDS) expect(text).not.toContain(id);
    for (const poison of POISON_VALUES) expect(text).not.toContain(poison.toLowerCase());
  });
});
