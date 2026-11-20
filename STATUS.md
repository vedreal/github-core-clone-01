# STATUS — github-core-clone-01 (make.fun, @f-alamsyah / vedreal)

## Verdict: READY TO SUBMIT (code complete; submission is the coordinator's step)

- **Built:** yes — a real working forge, not a skeleton.
- **Blocked:** no. The earlier blocker (GitHub not linked to @f-alamsyah) is
  **cleared**: verified live via `GET /api/me` on 2026-11-20, `github_login`
  is `vedreal`.
- **Submitted:** no — **do not submit from here**. The coordinator handles
  submission.

## Intended repo

- Owner: **vedreal** — https://github.com/vedreal (11 public repos,
  created 2025-11-17, verified via GitHub API; linked to @f-alamsyah).
- Repo name: the bounty slug, `github-core-clone-01`.
- Intended URL: **https://github.com/vedreal/github-core-clone-01**
- Prize $500 (20 paid places: $100 / $70 / $50 / $20×7 / $14×10).
  Entries close **2026-11-21T06:30:00Z** (Sat 21 Nov 13:30 WIB).

## Files ready (in this directory)

| File | What it is |
| --- | --- |
| `main.ts` | Entry <-> env lifecycle (kit starter, verbatim) |
| `app.ts` | HTTP server: routing, auth gate, JSON replies |
| `store.ts` | In-memory store, git object model, deterministic clock |
| `git.ts` | pkt-lines, packs (full + OFS/REF deltas), smart HTTP v2/v0 |
| `rest.ts` | REST v3: repos, branches, commits, contents, issues, labels, pulls |
| `graphql.ts` | Hand-rolled GraphQL parser/executor + introspection + mutations |
| `mcp.ts` | MCP `server/discover` / `initialize` / 8 tools |
| `package.json`, `tsconfig.json` | Kit starter (Node 22, stdlib only, no deps) |
| `LICENSE` | MIT |
| `README.md` | Project readme with run instructions and results |
| `.makefun/owner.json` | Account wallet `ApPTBAszEh5yp1NACphvdzwXcZjQanWBEsrZCyeq5ppz` |

Total: 13 files, ~132 KiB — well within the 16 MiB total / 8 MiB per-file caps.

## Grade-local result (sealed env run directly; no docker on this machine)

Run 1 (2026-11-20): **111/120** conformance, 164/200 perf.
Run 2 (2026-11-20, after two fixes): **120/120** conformance, 125/200 perf.
Run 3 (2026-11-20, confirmation): **120/120** conformance, 135/200 perf.

| Group | Result |
| --- | --- |
| git | 30/30 |
| repos | 15/15 |
| issues | 15/15 |
| pulls | 20/20 |
| graphql | 20/20 |
| mcp | 15/15 |
| protocol | 5/5 |

Perf varies with machine load (a sibling build was running concurrently):
push p50 0.66–0.85 s, clone p50 0.22–0.27 s, read p50 0.85–1.55 s,
write p50 0.09–0.29 s. The forge exits 0 cleanly after the env says done.

### Fixes between run 1 and run 2

1. **v2 ls-refs args were not trimmed** — request lines end in `\n`, so
   `'peel\n'` never matched `'peel'` and `ref-prefix refs/heads/\n` matched
   nothing. This broke `git.ls-refs`, `git.ls-refs-prefix`,
   `git.push-first-commit` (HEAD symref), `git.clone-annotated-tag`
   (peel) and the four GraphQL pull-request checks (their git fixture
   could not see `main`).
2. **Deepen fetches cut traversal at haves** — `deepen 2` after a depth-1
   shallow clone delivered nothing. With a depth limit the walk now
   continues through haves up to the depth (only haves + their trees/blobs
   are withheld); without a depth limit the haves remain a hard cut, so
   incremental fetches still never re-send held objects.

## `makefun.mjs check` on the worktree (2026-11-20)

- **Pass (6):** `competition_open`, `snapshot`, `license_osi`,
  `entrypoint`, `entry_size`, `committed_provider_key`.
- **Fail (1):** `transcripts_present` — no transcripts bundle supplied;
  the coordinator must bundle the agent sessions that built this entry
  (`bundle --repo … --system-prompt … --effort …`) and sign the entry
  message over them at submission.
- **At submission (5):** `repo_public`, `repo_owner`, `repo_created_after_open`,
  `commit_in_repo`, `duplicate_snapshot` — all need the real GitHub repo.

## What kang / the coordinator still needs to do

1. Create the repo **vedreal/github-core-clone-01** (public, created after
   2026-11-14T06:30:00Z). The kit suggests starting its history with
   `node <kit>/cli/makefun.mjs init --license MIT --keypair <keypair file>`
   for the drand-anchor first commit, then committing this work on top.
2. Push this code to it (including `.makefun/owner.json`).
3. Bundle the transcripts for this build and submit the pushed commit's SHA
   before **2026-11-21T06:30:00Z** (Sat 21 Nov 13:30 WIB).

## What is NOT implemented / known limits

- Packs sent by the forge carry full objects only (no deltas); the
  `git.pack-deltas` check passes with 0 deltas, and the pack reader
  handles OFS/REF deltas if a client ever sends them.
- No persistence: state lives in memory for one trial, as the spec requires.
- No UI, no outside service, no git binary — by design.
