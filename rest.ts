// GitHub REST v3, under /api/v3: repositories, branches, commits, contents,
// issues, comments, labels, pull requests and the Git Data refs API.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id.
// Errors are JSON {message}. A repository belongs to the login the token
// names (adaiversen): the same name under another owner is 404, never 403.
// A request without the token is 401.

import {
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_EMAIL,
  ZERO_OID,
  DEFAULT_BRANCH,
  store,
  tickMs,
  iso,
  identLine,
  b64encode,
  b64decode,
  globalId,
  createRepoRecord,
  getRepo,
  listViewerRepos,
  getObject,
  putObject,
  parseCommit,
  parseTree,
  flattenTree,
  makeCommit,
  collectReachable,
  isAncestor,
  mergeBase,
  diffTrees,
  applyTreeChanges,
  resolveTreePath,
  listTreeDir,
  listCommits,
  branchTip,
} from './store.ts';

export function notFound(message = 'Not Found') {
  return { status: 404, body: { message } };
}
export function badRequest(message) {
  return { status: 400, body: { message } };
}
export function unprocessable(message) {
  return { status: 422, body: { message } };
}
export function conflict(message) {
  return { status: 409, body: { message } };
}
export function unauthorized() {
  return { status: 401, body: { message: 'Requires authentication' } };
}

export function userView() {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', String(VIEWER_ID)),
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
    type: 'User',
    site_admin: false,
    name: 'ada iversen',
    email: VIEWER_EMAIL,
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    url: `/api/v3/users/${VIEWER_LOGIN}`,
  };
}

export function repoView(repo) {
  const openIssues = repo.issues.filter((i) => i.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner, id: VIEWER_ID, node_id: globalId('User', String(VIEWER_ID)), type: 'User', avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4` },
    private: repo.private,
    html_url: `https://github.com/${repo.full_name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.full_name}`,
    created_at: iso(repo.createdMs),
    updated_at: iso(repo.updatedMs),
    pushed_at: iso(repo.updatedMs),
    git_url: `git://github.com/${repo.full_name}.git`,
    ssh_url: `git@github.com:${repo.full_name}.git`,
    clone_url: `https://github.com/${repo.full_name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.default_branch,
  };
}

export function labelView(label) {
  return {
    id: label.id,
    node_id: globalId('Label', String(label.id)),
    url: `/api/v3/repos/${label.repo}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description ?? '',
  };
}

export function issueView(repo, issue) {
  return {
    id: issue.id,
    node_id: issue.node_id,
    url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.full_name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelView({ ...label, repo: repo.full_name }) : { name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: iso(issue.createdMs),
    updated_at: iso(issue.updatedMs),
    closed_at: issue.state === 'closed' ? iso(issue.updatedMs) : null,
    author_association: 'OWNER',
  };
}

export function commentView(repo, issue, comment) {
  return {
    id: comment.id,
    node_id: comment.node_id,
    url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.full_name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: iso(comment.createdMs),
    updated_at: iso(comment.updatedMs),
    author_association: 'OWNER',
  };
}

export function pullView(repo, pr) {
  const headTip = repo.refs.get(`refs/heads/${pr.head}`) ?? null;
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`) ?? null;
  return {
    id: pr.id,
    node_id: pr.node_id,
    url: `/api/v3/repos/${repo.full_name}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.full_name}/pull/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    body: pr.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: iso(pr.createdMs),
    updated_at: iso(pr.updatedMs),
    closed_at: pr.state === 'closed' ? iso(pr.updatedMs) : null,
    merged_at: pr.merged_at ? iso(pr.merged_at) : null,
    merge_commit_sha: pr.merge_commit_sha,
    merged: pr.merged,
    mergeable: prMergeable(repo, pr),
    mergeable_state: prMergeable(repo, pr) === 'MERGEABLE' ? 'clean' : 'dirty',
    merged_by: pr.merged ? { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' } : null,
    head: { label: `${repo.owner}:${pr.head}`, ref: pr.head, sha: headTip ?? pr.headSha },
    base: { label: `${repo.owner}:${pr.base}`, ref: pr.base, sha: baseTip ?? pr.baseSha },
    draft: false,
  };
}

