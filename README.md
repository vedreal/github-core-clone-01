# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/vedreal/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/vedreal/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, single-process GitHub-compatible git forge: one Node process serving git smart HTTP, REST v3, GraphQL and MCP from one in-memory store, with no dependencies, no git binary, no npm install and no outside service. Built for the make.fun bounty github-core-clone-01 ($500 prize).

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

---

Entered on [make.fun](https://make.fun/?ref=f2pdfak6&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards

## What it does

| Surface | Route | What it does |
| --- | --- | --- |
| Git smart HTTP | `/{owner}/{repo}.git/*` | clone / push / fetch over protocol v2 (ls-refs, fetch, shallow, deepen) and v0, plus receive-pack with fast-forward and report-status |
| REST v3 | `/api/v3/*` | repos, branches, commits, contents, issues, comments, labels, pull requests, git refs |
| GraphQL | `/api/graphql` | viewer / repository / node / issues / pull requests, the five mutations, introspection, batched operations |
| MCP | `/mcp` | JSON-RPC 2.0 Streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` (8 tools) |

Repository: **https://github.com/vedreal/github-core-clone-01**

## Run

```sh
# Node 22+ (the harness runs Node 22; developed and graded on Node 24.22.1)
MAKEFUN_ENV_URL=http://127.0.0.1:8080 \
MAKEFUN_SHOP_TOKEN=<token> \
node main.ts
```

`main.ts` is the harness lifecycle (kept verbatim from the kit): it binds an
ephemeral port, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`, then polls
`GET $MAKEFUN_ENV_URL/done` until the trial ends and exits 0. `GET /healthz`
answers `{"ok":true}` with no auth (the env's boot check).

Every API and git call carries `Authorization: Bearer <token>` where the
token is `MAKEFUN_SHOP_TOKEN`. A missing or wrong token is 401. The only
public endpoints are `GET /healthz`, `GET /api/v3/` and `GET /api/v3/meta`.
When the env token is empty (local dev), any non-empty Bearer token is
accepted.

## Layout

- `main.ts` — entry <-> env lifecycle (kit starter, verbatim).
- `app.ts` — the HTTP server: routing, auth gate, body limits, JSON replies.
- `store.ts` — the in-memory store: repos, git object model (commits, trees,
  blobs, tags), reachability with depth / have-cut, merge-base, tree diffs,
  and the deterministic logical clock (timestamps come from
  `MAKEFUN_TRIAL_NOW`, never the wall clock, so two runs on the same
  instance leave the same state export).
- `git.ts` — pkt-lines, pack read (full + OFS/REF deltas) and write, smart
  HTTP handlers (v2 ls-refs / fetch, v0 fetch, v0 receive-pack).
- `rest.ts` — REST v3 (see the table above).
- `graphql.ts` — hand-rolled GraphQL parser + executor, introspection for
  `Issue` / `PullRequest` / `Repository` / `SearchType`, opaque base64
  global ids.
- `mcp.ts` — MCP `server/discover` (protocol `2026-07-28` and older),
  `initialize`, and 8 tools acting on the same store as REST.
- `.makefun/owner.json` — the make.fun account wallet, so the entry can be
  submitted from the `vedreal` repository.

## Grade-local result

Run against the kit's sealed env directly (no docker on this machine):

- **120/120 conformance checks pass** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, GraphQL 20/20, MCP 15/15, protocol 5/5 — confirmed on two
  consecutive runs (2026-11-20).
- Performance: **125–164 / 200 points** depending on machine load
  (push p50 ≈ 0.66–0.85 s, clone p50 ≈ 0.22–0.27 s, read p50 ≈ 0.85–1.55 s,
  write p50 ≈ 0.09–0.29 s).

`node cli/makefun.mjs check` on the worktree: 6 passed
(`competition_open`, `snapshot`, `license_osi`, `entrypoint`, `entry_size`,
`committed_provider_key`); the remaining items are submission-time
(transcripts bundle, public repo, push, submit) — see `STATUS.md`.

## Notes on the scenario

The trial's viewer is fixed by the scenario seed: `adaiversen` (id 1000,
`adaiversen@example.invalid`). The forge knows this identity from the
public scenario seed, as the kit documents — the bearer token itself names
no login.
