// Domain operations shared by the REST, GraphQL and MCP surfaces: content
// commits, issues, pull requests, merges and diffs, all against the store.

import {
  buildCommit,
  buildTreeForPaths,
  flattenTree,
  forgeIdentity,
  hashObject,
  mergeBase,
  parseCommit,
  reachable,
  storeObject,
  threeWayMerge,
  ZERO_OID,
} from './git.ts';
import { globalId, nowIso, VIEWER_LOGIN, type Forge, type Issue, type PullRequest, type Repo } from './store.ts';

// ---------------------------------------------------------------- views

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: forge.repoGlobalId(repo),
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    owner: { login: VIEWER_LOGIN, id: 1, type: 'User' },
    html_url: `https://github.com/${VIEWER_LOGIN}/${repo.name}`,
    clone_url: `https://github.com/${VIEWER_LOGIN}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    has_issues: true,
    fork: false,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.dbId * 1_000_000 + issue.number,
    node_id: forge.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
    user: { login: VIEWER_LOGIN, id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = branchTip(repo, pull.head) ?? ZERO_OID;
  const baseSha = branchTip(repo, pull.base) ?? ZERO_OID;
  return {
    id: repo.dbId * 1_000_000 + pull.number,
    node_id: forge.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: headSha, label: `${VIEWER_LOGIN}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${VIEWER_LOGIN}:${pull.base}` },
    user: { login: VIEWER_LOGIN, id: 1, type: 'User' },
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

// ---------------------------------------------------------------- refs

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

export function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function listBranches(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha: oid });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export function commitMessageOf(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return '';
  return parseCommit(obj.data).message;
}

export function commitAuthorOf(repo: Repo, oid: string): { name: string; email: string; date: string } {
  const obj = repo.objects.get(oid);
  const fallback = { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@users.noreply.github.com`, date: nowIso() };
  if (obj === undefined || obj.type !== 'commit') return fallback;
  const author = parseCommit(obj.data).author;
  const match = /^(.*?) <(.*?)> (\d+) /.exec(author);
  if (match === null) return fallback;
  return {
    name: match[1] ?? VIEWER_LOGIN,
    email: match[2] ?? `${VIEWER_LOGIN}@users.noreply.github.com`,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

/** Commits reachable from a ref, newest first (parents follow the first parent line order). */
export function listCommits(repo: Repo, ref: string): string[] {
  let tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (tip === undefined && /^[0-9a-f]{40}$/.test(ref)) tip = ref;
  if (tip === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------- contents

export interface ContentResult {
  ok: boolean;
  status: number;
  message?: string;
  commitSha?: string;
  contentSha?: string;
}

/**
 * Commit one file change on a branch. `expectedSha` is the blob id the
 * caller read before editing: a mismatch is a 409, a missing one on an
 * existing file is a 422. A first commit names the branch the default.
 */
export function putContent(
  repo: Repo,
  options: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): ContentResult {
  const branch = options.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const parentTree = tip === undefined ? new Map<string, string>() : flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
  const existing = parentTree.get(options.path);
  if (existing !== undefined && options.sha === undefined) {
    return { ok: false, status: 422, message: 'sha is required to update a file' };
  }
  if (existing !== undefined && options.sha !== undefined && options.sha.toLowerCase() !== existing.toLowerCase()) {
    return { ok: false, status: 409, message: 'sha does not match the current file' };
  }
  if (existing === undefined && options.sha !== undefined) {
    return { ok: false, status: 422, message: 'sha does not match: the file does not exist' };
  }
  const blobOid = storeObject(repo, 'blob', options.content);
  const paths = new Map(parentTree);
  paths.set(options.path, blobOid);
  const treeOid = buildTreeForPaths(repo, paths);
  const identity = forgeIdentity();
  const commit = buildCommit({
    tree: treeOid,
    parents: tip === undefined ? [] : [tip],
    author: identity,
    committer: identity,
    message: options.message,
  });
  const commitOid = storeObject(repo, 'commit', commit);
  repo.refs.set(ref, commitOid);
  if (tip === undefined && repo.refs.size === 1) repo.defaultBranch = branch;
  return {
    ok: true,
    status: existing === undefined ? 201 : 200,
    commitSha: commitOid,
    contentSha: blobOid,
  };
}

export function deleteContent(
  repo: Repo,
  options: { path: string; message: string; branch?: string; sha?: string },
): ContentResult {
  const branch = options.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) return { ok: false, status: 404, message: 'Not Found' };
  const parentTree = flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
  const existing = parentTree.get(options.path);
  if (existing === undefined) return { ok: false, status: 404, message: 'Not Found' };
  if (options.sha !== undefined && options.sha.toLowerCase() !== existing.toLowerCase()) {
    return { ok: false, status: 409, message: 'sha does not match the current file' };
  }
  const paths = new Map(parentTree);
  paths.delete(options.path);
  const treeOid = buildTreeForPaths(repo, paths);
  const identity = forgeIdentity();
  const commit = buildCommit({
    tree: treeOid,
    parents: [tip],
    author: identity,
    committer: identity,
    message: options.message,
  });
  const commitOid = storeObject(repo, 'commit', commit);
  repo.refs.set(ref, commitOid);
  return { ok: true, status: 200, commitSha: commitOid, contentSha: existing };
}

export type ContentRead =
  | { kind: 'file'; name: string; path: string; sha: string; size: number; content: Buffer }
  | { kind: 'dir'; entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> }
  | null;

/** Read a path out of a branch tip (or a raw commit id) in `ref`. */
export function readContent(repo: Repo, path: string, ref?: string): ContentRead {
  let tip = ref === undefined ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : undefined;
  if (ref !== undefined) {
    tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
    if (tip === undefined && /^[0-9a-f]{40}$/.test(ref)) tip = ref;
  }
  if (tip === undefined) return null;
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return null;
  const flat = flattenTree(repo, parseCommit(commit.data).tree);
  const direct = flat.get(path);
  if (direct !== undefined) {
    const blob = repo.objects.get(direct);
    if (blob === undefined) return null;
    return {
      kind: 'file',
      name: path.split('/').pop() ?? path,
      path,
      sha: direct,
      size: blob.data.length,
      content: blob.data,
    };
  }
  // A directory: every path below it, grouped one level down.
  const prefix = `${path}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
  for (const [filePath, blobOid] of flat) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      entries.set(rest, { type: 'file', name: rest, path: filePath, sha: blobOid });
    } else {
      const dirName = rest.slice(0, slash);
      if (!entries.has(dirName)) {
        const dirPath = `${path}/${dirName}`;
        const treeOid = treeOidForPath(repo, parseCommit(commit.data).tree, dirPath) ?? hashObject('tree', Buffer.alloc(0));
        entries.set(dirName, { type: 'dir', name: dirName, path: dirPath, sha: treeOid });
      }
    }
  }
  if (entries.size === 0) return null;
  return { kind: 'dir', entries: [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) };
}

function treeOidForPath(repo: Repo, rootTree: string, path: string): string | null {
  let current = rootTree;
  for (const segment of path.split('/')) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------- issues

export function createIssue(
  repo: Repo,
  input: { title: string; body: string; labels?: string[] },
): { issue: Issue } | { error: string; status: number } {
  const labels = input.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return { error: `label "${label}" does not exist`, status: 422 };
  }
  const issue: Issue = {
    number: repo.nextIssue,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: repo.nextIssue,
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return { issue };
}

export function listIssues(
  repo: Repo,
  query: { state?: string; sort?: string; direction?: string },
): Issue[] {
  const state = query.state ?? 'open';
  let out = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  const direction = query.direction ?? 'desc';
  out = [...out].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  return out;
}

// ---------------------------------------------------------------- pull requests

export function createPull(
  repo: Repo,
  input: { title: string; head: string; base: string; body?: string },
): { pull: PullRequest } | { error: string; status: number } {
  const headTip = branchTip(repo, input.head);
  const baseTip = branchTip(repo, input.base);
  if (headTip === undefined) return { error: `head branch "${input.head}" does not exist`, status: 422 };
  if (baseTip === undefined) return { error: `base branch "${input.base}" does not exist`, status: 422 };
  const existing = repo.pulls.find((pull) => pull.head === input.head && pull.state === 'open');
  if (existing !== undefined) return { error: 'a pull request is already open for this head branch', status: 422 };
  const pull: PullRequest = {
    number: repo.nextPull,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head: input.head,
    base: input.base,
    seq: repo.nextPull,
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  return { pull };
}

export function mergeableState(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) return 'CONFLICTING';
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return 'CONFLICTING';
  return threeWayMerge(repo, base, headTip, baseTip).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

export function mergePull(
  repo: Repo,
  pull: PullRequest,
): { sha: string } | { error: string; status: number } {
  if (pull.merged) return { error: 'pull request is already merged', status: 405 };
  if (pull.state !== 'open') return { error: 'pull request is not open', status: 405 };
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) return { error: 'head or base branch is missing', status: 422 };
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return { error: 'no merge base', status: 405 };
  const merged = threeWayMerge(repo, base, headTip, baseTip);
  if (merged.conflict) return { error: 'merge conflict', status: 405 };
  const treeOid = buildTreeForPaths(repo, merged.paths);
  const identity = forgeIdentity();
  const commit = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    author: identity,
    committer: identity,
    message: pull.title,
  });
  const commitOid = storeObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.base}`, commitOid);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = commitOid;
  return { sha: commitOid };
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** A small multiset line diff: enough for the added/modified counts. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

export function pullFiles(repo: Repo, pull: PullRequest): PullFile[] {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = mergeBase(repo, headTip, baseTip) ?? baseTip;
  const baseTree = flattenTree(repo, parseCommit(repo.objects.get(base)!.data).tree);
  const headTree = flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const out: PullFile[] = [];
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  for (const path of [...paths].sort()) {
    const oldOid = baseTree.get(path);
    const newOid = headTree.get(path);
    if (oldOid === newOid) continue;
    const oldText = oldOid === undefined ? '' : (repo.objects.get(oldOid)?.data.toString('utf8') ?? '');
    const newText = newOid === undefined ? '' : (repo.objects.get(newOid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    const status = oldOid === undefined ? 'added' : newOid === undefined ? 'removed' : 'modified';
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

/** The object ids a fetch must send, and the shallow-info lines that go with them. */
export function fetchPlan(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth?: number,
): { objects: Array<{ oid: string; type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>; shallow: string[]; unshallow: string[] } {
  const exclude = new Set<string>();
  const excludeShallow = new Set<string>();
  for (const have of haves) {
    if (shallowBoundaries.includes(have)) excludeShallow.add(have);
    else exclude.add(have);
  }
  // A shallow boundary's own ancestors are pruned only through the have
  // list when it is not a shallow boundary; a boundary prunes itself alone.
  const closure = reachable(repo, wants, {
    maxDepth: depth,
    exclude,
    excludeShallow,
  });
  const objects: Array<{ oid: string; type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }> = [];
  for (const oid of closure.objects) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objects.push({ oid, type: obj.type, data: obj.data });
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, generation] of closure.commits) {
      if (generation !== depth - 1) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.length > 0) shallow.push(oid);
    }
    for (const boundary of shallowBoundaries) {
      const obj = repo.objects.get(boundary);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.every((parent) => closure.commits.has(parent))) unshallow.push(boundary);
    }
  }
  return { objects, shallow, unshallow };
}
