```
    🔧
   /|\
  / | \
 /  |  \
/___🤖__\
```

# pi-tools

> Power tools for [pi](https://github.com/mariozechner/pi-coding-agent). Clone repos and tear them apart. Run autonomous background loops. Lease secrets safely. Bridge any MCP server with OAuth. Quit when you want to quit.

## Install

```bash
# install dependencies
curl -sL https://raw.githubusercontent.com/joelhooks/pi-tools/main/setup.sh | bash

# install extensions
pi install git:github.com/joelhooks/pi-tools
pi config  # enable/disable individual extensions
```

## Extensions

| Extension           | What                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `repo-autopsy` 🔬   | Clone GitHub repos, analyze them, and add active dependency source mirrors under `.agent_sources/`                              |
| `secrets` 🛡️        | Lease secrets with TTLs via [agent-secrets](https://github.com/joelhooks/agent-secrets) — status, revoke, audit, env generation |
| `mcp-bridge` 🌉     | Connect to any remote MCP server with OAuth — auto-registers tools into pi                                                      |
| `session-reader` 📖 | Flowing recall plus bounded Pi/Claude/Codex/Cursor/Grok/OpenCode transcript evidence                                            |
| `skill-shortcut` ⚡ | `$skill-name` autocomplete shortcut for `/skill:skill-name`                                                                     |
| `aliases` 🚪        | `/quit` and `/q` → `/exit`                                                                                                      |
| `linear-tracker` 🔒 | Resolve project-local issue tracker policy and safely publish Linear issues with verified readback                              |
| `shortlink-qr` 🔗   | Create joel.dev shortlinks, generate HiDPI QR PNG/SVG assets, push via ShitRat, and record local Brain resources                |

The herdr turn-ping extension and wait CLI now live in [joelhooks/herdr-pings](https://github.com/joelhooks/herdr-pings).

## repo-autopsy

Repo analysis tools clone into `~/.repo-autopsy` for cacheable inspection. `repo_add_source` additionally copies a repo into the current project under `.agent_sources/github.com/<owner>/<repo>` with `.agent-source.json` metadata, so agents can inspect active dependency source alongside project code.

Tools: `repo_clone`, `repo_structure`, `repo_search`, `repo_ast`, `repo_deps`, `repo_hotspots`, `repo_file`, `repo_blame`, `repo_stats`, `repo_exports`, `repo_find`, `repo_cleanup`, `repo_add_source`

This repo keeps the current Pi source mirrored at `.agent_sources/github.com/earendil-works/pi-mono` for SDK receipts.

## linear-tracker

Project-local issue tracker resolver for agents that want to publish PRDs/issues. Linear is only allowed when local policy says Linear, a team association exists, and auth is available. Global MCP/auth is capability, not routing.

Tools:

- `linear_tracker_resolve` — reads nearest project policy and returns `linear_direct`, `linear_mcp`, `payload_only`, `not_linear`, or `unknown`
- `linear_tracker_create_issue` — creates one Linear issue via direct API auth and verifies readback
- `linear_tracker_create_issues` — creates dependency-ordered issue batches and verifies each created issue
- `linear_tracker_get_issue` — fetches an issue for readback verification

Policy lives in `AGENTS.md`, `CLAUDE.md`, `docs/agents/issue-tracker.md`, or `.pi/settings.json`.

## session-reader

`session-reader` separates semantic recall from raw evidence. `flowing_recall` returns the canonical reflection, observation, and curated-page lanes. Native adapters then read bounded Pi, Claude, Codex, Cursor, Grok, and OpenCode sessions only when exact transcript evidence is needed. `joelclaw` owns flowing recall; native transcript stores remain immutable evidence.

Use `/skill:session-search` for the operating workflow.

Primary Pi tools:

- `flowing_recall` — explicit project/workstream recall with three separate lanes
- `session_search` — compatibility-only search for explicit native evidence, never semantic recall
- `session_capture_status` — verify native adapters and Pi/Claude/Codex delivery state
- `session_context` — bounded extraction for a session id or transcript path
- `session_inspect` — deterministic line inspection around a regex
- `session_expand` — bounded opaque-cursor continuation
- `session_chunks` — compact chunk search with safety caps

The read-only surface is available through MCP. Executor is the preferred catalog and Code Mode owner. Pi calls one `executor_execute` tool. Executor starts with recall. Native evidence search requires the signed receipt from that successful recall.

`pi-session-recall-mcp-http` serves Streamable HTTP for Executor. It:

- binds only to `127.0.0.1`;
- requires a bearer token of at least 32 bytes;
- returns no query or body data from `/healthz`;
- creates a stateless MCP transport for each request;
- exposes only read-only, idempotent tools.

```bash
SESSION_RECALL_MCP_TOKEN="$(secrets lease session_recall_mcp_bearer_token --ttl 1h)" \
  pi-session-recall-mcp-http
```

After adding `session_recall_mcp_bearer_token` to agent-secrets, install the user LaunchAgent from a clean release:

```bash
session-reader/install-executor-memory-service.sh install /absolute/path/to/clean/pi-tools-release
curl --fail --silent http://127.0.0.1:4792/healthz
```

Register `http://127.0.0.1:4792/mcp` as a remote Streamable HTTP integration in Executor. Use Executor's credential handoff for the `Authorization: Bearer` value. Never put the token in a prompt, shell argv, source file, shared MCP config, or Executor integration metadata.

`pi-session-recall-mcp` remains the stdio rollback path. Do not run both transports as active catalog owners.

MCP tools: `recall`, `drill_down_session_evidence`, `inspect_session`, `expand_session`, `session_context`, `drill_down_session_chunks`, and `capture_status`.

`recall` requires an exact persisted project/workstream scope and returns a process-bound evidence receipt. The two drill-down tools reject calls without a valid receipt, cap native scans at 200 files, and never act as initial memory search.

Still removed:

- background reader-agent spawning

The native reader stays local-only because the current `joelclaw sessions` CLI accepts query text only in argv. Do not route private search text through that contract. Flowing recall uses the typed stdin request boundary.

Pi `session_chunks` wrapper safety defaults:

- defaults to `limit: 5`, `context_before: 0`, `context_after: 0`
- caps requests at `limit: 10` and context `2` unless `allow_large_output: true`
- returns compact markdown by default; raw JSON requires `compact: false` plus `allow_large_output: true`
- excludes current-session matches by default when Pi exposes the current session id/file; pass `exclude_current: false` to include them intentionally

Use direct `joelclaw session chunks` only when you really want the raw CLI behavior.

## mcp-bridge

Connect to any remote MCP server that supports OAuth. Tools are auto-discovered and registered into pi, prefixed by server name.

```bash
# Add a server
/mcp-add notion https://mcp.notion.com/mcp
/mcp-add linear https://mcp.linear.app/mcp

# Authenticate (opens browser)
/mcp-login notion

# Check status
/mcp-list

# Reconnect after restart (auto on session start)
/mcp-reconnect

# Remove
/mcp-remove notion
```

Commands: `/mcp-add`, `/mcp-remove`, `/mcp-login`, `/mcp-logout`, `/mcp-list`, `/mcp-reconnect`

Tool: `mcp_status`

Bridge metadata is stored in `~/.pi/mcp-bridge/` (OAuth client registrations, cached tokens, PKCE verifiers). OAuth tokens are also written to Pi's native MCP auth path at `~/.pi/agent/mcp-oauth/<name>/tokens.json` so Pi-compatible flows can reuse them. Tools from each server are registered as `<name>_<tool>` (e.g., `notion_search`, `notion_update_block`).

On session start, auto-connects to all servers with saved tokens. If tokens are expired or invalid, the bridge clears stale credentials and shows a status warning — run `/mcp-login <name>` to re-auth.

Requires `@modelcontextprotocol/sdk` (installed by `setup.sh`).

## shortlink-qr

Create stage/demo shortlinks with QR assets and a local Brain resource entry.

```ts
shortlink_qr({
  slug: "cascadia-viv",
  url: "https://x.com/Vtrivedy10/status/2031408954517971368",
  title: "Viv harness engineering article",
  push: true,
  background: "transparent",
});
```

Outputs:

- friendly `https://joel.dev/<slug>` shortlink
- native 1500×1500 QR PNG and SVG under `resources/qr/`
- PNG copied to the macOS clipboard
- optional ShitRat commit to `joelhooks/joel-dev-link-shortener`
- `.brain/resources/shortlinks.svx` resource-list entry with a pi-notes/portless URL when available

Backgrounds: `transparent` (default), `white`, or `black` (white QR code on black).

Command shortcut:

```bash
/shortlink-qr cascadia-viv https://example.com
```

## secrets

Lease credentials safely with TTLs. No env files committed, no plaintext on disk.

```
Use secrets_lease to get the slack_bot_token with a 30 minute TTL
```

Tools: `secrets_lease`, `secrets_status`, `secrets_revoke`, `secrets_audit`, `secrets_env`

Requires [agent-secrets](https://github.com/joelhooks/agent-secrets) daemon running.

## License

MIT
