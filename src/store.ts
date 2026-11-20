// The forge's in-memory store: repositories, git objects, refs, issues and pull
// requests. Everything lives in process memory; a trial starts from an empty
// forge and the suite seeds its own fixtures through the public surfaces.

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  /** Monotonic creation order inside the repository. */
  seq: number;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  /** Monotonic creation order inside the repository. */
  seq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  name: string;
  dbId: number;
  isPrivate: boolean;
  description: string | null;
  /** Git objects by their SHA-1 id. */
  objects: Map<string, GitObject>;
  /** Ref name (refs/heads/..., refs/tags/...) to the object id it points at. */
  refs: Map<string, string>;
  /** The branch new repositories start on; set by the first commit. */
  defaultBranch: string;
  issues: Issue[];
  nextIssue: number;
  pulls: PullRequest[];
  nextPull: number;
  labels: Map<string, Label>;
  nextCommentId: number;
  createdAt: string;
  /** Creation order across repositories (drives list ordering). */
  seq: number;
}

/** The token owner's login: the scenario's viewer, the only user this forge knows. */
export const VIEWER_LOGIN = 'adaiversen';

export const DEFAULT_BRANCH = 'main';

/** An opaque Relay-style global id: base64url of `Kind:part:part`. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  const raw = [kind, ...parts.map(String)].join(':');
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Decode a global id back into its kind and parts, or null when it is not one. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const split = raw.split(':');
    const kind = split[0];
    if (kind === undefined || kind === '' || split.length < 2) return null;
    return { kind, parts: split.slice(1) };
  } catch {
    return null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class Forge {
  repos = new Map<string, Repo>();
  private nextDbId = 1;
  private nextSeq = 1;

  createRepo(name: string, isPrivate: boolean, description: string | null): Repo | null {
    if (this.repos.has(name)) return null;
    const repo: Repo = {
      name,
      dbId: this.nextDbId,
      isPrivate,
      description,
      objects: new Map(),
      refs: new Map(),
      defaultBranch: DEFAULT_BRANCH,
      issues: [],
      nextIssue: 1,
      pulls: [],
      nextPull: 1,
      labels: new Map(),
      nextCommentId: 1,
      createdAt: nowIso(),
      seq: this.nextSeq,
    };
    this.nextDbId += 1;
    this.nextSeq += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  repoGlobalId(repo: Repo): string {
    return globalId('Repository', repo.dbId);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return globalId('Issue', repo.dbId, issue.number);
  }

  pullGlobalId(repo: Repo, pull: PullRequest): string {
    return globalId('PullRequest', repo.dbId, pull.number);
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
    return globalId('IssueComment', repo.dbId, issue.number, comment.id);
  }

  /** Find a repository by its numeric database id (GraphQL node / id lookups). */
  repoByDbId(dbId: number): Repo | undefined {
    for (const repo of this.repos.values()) {
      if (repo.dbId === dbId) return repo;
    }
    return undefined;
  }
}
