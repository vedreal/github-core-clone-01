// GitHub GraphQL v4, POST /api/graphql: the documents gh and
// github-mcp-server send, plus the introspection probes they run.
//
// A small hand-rolled parser and executor (no dependency): one operation
// document per body, or a JSON array of operations (GitHub's batching).
// An unknown field is HTTP 200 with an errors array naming it; an unknown
// repository is data.repository = null with no errors.

import {
  VIEWER_LOGIN,
  VIEWER_ID,
  store,
  tickMs,
  getRepo,
  getObject,
  parseCommit,
  makeCommit,
  globalId,
  parseGlobalId,
} from './store.ts';
import { createIssueRecord, addComment, prMergeable, pullFiles, createPullRecord, mergePullRecord } from './rest.ts';

// ---------------------------------------------------------------------------
// lexer / parser
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const INT_RE = /^-?(0|[1-9][0-9]*)/;

function lex(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: '...', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(ch)) { tokens.push({ kind: ch, value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u') { out += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    const rest = src.slice(i);
    const name = NAME_RE.exec(rest);
    if (name) { tokens.push({ kind: 'name', value: name[0] }); i += name[0].length; continue; }
    const num = INT_RE.exec(rest);
    if (num && !/[A-Za-z_]/.test(rest[num[0].length] ?? '')) {
      if (rest[num[0].length] === '.') {
        const fl = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(rest);
        tokens.push({ kind: 'float', value: Number(fl[0]) });
        i += fl[0].length;
      } else {
        tokens.push({ kind: 'int', value: Number(num[0]) });
        i += num[0].length;
      }
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.t = tokens;
    this.i = 0;
  }
  peek() { return this.t[this.i]; }
  next() { return this.t[this.i++]; }
  expect(kind) {
    const tok = this.next();
    if (tok.kind !== kind) throw new Error(`Expected ${kind}, got ${tok.kind} (${tok.value})`);
    return tok;
  }
  skip(kind) {
    if (this.peek().kind === kind) { this.i += 1; return true; }
    return false;
  }
  parseDocument() {
    const defs = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }
  parseDefinition() {
    const tok = this.peek();
    if (tok.kind === '{') return { kind: 'operation', operation: 'query', name: null, variables: {}, selection: this.parseSelectionSet() };
    if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
      this.next();
      let name = null;
      if (this.peek().kind === 'name') name = this.next().value;
      let variables = {};
      if (this.peek().kind === '(') variables = this.parseVariableDefinitions();
      return { kind: 'operation', operation: tok.value, name, variables, selection: this.parseSelectionSet() };
    }
    if (tok.kind === 'name' && tok.value === 'fragment') {
      this.next();
      const name = this.expect('name').value;
      this.expect('name'); // 'on'
      const type = this.expect('name').value;
      return { kind: 'fragment', name, type, selection: this.parseSelectionSet() };
    }
    throw new Error(`Unexpected token ${tok.kind} ${tok.value}`);
  }
  parseVariableDefinitions() {
    const vars = {};
    this.expect('(');
    while (!this.skip(')')) {
      this.expect('$');
      const name = this.expect('name').value;
      this.expect(':');
      vars[name] = this.parseType();
      if (this.peek().kind === '=') { this.next(); this.parseValue(); }
    }
    return vars;
  }
  parseType() {
    let type;
    if (this.skip('[')) { const inner = this.parseType(); this.expect(']'); type = `[${inner}]`; }
    else type = this.expect('name').value;
    if (this.skip('!')) type += '!';
    return type;
  }
  parseSelectionSet() {
    this.expect('{');
    const fields = [];
    while (!this.skip('}')) fields.push(this.parseField());
    return fields;
  }
  parseField() {
    if (this.peek().kind === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const type = this.expect('name').value;
        return { kind: 'inline-fragment', type, selection: this.parseSelectionSet() };
      }
      const name = this.expect('name').value;
      return { kind: 'fragment-spread', name };
    }
    let alias = null;
    let name = this.expect('name').value;
    if (this.skip(':')) { alias = name; name = this.expect('name').value; }
    let args = {};
    if (this.peek().kind === '(') args = this.parseArguments();
    let selection = null;
    if (this.peek().kind === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }
  parseArguments() {
    const args = {};
    this.expect('(');
    while (!this.skip(')')) {
      const name = this.expect('name').value;
      this.expect(':');
      args[name] = this.parseValue();
    }
    return args;
  }
  parseValue() {
    const tok = this.next();
    if (tok.kind === 'int' || tok.kind === 'float' || tok.kind === 'string') return tok.value;
    if (tok.kind === 'name') {
      if (tok.value === 'true') return true;
      if (tok.value === 'false') return false;
      if (tok.value === 'null') return null;
      return { __enum: tok.value };
    }
    if (tok.kind === '$') return { __var: this.expect('name').value };
    if (tok.kind === '[') {
      const list = [];
      while (!this.skip(']')) list.push(this.parseValue());
      return list;
    }
    if (tok.kind === '{') {
      const obj = {};
      while (!this.skip('}')) {
        const name = this.expect('name').value;
        this.expect(':');
        obj[name] = this.parseValue();
      }
      return obj;
    }
    throw new Error(`Unexpected value token ${tok.kind}`);
  }
}

function resolveValue(value, variables) {
  if (value && typeof value === 'object') {
    if ('__var' in value) return variables[value.__var];
    if ('__enum' in value) return value.__enum;
    if (Array.isArray(value)) return value.map((v) => resolveValue(v, variables));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, variables);
    return out;
  }
  return value;
}

