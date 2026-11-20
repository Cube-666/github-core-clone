// github-core-clone: a GitHub-compatible git forge in one process.
//
// Surfaces: git smart HTTP (/:owner/:repo.git), REST v3 (/api/v3),
// GraphQL v4 (/api/graphql) and MCP (/mcp), all over one in-memory store.
//
// Lifecycle (the harness drives it): bind an ephemeral port, POST the port
// to $MAKEFUN_ENV_URL/register, answer GET /healthz, then poll GET
// $MAKEFUN_ENV_URL/done until the suite is over and exit 0. Without an env
// URL the forge just serves on $PORT (or 3000) for local use.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleGit } from './src/git-http.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { errorBody, sendJson } from './src/http-util.ts';
import { Forge } from './src/store.ts';

const forge = new Forge();

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname === '/healthz' && (req.method ?? 'GET') === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (await handleGit(forge, req, res)) return;
    if (await handleRest(forge, req, res)) return;
    if (await handleGraphql(forge, req, res)) return;
    if (await handleMcp(forge, req, res)) return;
    sendJson(res, 404, errorBody('Not Found'));
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, errorBody(error instanceof Error ? error.message : 'internal error'));
    } else {
      res.destroy();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url);
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function register(envUrl: string, port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  let delay = 100;
  for (;;) {
    try {
      const { status } = await postJson(`${envUrl.replace(/\/+$/, '')}/register`, { port });
      if (status === 200 || status === 409) return;
    } catch {
      // The env may not be listening yet; retry until the deadline.
    }
    if (Date.now() > deadline) throw new Error(`could not register with ${envUrl}`);
    await sleep(delay);
    delay = Math.min(delay * 2, 1000);
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  const doneUrl = `${envUrl.replace(/\/+$/, '')}/done`;
  let delay = 500;
  for (;;) {
    const body = await getJson(doneUrl);
    if (body !== null && body.done === true) return;
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

const server = createServer((req, res) => {
  void dispatch(req, res);
});

const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
if (envUrl === '') {
  const port = Number(process.env.PORT ?? '3000') || 3000;
  server.listen(port, '127.0.0.1', () => {
    console.log(`github-core-clone listening on http://127.0.0.1:${port} (no MAKEFUN_ENV_URL; standalone mode)`);
  });
} else {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      console.error('could not read the bound port');
      process.exit(1);
    }
    const port = address.port;
    register(envUrl, port)
      .then(() => {
        console.log(`github-core-clone registered on port ${port} with ${envUrl}`);
        return waitForDone(envUrl);
      })
      .then(() => {
        server.close(() => process.exit(0));
        // If close stalls, exit anyway after a short grace period.
        setTimeout(() => process.exit(0), 1000).unref();
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
  });
}
