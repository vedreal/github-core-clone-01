// The forge's store: one process, in-memory only, deterministic.
//
// Identity: the suite's bearer token names the scenario's viewer. The token
// itself is opaque (shpat_<hex> derived from the trial), so the login comes
// from the kit's public scenario seed (program/env/src/wire.ts, sealed and
// identical in every trial): viewer adaiversen (id 1000), stranger olgabauer.
// A real forge would read this from its auth database; here the scenario is
// the only source, and it is public by design.
//
// Time: no wall clock reaches any answer that the export could compare. A
// logical clock starts at MAKEFUN_TRIAL_NOW (or the competition opening)
// and ticks one second per created object, so two runs on one instance agree.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const ZERO_OID = '0'.repeat(40);
export const DEFAULT_BRANCH = 'main';

const TRIAL_NOW = Number.parseInt(process.env.MAKEFUN_TRIAL_NOW ?? '', 10);
const BASE_MS = Number.isFinite(TRIAL_NOW) && TRIAL_NOW > 0 ? TRIAL_NOW : Date.parse('2026-11-14T06:30:00Z');

let clockSeq = 0;
/** The next logical timestamp, milliseconds since the epoch. Deterministic. */
export function tickMs() {
  clockSeq += 1;
  return BASE_MS + clockSeq * 1000;
}
/** GitHub-style ISO timestamp (no fractional seconds). */
export function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
/** The author/committer line for a server-made commit at logical time `ms`. */
export function identLine(ms) {
  const sec = Math.floor(ms / 1000);
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${sec} +0000`;
}

export function sha1Hex(data) {
  return createHash('sha1').update(data).digest('hex');
}

/** The git id of an object: sha1("<type> <size>\0" + data). */
export function hashObject(type, data) {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function b64encode(buf) {
  return Buffer.from(buf).toString('base64');
}
export function b64decode(text) {
  return Buffer.from(String(text).replace(/\s+/g, ''), 'base64');
}
/** An opaque Relay-style global id: base64, never the bare database id. */
export function globalId(kind, ...parts) {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}
export function parseGlobalId(id) {
  try {
    const text = Buffer.from(String(id), 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export const store = {
  repos: new Map(), // "owner/name" -> repo
  repoSeq: 5000,
  issueIdSeq: 10000,
  commentIdSeq: 100000,
  reqSeq: 0,
};

export function nextReqId() {
  store.reqSeq += 1;
  return `req-${store.reqSeq}`;
}

export function repoKey(owner, name) {
  return `${owner}/${name}`;
}

export function createRepoRecord(owner, name, fields) {
  const ms = tickMs();
  const repo = {
    id: store.repoSeq,
    databaseId: store.repoSeq,
    name,
    owner,
    full_name: `${owner}/${name}`,
    description: fields.description ?? null,
    private: fields.private === true,
    default_branch: DEFAULT_BRANCH,
    createdMs: ms,
    updatedMs: ms,
    refs: new Map(), // refname -> oid
    objects: new Map(), // oid -> { type, data }
    labels: new Map(), // name -> { name, color, description }
    issues: [], // creation order
    pulls: [], // creation order
    nextIssue: 1,
    nextPull: 1,
  };
  store.repoSeq += 1;
  store.repos.set(repoKey(owner, name), repo);
  return repo;
}

export function getRepo(owner, name) {
  return store.repos.get(repoKey(owner, name)) ?? null;
}

export function listViewerRepos() {
  return [...store.repos.values()].filter((r) => r.owner === VIEWER_LOGIN);
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

export function putObject(repo, type, data) {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data: Buffer.from(data) });
  return oid;
}

export function getObject(repo, oid) {
  return repo.objects.get(oid) ?? null;
}

export function parseCommit(data) {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTree(data) {
  const entries = [];
  const buf = Buffer.from(data);
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = buf.toString('ascii', off, sp);
    const nul = buf.indexOf(0x00, sp + 1);
    if (nul < 0) break;
    const name = buf.toString('utf8', sp + 1, nul);
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTreeBuffer(entries) {
  // Git sorts tree entries by name, directories as if the name had a trailing '/'.
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build (and store) a tree from a flat path -> {oid, mode} map. Returns the root tree oid. */
export function treeFromFiles(repo, files) {
  const build = (prefix) => {
    const entries = [];
    const dirs = new Map();
    for (const [path, file] of files) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: file.mode ?? '100644', name: rest, oid: file.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, new Map());
        dirs.get(dir).set(path, file);
      }
    }
    for (const [dir, sub] of dirs) {
      const oid = build(prefix === '' ? dir : `${prefix}/${dir}`);
      entries.push({ mode: '40000', name: dir, oid });
    }
    return putObject(repo, 'tree', buildTreeBuffer(entries));
  };
  return build('');
}

/** The flat path -> blob-oid map of a tree, recursively. */
export function flattenTree(repo, treeOid, prefix = '') {
  const out = new Map();
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, v] of flattenTree(repo, entry.oid, path)) out.set(p, v);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Create a commit object (server-made, viewer identity, logical clock). */
export function makeCommit(repo, treeOid, parents, message) {
  const ms = tickMs();
  const ident = identLine(ms);
  const text = `tree ${treeOid}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${ident}\ncommitter ${ident}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return putObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

/**
 * Objects reachable from `tips`, optionally limited to `depth` commit
 * generations (depth 1 = the tips only). Returns { objects, shallow } where
 * `shallow` is the boundary commit oids when depth is set. `exclude` is a
 * set of oids already held (their whole closure is skipped).
 */
export function collectReachable(repo, tips, opts = {}) {
  const depth = opts.depth ?? null;
  const exclude = opts.exclude ?? null;
  const objects = new Map();
  const shallow = [];
  const seen = new Set();
  // What the client already holds. Without a depth limit the haves are a
  // hard cut: the full closure (parents included) is held. With `deepen`
  // the client is asking for more history *below* what it has, so the walk
  // must continue through the haves up to the depth — only the haves
  // themselves and their trees/blobs are held, never their parents.
  const traverseHeld = depth !== null;
  const heldSet = new Set();
  if (exclude) {
    const stack = [...exclude];
    while (stack.length) {
      const oid = stack.pop();
      if (heldSet.has(oid)) continue;
      const obj = getObject(repo, oid);
      if (!obj) continue;
      heldSet.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        if (c.tree) stack.push(c.tree);
        if (depth === null) for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) stack.push(target);
      }
    }
  }
  const isHeld = (oid) => heldSet.has(oid);
  // Commit generations first (breadth-first by generation).
  let frontier = [...new Set(tips)];
  let gen = 1;
  const commitOids = [];
  while (frontier.length) {
    const next = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      const obj = getObject(repo, oid);
      if (!obj) continue;
      seen.add(oid);
      const held = isHeld(oid);
      if (!held) {
        objects.set(oid, obj);
        commitOids.push(oid);
      }
      // Without a depth limit a held commit is a hard cut: do not walk past it.
      if (held && !traverseHeld) continue;
      if (obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) {
          const t = getObject(repo, target);
          if (t && t.type === 'commit') next.push(target);
        }
        continue;
      }
      if (obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      if (depth === null || gen < depth) {
        for (const p of c.parents) next.push(p);
      } else if (!held) {
        shallow.push(oid);
      }
    }
    frontier = [...new Set(next)];
    gen += 1;
    if (depth !== null && gen > depth) break;
  }
  // Trees and blobs of the collected commits (and tag targets).
  const stack = [];
  for (const oid of commitOids) {
    const obj = getObject(repo, oid);
    if (!obj) continue;
    if (obj.type === 'commit') stack.push(parseCommit(obj.data).tree);
    else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) stack.push(target);
    }
  }
  while (stack.length) {
    const oid = stack.pop();
    if (seen.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj) continue;
    seen.add(oid);
    if (isHeld(oid)) continue; // the client already has this tree/blob
    objects.set(oid, obj);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) stack.push(target);
    }
  }
  return { objects, shallow };
}

