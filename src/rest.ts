// GitHub REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, with the exact statuses and shapes the
// conformance suite asserts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  branchTip,
  commitAuthorOf,
  commitMessageOf,
  createIssue,
  createPull,
  deleteContent,
  issueJson,
  listBranches,
  listCommits,
  listIssues,
  mergePull,
  pullFiles,
  pullJson,
  putContent,
  readContent,
  repoJson,
} from './domain.ts';
import { errorBody, hasAuth, parseJsonBody, pathSegments, readBody, sendJson, sendNoContent } from './http-util.ts';
import { VIEWER_LOGIN, type Forge, type Repo } from './store.ts';

interface Ctx {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
}

function notFound(ctx: Ctx, message = 'Not Found'): void {
  sendJson(ctx.res, 404, errorBody(message));
}

function unprocessable(ctx: Ctx, message: string): void {
  sendJson(ctx.res, 422, errorBody(message));
}

/** The repository a route names, or null after answering the 404. */
function repoOf(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    notFound(ctx);
    return null;
  }
  const repo = ctx.forge.getRepo(name);
  if (repo === undefined) {
    notFound(ctx);
    return null;
  }
  return repo;
}

function pageOf(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, Number(ctx.url.searchParams.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(ctx.url.searchParams.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(ctx: Ctx, items: T[]): { page: T[]; link: string | null } {
  const { page, perPage } = pageOf(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  let link: string | null = null;
  if (page < totalPages) {
    const base = `${ctx.url.origin}${ctx.url.pathname}`;
    const nextParams = new URLSearchParams(ctx.url.searchParams);
    nextParams.set('page', String(page + 1));
    nextParams.set('per_page', String(perPage));
    const lastParams = new URLSearchParams(ctx.url.searchParams);
    lastParams.set('page', String(totalPages));
    lastParams.set('per_page', String(perPage));
    link = `<${base}?${nextParams.toString()}>; rel="next", <${base}?${lastParams.toString()}>; rel="last"`;
  }
  return { page: slice, link };
}

async function readJsonBody(ctx: Ctx): Promise<unknown> {
  const buf = await readBody(ctx.req);
  try {
    return parseJsonBody(buf);
  } catch {
    sendJson(ctx.res, 400, errorBody('malformed JSON body'));
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Handle one REST request. Returns true when the route was answered. */
export async function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const segments = pathSegments(url.pathname);
  if (segments[0] !== 'api' || segments[1] !== 'v3') return false;
  if (!hasAuth(req)) {
    sendJson(res, 401, errorBody('Requires authentication'));
    return true;
  }
  const ctx: Ctx = { forge, req, res, url, segments };
  const method = req.method ?? 'GET';
  const rest = segments.slice(2);

  // GET /api/v3/ — the API root, with the OAuth scopes header.
  if (rest.length === 0 && method === 'GET') {
    sendJson(res, 200, {}, { 'x-oauth-scopes': 'repo, read:user' });
    return true;
  }
  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return true;
  }
  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: 1, type: 'User' });
    return true;
  }
  // POST /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos' && method === 'POST') {
    const body = await readJsonBody(ctx);
    if (body === undefined) return true;
    if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
      unprocessable(ctx, 'name is required');
      return true;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(body.name)) {
      unprocessable(ctx, 'name is invalid');
      return true;
    }
    const repo = forge.createRepo(body.name, body.private === true, typeof body.description === 'string' ? body.description : null);
    if (repo === null) {
      unprocessable(ctx, 'name already exists on this account');
      return true;
    }
    sendJson(res, 201, repoJson(forge, repo));
    return true;
  }
  // GET /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos' && method === 'GET') {
    const { page, link } = paginate(ctx, forge.listRepos().map((repo) => repoJson(forge, repo)));
    sendJson(res, 200, page, link === null ? {} : { link });
    return true;
  }

  // Repository-scoped routes: /api/v3/repos/:owner/:name[/...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const name = rest[2]!;
    const tail = rest.slice(3);

    // GET /repos/:owner/:name
    if (tail.length === 0 && method === 'GET') {
      const repo = repoOf(ctx, owner, name);
      if (repo === null) return true;
      sendJson(res, 200, repoJson(forge, repo));
      return true;
    }
    // PATCH /repos/:owner/:name
    if (tail.length === 0 && method === 'PATCH') {
      const repo = repoOf(ctx, owner, name);
      if (repo === null) return true;
      const body = await readJsonBody(ctx);
      if (body === undefined) return true;
      if (isRecord(body) && typeof body.description === 'string') repo.description = body.description;
      sendJson(res, 200, repoJson(forge, repo));
      return true;
    }
    // DELETE /repos/:owner/:name
    if (tail.length === 0 && method === 'DELETE') {
      if (owner !== VIEWER_LOGIN) {
        notFound(ctx);
        return true;
      }
      if (!forge.deleteRepo(name)) {
        notFound(ctx);
        return true;
      }
      sendNoContent(res, 204);
      return true;
    }

    const repo = repoOf(ctx, owner, name);
    if (repo === null) return true;

    // GET /repos/:owner/:name/branches
    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      const branches = listBranches(repo).map((branch) => ({
        name: branch.name,
        commit: { sha: branch.sha },
        protected: false,
      }));
      sendJson(res, 200, branches);
      return true;
    }
    // GET /repos/:owner/:name/branches/:branch
    if (tail.length === 2 && tail[0] === 'branches' && method === 'GET') {
      const sha = branchTip(repo, tail[1]!);
      if (sha === undefined) {
        notFound(ctx, 'Branch not found');
        return true;
      }
      sendJson(res, 200, { name: tail[1], commit: { sha }, protected: false });
      return true;
    }
    // GET /repos/:owner/:name/commits
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const sha = url.searchParams.get('sha') ?? repo.defaultBranch;
      const commits = listCommits(repo, sha).map((oid) => {
        const author = commitAuthorOf(repo, oid);
        return {
          sha: oid,
          commit: {
            message: commitMessageOf(repo, oid),
            author: { name: author.name, email: author.email, date: author.date },
            committer: { name: author.name, email: author.email, date: author.date },
          },
        };
      });
      sendJson(res, 200, commits);
      return true;
    }
    // GET /repos/:owner/:name/git/refs/heads/:branch
    if (tail.length === 4 && tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads' && method === 'GET') {
      const sha = branchTip(repo, tail[3]!);
      if (sha === undefined) {
        notFound(ctx, 'Reference does not exist');
        return true;
      }
      sendJson(res, 200, { ref: `refs/heads/${tail[3]}`, object: { sha, type: 'commit' } });
      return true;
    }
    // POST /repos/:owner/:name/git/refs
    if (tail.length === 3 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
      const body = await readJsonBody(ctx);
      if (body === undefined) return true;
      if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
        unprocessable(ctx, 'ref and sha are required');
        return true;
      }
      if (!body.ref.startsWith('refs/')) {
        unprocessable(ctx, 'ref must start with refs/');
        return true;
      }
      if (repo.refs.has(body.ref)) {
        unprocessable(ctx, 'Reference already exists');
        return true;
      }
      const obj = repo.objects.get(body.sha);
      if (obj === undefined || (obj.type !== 'commit' && obj.type !== 'tag')) {
        unprocessable(ctx, 'sha does not name a commit or tag');
        return true;
      }
      repo.refs.set(body.ref, body.sha);
      sendJson(res, 201, { ref: body.ref, object: { sha: body.sha, type: obj.type } });
      return true;
    }
    // Contents: /repos/:owner/:name/contents/<path...>
    if (tail.length >= 1 && tail[0] === 'contents') {
      const contentPath = tail.slice(1).join('/');
      if (contentPath === '') {
        notFound(ctx);
        return true;
      }
      if (method === 'GET') {
        const ref = url.searchParams.get('ref') ?? undefined;
        const read = readContent(repo, contentPath, ref);
        if (read === null) {
          notFound(ctx);
          return true;
        }
        if (read.kind === 'file') {
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: read.content.toString('base64'),
            sha: read.sha,
            size: read.size,
            name: read.name,
            path: read.path,
          });
        } else {
          sendJson(res, 200, read.entries);
        }
        return true;
      }
      if (method === 'PUT') {
        const body = await readJsonBody(ctx);
        if (body === undefined) return true;
        if (!isRecord(body) || typeof body.message !== 'string' || typeof body.content !== 'string') {
          unprocessable(ctx, 'message and content are required');
          return true;
        }
        let content: Buffer;
        try {
          content = Buffer.from(body.content, 'base64');
        } catch {
          unprocessable(ctx, 'content is not valid base64');
          return true;
        }
        const result = putContent(repo, {
          path: contentPath,
          content,
          message: body.message,
          branch: typeof body.branch === 'string' ? body.branch : undefined,
          sha: typeof body.sha === 'string' ? body.sha : undefined,
        });
        if (!result.ok) {
          sendJson(res, result.status, errorBody(result.message ?? 'error'));
          return true;
        }
        sendJson(res, result.status, {
          content: { sha: result.contentSha, encoding: 'base64' },
          commit: { sha: result.commitSha },
        });
        return true;
      }
      if (method === 'DELETE') {
        const body = await readJsonBody(ctx);
        if (body === undefined) return true;
        if (!isRecord(body) || typeof body.message !== 'string') {
          unprocessable(ctx, 'message is required');
          return true;
        }
        const result = deleteContent(repo, {
          path: contentPath,
          message: body.message,
          branch: typeof body.branch === 'string' ? body.branch : undefined,
          sha: typeof body.sha === 'string' ? body.sha : undefined,
        });
        if (!result.ok) {
          sendJson(res, result.status, errorBody(result.message ?? 'error'));
          return true;
        }
        sendJson(res, 200, { commit: { sha: result.commitSha } });
        return true;
      }
      notFound(ctx);
      return true;
    }
    // Labels
    if (tail.length === 1 && tail[0] === 'labels' && method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()]);
      return true;
    }
    if (tail.length === 1 && tail[0] === 'labels' && method === 'POST') {
      const body = await readJsonBody(ctx);
      if (body === undefined) return true;
      if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
        unprocessable(ctx, 'name is required');
        return true;
      }
      if (repo.labels.has(body.name)) {
        unprocessable(ctx, 'label already exists');
        return true;
      }
      const label = { name: body.name, color: typeof body.color === 'string' ? body.color : 'ededed' };
      repo.labels.set(label.name, label);
      sendJson(res, 201, label);
      return true;
    }
    // Issues
    if (tail.length === 1 && tail[0] === 'issues' && method === 'GET') {
      const issues = listIssues(repo, {
        state: url.searchParams.get('state') ?? undefined,
        sort: url.searchParams.get('sort') ?? undefined,
        direction: url.searchParams.get('direction') ?? undefined,
      });
      const { page, link } = paginate(ctx, issues.map((issue) => issueJson(forge, repo, issue)));
      sendJson(res, 200, page, link === null ? {} : { link });
      return true;
    }
    if (tail.length === 1 && tail[0] === 'issues' && method === 'POST') {
      const body = await readJsonBody(ctx);
      if (body === undefined) return true;
      if (!isRecord(body) || typeof body.title !== 'string') {
        unprocessable(ctx, 'title is required');
        return true;
      }
      const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      const created = createIssue(repo, { title: body.title, body: typeof body.body === 'string' ? body.body : '', labels });
      if ('error' in created) {
        sendJson(res, created.status, errorBody(created.error));
        return true;
      }
      sendJson(res, 201, issueJson(forge, repo, created.issue));
      return true;
    }
    if (tail.length === 2 && tail[0] === 'issues' && method === 'GET') {
      const number = Number(tail[1]);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) {
        notFound(ctx);
        return true;
      }
      sendJson(res, 200, issueJson(forge, repo, issue));
      return true;
    }
    if (tail.length === 2 && tail[0] === 'issues' && method === 'PATCH') {
      const number = Number(tail[1]);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) {
        notFound(ctx);
        return true;
      }
      const body = await readJsonBody(ctx);
      if (body === undefined) return true;
      if (isRecord(body)) {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
      }
      sendJson(res, 200, issueJson(forge, repo, issue));
      return true;
    }
    // Issue comments
    if (tail.length === 3 && tail[0] === 'issues' && tail[2] === 'comments' && method === 'GET') {
      const number = Number(tail[1]);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) {
        notFound(ctx);
        return true;
      }
      sendJson(res, 200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
      return true;
    }
    if (tail.length === 3 && tail[0] === 'issues' && tail[2] === 'comments' && method === 'POST') {
      const number = Number(tail[1]);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) {
        notFound(ctx);
        return true;
      }
      const body = await readJsonBody(ctx);
      if (body === undefined) return true;
      if (!isRecord(body) || typeof body.body !== 'string') {
        unprocessable(ctx, 'body is required');
        return true;
      }
      const comment = { id: repo.nextCommentId, body: body.body };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      sendJson(res, 201, { id: comment.id, body: comment.body });
      return true;
    }
    // Pull requests
    if (tail.length === 1 && tail[0] === 'pulls' && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      const { page, link } = paginate(ctx, pulls.map((pull) => pullJson(forge, repo, pull)));
      sendJson(res, 200, page, link === null ? {} : { link });
      return true;
    }
    if (tail.length === 1 && tail[0] === 'pulls' && method === 'POST') {
      const body = await readJsonBody(ctx);
      if (body === undefined) return true;
      if (!isRecord(body) || typeof body.title !== 'string' || typeof body.head !== 'string' || typeof body.base !== 'string') {
        unprocessable(ctx, 'title, head and base are required');
        return true;
      }
      const created = createPull(repo, {
        title: body.title,
        head: body.head,
        base: body.base,
        body: typeof body.body === 'string' ? body.body : '',
      });
      if ('error' in created) {
        sendJson(res, created.status, errorBody(created.error));
        return true;
      }
      sendJson(res, 201, pullJson(forge, repo, created.pull));
      return true;
    }
    if (tail.length === 2 && tail[0] === 'pulls' && method === 'GET') {
      const number = Number(tail[1]);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) {
        notFound(ctx);
        return true;
      }
      sendJson(res, 200, pullJson(forge, repo, pull));
      return true;
    }
    if (tail.length === 3 && tail[0] === 'pulls' && tail[2] === 'files' && method === 'GET') {
      const number = Number(tail[1]);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) {
        notFound(ctx);
        return true;
      }
      sendJson(res, 200, pullFiles(repo, pull));
      return true;
    }
    if (tail.length === 3 && tail[0] === 'pulls' && tail[2] === 'merge' && method === 'PUT') {
      const number = Number(tail[1]);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) {
        notFound(ctx);
        return true;
      }
      const body = await readJsonBody(ctx);
      if (body === undefined) return true;
      const result = mergePull(repo, pull);
      if ('error' in result) {
        sendJson(res, result.status, errorBody(result.error));
        return true;
      }
      sendJson(res, 200, { merged: true, sha: result.sha, message: `Merged pull request #${pull.number}` });
      return true;
    }
    notFound(ctx);
    return true;
  }

  return false;
}