function resolveArgs(args, variables) {
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) out[k] = resolveValue(v, variables);
  return out;
}

// ---------------------------------------------------------------------------
// schema (for validation and introspection)
// ---------------------------------------------------------------------------

const SCHEMA = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Viewer: ['login', 'id'],
  User: ['login', 'id'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'createdAt'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  FileConnection: ['nodes', 'totalCount'],
  File: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Comment: ['id', 'body'],
  CommentEdge: ['node', 'cursor'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
};

const INTROSPECTION = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments', 'labels', 'closed', 'closedAt', 'repository'], enumValues: null },
  PullRequest: { fields: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'createdAt', 'updatedAt', 'url', 'author', 'additions', 'deletions', 'changedFiles'], enumValues: null },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'defaultBranch', 'isPrivate', 'forkCount', 'stargazerCount'], enumValues: null },
  SearchType: { fields: null, enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'WIKI', 'PACKAGE'] },
  User: { fields: ['id', 'login', 'name', 'email', 'url'], enumValues: null },
  Viewer: { fields: ['login', 'id'], enumValues: null },
  IssueState: { fields: null, enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { fields: null, enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
};

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

function gqlError(message) {
  return { message };
}

function repoObject(repo) {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: globalId('Repository', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.full_name,
    description: repo.description,
    url: `https://github.com/${repo.full_name}`,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueObject(repo, issue) {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
  };
}

function prObject(repo, pr) {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pr: pr,
    id: pr.node_id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    headRefName: pr.head,
    baseRefName: pr.base,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    mergeable: prMergeable(repo, pr),
  };
}

function cursorFor(number) {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}
function numberFromCursor(cursor) {
  try {
    const text = Buffer.from(String(cursor), 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function issuesConnection(repo, args) {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy ?? {};
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  issues.sort((a, b) => {
    if (direction === 'ASC') return a.createdMs - b.createdMs || a.number - b.number;
    return b.createdMs - a.createdMs || b.number - a.number;
  });
  if (typeof args.after === 'string' && args.after !== '') {
    const afterNumber = numberFromCursor(args.after);
    if (afterNumber !== null) {
      const idx = issues.findIndex((i) => i.number === afterNumber);
      if (idx >= 0) issues = issues.slice(idx + 1);
    }
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, first);
  const hasNext = issues.length > first;
  return {
    __typename: 'IssueConnection',
    _nodes: page.map((i) => issueObject(repo, i)),
    _pageInfo: {
      hasNextPage: hasNext,
      hasPreviousPage: false,
      startCursor: page.length ? cursorFor(page[0].number) : null,
      endCursor: page.length ? cursorFor(page[page.length - 1].number) : null,
    },
  };
}

function pullsConnection(repo, args) {
  let pulls = [...repo.pulls];
  pulls.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    _nodes: page.map((p) => prObject(repo, p)),
    _pageInfo: { hasNextPage: pulls.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
}

function findRepoByGlobalId(id) {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  const dbId = Number(parsed.parts[0]);
  for (const repo of getAllRepos()) if (repo.id === dbId) return repo;
  return null;
}
function getAllRepos() {
  return [...store.repos.values()];
}
function findIssueByGlobalId(id) {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.kind === 'Issue') {
    const [repoId, number] = parsed.parts.map(Number);
    for (const repo of getAllRepos()) {
      if (repo.id === repoId) {
        const issue = repo.issues.find((i) => i.number === number);
        return issue ? { repo, issue } : null;
      }
    }
  }
  return null;
}
function findPullByGlobalId(id) {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.parts.map(Number);
  for (const repo of getAllRepos()) {
    if (repo.id === repoId) {
      const pr = repo.pulls.find((p) => p.number === number);
      return pr ? { repo, pr } : null;
    }
  }
  return null;
}

// Field resolvers: (parent, args, ctx) -> value (raw; selection applied by executor).
const RESOLVERS = {
  Query: {
    viewer: () => ({ __typename: 'Viewer', login: VIEWER_LOGIN, id: globalId('User', String(VIEWER_ID)) }),
    repository: (_p, args) => {
      if (args.owner !== VIEWER_LOGIN) return null;
      const repo = getRepo(args.owner, args.name);
      return repo ? repoObject(repo) : null;
    },
    node: (_p, args) => {
      const parsed = parseGlobalId(args.id);
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = findRepoByGlobalId(args.id);
        return repo ? repoObject(repo) : null;
      }
      if (parsed.kind === 'Issue') {
        const found = findIssueByGlobalId(args.id);
        return found ? issueObject(found.repo, found.issue) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const found = findPullByGlobalId(args.id);
        return found ? prObject(found.repo, found.pr) : null;
      }
      return null;
    },
    search: () => ({ __typename: 'SearchResultItemConnection', nodes: [] }),
  },
  Viewer: {
    login: (p) => p.login,
    id: (p) => p.id,
  },
  User: {
    login: (p) => p.login ?? VIEWER_LOGIN,
    id: (p) => p.id ?? globalId('User', String(VIEWER_ID)),
  },
  Repository: {
    id: (p) => p.id,
    databaseId: (p) => p.databaseId,
    name: (p) => p.name,
    nameWithOwner: (p) => p.nameWithOwner,
    description: (p) => p.description,
    url: (p) => p.url,
    owner: (p) => ({ __typename: 'User', login: VIEWER_LOGIN, id: globalId('User', String(VIEWER_ID)) }),
    defaultBranchRef: (p) => {
      const tip = p._repo.refs.get(`refs/heads/${p._repo.default_branch}`);
      return tip ? { __typename: 'Ref', name: p._repo.default_branch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (p, args) => {
      const issue = p._repo.issues.find((i) => i.number === args.number);
      return issue ? issueObject(p._repo, issue) : null;
    },
    issues: (p, args) => issuesConnection(p._repo, args),
    pullRequests: (p, args) => pullsConnection(p._repo, args),
    pullRequest: (p, args) => {
      const pr = p._repo.pulls.find((x) => x.number === args.number);
      return pr ? prObject(p._repo, pr) : null;
    },
  },
  Ref: { name: (p) => p.name },
  Issue: {
    id: (p) => p.id,
    number: (p) => p.number,
    title: (p) => p.title,
    state: (p) => p.state,
    body: (p) => p.body,
  },
  IssueConnection: {
    nodes: (p) => p._nodes,
    edges: (p) => p._nodes.map((n) => ({ node: n, cursor: cursorFor(n.number) })),
    totalCount: (p) => p._nodes.length,
    pageInfo: (p) => p._pageInfo,
  },
  PullRequestConnection: {
    nodes: (p) => p._nodes,
    edges: (p) => p._nodes.map((n) => ({ node: n, cursor: cursorFor(n.number) })),
    totalCount: (p) => p._nodes.length,
    pageInfo: (p) => p._pageInfo,
  },
  PullRequest: {
    id: (p) => p.id,
    number: (p) => p.number,
    title: (p) => p.title,
    body: (p) => p.body,
    headRefName: (p) => p.headRefName,
    baseRefName: (p) => p.baseRefName,
    state: (p) => p.state,
    merged: (p) => p.merged,
    mergeable: (p) => p.mergeable,
    files: (p, args) => {
      const files = pullFiles(p._repo, p._pr).map((f) => ({ __typename: 'File', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status }));
      const first = typeof args.first === 'number' ? args.first : files.length;
      return { __typename: 'FileConnection', _nodes: files.slice(0, first), totalCount: files.length };
    },
  },
  FileConnection: {
    nodes: (p) => p._nodes,
    totalCount: (p) => p.totalCount,
  },
  File: {
    path: (p) => p.path,
    additions: (p) => p.additions,
    deletions: (p) => p.deletions,
    changeType: (p) => p.changeType,
  },
  PageInfo: {
    hasNextPage: (p) => p.hasNextPage,
    hasPreviousPage: (p) => p.hasPreviousPage,
    startCursor: (p) => p.startCursor,
    endCursor: (p) => p.endCursor,
  },
  Comment: {
    id: (p) => p.id,
    body: (p) => p.body,
  },
  CommentEdge: {
    node: (p) => p.node,
    cursor: (p) => p.cursor ?? null,
  },
  Mutation: {
    createIssue: (_p, args) => {
      const input = args.input ?? {};
      const repo = findRepoByGlobalId(input.repositoryId);
      if (!repo) throw new Error('Repository not found');
      const issue = createIssueRecord(repo, input.title ?? '', typeof input.body === 'string' ? input.body : '', []);
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
    },
    closeIssue: (_p, args) => {
      const input = args.input ?? {};
      const found = findIssueByGlobalId(input.issueId);
      if (!found) throw new Error('Issue not found');
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue) };
    },
    createPullRequest: (_p, args) => {
      const input = args.input ?? {};
      const repo = findRepoByGlobalId(input.repositoryId);
      if (!repo) throw new Error('Repository not found');
      const head = input.headRefName;
      const base = input.baseRefName ?? repo.default_branch;
      const pr = createPullRecord(repo, input.title ?? '', typeof input.body === 'string' ? input.body : '', head, base);
      return { __typename: 'CreatePullRequestPayload', pullRequest: prObject(repo, pr) };
    },
    mergePullRequest: (_p, args) => {
      const input = args.input ?? {};
      const found = findPullByGlobalId(input.pullRequestId);
      if (!found) throw new Error('Pull request not found');
      const { repo, pr } = found;
      mergePullRecord(repo, pr);
      return { __typename: 'MergePullRequestPayload', pullRequest: prObject(repo, pr) };
    },
    addComment: (_p, args) => {
      const input = args.input ?? {};
      const found = findIssueByGlobalId(input.subjectId);
      if (!found) throw new Error('Subject not found');
      const comment = addComment(found.repo, found.issue, input.body ?? '');
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node: { __typename: 'Comment', id: comment.node_id, body: comment.body }, cursor: null } };
    },
  },
  CreateIssuePayload: { issue: (p) => p.issue },
  CloseIssuePayload: { issue: (p) => p.issue },
  CreatePullRequestPayload: { pullRequest: (p) => p.pullRequest },
  MergePullRequestPayload: { pullRequest: (p) => p.pullRequest },
  AddCommentPayload: { commentEdge: (p) => p.commentEdge },
};

function typeOf(value) {
  if (value && typeof value === 'object' && typeof value.__typename === 'string') return value.__typename;
  return null;
}

/** Validate the selection against SCHEMA; returns an error string or null. */
function validateSelection(selection, parentType, fragments) {
  for (const field of selection ?? []) {
    if (field.kind === 'inline-fragment') {
      const err = validateSelection(field.selection, field.type, fragments);
      if (err) return err;
      continue;
    }
    if (field.kind === 'fragment-spread') {
      const frag = fragments[field.name];
      if (!frag) return `Unknown fragment "${field.name}".`;
      const err = validateSelection(frag.selection, frag.type, fragments);
      if (err) return err;
      continue;
    }
    if (field.name === '__typename') continue;
    if (field.name === '__type' || field.name === '__schema') continue;
    const allowed = SCHEMA[parentType];
    if (!allowed) return `Cannot query field "${field.name}" on type "${parentType}".`;
    if (!allowed.includes(field.name)) {
      return `Cannot query field "${field.name}" on type "${parentType}".`;
    }
    // Recurse into the child type when the field has a sub-selection.
    if (field.selection) {
      const childType = childTypeOf(parentType, field.name);
      if (childType) {
        const err = validateSelection(field.selection, childType, fragments);
        if (err) return err;
      }
    }
  }
  return null;
}

function childTypeOf(parentType, field) {
  const map = {
    'Query.viewer': 'Viewer',
    'Query.repository': 'Repository',
    'Query.node': null, // polymorphic; validated loosely
    'Repository.owner': 'User',
    'Repository.defaultBranchRef': 'Ref',
    'Repository.issue': 'Issue',
    'Repository.issues': 'IssueConnection',
    'Repository.pullRequests': 'PullRequestConnection',
    'Repository.pullRequest': 'PullRequest',
    'IssueConnection.nodes': 'Issue',
    'IssueConnection.edges': 'IssueEdge',
    'IssueConnection.pageInfo': 'PageInfo',
    'PullRequestConnection.nodes': 'PullRequest',
    'PullRequestConnection.edges': 'PullRequestEdge',
    'PullRequestConnection.pageInfo': 'PageInfo',
    'PullRequest.files': 'FileConnection',
    'FileConnection.nodes': 'File',
    'Mutation.createIssue': 'CreateIssuePayload',
    'Mutation.closeIssue': 'CloseIssuePayload',
    'Mutation.createPullRequest': 'CreatePullRequestPayload',
    'Mutation.mergePullRequest': 'MergePullRequestPayload',
    'Mutation.addComment': 'AddCommentPayload',
    'CreateIssuePayload.issue': 'Issue',
    'CloseIssuePayload.issue': 'Issue',
    'CreatePullRequestPayload.pullRequest': 'PullRequest',
    'MergePullRequestPayload.pullRequest': 'PullRequest',
    'AddCommentPayload.commentEdge': 'CommentEdge',
    'CommentEdge.node': 'Comment',
  };
  return map[`${parentType}.${field}`] ?? null;
}

function executeSelection(selection, parent, parentType, variables, fragments, errors) {
  const out = {};
  for (const field of selection ?? []) {
    if (field.kind === 'inline-fragment') {
      const parentTypename = typeOf(parent);
      if (field.type && parentTypename && parentTypename !== field.type) continue;
      Object.assign(out, executeSelection(field.selection, parent, field.type, variables, fragments, errors));
      continue;
    }
    if (field.kind === 'fragment-spread') {
      const frag = fragments[field.name];
      if (frag) Object.assign(out, executeSelection(frag.selection, parent, frag.type, variables, fragments, errors));
      continue;
    }
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = parentType;
      continue;
    }
    if (field.name === '__type') {
      const args = resolveArgs(field.args, variables);
      const info = INTROSPECTION[args.name];
      const typeObj = { __typename: '__Type', _name: args.name };
      out[responseKey] = info ? executeSelection(field.selection, typeObj, '__Type', variables, fragments, errors) : null;
      continue;
    }
    if (field.name === '__schema') {
      out[responseKey] = null;
      continue;
    }
    const resolvers = RESOLVERS[parentType];
    const resolve = resolvers?.[field.name];
    if (!resolve) {
      errors.push(gqlError(`Cannot query field "${field.name}" on type "${parentType}".`));
      out[responseKey] = null;
      continue;
    }
    let value;
    try {
      value = resolve(parent, resolveArgs(field.args, variables));
    } catch (err) {
      errors.push(gqlError(err.message));
      out[responseKey] = null;
      continue;
    }
    if (field.selection && value !== null && value !== undefined) {
      const childType = childTypeOf(parentType, field.name) ?? typeOf(value) ?? parentType;
      if (Array.isArray(value)) {
        out[responseKey] = value.map((v) => executeSelection(field.selection, v, childTypeOf(parentType, field.name) ?? typeOf(v) ?? parentType, variables, fragments, errors));
      } else {
        out[responseKey] = executeSelection(field.selection, value, childType, variables, fragments, errors);
      }
    } else {
      out[responseKey] = value ?? null;
    }
  }
  return out;
}

