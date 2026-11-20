// GitHub GraphQL v4, hand-rolled: a small parser for the documents gh and
// github-mcp-server send, a validator against the schema surface the suite
// probes, and resolvers over the same store the REST surface uses.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { branchTip, createIssue, createPull, mergePull, mergeableState, pullFiles } from './domain.ts';
import { errorBody, hasAuth, parseJsonBody, readBody, sendJson } from './http-util.ts';
import {
  globalId,
  parseGlobalId,
  VIEWER_LOGIN,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'variable'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const escaped = input[i + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'variable', value: input.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selections?: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = token.value;
      this.next();
    }
    let name: string | undefined;
    const maybeName = this.peek();
    if (maybeName?.kind === 'name') {
      name = this.next().value as string;
    }
    // Variable definitions: ($name: Type = default, ...)
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      let depth = 1;
      while (depth > 0) {
        const token = this.next();
        if (token.kind === 'punct' && token.value === '(') depth += 1;
        else if (token.kind === 'punct' && token.value === ')') depth -= 1;
      }
    }
    const selections = this.parseSelectionSet();
    return { type, name, selections };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const on = this.next();
      if (on.kind !== 'name' || on.value !== 'on') throw new Error('expected "on" after "..." in a fragment');
      const typeCondition = this.expectName();
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    let name = this.expectName();
    let alias: string | undefined;
    const maybeColon = this.peek();
    if (maybeColon?.kind === 'punct' && maybeColon.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      for (;;) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    let selections: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'variable') return { kind: 'variable', name: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      for (;;) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ']') {
          this.next();
          return { kind: 'list', items };
        }
        items.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === '}') {
          this.next();
          return { kind: 'object', fields };
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema

const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { login: 'String' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'RepositoryPermission',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
    description: 'String',
    private: 'Boolean',
    url: 'String',
    createdAt: 'String',
  },
  Ref: { name: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'IssueState', url: 'String', createdAt: 'String' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PageInfo: { hasNextPage: 'Boolean', endCursor: 'String' },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'PullRequestState',
    merged: 'Boolean',
    mergeable: 'MergeableState',
    headRefName: 'String',
    baseRefName: 'String',
    files: 'PullRequestChangedFileConnection',
    mergedAt: 'String',
    mergeCommit: 'Commit',
  },
  PullRequestConnection: { nodes: 'PullRequest' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile' },
  PullRequestChangedFile: { path: 'String' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { id: 'ID', body: 'String' },
  Commit: { oid: 'String', message: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: 'String' },
  __EnumValue: { name: 'String' },
};

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id',
    'number',
    'title',
    'body',
    'state',
    'merged',
    'mergeable',
    'headRefName',
    'baseRefName',
    'files',
    'mergedAt',
    'mergeCommit',
    'url',
    'createdAt',
  ],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
    'description',
    'private',
    'url',
    'createdAt',
  ],
};

const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
};

// ---------------------------------------------------------------- execution

class GraphQLError extends Error {}

type AnyObj = Record<string, unknown> & { __typename: string };

function wrapRepo(forge: Forge, repo: Repo): AnyObj {
  return { __typename: 'Repository', _forge: forge, _repo: repo };
}

function wrapIssue(forge: Forge, repo: Repo, issue: Issue): AnyObj {
  return { __typename: 'Issue', _forge: forge, _repo: repo, _issue: issue };
}