/** 'MERGEABLE' | 'CONFLICTING' for a pull request's current refs. */
export function prMergeable(repo, pr) {
  if (pr.merged) return 'MERGEABLE';
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  if (headTip === baseTip) return 'MERGEABLE';
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return 'CONFLICTING';
  const headCommit = getObject(repo, headTip);
  const baseCommit = getObject(repo, baseTip);
  const baseMerge = getObject(repo, base);
  if (!headCommit || !baseCommit || !baseMerge) return 'CONFLICTING';
  const headTree = parseCommit(headCommit.data).tree;
  const baseTree = parseCommit(baseCommit.data).tree;
  const mergeTree = parseCommit(baseMerge.data).tree;
  const headChanges = diffTrees(repo, mergeTree, headTree);
  const baseChanges = diffTrees(repo, mergeTree, baseTree);
  const baseByPath = new Map(baseChanges.map((c) => [c.path, c]));
  for (const c of headChanges) {
    const other = baseByPath.get(c.path);
    if (other && other.newOid !== c.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** The files a pull request changes (merge-base tree -> head tree). */
export function pullFiles(repo, pr) {
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (!headTip || !baseTip) return [];
  const base = mergeBase(repo, headTip, baseTip);
  const headCommit = getObject(repo, headTip);
  if (!headCommit) return [];
  const headTree = parseCommit(headCommit.data).tree;
  const mergeTree = base ? parseCommit(getObject(repo, base).data).tree : null;
  const changes = diffTrees(repo, mergeTree, headTree);
  return changes.map((c) => {
    const countLines = (oid) => {
      if (!oid) return 0;
      const obj = getObject(repo, oid);
      if (!obj) return 0;
      const text = obj.data.toString('utf8');
      if (text === '') return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    const additions = c.status === 'removed' ? 0 : countLines(c.newOid);
    const deletions = c.status === 'added' ? 0 : countLines(c.oldOid);
    return {
      sha: c.newOid ?? c.oldOid,
      filename: c.path,
      status: c.status === 'modified' ? 'modified' : c.status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `https://github.com/${repo.full_name}/blob/${headTip}/${c.path}`,
      raw_url: `https://github.com/${repo.full_name}/raw/${headTip}/${c.path}`,
      contents_url: `/api/v3/repos/${repo.full_name}/contents/${c.path}?ref=${headTip}`,
      patch: null,
    };
  });
}

function parseIdent(line) {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line ?? '');
  if (!m) return { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: iso(tickMs()) };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

export function commitView(repo, oid) {
  const obj = getObject(repo, oid);
  const parsed = parseCommit(obj.data);
  const author = parseIdent(parsed.author);
  const committer = parseIdent(parsed.committer);
  return {
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: {
      author,
      committer,
      message: parsed.message.replace(/\n+$/, ''),
      tree: { sha: parsed.tree },
      url: `/api/v3/repos/${repo.full_name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.full_name}/commits/${oid}`,
    html_url: `https://github.com/${repo.full_name}/commit/${oid}`,
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: parsed.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.full_name}/commits/${p}` })),
  };
}

/** Parse ?per_page=&page= and slice `items`; returns {page, link}. */
export function paginate(req, items, defaultPerPage = 30) {
  const query = req.query;
  let perPage = Number.parseInt(query.per_page ?? '', 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = defaultPerPage;
  if (perPage > 100) perPage = 100;
  let page = Number.parseInt(query.page ?? '', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link = null;
  if (page < pages) {
    const base = req.absoluteUrl();
    const nextUrl = new URL(base);
    nextUrl.searchParams.set('page', String(page + 1));
    nextUrl.searchParams.set('per_page', String(perPage));
    const lastUrl = new URL(base);
    lastUrl.searchParams.set('page', String(pages));
    lastUrl.searchParams.set('per_page', String(perPage));
    const firstUrl = new URL(base);
    firstUrl.searchParams.set('page', '1');
    firstUrl.searchParams.set('per_page', String(perPage));
    link = `<${nextUrl.toString()}>; rel="next", <${lastUrl.toString()}>; rel="last", <${firstUrl.toString()}>; rel="first"`;
  }
  return { page: slice, link };
}

/** Resolve a ref query (?ref=branch|sha) to a commit oid, or null. */
function resolveRef(repo, ref) {
  if (ref === undefined || ref === null || ref === '') return branchTip(repo, repo.default_branch);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const obj = getObject(repo, ref);
  if (obj && (obj.type === 'commit' || obj.type === 'tag')) {
    if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      return target;
    }
    return ref;
  }
  return null;
}

/** Ensure `branch` exists on `repo`, creating it from the default tip (or unborn). */
function ensureBranch(repo, branch) {
  const ref = `refs/heads/${branch}`;
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const base = branch === repo.default_branch ? null : branchTip(repo, repo.default_branch);
  if (base) repo.refs.set(ref, base);
  return base;
}

/**
 * Write one file through the contents API: creates a blob, a tree and a
 * commit on `branch`. Returns {status, body} for the PUT response.
 */
function contentsWrite(repo, filePath, contentBuf, message, branch, sha) {
  const tip = ensureBranch(repo, branch);
  const treeOid = tip ? parseCommit(getObject(repo, tip).data).tree : null;
  const existing = treeOid ? resolveTreePath(repo, treeOid, filePath) : null;
  const blobOid = putObject(repo, 'blob', contentBuf);
  if (existing && existing.type === 'tree') return conflict('Is a directory');
  if (existing) {
    if (sha === undefined || sha === null) return unprocessable('sha is required to update a file');
    if (sha !== existing.oid) return conflict('The file has changed since the sha was read');
  }
  const parents = tip ? [tip] : [];
  const newTree = applyTreeChanges(repo, treeOid, new Map([[filePath, blobOid]]));
  const commitOid = makeCommit(repo, newTree, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedMs = tickMs();
  const status = existing ? 200 : 201;
  return {
    status,
    body: {
      content: {
        name: filePath.split('/').pop(),
        path: filePath,
        sha: blobOid,
        size: contentBuf.length,
        url: `/api/v3/repos/${repo.full_name}/contents/${filePath}`,
        html_url: `https://github.com/${repo.full_name}/blob/${branch}/${filePath}`,
        git_url: `/api/v3/repos/${repo.full_name}/git/blobs/${blobOid}`,
        download_url: `https://raw.githubusercontent.com/${repo.full_name}/${branch}/${filePath}`,
        type: 'file',
        encoding: 'base64',
        content: b64encode(contentBuf),
        _links: {},
      },
      commit: { sha: commitOid, message },
    },
  };
}

function contentsDelete(repo, filePath, message, branch, sha) {
  const tip = branchTip(repo, branch);
  if (!tip) return notFound('Not Found');
  const treeOid = parseCommit(getObject(repo, tip).data).tree;
  const existing = resolveTreePath(repo, treeOid, filePath);
  if (!existing || existing.type !== 'blob') return notFound('Not Found');
  if (sha !== undefined && sha !== null && sha !== existing.oid) return conflict('The file has changed since the sha was read');
  const newTree = applyTreeChanges(repo, treeOid, new Map([[filePath, null]]));
  const commitOid = makeCommit(repo, newTree, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedMs = tickMs();
  return { status: 200, body: { commit: { sha: commitOid, message } } };
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/**
 * Handle a REST request. `req` carries {method, segments, query, body,
 * absoluteUrl}. Returns {status, body, headers?} or null when the path is
 * not a REST route at all (caller answers 404).
 */
export function handleRest(req) {
  const seg = req.segments; // after /api/v3
  const method = req.method;
  const body = req.body ?? {};

  if (seg.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    return notFound();
  }

  if (seg[0] === 'meta' && seg.length === 1 && method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }

  if (seg[0] === 'user' && seg.length === 1 && method === 'GET') {
    return { status: 200, body: userView() };
  }

  if (seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(req, listViewerRepos().map(repoView));
      return { status: 200, body: page, headers: link ? { link } : {} };
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return unprocessable('Validation Failed: name is required');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return unprocessable('Validation Failed: invalid repository name');
      const existing = getRepo(VIEWER_LOGIN, name);
      if (existing) return unprocessable(`Repository creation failed. ${VIEWER_LOGIN}/${name} already exists on this account.`);
      const repo = createRepoRecord(VIEWER_LOGIN, name, { description: body.description ?? null, private: body.private === true });
      return { status: 201, body: repoView(repo) };
    }
    return notFound();
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = decodeURIComponent(seg[1]);
    const name = decodeURIComponent(seg[2]);
    if (owner !== VIEWER_LOGIN) return notFound('Not Found');
    const repo = getRepo(owner, name);
    const rest = seg.slice(3);

    if (rest.length === 0) {
      if (!repo) return notFound('Not Found');
      if (method === 'GET') return { status: 200, body: repoView(repo) };
      if (method === 'PATCH') {
        if (typeof body.description === 'string' || body.description === null) repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        repo.updatedMs = tickMs();
        return { status: 200, body: repoView(repo) };
      }
      if (method === 'DELETE') {
        store.repos.delete(`${owner}/${name}`);
        return { status: 204, body: null };
      }
      return notFound();
    }

    if (!repo) return notFound('Not Found');

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .sort()
          .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r), url: `/api/v3/repos/${repo.full_name}/commits/${repo.refs.get(r)}` }, protected: false }));
        return { status: 200, body: list };
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(rest[1]);
        const tip = branchTip(repo, branch);
        if (!tip) return notFound('Branch not found');
        return { status: 200, body: { name: branch, commit: { sha: tip, url: `/api/v3/repos/${repo.full_name}/commits/${tip}` }, protected: false } };
      }
      return notFound();
    }

    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const tip = resolveRef(repo, req.query.sha);
      if (!tip) return notFound('Not Found');
      const commits = listCommits(repo, tip).map((oid) => commitView(repo, oid));
      const { page, link } = paginate(req, commits);
      return { status: 200, body: page, headers: link ? { link } : {} };
    }

    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (method === 'GET') {
        const tip = resolveRef(repo, req.query.ref);
        if (!tip) return notFound('Not Found');
        const treeOid = parseCommit(getObject(repo, tip).data).tree;
        if (filePath === '') {
          const entries = listTreeDir(repo, treeOid, '') ?? [];
          return { status: 200, body: entries.map((e) => contentEntryView(repo, e)) };
        }
        const resolved = resolveTreePath(repo, treeOid, filePath);
        if (!resolved) return notFound('Not Found');
        if (resolved.type === 'tree') {
          const entries = listTreeDir(repo, treeOid, filePath) ?? [];
          return { status: 200, body: entries.map((e) => contentEntryView(repo, e)) };
        }
        return {
          status: 200,
          body: {
            type: 'file',
            encoding: 'base64',
            size: resolved.data.length,
            name: filePath.split('/').pop(),
            path: filePath,
            content: b64encode(resolved.data),
            sha: resolved.oid,
            url: `/api/v3/repos/${repo.full_name}/contents/${filePath}`,
            html_url: `https://github.com/${repo.full_name}/blob/${req.query.ref ?? repo.default_branch}/${filePath}`,
            git_url: `/api/v3/repos/${repo.full_name}/git/blobs/${resolved.oid}`,
            download_url: `https://raw.githubusercontent.com/${repo.full_name}/${req.query.ref ?? repo.default_branch}/${filePath}`,
          },
        };
      }
      if (method === 'PUT') {
        if (typeof body.content !== 'string' || typeof body.message !== 'string') return badRequest('content and message are required');
        let contentBuf;
        try {
          contentBuf = b64decode(body.content);
        } catch {
          return badRequest('content is not valid base64');
        }
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
        return contentsWrite(repo, filePath, contentBuf, body.message, branch, body.sha);
      }
      if (method === 'DELETE') {
        if (typeof body.message !== 'string') return badRequest('message is required');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
        return contentsDelete(repo, filePath, body.message, branch, body.sha);
      }
      return notFound();
    }

    if (rest[0] === 'labels') {
      if (method === 'GET') {
        return { status: 200, body: [...repo.labels.values()].map((l) => labelView({ ...l, repo: repo.full_name })) };
      }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return unprocessable('Validation Failed: name is required');
        const existing = repo.labels.get(name);
        if (existing) return { status: 200, body: labelView({ ...existing, repo: repo.full_name }) };
        const label = { id: store.issueIdSeq + repo.labels.size + 1, name, color: typeof body.color === 'string' ? body.color : 'ededed', description: typeof body.description === 'string' ? body.description : '' };
        repo.labels.set(name, label);
        return { status: 201, body: labelView({ ...label, repo: repo.full_name }) };
      }
      return notFound();
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!/^refs\/(heads|tags)\/.+/.test(ref)) return unprocessable('Validation Failed: ref must be refs/heads/<name> or refs/tags/<name>');
        const obj = getObject(repo, sha);
        if (!obj) return unprocessable('Validation Failed: sha does not exist in this repository');
        if (repo.refs.has(ref)) return unprocessable('Validation Failed: reference already exists');
        repo.refs.set(ref, sha);
        return { status: 201, body: { ref, node_id: globalId('Ref', ref), url: `/api/v3/repos/${repo.full_name}/git/${ref}`, object: { sha, type: obj.type, url: `/api/v3/repos/${repo.full_name}/git/${obj.type}s/${sha}` } } };
      }
      if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
        const branch = decodeURIComponent(rest[3]);
        const tip = branchTip(repo, branch);
        if (!tip) return notFound('Not Found');
        return { status: 200, body: { ref: `refs/heads/${branch}`, node_id: globalId('Ref', `refs/heads/${branch}`), url: `/api/v3/repos/${repo.full_name}/git/refs/heads/${branch}`, object: { sha: tip, type: 'commit', url: `/api/v3/repos/${repo.full_name}/git/commits/${tip}` } } };
      }
      if (method === 'GET' && rest.length === 2) {
        const list = [...repo.refs.entries()].sort().map(([ref, sha]) => {
          const obj = getObject(repo, sha);
          return { ref, node_id: globalId('Ref', ref), url: `/api/v3/repos/${repo.full_name}/git/${ref}`, object: { sha, type: obj?.type ?? 'commit', url: '' } };
        });
        return { status: 200, body: list };
      }
      return notFound();
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          return createIssue(repo, body);
        }
        if (method === 'GET') {
          let issues = [...repo.issues];
          const state = (req.query.state ?? 'open').toLowerCase();
          if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
          else if (state !== 'all') issues = issues.filter((i) => i.state === 'open');
          const direction = (req.query.direction ?? 'desc').toLowerCase();
          issues.sort((a, b) => (direction === 'asc' ? a.createdMs - b.createdMs || a.number - b.number : b.createdMs - a.createdMs || b.number - a.number));
          const { page, link } = paginate(req, issues.map((i) => issueView(repo, i)));
          return { status: 200, body: page, headers: link ? { link } : {} };
        }
        return notFound();
      }
      const number = Number.parseInt(rest[1], 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return notFound('Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return { status: 200, body: issueView(repo, issue) };
        if (method === 'PATCH') {
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string' || body.body === null) issue.body = body.body;
          if (Array.isArray(body.labels)) {
            const names = body.labels.map((l) => (typeof l === 'string' ? l : l.name));
            for (const n of names) if (!repo.labels.has(n)) return unprocessable(`Validation Failed: label "${n}" does not exist`);
            issue.labels = names;
          }
          issue.updatedMs = tickMs();
          return { status: 200, body: issueView(repo, issue) };
        }
        return notFound();
      }
      if (rest[2] === 'comments') {
        if (method === 'GET') return { status: 200, body: issue.comments.map((c) => commentView(repo, issue, c)) };
        if (method === 'POST') {
          if (typeof body.body !== 'string' || body.body === '') return unprocessable('Validation Failed: body is required');
          const comment = addComment(repo, issue, body.body);
          return { status: 201, body: commentView(repo, issue, comment) };
        }
        return notFound();
      }
      return notFound();
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          return createPull(repo, body);
        }
        if (method === 'GET') {
          let pulls = [...repo.pulls];
          const state = (req.query.state ?? 'open').toLowerCase();
          if (state === 'open' || state === 'closed') pulls = pulls.filter((p) => p.state === state);
          else if (state !== 'all') pulls = pulls.filter((p) => p.state === 'open');
          pulls.sort((a, b) => b.number - a.number);
          const { page, link } = paginate(req, pulls.map((p) => pullView(repo, p)));
          return { status: 200, body: page, headers: link ? { link } : {} };
        }
        return notFound();
      }
      const number = Number.parseInt(rest[1], 10);
      const pr = repo.pulls.find((p) => p.number === number);
      if (!pr) return notFound('Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return { status: 200, body: pullView(repo, pr) };
        return notFound();
      }
      if (rest[2] === 'files' && method === 'GET') {
        return { status: 200, body: pullFiles(repo, pr) };
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        return mergePull(repo, pr);
      }
      return notFound();
    }

    return notFound();
  }

  return null;
}

