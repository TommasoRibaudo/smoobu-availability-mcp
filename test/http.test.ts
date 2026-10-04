import { describe, expect, it } from 'vitest';
import { clientIpFrom } from '../src/http.js';
import { TokenBucketRateLimiter } from '../src/rateLimit.js';
import { createTestApp } from './helpers.js';

const URL_ = 'http://localhost/mcp';

function rpc(method: string, params: Record<string, unknown> = {}, id = 1): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  };
}

const INIT = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });

describe('HTTP handler', () => {
  it('answers OPTIONS with CORS headers and no body', async () => {
    const { app } = createTestApp();
    const res = await app.handler(new Request(URL_, { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('handles initialize statelessly: JSON response, no session id, no-store', async () => {
    const { app } = createTestApp();
    const res = await app.handler(new Request(URL_, INIT));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('smoobu-availability-mcp');
  });

  it('serves tools/list without a prior initialize (stateless)', async () => {
    const { app } = createTestApp();
    const res = await app.handler(new Request(URL_, rpc('tools/list')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools).toHaveLength(4);
  });

  it('rate limits per client IP with 429 + Retry-After and keeps IPs independent', async () => {
    const { app } = createTestApp({ rateLimiter: new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 0.001 }) });
    const from = (ip: string): Request => new Request(URL_, { ...rpc('tools/list'), headers: { ...(rpc('tools/list').headers as Record<string, string>), 'x-forwarded-for': `${ip}, 10.0.0.1` } });

    expect((await app.handler(from('203.0.113.5'))).status).toBe(200);
    expect((await app.handler(from('203.0.113.5'))).status).toBe(200);
    const limited = await app.handler(from('203.0.113.5'));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const body = (await limited.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/rate limit/i);

    expect((await app.handler(from('203.0.113.6'))).status).toBe(200);
  });

  it('prefers the hosting layer client ip over forwarded headers', async () => {
    const { app } = createTestApp({ rateLimiter: new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0.001 }) });
    const req = (): Request => new Request(URL_, { ...rpc('tools/list'), headers: { ...(rpc('tools/list').headers as Record<string, string>), 'x-forwarded-for': '198.51.100.1' } });
    expect((await app.handler(req(), { clientIp: 'a' })).status).toBe(200);
    expect((await app.handler(req(), { clientIp: 'b' })).status).toBe(200);
    expect((await app.handler(req(), { clientIp: 'a' })).status).toBe(429);
  });

  it('clientIpFrom resolves ctx, then vercel header, then x-forwarded-for, then x-real-ip, then unknown', () => {
    const mk = (h: Record<string, string>): Request => new Request(URL_, { headers: h });
    expect(clientIpFrom(mk({ 'x-forwarded-for': '1.1.1.1' }), { clientIp: '9.9.9.9' })).toBe('9.9.9.9');
    expect(clientIpFrom(mk({ 'x-vercel-forwarded-for': '2.2.2.2', 'x-forwarded-for': '1.1.1.1' }))).toBe('2.2.2.2');
    expect(clientIpFrom(mk({ 'x-forwarded-for': ' 1.1.1.1 , 3.3.3.3' }))).toBe('1.1.1.1');
    expect(clientIpFrom(mk({ 'x-real-ip': '4.4.4.4' }))).toBe('4.4.4.4');
    expect(clientIpFrom(mk({}))).toBe('unknown');
  });

  it('does not rate limit the plain GET description', async () => {
    const { app } = createTestApp({ rateLimiter: new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0.001 }) });
    for (let i = 0; i < 5; i++) expect((await app.handler(new Request(URL_))).status).toBe(200);
  });

  it('rejects oversized bodies with 413', async () => {
    const { app } = createTestApp();
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(70 * 1024) } });
    const res = await app.handler(new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: big }));
    expect(res.status).toBe(413);
  });

  it('refuses a standalone GET SSE stream with 405 (stateless, nothing to stream)', async () => {
    const { app } = createTestApp();
    const res = await app.handler(new Request(URL_, { headers: { accept: 'text/event-stream' } }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toContain('POST');
  });

  it('returns a JSON-RPC error, not a stack, for a malformed body', async () => {
    const { app } = createTestApp();
    const res = await app.handler(new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{not json' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    const text = await res.text();
    expect(text).not.toMatch(/\.ts:\d+/);
  });
});
