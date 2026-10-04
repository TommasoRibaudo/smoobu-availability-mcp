import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOOKING_PLACEHOLDERS, buildBookingUrl, validateBookingUrlTemplate } from '../src/booking.js';

const TEMPLATE = 'https://example.com/book?property={property}&from={arrival}&to={departure}&guests={guests}';

describe('buildBookingUrl', () => {
  it('replaces all four placeholders', () => {
    const url = buildBookingUrl(TEMPLATE, { property: 'casa-caribe', arrival: '2026-11-02', departure: '2026-11-04', guests: 2 });
    expect(url).toBe('https://example.com/book?property=casa-caribe&from=2026-11-02&to=2026-11-04&guests=2');
    for (const placeholder of BOOKING_PLACEHOLDERS) expect(url).not.toContain(placeholder);
  });

  it('replaces repeated occurrences of a placeholder', () => {
    const url = buildBookingUrl('https://example.com/{property}/x?p={property}&a={arrival}&d={departure}', {
      property: 'casa',
      arrival: '2026-11-02',
      departure: '2026-11-04',
      guests: 1,
    });
    expect(url).toBe('https://example.com/casa/x?p=casa&a=2026-11-02&d=2026-11-04');
  });

  it('URL-encodes a property slug containing a space', () => {
    const url = buildBookingUrl(TEMPLATE, { property: 'casa caribe', arrival: '2026-11-02', departure: '2026-11-04', guests: 2 });
    expect(url).toContain('property=casa%20caribe&');
  });

  it('URL-encodes ampersands so a value cannot inject extra query parameters', () => {
    const url = buildBookingUrl(TEMPLATE, { property: 'a&b=c#frag', arrival: '2026-11-02', departure: '2026-11-04', guests: 2 });
    expect(url).toContain('property=a%26b%3Dc%23frag&');
    const parsed = new URL(url);
    expect([...parsed.searchParams.keys()]).toEqual(['property', 'from', 'to', 'guests']);
    expect(parsed.searchParams.get('property')).toBe('a&b=c#frag');
  });

  it('renders guests as a number string', () => {
    const url = buildBookingUrl(TEMPLATE, { property: 'p', arrival: '2026-11-02', departure: '2026-11-04', guests: 6 });
    expect(new URL(url).searchParams.get('guests')).toBe('6');
  });

  it('does not re-expand placeholders that appear inside an encoded value', () => {
    const url = buildBookingUrl(TEMPLATE, { property: '{guests}', arrival: '2026-11-02', departure: '2026-11-04', guests: 3 });
    // Braces are percent-encoded, so a later replaceAll cannot expand a placeholder smuggled in a value.
    expect(url).toContain('property=%7Bguests%7D&');
    expect(new URL(url).searchParams.get('guests')).toBe('3');
  });
});

describe('validateBookingUrlTemplate', () => {
  it('accepts the template from .env.example', () => {
    const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    const line = env.split('\n').find((l) => l.startsWith('BOOKING_URL_TEMPLATE='));
    expect(line).toBeDefined();
    const template = (line ?? '').slice('BOOKING_URL_TEMPLATE='.length).trim();
    expect(() => validateBookingUrlTemplate(template)).not.toThrow();
  });

  it('accepts http and https', () => {
    expect(() => validateBookingUrlTemplate('http://example.com/?a={arrival}&d={departure}')).not.toThrow();
    expect(() => validateBookingUrlTemplate(TEMPLATE)).not.toThrow();
  });

  it('rejects something that is not a URL', () => {
    expect(() => validateBookingUrlTemplate('not a url {arrival} {departure}')).toThrow(/absolute http\(s\) URL/);
    expect(() => validateBookingUrlTemplate('')).toThrow(/BOOKING_URL_TEMPLATE/);
  });

  it('rejects a non-http(s) protocol', () => {
    expect(() => validateBookingUrlTemplate('ftp://example.com/?a={arrival}&d={departure}')).toThrow(/http or https/);
  });

  it('rejects a template without {arrival}', () => {
    expect(() => validateBookingUrlTemplate('https://example.com/?d={departure}')).toThrow(/\{arrival\}/);
  });

  it('rejects a template without {departure}', () => {
    expect(() => validateBookingUrlTemplate('https://example.com/?a={arrival}')).toThrow(/\{departure\}/);
  });
});