function contentEntryView(repo, entry) {
  return {
    type: entry.type,
    size: entry.type === 'file' ? (getObject(repo, entry.oid)?.data.length ?? 0) : 0,
    name: entry.name,
    path: entry.path,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.full_name}/contents/${entry.path}`,
    git_url: `/api/v3/repos/${repo.full_name}/git/${entry.type === 'dir' ? 'trees' : 'blobs'}/${entry.oid}`,
    html_url: `https://github.com/${repo.full_name}/${entry.type === 'dir' ? 'tree' : 'blob'}/${repo.default_branch}/${entry.path}`,
    download_url: entry.type === 'file' ? `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${entry.path}` : null,
  };
}

export function addComment(repo, issue, bodyText) {
  const ms = tickMs();
  const comment = {
    id: store.commentIdSeq,
    node_id: globalId('IssueComment', String(repo.id), String(issue.number), String(store.commentIdSeq)),
    body: bodyText,
    createdMs: ms,
    updatedMs: ms,
  };
  store.commentIdSeq += 1;
  issue.comments.push(comment);
  issue.updatedMs = ms;
  return comment;
}

export function createIssueRecord(repo, title, bodyText, labelNames) {
  const ms = tickMs();
  const number = repo.nextIssue;
  repo.nextIssue += 1;
  const issue = {
    id: store.issueIdSeq,
    node_id: globalId('Issue', String(repo.id), String(number)),
    number,
    title,
    body: bodyText ?? '',
    state: 'open',
    labels: labelNames,
    comments: [],
    createdMs: ms,
    updatedMs: ms,
  };
  store.issueIdSeq += 1;
  repo.issues.push(issue);
  return issue;
}