// __Type field resolvers are handled inline in executeSelection's __type branch
// through a synthetic object; give it resolvers here.
RESOLVERS['__Type'] = {
  name: (p) => p._name,
  kind: (p) => (INTROSPECTION[p._name]?.enumValues ? 'ENUM' : 'OBJECT'),
  fields: (p) => {
    const info = INTROSPECTION[p._name];
    if (!info || !info.fields) return null;
    return info.fields.map((name) => ({ __typename: '__Field', _fieldName: name }));
  },
  enumValues: (p) => {
    const info = INTROSPECTION[p._name];
    if (!info || !info.enumValues) return null;
    return info.enumValues.map((name) => ({ __typename: '__EnumValue', _enumName: name }));
  },
};
SCHEMA['__Type'] = ['name', 'kind', 'fields', 'enumValues', 'description'];
SCHEMA['__Field'] = ['name', 'description'];
SCHEMA['__EnumValue'] = ['name', 'description'];
RESOLVERS['__Field'] = { name: (p) => p._fieldName, description: () => null };
RESOLVERS['__EnumValue'] = { name: (p) => p._enumName, description: () => null };

function executeOperation(def, variables, fragments) {
  const errors = [];
  const rootType = def.operation === 'mutation' ? 'Mutation' : 'Query';
  const validationError = validateSelection(def.selection, rootType, fragments);
  if (validationError) {
    return { data: null, errors: [gqlError(validationError)] };
  }
  const data = executeSelection(def.selection, {}, rootType, variables, fragments, errors);
  return errors.length ? { data, errors } : { data };
}

/**
 * Handle POST /api/graphql. `body` is the parsed JSON (object or array).
 * Returns {status, body}.
 */
export function handleGraphQL(body) {
  const runOne = (op) => {
    if (!op || typeof op.query !== 'string') {
      return { data: null, errors: [gqlError('Request must carry a query string.')] };
    }
    let defs;
    try {
      defs = new Parser(lex(op.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [gqlError(err.message)] };
    }
    const fragments = {};
    let operation = null;
    for (const d of defs) {
      if (d.kind === 'fragment') fragments[d.name] = d;
      else if (!operation) operation = d;
    }
    if (!operation) return { data: null, errors: [gqlError('No operation in document.')] };
    if (op.operationName) {
      const named = defs.find((d) => d.kind === 'operation' && d.name === op.operationName);
      if (named) operation = named;
    }
    const variables = { ...(op.variables ?? {}) };
    return executeOperation(operation, variables, fragments);
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}

/** No-op kept for symmetry with the original plan; repos come from the store. */
export function registerRepos() {}
