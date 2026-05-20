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
| `repo-autopsy` 🔬 | Clone GitHub repos and analyze them — ripgrep, ast-grep, deps, hotspots, blame, tokei stats |
| `ralph-loop` 🔁 | Autonomous coding loops via pi background workers — PRD-driven stories or free-form prompt loops with progress reporting |
| `agent-secrets` 🛡️ | Lease secrets with TTLs via [agent-secrets](https://github.com/joelhooks/agent-secrets) — status, revoke, audit, env generation |
| `mcp-bridge` 🌉 | Connect to any remote MCP server with OAuth — auto-registers tools into pi |
| `session-reader` 📖 | Deprecated compatibility shortcuts for `joelclaw session` recovery. `joelclaw session` owns search, extraction, inspect, and chunks |
| `skill-shortcut` ⚡ | `$skill-name` autocomplete shortcut for `/skill:skill-name` |
| `aliases` 🚪 | `/quit` and `/q` → `/exit` |
| `linear-tracker` 🔒 | Resolve project-local issue tracker policy and safely publish Linear issues with verified readback |

## linear-tracker

Project-local issue tracker resolver for agents that want to publish PRDs/issues. Linear is only allowed when local policy says Linear, a team association exists, and auth is available. Global MCP/auth is capability, not routing.

Tools:
- `linear_tracker_resolve` — reads nearest project policy and returns `linear_direct`, `linear_mcp`, `payload_only`, `not_linear`, or `unknown`
- `linear_tracker_create_issue` — creates one Linear issue via direct API auth and verifies readback
- `linear_tracker_create_issues` — creates dependency-ordered issue batches and verifies each created issue
- `linear_tracker_get_issue` — fetches an issue for readback verification

Policy lives in `AGENTS.md`, `CLAUDE.md`, `docs/agents/issue-tracker.md`, or `.pi/settings.json`.

## session-reader

`session-reader` is now a thin compatibility wrapper. Session recovery is owned by `joelclaw session`, and this extension only presents Pi tool shortcuts for `search --extract`, `extract`, `inspect`, and `chunks`.

Deprecated behavior removed:

- no direct raw JSONL parsing
- no local Typesense probing
- no background reader-agent spawning

Use the CLI directly when possible:

```bash
joelclaw session search "<query>" --source both --machine "$(hostname -s)" --limit 5 --extract
joelclaw session extract <session-id-or-path> --query "<topic>" --format markdown
joelclaw session inspect <session-id-or-path> --around "<regex>" --before 20 --after 80
joelclaw session chunks "<query>" --source local --machine "$(hostname -s)" --limit 20
```

## ralph-loop

Two modes:

**PRD mode** — reads `prd.json` in the working directory, picks stories by priority, spawns background pi workers to implement each one. Marks stories as done when they pass. Reports each iteration back to pi.

```
Use ralph_loop in prd mode to implement the stories in this project
```

**Prompt mode** — runs a prompt repeatedly up to N iterations. Each iteration is a fresh worker session.

```
Use ralph_loop in prompt mode with "Run the tests and fix any failures" for 5 iterations
```

Progress appears as messages in your pi session. Use `ralph_jobs` to check status or cancel.

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

## agent-secrets

Lease credentials safely with TTLs. No env files committed, no plaintext on disk.

```
Use secrets_lease to get the slack_bot_token with a 30 minute TTL
```

Tools: `secrets_lease`, `secrets_status`, `secrets_revoke`, `secrets_audit`, `secrets_env`

Requires [agent-secrets](https://github.com/joelhooks/agent-secrets) daemon running.

## License

MIT