function createIssue(repo, body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return unprocessable('Validation Failed: title is required');
  const rawLabels = Array.isArray(body.labels) ? body.labels : [];
  const labelNames = rawLabels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return unprocessable(`Validation Failed: label "${name}" does not exist`);
  }
  const issue = createIssueRecord(repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
  return { status: 201, body: issueView(repo, issue) };
}

function branchNameOf(value) {
  if (typeof value !== 'string') return '';
  const idx = value.lastIndexOf(':');
  return idx >= 0 ? value.slice(idx + 1) : value;
}

/** Create a pull request record; throws Error on validation failure. */
export function createPullRecord(repo, title, bodyText, head, base) {
  const headTip = branchTip(repo, head);
  const baseTip = branchTip(repo, base);
  if (!headTip) throw new Error(`head branch "${head}" does not exist`);
  if (!baseTip) throw new Error(`base branch "${base}" does not exist`);
  const existing = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
  if (existing) throw new Error('a pull request already exists for this head branch');
  const ms = tickMs();
  const number = repo.nextPull;
  repo.nextPull += 1;
  const pr = {
    id: store.issueIdSeq,
    node_id: globalId('PullRequest', String(repo.id), String(number)),
    number,
    title,
    body: bodyText,
    state: 'open',
    head,
    base,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    createdMs: ms,
    updatedMs: ms,
  };
  store.issueIdSeq += 1;
  repo.pulls.push(pr);
  return pr;
}

