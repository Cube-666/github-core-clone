// Git smart HTTP: ref advertisements (v0 and v2), ls-refs, fetch and
// receive-pack, in the exact framing the conformance client parses.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { fetchPlan } from './domain.ts';
import {
  isAncestor,
  parseCommit,
  parsePktLines,
  parseTag,
  pkt,
  pktDelim,
  pktFlush,
  pktLinesText,
  readPack,
  writePack,
  ZERO_OID,
} from './git.ts';
import { errorBody, hasAuth, pathSegments, readBody, sendJson } from './http-util.ts';
import { VIEWER_LOGIN, type Forge, type Repo } from './store.ts';

const AGENT = 'github-core-clone/1.0';

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

function refsSorted(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The peeled commit of an annotated tag ref, or null. */
function peeledOf(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  return parseTag(obj.data).object;
}

function advertisementV2(): Buffer {
  return Buffer.concat([
    pkt('# service=git-upload-pack\n'),
    pktFlush(),
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    pktFlush(),
  ]);
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} multi_ack thin-pack side-band-64k ofs-delta shallow agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const chunks: Buffer[] = [pkt(`# service=${service}\n`), pktFlush()];
  const refs = refsSorted(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    chunks.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (headOid !== undefined) {
      chunks.push(pkt(`${headOid} HEAD\0${caps}\n`));
      first = false;
    }
    for (const ref of refs) {
      const line = first ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      chunks.push(pkt(line));
      first = false;
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== null) chunks.push(pkt(`${peeled} ${ref.name}^{}\n`));
    }
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

function infoRefs(forge: Forge, req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 400, errorBody('service is required'));
    return;
  }
  if (owner !== VIEWER_LOGIN) {
    sendJson(res, 404, errorBody('Not Found'));
    return;
  }
  const repo = forge.getRepo(name);
  if (repo === undefined) {
    sendJson(res, 404, errorBody('Not Found'));
    return;
  }
  const isV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
  const body = isV2 ? advertisementV2() : advertisementV0(repo, service);
  sendGit(res, 200, `application/x-${service}-advertisement`, body);
}

interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, options: LsRefsOptions): Buffer {
  const chunks: Buffer[] = [];
  const refs = refsSorted(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const matches = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  if (options.prefixes.length === 0 || options.prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
    if (headOid !== undefined) {
      const extra = options.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      chunks.push(pkt(`${headOid} HEAD${extra}\n`));
    } else if (options.unborn) {
      chunks.push(pkt(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (options.peel) {
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    chunks.push(pkt(`${line}\n`));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

function fetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const chunks: Buffer[] = [];
  // The acknowledgments section exists only when the client sent haves:
  // with no haves there is nothing to acknowledge, and the response opens
  // directly with the shallow-info or packfile section.
  if (request.haves.length > 0) {
    const acks: string[] = [];
    for (const have of request.haves) {
      if (request.wants.some((want) => isAncestor(repo, have, want))) acks.push(have);
    }
    chunks.push(pkt('acknowledgments\n'));
    if (acks.length === 0) chunks.push(pkt('NAK\n'));
    else {
      for (const ack of acks) chunks.push(pkt(`ACK ${ack}\n`));
      chunks.push(pkt('ready\n'));
    }
    chunks.push(pktDelim());
  }

  const missingWant = request.wants.find((want) => repo.objects.get(want) === undefined);
  if (missingWant !== undefined) {
    chunks.push(pkt('packfile\n'));
    const error = pkt(`error: object ${missingWant} not found\n`);
    chunks.push(pkt(Buffer.concat([Buffer.from([3]), error])));
    chunks.push(pktFlush());
    return Buffer.concat(chunks);
  }

  const plan = fetchPlan(repo, request.wants, request.haves, request.shallow, request.depth);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    chunks.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) chunks.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pkt(`unshallow ${oid}\n`));
    chunks.push(pktDelim());
  }
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    chunks.push(pkt('packfile\n'));
    const maxChunk = 65515;
    for (let offset = 0; offset < pack.length; offset += maxChunk) {
      const slice = pack.subarray(offset, Math.min(pack.length, offset + maxChunk));
      chunks.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
    }
    chunks.push(pktFlush());
  }
  return Buffer.concat(chunks);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePackResponse(repo: Repo, commands: PushCommand[], unpackError: string | null): Buffer {
  const hadRefs = repo.refs.size > 0;
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackError === null) {
    let firstBranch: string | null = null;
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'stale info' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      const target = repo.objects.get(command.newOid);
      if (target === undefined || (target.type !== 'commit' && target.type !== 'tag')) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'already exists' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        if (command.ref.startsWith('refs/heads/') && firstBranch === null) firstBranch = command.ref.slice('refs/heads/'.length);
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      // Update: the old value must match, and the new tip must descend from it.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
        continue;
      }
      if (command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'stale info' });
        continue;
      }
      if (!isAncestor(repo, command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
    if (!hadRefs && firstBranch !== null) repo.defaultBranch = firstBranch;
  } else {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: unpackError });
  }
  const inner: Buffer[] = [pkt(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    inner.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(pktFlush());
  const outer: Buffer[] = [];
  for (const line of inner) outer.push(pkt(Buffer.concat([Buffer.from([1]), line])));
  outer.push(pktFlush());
  return Buffer.concat(outer);
}

/** The git smart-HTTP routes under /:owner/:repo.git. Returns true when answered. */
export async function handleGit(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const segments = pathSegments(url.pathname);
  if (segments.length < 2) return false;
  const repoSegment = segments[1]!;
  if (!repoSegment.endsWith('.git')) return false;
  const owner = segments[0]!;
  const repoName = repoSegment.slice(0, -'.git'.length);
  const tail = segments.slice(2);
  if (tail.length === 0) return false;
  if (!hasAuth(req)) {
    sendJson(res, 401, errorBody('Requires authentication'));
    return true;
  }
  if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && (req.method ?? 'GET') === 'GET') {
    infoRefs(forge, req, res, owner, repoName);
    return true;
  }
  if (owner !== VIEWER_LOGIN) {
    sendJson(res, 404, errorBody('Not Found'));
    return true;
  }
  const repo = forge.getRepo(repoName);
  if (repo === undefined) {
    sendJson(res, 404, errorBody('Not Found'));
    return true;
  }

  if (tail.length === 1 && tail[0] === 'git-upload-pack' && (req.method ?? 'GET') === 'POST') {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, errorBody('request body too large'));
      return true;
    }
    let parsed;
    try {
      parsed = parsePktLines(body);
    } catch {
      sendJson(res, 400, errorBody('malformed pkt-line'));
      return true;
    }
    const lines = pktLinesText(parsed.packets);
    const command = lines[0]?.trim() ?? '';
    if (command === 'command=ls-refs') {
      const options: LsRefsOptions = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of lines.slice(1)) {
        const text = line.trim();
        if (text === 'peel') options.peel = true;
        else if (text === 'symrefs') options.symrefs = true;
        else if (text === 'unborn') options.unborn = true;
        else if (text.startsWith('ref-prefix ')) options.prefixes.push(text.slice('ref-prefix '.length));
      }
      sendGit(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, options));
      return true;
    }
    if (command === 'command=fetch') {
      const request: FetchRequest = { wants: [], haves: [], shallow: [] };
      for (const line of lines.slice(1)) {
        const text = line.trim();
        if (text.startsWith('want ')) request.wants.push(text.slice(5).trim());
        else if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) {
          const depth = Number(text.slice(7).trim());
          if (Number.isFinite(depth)) request.depth = depth;
        }
      }
      sendGit(res, 200, 'application/x-git-upload-pack-result', fetchResponse(repo, request));
      return true;
    }
    sendJson(res, 400, errorBody(`unknown upload-pack command ${JSON.stringify(command)}`));
    return true;
  }

  if (tail.length === 1 && tail[0] === 'git-receive-pack' && (req.method ?? 'GET') === 'POST') {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, errorBody('request body too large'));
      return true;
    }
    let parsed;
    try {
      parsed = parsePktLines(body);
    } catch {
      sendJson(res, 400, errorBody('malformed pkt-line'));
      return true;
    }
    const commands: PushCommand[] = [];
    for (const line of pktLinesText(parsed.packets)) {
      const text = line.replace(/\n$/, '');
      if (text === '') continue;
      const nul = text.indexOf('\0');
      const head = nul >= 0 ? text.slice(0, nul) : text;
      const parts = head.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
    let unpackError: string | null = null;
    if (parsed.rest.length > 0) {
      try {
        const objects = readPack(parsed.rest);
        for (const obj of objects) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
      } catch (error) {
        unpackError = error instanceof Error ? error.message : 'unpack failed';
      }
    }
    sendGit(res, 200, 'application/x-git-receive-pack-result', receivePackResponse(repo, commands, unpackError));
    return true;
  }

  return false;
}
