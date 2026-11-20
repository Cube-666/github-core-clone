// Small HTTP plumbing shared by every surface: body reading, JSON replies,
// the bearer check and the per-reply request id the REST protocol checks
// require on every response.

import type { IncomingMessage, ServerResponse } from 'node:http';

let requestCounter = 0;

/** A short unique id for one reply's X-GitHub-Request-Id header. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** Read the whole request body (up to the cap), or throw on overflow. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns null for an empty body, throws on bad JSON. */
export function parseJsonBody(buf: Buffer): unknown {
  const text = buf.toString('utf8').trim();
  if (text === '') return null;
  return JSON.parse(text);
}

export function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

export function sendNoContent(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

export function sendText(res: ServerResponse, status: number, text: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
  });
  res.end(text);
}

/** True when the request carries a non-empty bearer token. */
export function hasAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined) return false;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match !== null && match[1]!.trim() !== '';
}

/** The standard error body for REST/GraphQL surfaces. */
export function errorBody(message: string): { message: string } {
  return { message };
}

/** Split a URL path into its decoded segments, dropping empty ones. */
export function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}
