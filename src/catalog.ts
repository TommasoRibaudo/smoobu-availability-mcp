/**
 * Hand-written public catalog.
 *
 * This file is the ONLY source of public property identity. Tools never read
 * names or ids from Smoobu; they only use the Smoobu apartment id internally
 * to query prices and availability for a catalog entry.
 *
 * To go live, replace the entries below with your real properties and set
 * CATALOG_IS_PLACEHOLDER to false.
 */

export interface CatalogProperty {
  /** URL-safe public identifier used in tool calls and booking links. */
  readonly slug: string;
  /** Public marketing name. */
  readonly name: string;
  readonly bedrooms: number;
  readonly maxGuests: number;
  /** ISO 4217 currency the property is priced in (shown on the calendar). */
  readonly currency: string;
  /** INTERNAL Smoobu apartment id. Never returned by any tool. */
  readonly smoobuApartmentId: number;
}

/** Fields that may leave the server. Deliberately excludes smoobuApartmentId. */
export interface PublicProperty {
  readonly slug: string;
  readonly name: string;
  readonly bedrooms: number;
  readonly maxGuests: number;
}

/** Set to false once the entries below describe real properties. */
export const CATALOG_IS_PLACEHOLDER = false;

/**
 * Not yet known: fill in from Smoobu before merging. validateCatalog rejects
 * it, so tests and check-catalog fail until every TODO is replaced.
 */
const TODO = -1;

// Units from the 'luciano' Smoobu login only. The 4 La Perla units live under
// a second login, and the server holds one API key, so they are not listed here.
export const CATALOG: readonly CatalogProperty[] = [
  {
    slug: 'kalawala-tucano',
    name: 'Kalawala Tucano, Puerto Viejo',
    bedrooms: TODO,
    maxGuests: TODO,
    currency: 'USD',
    smoobuApartmentId: 301055,
  },
  {
    slug: 'kalawala-pappagallo',
    name: 'Kalawala Pappagallo, Puerto Viejo',
    bedrooms: TODO,
    maxGuests: TODO,
    currency: 'USD',
    smoobuApartmentId: 301058,
  },
  {
    slug: 'kalawala-geco',
    name: 'Kalawala Geco, Puerto Viejo',
    bedrooms: TODO,
    maxGuests: TODO,
    currency: 'USD',
    smoobuApartmentId: 301061,
  },
  {
    slug: 'kalawala-rana',
    name: 'Kalawala Rana, Puerto Viejo',
    bedrooms: TODO,
    maxGuests: TODO,
    currency: 'USD',
    smoobuApartmentId: 301064,
  },
  {
    slug: 'namaitami-areka',
    name: 'Namaitami Areka, Playa Chiquita',
    bedrooms: TODO,
    maxGuests: TODO,
    currency: 'USD',
    smoobuApartmentId: 1516846,
  },
  {
    slug: 'namaitami-plumeria',
    name: 'Namaitami Plumeria, Playa Chiquita',
    bedrooms: TODO,
    maxGuests: TODO,
    currency: 'USD',
    smoobuApartmentId: 1516849,
  },
  {
    slug: 'namaitami-giulia',
    name: 'Namaitami Giulia, Playa Chiquita',
    bedrooms: TODO,
    maxGuests: TODO,
    currency: 'USD',
    smoobuApartmentId: 1597723,
  },
  {
    slug: 'villa-coral',
    name: 'Villa Coral, Playa Chiquita',
    bedrooms: TODO,
    maxGuests: TODO,
    currency: 'USD',
    smoobuApartmentId: 1819085,
  },
  {
    slug: 'villa-mar',
    name: 'Villa Mar, Playa Chiquita',
    bedrooms: TODO,
    maxGuests: TODO,
    currency: 'USD',
    smoobuApartmentId: 1829402,
  },
  {
    slug: 'casa-delfines',
    name: 'Casa Delfines',
    bedrooms: TODO,
    maxGuests: TODO,
    currency: 'USD',
    smoobuApartmentId: 2946826,
  },
];

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Build the public view of a catalog entry, field by field. */
export function toPublicProperty(p: CatalogProperty): PublicProperty {
  return { slug: p.slug, name: p.name, bedrooms: p.bedrooms, maxGuests: p.maxGuests };
}

export function findBySlug(catalog: readonly CatalogProperty[], slug: string): CatalogProperty | undefined {
  return catalog.find((p) => p.slug === slug);
}

export function maxGuestsAcross(catalog: readonly CatalogProperty[]): number {
  return catalog.reduce((max, p) => Math.max(max, p.maxGuests), 0);
}

/** Throws if the catalog is malformed (run at startup and in tests). */
export function validateCatalog(catalog: readonly CatalogProperty[]): void {
  if (catalog.length === 0) throw new Error('Catalog is empty');
  const slugs = new Set<string>();
  const ids = new Set<number>();
  for (const p of catalog) {
    if (!SLUG_PATTERN.test(p.slug)) throw new Error(`Catalog slug "${p.slug}" is not url-safe`);
    if (slugs.has(p.slug)) throw new Error(`Catalog slug "${p.slug}" is duplicated`);
    if (ids.has(p.smoobuApartmentId)) throw new Error(`Catalog apartment id for "${p.slug}" is duplicated`);
    if (!Number.isInteger(p.smoobuApartmentId) || p.smoobuApartmentId <= 0) {
      throw new Error(`Catalog apartment id for "${p.slug}" must be a positive integer`);
    }
    if (!Number.isInteger(p.bedrooms) || p.bedrooms < 0) throw new Error(`Catalog bedrooms for "${p.slug}" invalid`);
    if (!Number.isInteger(p.maxGuests) || p.maxGuests < 1) throw new Error(`Catalog maxGuests for "${p.slug}" invalid`);
    if (!/^[A-Z]{3}$/.test(p.currency)) throw new Error(`Catalog currency for "${p.slug}" must be ISO 4217`);
    if (p.name.trim().length === 0) throw new Error(`Catalog name for "${p.slug}" is empty`);
    slugs.add(p.slug);
    ids.add(p.smoobuApartmentId);
  }
}
