/**
 * Vercel entry point (Node runtime, Web-standard handler).
 * `vercel.json` rewrites /mcp to this function.
 */
import { createApp } from '../src/app.js';
import type { FetchHandler } from '../src/http.js';
import { loadConfig } from '../src/config.js';

let handler: FetchHandler | undefined;
let configError: string | undefined;

function getHandler(): FetchHandler | undefined {
  if (handler !== undefined || configError !== undefined) return handler;
  try {
    handler = createApp(loadConfig(process.env)).handler;
  } catch (err) {
    // Configuration errors name variables, never values.
    configError = err instanceof Error ? err.message : 'configuration error';
    console.error(`smoobu-availability-mcp: ${configError}`);
  }
  return handler;
}

async function handle(request: Request): Promise<Response> {
  const h = getHandler();
  if (h === undefined) {
    return new Response(JSON.stringify({ error: 'Server is not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }
  return h(request);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
