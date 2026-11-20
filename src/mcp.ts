// Model Context Protocol endpoint (Streamable HTTP, 2026-07-28 revision):
// server/discover, the legacy initialize handshake, tools/list and tools/call
// over the same store the REST and GraphQL surfaces use.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createIssue, createPull, mergePull, repoJson } from './domain.ts';
import { hasAuth, parseJsonBody, readBody, sendJson } from './http-util.ts';
import { VIEWER_LOGIN, type Forge } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the token owner.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: ServerResponse, id: unknown, code: number, message: string, status = 200): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoOf(forge: Forge, args: Record<string, unknown>): { repo: NonNullable<ReturnType<Forge['getRepo']>> } | { error: string } {
  const owner = args.owner;
  const repoName = args.repo;
  if (typeof owner !== 'string' || typeof repoName !== 'string') return { error: 'owner and repo are required' };
  if (owner !== VIEWER_LOGIN) return { error: `repository ${owner}/${repoName} not found` };
  const repo = forge.getRepo(repoName);
  if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
  return { repo };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`unknown tool ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      throw new Error(`missing required argument ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return toolError('name is invalid');
      const repo = forge.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : null);
      if (repo === null) return toolError(`repository ${repoName} already exists`);
      return toolResult(repoJson(forge, repo));
    }
    case 'get_repo': {
      const found = repoOf(forge, args);
      if ('error' in found) return toolError(found.error);
      return toolResult(repoJson(forge, found.repo));
    }
    case 'create_issue': {
      const found = repoOf(forge, args);
      if ('error' in found) return toolError(found.error);
      const created = createIssue(found.repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return toolError(created.error);
      return toolResult({
        number: created.issue.number,
        title: created.issue.title,
        body: created.issue.body,
        state: created.issue.state,
      });
    }
    case 'list_issues': {
      const found = repoOf(forge, args);
      if ('error' in found) return toolError(found.error);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = found.repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return toolResult(
        issues.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body, state: issue.state })),
      );
    }
    case 'create_pull_request': {
      const found = repoOf(forge, args);
      if ('error' in found) return toolError(found.error);
      const created = createPull(found.repo, {
        title: args.title as string,
        head: args.head as string,
        base: args.base as string,
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return toolError(created.error);
      return toolResult({
        number: created.pull.number,
        title: created.pull.title,
        state: created.pull.state,
        head: { ref: created.pull.head },
        base: { ref: created.pull.base },
      });
    }
    case 'merge_pull_request': {
      const found = repoOf(forge, args);
      if ('error' in found) return toolError(found.error);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = found.repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return toolError(`pull request #${number} not found`);
      const result = mergePull(found.repo, pull);
      if ('error' in result) return toolError(result.error);
      return toolResult({ number: pull.number, merged: true, sha: result.sha, state: pull.state });
    }
    default:
      return toolError(`tool ${name} is not implemented`);
  }
}

/** POST /mcp: JSON-RPC over Streamable HTTP (one JSON body per request). */
export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  if (url.pathname !== '/mcp') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'method not allowed' } });
    return true;
  }
  if (!hasAuth(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } });
    return true;
  }
  let body: unknown;
  try {
    body = parseJsonBody(await readBody(req));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = body.id ?? null;
  const method = body.method;
  const params = isRecord(body.params) ? body.params : {};

  // Notifications carry no id and get an empty 202.
  if (id === null && typeof method === 'string' && method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return true;
  }

  if (method === 'server/discover') {
    rpcResult(res, id, {
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return true;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = LEGACY_REVISIONS.includes(requested) ? requested : '2025-11-25';
    rpcResult(res, id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }
  if (method === 'tools/list') {
    rpcResult(res, id, { tools: TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (typeof name !== 'string' || name === '') {
      rpcError(res, id, -32602, 'tools/call requires a tool name');
      return true;
    }
    const tool = TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) {
      rpcError(res, id, -32602, `unknown tool ${name}`);
      return true;
    }
    try {
      const result = callTool(forge, name, args);
      rpcResult(res, id, result);
    } catch (error) {
      // A missing required argument (or any other call failure) is a
      // JSON-RPC invalid-params error, never an HTTP 500.
      rpcError(res, id, -32602, error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  rpcError(res, id, -32601, `method not found: ${String(method)}`);
  return true;
}
