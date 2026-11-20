// Git smart HTTP, implemented from scratch on node:zlib / node:crypto.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   (v2 when the
//        client asks Git-Protocol: version=2, else v0)
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  (v0 only)
//   POST /{owner}/{repo}.git/git-upload-pack                     (v2 ls-refs /
//        fetch, or v0 fetch when no Git-Protocol header)
//   POST /{owner}/{repo}.git/git-receive-pack                    (v0 only)
//
// Packs carry full objects only (no deltas); the client never sends deltas
// either, but receive-pack resolves REF_DELTA / OFS_DELTA if it meets one.

import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  DEFAULT_BRANCH,
  getRepo,
  getObject,
  putObject,
  parseCommit,
  parseTree,
  parseTag,
  parseTagTarget,
  collectReachable,
  isAncestor,
  sha1Hex,
  hashObject,
} from './store.ts';

const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const AGENT = 'github-forge/1.0';
const PKT_MAX = 65520;

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}
export const pktFlush = () => Buffer.from('0000', 'ascii');
export const pktDelim = () => Buffer.from('0001', 'ascii');

export function pktLines(items) {
  const parts = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Parse a pkt-line stream into [{kind:'data',payload}|{kind:'flush'}|{kind:'delim'}]. */
export function decodePktLines(buf) {
  const out = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = Number.parseInt(buf.toString('ascii', off, off + 4), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      out.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/** The data lines of a pkt-line stream, as strings. */
export function pktTextLines(buf) {
  const lines = [];
  for (const p of decodePktLines(buf)) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------

function packObjectHeader(type, size) {
  const code = TYPE_CODE[type];
  const bytes = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile (version 2, full objects, SHA-1 trailer). */
export function writePack(objects) {
  const list = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

function readVarintSize(buffer, start) {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer, start) {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer, offset) {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true });
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base, delta) {
  const baseBuf = Buffer.from(base);
  const d = Buffer.from(delta);
  let off = 0;
  const readSize = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = d[off++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuf.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < d.length) {
    const op = d[off++];
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOff += d[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += d[off++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      baseBuf.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      d.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a packfile into a Map oid -> {type, data}; resolves deltas. */
export function readPack(pack, resolveBase) {
  const buffer = Buffer.from(pack);
  if (buffer.length < 32) throw new Error('pack too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  if (trailer !== sha1Hex(buffer.subarray(0, trailerStart))) throw new Error('pack trailer checksum mismatch');
  const raw = [];
  const byOffset = new Map();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry = { offset: entryOffset, typeCode, size: header.size, data: null };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map();
  const resolve = (entry, seen = new Set()) => {
    if (entry.oid) return entry;
    if (seen.has(entry.offset)) throw new Error('delta cycle');
    seen.add(entry.offset);
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base = null;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (!baseEntry) throw new Error('ofs-delta base missing');
        base = resolve(baseEntry, seen);
      } else {
        base = objects.get(entry.baseOid) ?? (resolveBase ? resolveBase(entry.baseOid) : null);
        if (!base) throw new Error('ref-delta base missing');
      }
      const data = applyDelta(base.data, entry.data);
      entry.resolvedType = base.type;
      entry.data = data;
      entry.oid = hashObject(base.type, data);
    } else {
      entry.resolvedType = CODE_TYPE[entry.typeCode];
      entry.oid = hashObject(entry.resolvedType, entry.data);
    }
    objects.set(entry.oid, { type: entry.resolvedType, data: entry.data });
    return entry;
  };
  for (const entry of raw) resolve(entry);
  return objects;
}

// ---------------------------------------------------------------------------
// ref advertisement
// ---------------------------------------------------------------------------

function sortedRefs(repo) {
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return refs;
}

function peeledOid(repo, oid) {
  const obj = getObject(repo, oid);
  if (!obj) return null;
  if (obj.type === 'tag') return parseTagTarget(obj.data);
  return null;
}

/** The v2 capability advertisement body. */
function v2Advertisement() {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow thin-pack ofs-delta filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The v0 ref advertisement body for `service`, with capabilities on the first line. */
function v0Advertisement(repo, service) {
  const caps =
    service === 'git-receive-pack'
      ? `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1`
      : `side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT} object-format=sha1`;
  const lines = [pktLine(`# service=${service}\n`), pktFlush()];
  const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const emit = (text) => {
      if (first) {
        lines.push(pktLine(`${text}\0${caps}\n`));
        first = false;
      } else {
        lines.push(pktLine(`${text}\n`));
      }
    };
    emit(`${headTip} HEAD`);
    for (const [name, oid] of refs) {
      emit(`${oid} ${name}`);
      const peeled = peeledOid(repo, oid);
      if (peeled) lines.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

/** Sideband-framed bytes: split `data` into band-1 pkt-lines (max 64k each). */
function sideband(data) {
  const parts = [];
  const CHUNK = PKT_MAX - 5;
  for (let off = 0; off < data.length; off += CHUNK) {
    const chunk = data.subarray(off, Math.min(data.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// handlers: each returns {status, contentType, body} or null when no repo
// ---------------------------------------------------------------------------

export function handleInfoRefs(repo, service, gitProtocol) {
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(repo, service),
  };
}

function v2LsRefs(repo, args) {
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const keep = (name) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines = [];
  const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (keep('HEAD')) {
    if (headTip) lines.push(`${headTip} HEAD${wantSymrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : ''}\n`);
    else if (wantUnborn) lines.push(`unborn HEAD${wantSymrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : ''}\n`);
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (wantPeel) {
      const peeled = peeledOid(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines);
}

function v2Fetch(repo, args) {
  const wants = [];
  const haves = [];
  const shallows = [];
  let depth = null;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallows.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = Number.parseInt(a.slice(7).trim(), 10);
  }
  return buildFetch(repo, wants, haves, shallows, depth, 2);
}

function v0Fetch(repo, lines) {
  const wants = [];
  const haves = [];
  const shallows = [];
  let depth = null;
  let section = 0;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === '') continue;
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('shallow ')) shallows.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text === 'done') section = 1;
  }
  return buildFetch(repo, wants, haves, shallows, depth, 0);
}

/**
 * Build an upload-pack fetch response. `protocol` 2 = sectioned v2, 0 = v0
 * sideband with NAK/shallow lines. Returns a Buffer body.
 */
function buildFetch(repo, wants, haves, shallows, depth, protocol) {
  const validWants = wants.filter((w) => getObject(repo, w));
  const { objects, shallow: newShallow } = collectReachable(repo, validWants, {
    depth,
    exclude: haves.length ? new Set(haves) : null,
  });
  const unshallow = shallows.filter((s) => !newShallow.includes(s) && collectReachable(repo, validWants, { depth }).objects.has(s));
  const out = [];
  if (protocol === 2) {
    if (haves.length) {
      out.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
    }
    if (depth !== null || shallows.length) {
      out.push(pktLine('shallow-info\n'));
      for (const s of newShallow) out.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) out.push(pktLine(`unshallow ${s}\n`));
      out.push(pktDelim());
    }
    if (objects.size) {
      out.push(pktLine('packfile\n'));
      const pack = writePack([...objects.entries()].map(([oid, obj]) => ({ oid, type: obj.type, data: obj.data })));
      out.push(sideband(pack));
      out.push(pktFlush());
    } else {
      out.push(pktFlush());
    }
    return Buffer.concat(out);
  }
  // v0
  out.push(pktLine('NAK\n'));
  for (const s of newShallow) out.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) out.push(pktLine(`unshallow ${s}\n`));
  if (objects.size) {
    const pack = writePack([...objects.entries()].map(([oid, obj]) => ({ oid, type: obj.type, data: obj.data })));
    out.push(sideband(pack));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

export function handleUploadPack(repo, body, gitProtocol) {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.from('bad pkt-line\n', 'utf8') };
  }
  // Every request line ends with \n; trim it, or 'peel' / 'ref-prefix <p>'
  // would never match (the ls-refs symref/peel/prefix failures).
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').trim());
  if (gitProtocol === 'version=2') {
    const command = (lines[0] ?? '').trim();
    const args = lines.slice(1);
    if (command === 'command=ls-refs') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2LsRefs(repo, args) };
    }
    if (command === 'command=fetch') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2Fetch(repo, args) };
    }
    return { status: 400, contentType: 'application/x-git-upload-pack-result', body: pktLines(['ERR unknown command\n', 'flush']) };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0Fetch(repo, lines) };
}

export function handleReceivePack(repo, body) {
  // Split the command pkt-lines (up to the first flush) from the pack bytes.
  let off = 0;
  const commands = [];
  let packStart = body.length;
  try {
    while (off + 4 <= body.length) {
      const len = Number.parseInt(body.toString('ascii', off, off + 4), 16);
      if (Number.isNaN(len)) throw new Error('bad pkt-line');
      if (len === 0) {
        packStart = off + 4;
        break;
      }
      if (len < 4 || off + len > body.length) throw new Error('truncated pkt-line');
      commands.push(body.toString('utf8', off + 4, off + len));
      off += len;
    }
  } catch {
    return { status: 400, contentType: 'application/x-git-receive-pack-result', body: Buffer.from('bad pkt-line\n', 'utf8') };
  }
  const parsed = [];
  for (let i = 0; i < commands.length; i += 1) {
    const line = commands[i].replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const caps = nul >= 0 ? line.slice(nul + 1) : '';
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    parsed.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2], caps: i === 0 ? caps : '' });
  }
  const sidebandCap = parsed.length > 0 && parsed[0].caps.split(' ').includes('side-band-64k');
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  let newObjects = new Map();
  const needsPack = parsed.some((c) => c.newOid !== ZERO_OID);
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error: missing pack';
    } else {
      try {
        newObjects = readPack(packBytes, (oid) => getObject(repo, oid) ?? null);
      } catch (err) {
        unpackOk = false;
        unpackDetail = `unpacker error: ${err.message}`;
      }
    }
  }
  const report = [];
  if (unpackOk) {
    for (const [oid, obj] of newObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  for (const cmd of parsed) {
    const current = repo.refs.get(cmd.ref);
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack failed';
    } else if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === undefined) reason = 'non-fast-forward';
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) reason = 'non-fast-forward';
      else ok = true;
    } else if (cmd.oldOid === ZERO_OID) {
      // create
      if (current !== undefined) reason = 'non-fast-forward';
      else if (!getObject(repo, cmd.newOid)) reason = 'non-fast-forward';
      else ok = true;
    } else {
      // update: old must match, new must be a descendant (or a tag whose target is)
      if (current === undefined || current !== cmd.oldOid) reason = 'non-fast-forward';
      else {
        const obj = getObject(repo, cmd.newOid);
        if (!obj) reason = 'non-fast-forward';
        else if (obj.type === 'commit' && isAncestor(repo, cmd.oldOid, cmd.newOid)) ok = true;
        else if (obj.type === 'tag') ok = true;
        else reason = 'non-fast-forward';
      }
    }
    if (ok) {
      if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
      else repo.refs.set(cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}\n`);
    } else {
      report.push(`ng ${cmd.ref} ${reason || 'non-fast-forward'}\n`);
    }
  }
  const reportLines = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`, ...report, 'flush'];
  const reportBytes = pktLines(reportLines);
  let out;
  if (sidebandCap) {
    out = Buffer.concat([sideband(reportBytes), pktFlush()]);
  } else {
    out = reportBytes;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: out };
}

/** Look a repository up for a git route; null when it does not exist. */
export function gitRepo(owner, name) {
  return getRepo(owner, name);
}