export function parseTagTarget(data) {
  const text = Buffer.from(data).toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return null;
}

export function parseTag(data) {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** True when `anc` is an ancestor of (or equal to) `desc`. */
export function isAncestor(repo, anc, desc) {
  if (anc === desc) return true;
  if (anc === ZERO_OID) return true;
  const seen = new Set();
  const stack = [desc];
  while (stack.length) {
    const oid = stack.pop();
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    } else if (obj.type === 'tag') {
      const t = parseTagTarget(obj.data);
      if (t) stack.push(t);
    }
  }
  return false;
}

/** A merge-base of a and b: the first common ancestor found breadth-first. */
export function mergeBase(repo, a, b) {
  if (a === b) return a;
  const ancA = new Set();
  const stackA = [a];
  while (stackA.length) {
    const oid = stackA.pop();
    if (ancA.has(oid)) continue;
    ancA.add(oid);
    const obj = getObject(repo, oid);
    if (obj?.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) stackA.push(p);
    }
  }
  const stackB = [b];
  const seenB = new Set();
  while (stackB.length) {
    const oid = stackB.shift();
    if (ancA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const obj = getObject(repo, oid);
    if (obj?.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) stackB.push(p);
    }
  }
  return null;
}

/** Changed paths between two trees: [{path, oldOid, newOid, status}]. */
export function diffTrees(repo, baseTreeOid, headTreeOid) {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map();
  const head = headTreeOid ? flattenTree(repo, headTreeOid) : new Map();
  const out = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, oldOid: b.oid, newOid: null, status: 'removed' });
    else if (!b && h) out.push({ path, oldOid: null, newOid: h.oid, status: 'added' });
    else if (b && h && b.oid !== h.oid) out.push({ path, oldOid: b.oid, newOid: h.oid, status: 'modified' });
  }
  return out;
}