function createPull(repo, body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const head = branchNameOf(body.head);
  const base = branchNameOf(body.base) || repo.default_branch;
  if (!title) return unprocessable('Validation Failed: title is required');
  if (!head) return unprocessable('Validation Failed: head is required');
  try {
    const pr = createPullRecord(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
    return { status: 201, body: pullView(repo, pr) };
  } catch (err) {
    return unprocessable(`Validation Failed: ${err.message}`);
  }
}

/** Squash-merge a pull request; throws Error on failure. */
export function mergePullRecord(repo, pr) {
  if (pr.merged) throw new Error('Pull request already merged');
  if (prMergeable(repo, pr) === 'CONFLICTING') throw new Error('Merge conflict: the pull request cannot be merged');
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (!headTip || !baseTip) throw new Error('Branch not found');
  const headTree = parseCommit(getObject(repo, headTip).data).tree;
  const mergeMessage = `${pr.title} (#${pr.number})`;
  const mergeSha = makeCommit(repo, headTree, [baseTip], mergeMessage);
  repo.refs.set(`refs/heads/${pr.base}`, mergeSha);
  const ms = tickMs();
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = ms;
  pr.merge_commit_sha = mergeSha;
  pr.updatedMs = ms;
  repo.updatedMs = ms;
  return { sha: mergeSha, merged: true, message: 'Pull request successfully merged' };
}

function mergePull(repo, pr) {
  try {
    const result = mergePullRecord(repo, pr);
    return { status: 200, body: result };
  } catch (err) {
    if (err.message.startsWith('Merge conflict') || err.message === 'Pull request already merged') {
      return { status: 405, body: { message: err.message } };
    }
    return notFound('Not Found');
  }
}
