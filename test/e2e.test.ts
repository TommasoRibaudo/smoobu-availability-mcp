import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startNodeServer } from '../src/nodeServer.js';
import type { RunningServer } from '../src/nodeServer.js';
import { createTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

describe('end to end over Streamable HTTP', () => {
  let running: RunningServer;
  let testApp: TestApp;
  let client: Client;

  beforeAll(async () => {
    testApp = createTestApp();
    running = await startNodeServer({ handler: testApp.app.handler, port: 0 });
    client = new Client({ name: 'e2e-test', version: '0.0.0' });
    // Cast: the SDK's transport class does not satisfy Transport under exactOptionalPropertyTypes.
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)) as Transport);
  });

  afterAll(async () => {
    await client.close();
    await running.close();
  });

  it('lists exactly the four read-only tools with annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['check_availability', 'get_booking_link', 'get_calendar', 'list_properties']);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
      expect(tool.description?.length ?? 0).toBeGreaterThan(80);
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it('list_properties returns the public catalog', async () => {
    const result = await client.callTool({ name: 'list_properties', arguments: {} });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { count: number; properties: { slug: string }[] };
    expect(out.count).toBe(2);
    expect(out.properties.map((p) => p.slug)).toEqual(['casa-caribe', 'jungle-studio']);
  });

  it('check_availability prices an open stay and explains a rejected one', async () => {
    const result = await client.callTool({ name: 'check_availability', arguments: { arrival: '2026-11-02', departure: '2026-11-04', guests: 2 } });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { availableCount: number; results: Record<string, unknown>[]; note: string };
    expect(out.note).toMatch(/exclude taxes/i);
    const casa = out.results.find((r) => r['slug'] === 'casa-caribe');
    const studio = out.results.find((r) => r['slug'] === 'jungle-studio');
    expect(casa?.['available']).toBe(false);
    expect(casa?.['reason']).toBe('Minimum stay is 3 nights for these dates (2 requested).');
    expect(studio?.['available']).toBe(true);
    expect(studio?.['currency']).toBe('USD');
    expect(studio?.['nights']).toBe(2);
    expect(studio?.['total']).toBe(80 + 2 * 10 + (80 + 3 * 10));
    expect(studio?.['nightlyAverage']).toBe(((80 + 20 + 80 + 30) / 2));
    expect(studio?.['bookingUrl']).toBe('https://example.com/book?property=jungle-studio&from=2026-11-02&to=2026-11-04&guests=2');
    expect(out.availableCount).toBe(1);
  });

  it('get_calendar returns one entry per day with availability as true/false only', async () => {
    const result = await client.callTool({ name: 'get_calendar', arguments: { property: 'casa-caribe', from: '2026-12-18', to: '2026-12-24' } });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { days: { date: string; available: boolean; price: number | null; minStay: number | null }[]; currency: string };
    expect(out.days).toHaveLength(7);
    expect(out.currency).toBe('USD');
    expect(out.days.map((d) => d.available)).toEqual([true, true, false, false, false, true, true]);
    expect(out.days[0]).toEqual({ date: '2026-12-18', available: true, price: 150 + (18 % 5) * 10, minStay: 3 });
    for (const day of out.days) expect(Object.keys(day).sort()).toEqual(['available', 'date', 'minStay', 'price']);
  });

  it('get_booking_link builds the configured URL', async () => {
    const result = await client.callTool({ name: 'get_booking_link', arguments: { property: 'jungle-studio', arrival: '2027-01-10', departure: '2027-01-12', guests: 2 } });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { url: string; nights: number };
    expect(out.url).toBe('https://example.com/book?property=jungle-studio&from=2027-01-10&to=2027-01-12&guests=2');
    expect(out.nights).toBe(2);
  });

  it('returns a friendly error, not a stack trace, for bad input', async () => {
    const result = await client.callTool({ name: 'check_availability', arguments: { arrival: '2020-01-01', departure: '2020-01-05', guests: 2 } });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('in the past');
    expect(text).not.toMatch(/at .*\.ts:\d+/);
    expect(result.structuredContent).toBeUndefined();
  });

  it('answers a plain GET with a small JSON description', async () => {
    const res = await fetch(running.url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { readOnly: boolean; tools: string[] };
    expect(body.readOnly).toBe(true);
    expect(body.tools).toHaveLength(4);
  });

  it('never called a non-allowlisted Smoobu endpoint', () => {
    for (const call of testApp.mock.calls) {
      expect(['GET /api/rates', 'POST /booking/checkApartmentAvailability']).toContain(`${call.method} ${call.path}`);
    }
    expect(testApp.mock.calls.length).toBeGreaterThan(0);
  });
});