/** A new root tree: `baseTreeOid` with `changes` applied (oid null deletes). */
export function applyTreeChanges(repo, baseTreeOid, changes) {
  const files = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map();
  for (const [path, oid] of changes) {
    if (oid === null) files.delete(path);
    else files.set(path, { oid, mode: '100644' });
  }
  return treeFromFiles(repo, files);
}

/** Resolve a path inside a tree: {type, oid, data} for a blob, or {type:'tree', oid}. */
export function resolveTreePath(repo, treeOid, path) {
  if (path === '' || path === '/') return { type: 'tree', oid: treeOid };
  const parts = path.split('/').filter((p) => p !== '');
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = getObject(repo, current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) {
      const target = getObject(repo, entry.oid);
      if (!target) return null;
      return { type: target.type, oid: entry.oid, data: target.data, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** List a directory inside a tree: [{type, name, path, oid, mode}]. */
export function listTreeDir(repo, treeOid, dirPath) {
  let current = treeOid;
  if (dirPath !== '' && dirPath !== '/') {
    const resolved = resolveTreePath(repo, treeOid, dirPath);
    if (!resolved || resolved.type !== 'tree') return null;
    current = resolved.oid;
  }
  const obj = getObject(repo, current);
  if (!obj || obj.type !== 'tree') return null;
  return parseTree(obj.data).map((e) => ({
    type: e.mode === '40000' ? 'dir' : 'file',
    name: e.name,
    path: dirPath === '' || dirPath === '/' ? e.name : `${dirPath.replace(/\/$/, '')}/${e.name}`,
    oid: e.oid,
    mode: e.mode,
  }));
}

/** Commits reachable from `tip`, newest first (parents after children). */
export function listCommits(repo, tip) {
  const out = [];
  const seen = new Set();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift();
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

/** The ref a branch name points at, or null. */
export function branchTip(repo, branch) {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}