function wrapPull(forge: Forge, repo: Repo, pull: PullRequest): AnyObj {
  return { __typename: 'PullRequest', _forge: forge, _repo: repo, _pull: pull };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberAfter(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(raw);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function resolveField(parent: AnyObj, field: FieldNode, variables: Record<string, unknown>, forge: Forge): unknown {
  const args: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(field.args)) args[name] = evalValue(value, variables);
  const type = parent.__typename;
  const raw = parent as Record<string, unknown>;

  if (type === 'Query') {
    if (field.name === 'viewer') return { __typename: 'User' };
    if (field.name === 'repository') {
      const owner = args.owner;
      const name = args.name;
      if (owner !== VIEWER_LOGIN || typeof name !== 'string') return null;
      const repo = forge.getRepo(name);
      return repo === undefined ? null : wrapRepo(forge, repo);
    }
    if (field.name === 'node') {
      const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = forge.repoByDbId(Number(parsed.parts[0]));
        return repo === undefined ? null : wrapRepo(forge, repo);
      }
      if (parsed.kind === 'Issue') {
        const repo = forge.repoByDbId(Number(parsed.parts[0]));
        const issue = repo?.issues.find((entry) => entry.number === Number(parsed.parts[1]));
        return repo === undefined || issue === undefined ? null : wrapIssue(forge, repo, issue);
      }
      if (parsed.kind === 'PullRequest') {
        const repo = forge.repoByDbId(Number(parsed.parts[0]));
        const pull = repo?.pulls.find((entry) => entry.number === Number(parsed.parts[1]));
        return repo === undefined || pull === undefined ? null : wrapPull(forge, repo, pull);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args.name;
      if (typeof name !== 'string') return null;
      const fields = INTROSPECTION_FIELDS[name];
      const enums = INTROSPECTION_ENUMS[name];
      if (fields === undefined && enums === undefined) return null;
      return {
        __typename: '__Type',
        _typeName: name,
        _fields: fields ?? null,
        _enums: enums ?? null,
      };
    }
  }

  if (type === 'User') {
    if (field.name === 'login') return VIEWER_LOGIN;
  }

  if (type === 'Repository') {
    const repo = raw._repo as Repo;
    const f = forge;
    switch (field.name) {
      case 'id':
        return f.repoGlobalId(repo);
      case 'databaseId':
        return repo.dbId;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${VIEWER_LOGIN}/${repo.name}`;
      case 'owner':
        return { __typename: 'User' };
      case 'defaultBranchRef': {
        const tip = branchTip(repo, repo.defaultBranch);
        return tip === undefined ? null : { __typename: 'Ref', _name: repo.defaultBranch };
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'private':
        return repo.isPrivate;
      case 'url':
        return `https://github.com/${VIEWER_LOGIN}/${repo.name}`;
      case 'createdAt':
        return repo.createdAt;
      case 'issue': {
        const issue = repo.issues.find((entry) => entry.number === args.number);
        return issue === undefined ? null : wrapIssue(f, repo, issue);
      }
      case 'issues': {
        let issues = [...repo.issues].sort((a, b) => a.number - b.number);
        const states = args.states;
        if (Array.isArray(states)) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = args.orderBy;
        if (orderBy !== null && typeof orderBy === 'object') {
          const order = orderBy as Record<string, unknown>;
          if (order.field === 'CREATED_AT' && order.direction === 'DESC') issues.reverse();
        }
        const after = numberAfter(args.after);
        if (after !== null) issues = issues.filter((issue) => issue.number > after);
        const first = typeof args.first === 'number' ? args.first : issues.length;
        const page = issues.slice(0, first);
        const hasNextPage = issues.length > page.length;
        const endCursor = page.length === 0 ? null : cursorFor(page[page.length - 1]!.number);
        return {
          __typename: 'IssueConnection',
          _nodes: page.map((issue) => wrapIssue(f, repo, issue)),
          _pageInfo: { __typename: 'PageInfo', _hasNextPage: hasNextPage, _endCursor: endCursor },
        };
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : undefined;
        const open = repo.pulls.filter((pull) => pull.state === 'open');
        const page = first === undefined ? open : open.slice(0, first);
        return { __typename: 'PullRequestConnection', _nodes: page.map((pull) => wrapPull(f, repo, pull)) };
      }
      case 'pullRequest': {
        const pull = repo.pulls.find((entry) => entry.number === args.number);
        return pull === undefined ? null : wrapPull(f, repo, pull);
      }
    }
  }

  if (type === 'Ref') {
    if (field.name === 'name') return raw._name;
  }

  if (type === 'Issue') {
    const issue = raw._issue as Issue;
    const repo = raw._repo as Repo;
    const f = raw._forge as Forge;
    switch (field.name) {
      case 'id':
        return f.issueGlobalId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'url':
        return `https://github.com/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`;
      case 'createdAt':
        return repo.createdAt;
    }
  }

  if (type === 'IssueConnection') {
    if (field.name === 'nodes') return raw._nodes;
    if (field.name === 'pageInfo') return raw._pageInfo;
  }

  if (type === 'PageInfo') {
    if (field.name === 'hasNextPage') return raw._hasNextPage;
    if (field.name === 'endCursor') return raw._endCursor;
  }

  if (type === 'PullRequest') {
    const pull = raw._pull as PullRequest;
    const repo = raw._repo as Repo;
    const f = raw._forge as Forge;
    switch (field.name) {
      case 'id':
        return f.pullGlobalId(repo, pull);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return mergeableState(repo, pull);
      case 'headRefName':
        return pull.head;
      case 'baseRefName':
        return pull.base;
      case 'mergedAt':
        return pull.mergedAt;
      case 'mergeCommit':
        return pull.mergeCommitSha === null ? null : { __typename: 'Commit', _oid: pull.mergeCommitSha, _message: pull.title };
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : undefined;
        const files = pullFiles(repo, pull);
        const page = first === undefined ? files : files.slice(0, first);
        return {
          __typename: 'PullRequestChangedFileConnection',
          _nodes: page.map((file) => ({ __typename: 'PullRequestChangedFile', _path: file.filename })),
        };
      }
    }
  }

  if (type === 'PullRequestConnection') {
    if (field.name === 'nodes') return raw._nodes;
  }

  if (type === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes') return raw._nodes;
  }

  if (type === 'PullRequestChangedFile') {
    if (field.name === 'path') return raw._path;
  }

  if (type === 'Commit') {
    if (field.name === 'oid') return raw._oid;
    if (field.name === 'message') return raw._message;
  }

  if (type === '__Type') {
    if (field.name === 'name') return raw._typeName;
    if (field.name === 'kind') return raw._enums !== null ? 'ENUM' : 'OBJECT';
    if (field.name === 'fields') {
      const fields = raw._fields as string[] | null;
      return fields === null ? null : fields.map((name) => ({ __typename: '__Field', _name: name }));
    }
    if (field.name === 'enumValues') {
      const enums = raw._enums as string[] | null;
      return enums === null ? null : enums.map((name) => ({ __typename: '__EnumValue', _name: name }));
    }
  }

  if (type === '__Field' || type === '__EnumValue') {
    if (field.name === 'name') return raw._name;
  }

  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (field.name === 'issue') return raw._issue;
  }

  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return raw._pull;
  }

  if (type === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return raw._edge;
  }

  if (type === 'IssueCommentEdge') {
    if (field.name === 'node') return raw._node;
  }

  if (type === 'IssueComment') {
    if (field.name === 'id') return raw._id;
    if (field.name === 'body') return raw._body;
  }

  if (type === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed?.kind === 'Repository' ? forge.repoByDbId(Number(parsed.parts[0])) : undefined;
      if (repo === undefined) throw new GraphQLError('repository not found');
      const created = createIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      if ('error' in created) throw new GraphQLError(created.error);
      return { __typename: 'CreateIssuePayload', _issue: wrapIssue(forge, repo, created.issue) };
    }
    if (field.name === 'closeIssue') {
      const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      const repo = parsed?.kind === 'Issue' ? forge.repoByDbId(Number(parsed.parts[0])) : undefined;
      const issue = repo?.issues.find((entry) => entry.number === Number(parsed?.parts[1]));
      if (repo === undefined || issue === undefined) throw new GraphQLError('issue not found');
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', _issue: wrapIssue(forge, repo, issue) };
    }
    if (field.name === 'createPullRequest') {
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed?.kind === 'Repository' ? forge.repoByDbId(Number(parsed.parts[0])) : undefined;
      if (repo === undefined) throw new GraphQLError('repository not found');
      const created = createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      if ('error' in created) throw new GraphQLError(created.error);
      return { __typename: 'CreatePullRequestPayload', _pull: wrapPull(forge, repo, created.pull) };
    }
    if (field.name === 'mergePullRequest') {
      const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      const repo = parsed?.kind === 'PullRequest' ? forge.repoByDbId(Number(parsed.parts[0])) : undefined;
      const pull = repo?.pulls.find((entry) => entry.number === Number(parsed?.parts[1]));
      if (repo === undefined || pull === undefined) throw new GraphQLError('pull request not found');
      const result = mergePull(repo, pull);
      if ('error' in result) throw new GraphQLError(result.error);
      return { __typename: 'MergePullRequestPayload', _pull: wrapPull(forge, repo, pull) };
    }
    if (field.name === 'addComment') {
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      const repo = parsed?.kind === 'Issue' ? forge.repoByDbId(Number(parsed.parts[0])) : undefined;
      const issue = repo?.issues.find((entry) => entry.number === Number(parsed?.parts[1]));
      if (repo === undefined || issue === undefined) throw new GraphQLError('issue not found');
      const comment = { id: repo.nextCommentId, body: typeof input.body === 'string' ? input.body : '' };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        _edge: {
          __typename: 'IssueCommentEdge',
          _node: { __typename: 'IssueComment', _id: globalId('IssueComment', repo.dbId, issue.number, comment.id), _body: comment.body },
        },
      };
    }
  }

  throw new GraphQLError(`Cannot query field "${field.name}" on type "${type}".`);
}

