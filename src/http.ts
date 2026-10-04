import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Logger } from './log.js';
import type { RateLimiter } from './rateLimit.js';
import { SERVER_NAME, SERVER_VERSION, TOOL_NAMES, createMcpServer } from './server.js';
import type { ToolDeps } from './tools/shared.js';

export interface McpHandlerOptions {
  readonly deps: ToolDeps;
  readonly rateLimiter: RateLimiter;
  readonly log: Logger;
  /** Upper bound on an accepted POST body. Tool calls are a few hundred bytes. */
  readonly maxRequestBodyBytes?: number;
}

export interface RequestContext {
  /** Client IP as seen by the hosting layer; falls back to forwarded headers. */
  readonly clientIp?: string | undefined;
}

export type FetchHandler = (request: Request, ctx?: RequestContext) => Promise<Response>;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return withCors(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } }));
}

export function clientIpFrom(request: Request, ctx?: RequestContext): string {
  if (ctx?.clientIp !== undefined && ctx.clientIp.length > 0) return ctx.clientIp;
  const forwarded = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first !== undefined && first.length > 0) return first;
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * Stateless Streamable HTTP handler built on Web-standard Request/Response so
 * the same code runs on Vercel and under the local Node server.
 *
 * Each POST gets its own McpServer + transport (no sessions, JSON responses),
 * which is what a serverless deployment needs.
 */
export function createMcpHandler(opts: McpHandlerOptions): FetchHandler {
  const maxBody = opts.maxRequestBodyBytes ?? 64 * 1024;

  return async (request, ctx) => {
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

    if (request.method === 'GET') {
      // Stateless server: there are no server-initiated messages, so a standalone
      // SSE stream (GET with Accept: text/event-stream) is refused instead of left hanging.
      if ((request.headers.get('accept') ?? '').includes('text/event-stream')) {
        return json(405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This stateless server accepts POST only.' }, id: null }, { Allow: 'POST, OPTIONS' });
      }
      return json(200, {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        transport: 'streamable-http',
        endpoint: '/mcp',
        tools: TOOL_NAMES,
        readOnly: true,
      });
    }

    const decision = await opts.rateLimiter.consume(clientIpFrom(request, ctx));
    if (!decision.allowed) {
      const retryAfter = String(decision.retryAfterSeconds ?? 1);
      opts.log('ratelimit.denied', { retryAfterSeconds: Number(retryAfter) });
      return json(
        429,
        { jsonrpc: '2.0', error: { code: -32000, message: `Rate limit exceeded. Retry after ${retryAfter} seconds.` }, id: null },
        { 'Retry-After': retryAfter },
      );
    }

    const server = createMcpServer(opts.deps);
    // No sessionIdGenerator => stateless mode (no Mcp-Session-Id, no server-side state).
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      maxRequestBodySize: maxBody,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      return withCors(response);
    } catch {
      opts.log('http.error', { status: 500 });
      return json(500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
}
