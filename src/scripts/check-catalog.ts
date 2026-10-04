/**
 * `npm run check-catalog`: verifies every catalog entry's Smoobu apartment id
 * exists in the account. Prints slugs and ids only (your own terminal).
 */
import { existsSync } from 'node:fs';
import { CATALOG, CATALOG_IS_PLACEHOLDER, validateCatalog } from '../catalog.js';
import { loadConfig } from '../config.js';
import { SmoobuClient } from '../smoobu/client.js';

if (existsSync('.env')) process.loadEnvFile('.env');

async function main(): Promise<void> {
  validateCatalog(CATALOG);
  if (CATALOG_IS_PLACEHOLDER) console.error('WARNING: src/catalog.ts still contains the placeholder catalog.');
  const config = loadConfig(process.env);
  const client = new SmoobuClient({
    credentials: { apiKey: config.smoobuApiKey, apiSecret: config.smoobuApiSecret },
    customerId: config.smoobuCustomerId,
  });
  const ids = new Set(await client.listApartmentIds());
  let missing = 0;
  for (const p of CATALOG) {
    const found = ids.has(p.smoobuApartmentId);
    if (!found) missing += 1;
    console.log(`${found ? 'OK     ' : 'MISSING'} ${p.slug} -> apartment ${p.smoobuApartmentId}`);
  }
  console.log(`${CATALOG.length - missing}/${CATALOG.length} catalog entries matched; account has ${ids.size} apartment(s).`);
  process.exitCode = missing > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'check failed');
  process.exitCode = 1;
});
