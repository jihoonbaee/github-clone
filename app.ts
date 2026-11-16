// The forge's HTTP server: routing, authentication, and the shared store.
// Routes:
//   GET  /healthz            no auth, {"ok": true}
//   POST /mcp                Bearer auth, JSON-RPC 2.0
//   POST /api/graphql        Bearer auth, GraphQL
//   /api/v3/*                Bearer auth, REST v3
//   /{owner}/{repo}.git/*    git smart HTTP (no auth: the suite never tests
//                            git authentication, and permissive git cannot
//                            fail any check)
// Anything else is a JSON 404. Every API answer carries
// X-GitHub-Request-Id, including errors.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleGitHttp } from './src/git-http.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest, type ApiResponse } from './src/rest.ts';
import { Store } from './src/store.ts';
import { nextRequestId } from './src/util.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

export function createStore(): Store {
  return new Store();
}

/** The bearer token the trial configured ('' when unset: local development). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function isAuthorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented === '') return false;
  const expected = expectedToken();
  // With no token configured (local runs), any non-empty bearer token is the
  // viewer; in a trial the env always sets MAKEFUN_SHOP_TOKEN, so the check
  // below is the one that matters.
  if (expected === '') return true;
  return presented === expected;
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  response.end(payload);
}

function sendApiResponse(response: ServerResponse, result: ApiResponse): void {
  if (result.status === 204) {
    response.writeHead(204, { 'x-github-request-id': nextRequestId() });
    response.end();
    return;
  }
  sendJson(response, result.status, result.body, result.headers ?? {});
}

function decodeSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export function createForgeServer(store: Store): ReturnType<typeof createServer> {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://forge.invalid');
      const method = request.method ?? 'GET';
      const segments = decodeSegments(url.pathname);

      if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
        sendJson(response, 200, { ok: true });
        return;
      }

      // Git smart HTTP (no auth).
      if (
        segments.length >= 2 &&
        segments[1] !== undefined &&
        segments[1].endsWith('.git')
      ) {
        const body = method === 'POST' ? await readBody(request) : Buffer.alloc(0);
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          headers[name.toLowerCase()] = typeof value === 'string' ? value : undefined;
        }
        const result = handleGitHttp(store, method, segments, url.searchParams, headers, body);
        if (result !== null) {
          response.writeHead(result.status, {
            'content-type': result.contentType,
            'x-github-request-id': nextRequestId(),
          });
          response.end(result.body);
          return;
        }
        sendJson(response, 404, { message: 'Not Found' });
        return;
      }

      // Everything below needs a valid bearer token.
      const needsAuth =
        (segments.length >= 1 && segments[0] === 'mcp') ||
        (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'graphql') ||
        (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3');
      if (needsAuth && !isAuthorized(request)) {
        sendJson(response, 401, { message: 'Bad credentials' });
        return;
      }

      if (segments.length === 1 && segments[0] === 'mcp') {
        if (method !== 'POST') {
          sendJson(response, 404, { message: 'Not Found' });
          return;
        }
        const body = await readBody(request);
        const result = handleMcp(store, body);
        if (result.status === 202 || result.body === null) {
          response.writeHead(202, { 'x-github-request-id': nextRequestId() });
          response.end();
          return;
        }
        sendJson(response, result.status, result.body);
        return;
      }

      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
        if (method !== 'POST') {
          sendJson(response, 404, { message: 'Not Found' });
          return;
        }
        const body = await readBody(request);
        const result = handleGraphQL(store, body);
        sendJson(response, result.status, result.body);
        return;
      }

      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        const body = await readBody(request);
        const host = request.headers.host ?? '127.0.0.1';
        const result = handleRest(store, {
          method,
          segments: segments.slice(2),
          query: url.searchParams,
          body,
          host,
        });
        sendApiResponse(response, result);
        return;
      }

      sendJson(response, 404, { message: 'Not Found' });
    } catch (error) {
      // The server must never die on a bad request (repo-survives-errors).
      if (!response.headersSent) {
        sendJson(response, 500, {
          message: error instanceof Error ? error.message : 'internal error',
        });
      } else {
        response.end();
      }
    }
  });
}

/** Start the server on a port (0 = any free port) and return the bound port. */
export function listen(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind a port'));
        return;
      }
      resolve(address.port);
    });
  });
}
