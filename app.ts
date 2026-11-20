// The forge's HTTP server: one process, one in-memory store, four surfaces.
//
//   GET  /healthz                              200 {"ok":true}, no auth
//   /{owner}/{repo}.git/*                      git smart HTTP (see git.ts)
//   /api/v3/*                                  REST v3 (see rest.ts)
//   POST /api/graphql                          GraphQL (see graphql.ts)
//   POST /mcp                                  MCP (see mcp.ts)
//
// Auth: every API and git call carries `Authorization: Bearer <token>` where
// the token is MAKEFUN_SHOP_TOKEN. A missing or wrong token is 401. The
// only exceptions are GET /healthz (the env's boot check) and the two
// public discovery endpoints GET /api/v3/ and GET /api/v3/meta. When the env
// token is empty (local dev), any non-empty Bearer token is accepted.

import http from 'node:http';
import { VIEWER_LOGIN, nextReqId } from './store.ts';
import { handleRest, unauthorized } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  handleInfoRefs,
  handleUploadPack,
  handleReceivePack,
  gitRepo,
} from './git.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function envToken() {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authorized(req, res) {
  const token = envToken();
  const header = req.headers.authorization ?? '';
  if (token === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === `Bearer ${token}`;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const headers = {
    'content-type': 'application/json',
    'x-github-request-id': nextReqId(),
    ...extraHeaders,
  };
  if (body === null || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  headers['content-length'] = Buffer.byteLength(text);
  res.writeHead(status, headers);
  res.end(text);
}

function sendBuffer(res, status, contentType, body, extraHeaders = {}) {
  const headers = { 'content-type': contentType, 'x-github-request-id': nextReqId(), ...extraHeaders };
  if (body && body.length) headers['content-length'] = body.length;
  res.writeHead(status, headers);
  res.end(body ?? Buffer.alloc(0));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw) {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}

export function createApp() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const method = (req.method ?? 'GET').toUpperCase();
      const segments = url.pathname.split('/').filter((s) => s !== '');

      if (method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Public discovery endpoints (the starter treats them as public).
      if (
        method === 'GET' &&
        ((segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') ||
          (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta'))
      ) {
        const restReq = {
          method,
          segments: segments.slice(2),
          query: Object.fromEntries(url.searchParams.entries()),
          body: null,
          absoluteUrl: () => url.toString(),
        };
        const result = handleRest(restReq);
        sendJson(res, result.status, result.body, result.headers ?? {});
        return;
      }

      if (!authorized(req, res)) {
        const err = unauthorized();
        sendJson(res, err.status, err.body);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
      if (segments.length >= 3 && segments[1].endsWith('.git')) {
        const owner = decodeURIComponent(segments[0]);
        const repoName = decodeURIComponent(segments[1].slice(0, -'.git'.length));
        const action = segments.slice(2).join('/');
        if (owner !== VIEWER_LOGIN) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const repo = gitRepo(owner, repoName);
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const service = url.searchParams.get('service') ?? '';
        const gitProtocol = req.headers['git-protocol'];
        if (method === 'GET' && action === 'info/refs' && (service === 'git-upload-pack' || service === 'git-receive-pack')) {
          const result = handleInfoRefs(repo, service, gitProtocol);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
        if (method === 'POST' && action === 'git-upload-pack') {
          const raw = await readBody(req);
          const result = handleUploadPack(repo, raw, gitProtocol);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
        if (method === 'POST' && action === 'git-receive-pack') {
          const raw = await readBody(req);
          const result = handleReceivePack(repo, raw);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // GraphQL.
      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql' && method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Request body is not valid JSON' });
          return;
        }
        const result = handleGraphQL(parsed.value);
        sendJson(res, result.status, result.body);
        return;
      }

      // MCP.
      if (segments.length === 1 && segments[0] === 'mcp' && method === 'POST') {
        const raw = await readBody(req);
        const result = handleMcp(raw.toString('utf8'));
        if (result.body === null) {
          res.writeHead(result.status, { 'x-github-request-id': nextReqId() });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      // REST v3.
      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        const raw = await readBody(req);
        let body = null;
        if (raw.length > 0) {
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Request body is not valid JSON' });
            return;
          }
          body = parsed.value;
        }
        const restReq = {
          method,
          segments: segments.slice(2),
          query: Object.fromEntries(url.searchParams.entries()),
          body,
          absoluteUrl: () => url.toString(),
        };
        const result = handleRest(restReq);
        if (result === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, result.status, result.body, result.headers ?? {});
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      process.stderr.write(`[forge] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    }
  });
}
