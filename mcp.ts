// Model Context Protocol, POST /mcp: JSON-RPC 2.0 Streamable HTTP, answered
// as plain application/json (no SSE needed). The client probes
// `server/discover` first (modern era) and falls back to `initialize`.
//
// Tools act on the same in-memory store as REST and GraphQL, so a repository
// created over REST is visible here and vice versa.

import {
  VIEWER_LOGIN,
  getRepo,
  listViewerRepos,
  createRepoRecord,
} from './store.ts';
import {
  repoView,
  issueView,
  pullView,
  createIssueRecord,
  createPullRecord,
  mergePullRecord,
} from './rest.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// One fixed constant: two tools/list calls must return the identical array
// byte-for-byte.
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', description: 'Repositories per page' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** The tool result shape the suite reads: text + structuredContent. */
function toolResult(obj, isError = false) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const out = { content: [{ type: 'text', text }], structuredContent: typeof obj === 'object' && obj !== null ? obj : { result: obj } };
  if (isError) out.isError = true;
  return out;
}

function findRepoOrThrow(args) {
  const owner = args.owner ?? args.org ?? args.login;
  const repoName = args.repo ?? args.repository;
  if (!owner || !repoName) throw new Error('owner and repo are required');
  if (owner !== VIEWER_LOGIN) throw new Error(`Repository ${owner}/${repoName} not found`);
  const repo = getRepo(owner, repoName);
  if (!repo) throw new Error(`Repository ${owner}/${repoName} not found`);
  return repo;
}

function pick(args, ...names) {
  for (const n of names) if (args[n] !== undefined && args[n] !== null) return args[n];
  return undefined;
}

const TOOL_HANDLERS = {
  create_repo(args) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) throw new Error('name is required');
    if (getRepo(VIEWER_LOGIN, name)) throw new Error(`Repository ${VIEWER_LOGIN}/${name} already exists`);
    const repo = createRepoRecord(VIEWER_LOGIN, name, { description: args.description ?? null, private: args.private === true });
    return repoView(repo);
  },
  get_repo(args) {
    const repo = findRepoOrThrow(args);
    return repoView(repo);
  },
  list_repos(args) {
    const perPage = typeof args.per_page === 'number' && args.per_page > 0 ? Math.floor(args.per_page) : 30;
    return listViewerRepos().slice(0, perPage).map(repoView);
  },
  create_issue(args) {
    const repo = findRepoOrThrow(args);
    const title = pick(args, 'title');
    if (!title) throw new Error('title is required');
    const issue = createIssueRecord(repo, title, typeof args.body === 'string' ? args.body : typeof args.description === 'string' ? args.description : '', []);
    return issueView(repo, issue);
  },
  list_issues(args) {
    const repo = findRepoOrThrow(args);
    const state = String(args.state ?? 'open').toLowerCase();
    let issues = [...repo.issues];
    if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
    else if (state !== 'all') issues = issues.filter((i) => i.state === 'open');
    issues.sort((a, b) => b.number - a.number);
    return issues.map((i) => issueView(repo, i));
  },
  get_issue(args) {
    const repo = findRepoOrThrow(args);
    const number = Number(pick(args, 'issue_number', 'number', 'issueNumber'));
    const issue = repo.issues.find((i) => i.number === number);
    if (!issue) throw new Error(`Issue #${number} not found`);
    return issueView(repo, issue);
  },
  create_pull_request(args) {
    const repo = findRepoOrThrow(args);
    const title = pick(args, 'title');
    const head = pick(args, 'head', 'head_branch');
    const base = pick(args, 'base', 'base_branch') ?? repo.default_branch;
    if (!title || !head || !base) throw new Error('title, head and base are required');
    const pr = createPullRecord(repo, title, typeof args.body === 'string' ? args.body : typeof args.description === 'string' ? args.description : '', head, base);
    return pullView(repo, pr);
  },
  merge_pull_request(args) {
    const repo = findRepoOrThrow(args);
    const number = Number(pick(args, 'pull_number', 'number', 'pullNumber'));
    const pr = repo.pulls.find((p) => p.number === number);
    if (!pr) throw new Error(`Pull request #${number} not found`);
    const result = mergePullRecord(repo, pr);
    return { ...result, number: pr.number, state: pr.state, merged_at: pr.merged_at ? new Date(pr.merged_at).toISOString() : null };
  },
};

function handleMethod(req) {
  const { method, params, id } = req;
  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: PROTOCOL_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS, nextCursor: undefined });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const handler = TOOL_HANDLERS[name];
    if (!handler) return rpcError(id, -32602, `Unknown tool: ${name}`);
    // The suite matches tools by suffix (a github__ prefix is allowed).
    let result;
    try {
      result = handler(args);
    } catch (err) {
      return rpcResult(id, toolResult({ error: err.message }, true));
    }
    return rpcResult(id, toolResult(result));
  }
  if (method.startsWith('notifications/')) return null; // notification: no reply
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/**
 * Handle POST /mcp. `bodyText` is the raw request body. Returns
 * {status, body} — status 202 with empty body for notifications.
 */
export function handleMcp(bodyText) {
  let req;
  try {
    req = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!req || typeof req !== 'object' || Array.isArray(req) || typeof req.method !== 'string') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  // Notifications (no id) get 202 with an empty body.
  if (req.id === undefined || req.id === null) {
    handleMethod(req);
    return { status: 202, body: null };
  }
  const result = handleMethod(req);
  if (result === null) return { status: 202, body: null };
  return { status: 200, body: result };
}
