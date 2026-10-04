import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { FetchHandler } from './http.js';

/** Minimal Node http -> Web Request/Response adapter (local dev and tests). */
export function toWebRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
}

export interface NodeServerOptions {
  readonly handler: FetchHandler;
  readonly port: number;
  readonly host?: string;
  readonly path?: string;
}

export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export function startNodeServer(opts: NodeServerOptions): Promise<RunningServer> {
  const path = opts.path ?? '/mcp';
  const host = opts.host ?? '127.0.0.1';

  const server = createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      try {
        if (pathname === '/healthz') {
          await writeWebResponse(res, new Response('ok', { status: 200 }));
          return;
        }
        if (pathname !== path && pathname !== '/') {
          await writeWebResponse(res, new Response('Not found', { status: 404 }));
          return;
        }
        const response = await opts.handler(toWebRequest(req), { clientIp: req.socket.remoteAddress ?? undefined });
        await writeWebResponse(res, response);
      } catch {
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      const address = server.address() as AddressInfo;
      resolve({
        server,
        port: address.port,
        url: `http://${host}:${address.port}${path}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.closeAllConnections();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
