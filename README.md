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

| Extension | What |
|-----------|------|
| `repo-autopsy` 🔬 | Clone GitHub repos, analyze them, and add active dependency source mirrors under `.agent_sources/` |
| `secrets` 🛡️ | Lease secrets with TTLs via [agent-secrets](https://github.com/joelhooks/agent-secrets) — status, revoke, audit, env generation |
| `mcp-bridge` 🌉 | Connect to any remote MCP server with OAuth — auto-registers tools into pi |
| `session-reader` 📖 | Pi/Claude/Codex session recovery: joelclaw pointers first, local transcript receipts second |
| `skill-shortcut` ⚡ | `$skill-name` autocomplete shortcut for `/skill:skill-name` |
| `aliases` 🚪 | `/quit` and `/q` → `/exit` |
| `linear-tracker` 🔒 | Resolve project-local issue tracker policy and safely publish Linear issues with verified readback |

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

`session-reader` is Pi-first session recovery. It asks `joelclaw session` for cross-machine/index pointers, then digs into local Pi/Claude/Codex JSONL transcripts for details when available. `joelclaw` is the backplane and backup; local transcript files are still the source of truth.

Use `/skill:session-search` for the operating workflow.

Primary tools:

- `session_search` — search joelclaw pointers, then local transcript details
- `session_capture_status` — verify Pi/Claude/Codex capture state on this machine
- `session_context` — bounded extraction for a session id or transcript path
- `session_inspect` — deterministic line inspection around a regex
- `session_chunks` — compact chunk search with safety caps

Still removed:

- background reader-agent spawning

Use the CLI directly when possible:

```bash
joelclaw session search "<query>" --source both --machine "$(hostname -s)" --limit 5 --extract
joelclaw session extract <session-id-or-path> --query "<topic>" --format markdown
joelclaw session inspect <session-id-or-path> --around "<regex>" --before 20 --after 80
joelclaw session chunks "<query>" --source local --machine "$(hostname -s)" --limit 5 --context-before 0 --context-after 0
```

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

## secrets

Lease credentials safely with TTLs. No env files committed, no plaintext on disk.

```
Use secrets_lease to get the slack_bot_token with a 30 minute TTL
```

Tools: `secrets_lease`, `secrets_status`, `secrets_revoke`, `secrets_audit`, `secrets_env`

Requires [agent-secrets](https://github.com/joelhooks/agent-secrets) daemon running.

## License

MIT