function resolveSelections(
  parent: AnyObj,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  forge: Forge,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (parent.__typename !== selection.typeCondition) continue;
      Object.assign(out, resolveSelections(parent, selection.selections, variables, forge));
      continue;
    }
    const fieldType = FIELD_TYPES[parent.__typename]?.[selection.name];
    if (fieldType === undefined) {
      throw new GraphQLError(`Cannot query field "${selection.name}" on type "${parent.__typename}".`);
    }
    const value = resolveField(parent, selection, variables, forge);
    const key = selection.alias ?? selection.name;
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (selection.selections === undefined) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((entry) => {
        if (entry !== null && typeof entry === 'object' && '__typename' in entry) {
          return resolveSelections(entry as AnyObj, selection.selections!, variables, forge);
        }
        return entry;
      });
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      out[key] = resolveSelections(value as AnyObj, selection.selections, variables, forge);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOperation(operation: Operation, variables: Record<string, unknown>, forge: Forge): { data: unknown; errors: Array<{ message: string }> } {
  try {
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const root: AnyObj = { __typename: rootType };
    const data = resolveSelections(root, operation.selections, variables, forge);
    return { data, errors: [] };
  } catch (error) {
    if (error instanceof GraphQLError) {
      return { data: null, errors: [{ message: error.message }] };
    }
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}

function executeDocument(query: string, variables: Record<string, unknown>, forge: Forge): { data: unknown; errors: Array<{ message: string }> } {
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operation = operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'empty GraphQL document' }] };
  }
  return executeOperation(operation, variables, forge);
}

/** POST /api/graphql: one operation, or a JSON array of batched operations. */
export async function handleGraphql(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  if (url.pathname !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, errorBody('method not allowed'));
    return true;
  }
  if (!hasAuth(req)) {
    sendJson(res, 401, errorBody('Requires authentication'));
    return true;
  }
  let body: unknown;
  try {
    body = parseJsonBody(await readBody(req));
  } catch {
    sendJson(res, 400, errorBody('malformed JSON body'));
    return true;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (entry === null || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).query !== 'string') {
        return { data: null, errors: [{ message: 'invalid batched operation' }] };
      }
      const op = entry as Record<string, unknown>;
      const variables = (op.variables ?? {}) as Record<string, unknown>;
      return executeDocument(op.query as string, variables, forge);
    });
    sendJson(res, 200, results);
    return true;
  }
  if (body === null || typeof body !== 'object' || typeof (body as Record<string, unknown>).query !== 'string') {
    sendJson(res, 400, errorBody('query is required'));
    return true;
  }
  const op = body as Record<string, unknown>;
  const variables = (op.variables ?? {}) as Record<string, unknown>;
  sendJson(res, 200, executeDocument(op.query as string, variables, forge));
  return true;
}
