import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodType } from 'zod';
import type { CachedLoader } from '../cache.js';
import type { CatalogProperty } from '../catalog.js';
import { findBySlug } from '../catalog.js';
import { SmoobuShapeError, SmoobuUpstreamError, UserFacingError } from '../errors.js';
import type { Logger } from '../log.js';
import type { SmoobuClient } from '../smoobu/client.js';
import { todayInCostaRica } from '../validation.js';

export interface ToolDeps {
  readonly smoobu: Pick<SmoobuClient, 'getRates' | 'checkAvailability'>;
  readonly catalog: readonly CatalogProperty[];
  readonly loader: CachedLoader;
  readonly bookingUrlTemplate: string;
  readonly cacheTtlRatesMs: number;
  readonly cacheTtlAvailabilityMs: number;
  readonly now: () => Date;
  readonly log: Logger;
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const UPSTREAM_ERROR_TEXT = 'The booking system is temporarily unavailable. Please try again in a minute.';
export const GENERIC_ERROR_TEXT = 'Something went wrong while handling this request. Please try again.';

export function today(deps: ToolDeps): string {
  return todayInCostaRica(deps.now());
}

export function requireProperty(deps: ToolDeps, slug: string): CatalogProperty {
  const p = findBySlug(deps.catalog, slug);
  if (p === undefined) {
    const known = deps.catalog.map((c) => c.slug).join(', ');
    // The caller's value is deliberately not echoed back.
    throw new UserFacingError(`Unknown property. Known property slugs: ${known}. Call list_properties for details.`);
  }
  return p;
}

/**
 * Validate against the strict output schema and emit both structuredContent
 * and a JSON text block. `schema.parse` throws on any unknown key, so a
 * leaked field turns into a generic error instead of reaching the caller.
 */
export function ok<T>(schema: ZodType<T>, data: T): CallToolResult {
  const validated = schema.parse(data);
  return {
    content: [{ type: 'text', text: JSON.stringify(validated, null, 2) }],
    structuredContent: validated as Record<string, unknown>,
  };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Runs a tool body and converts every failure into a friendly, stack-free result. */
export async function guarded(deps: ToolDeps, body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof UserFacingError) return fail(err.message);
    if (err instanceof SmoobuUpstreamError || err instanceof SmoobuShapeError) return fail(UPSTREAM_ERROR_TEXT);
    deps.log('http.error', { tool: true });
    return fail(GENERIC_ERROR_TEXT);
  }
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}
