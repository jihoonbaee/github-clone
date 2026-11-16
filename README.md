# github-core-clone-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jihoonbaee/github-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jihoonbaee/github-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible forge built from scratch for the make.fun
`github-core-clone-01` bounty — no git binary, no external dependencies,
Node 22 standard library only.

## What it serves

- **Git smart HTTP** — `upload-pack` protocol v2 (`ls-refs`, `fetch` with
  shallow/deepen) and v0, `receive-pack` v0 with report-status. Packfiles are
  read (OFS_DELTA and REF_DELTA resolution included) and written here; objects
  live in an in-memory store.
- **REST API v3** — repositories, refs, commits, contents, labels, issues,
  pull requests (with squash merge and three-way conflict detection),
  comments, and `Link`-header pagination.
- **GraphQL v4** — a small parser and executor: `viewer`, `repository`,
  `node`, `__type` introspection, issue/PR connections with cursor
  pagination, and the create/close/merge/comment mutations.
- **MCP** — JSON-RPC 2.0 Streamable HTTP at `POST /mcp`, modern era
  (`server/discover`, revision 2026-07-28) with the legacy `initialize`
  handshake as a fallback; six tools over the same store.

## Running

```sh
node main.ts            # local dev: listens on $PORT (default 8080)
```

In a trial, `MAKEFUN_ENV_URL` is set and `main.ts` binds port 0, registers
the port with the environment, and serves until the environment reports the
trial done. `MAKEFUN_SHOP_TOKEN` is the bearer token REST/GraphQL/MCP
require; `MAKEFUN_TRIAL_NOW` freezes the clock all timestamps derive from
(the forge never reads a live clock for state).

## Layout

- `main.ts` — lifecycle (bind, register, poll `/done`).
- `app.ts` — HTTP server, routing, authentication.
- `src/gitobj.ts` — git objects: hashing, commit/tree/tag, packfiles, deltas.
- `src/store.ts` — in-memory repositories, graph walks, tree diffs, merges.
- `src/git-http.ts` — smart HTTP: advertisements, upload-pack, receive-pack.
- `src/rest.ts` — REST v3 handlers.
- `src/graphql.ts` — GraphQL parser and executor.
- `src/mcp.ts` — MCP JSON-RPC handlers and tools.

## License

MIT — see `LICENSE`.
