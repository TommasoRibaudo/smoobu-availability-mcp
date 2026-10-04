import { describe, expect, it } from 'vitest';
import { CATALOG, CATALOG_IS_PLACEHOLDER, findBySlug, maxGuestsAcross, toPublicProperty, validateCatalog } from '../src/catalog.js';
import type { CatalogProperty } from '../src/catalog.js';

const good: CatalogProperty = { slug: 'ok-house', name: 'Ok House', bedrooms: 2, maxGuests: 4, currency: 'USD', smoobuApartmentId: 1 };

describe('catalog', () => {
  it('the shipped catalog is valid and flagged as placeholder consistently', () => {
    expect(() => validateCatalog(CATALOG)).not.toThrow();
    if (CATALOG_IS_PLACEHOLDER) for (const p of CATALOG) expect(p.name).toContain('placeholder');
  });

  it('toPublicProperty never includes the Smoobu id', () => {
    expect(toPublicProperty(good)).toEqual({ slug: 'ok-house', name: 'Ok House', bedrooms: 2, maxGuests: 4 });
    expect(JSON.stringify(CATALOG.map(toPublicProperty))).not.toContain('smoobu');
  });

  it.each([
    ['duplicate slug', [good, { ...good, smoobuApartmentId: 2 }]],
    ['duplicate id', [good, { ...good, slug: 'other' }]],
    ['bad slug', [{ ...good, slug: 'Bad Slug' }]],
    ['bad currency', [{ ...good, currency: 'usd' }]],
    ['zero id', [{ ...good, smoobuApartmentId: 0 }]],
    ['zero guests', [{ ...good, maxGuests: 0 }]],
    ['empty name', [{ ...good, name: ' ' }]],
    ['empty catalog', []],
  ])('rejects %s', (_label, catalog) => {
    expect(() => validateCatalog(catalog)).toThrow();
  });

  it('helpers', () => {
    expect(findBySlug([good], 'ok-house')).toBe(good);
    expect(findBySlug([good], 'nope')).toBeUndefined();
    expect(maxGuestsAcross([good, { ...good, slug: 'b', smoobuApartmentId: 2, maxGuests: 9 }])).toBe(9);
  });
});
