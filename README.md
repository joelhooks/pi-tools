```
    🔧
   /|\ 
  / | \
 /  |  \
/___🤖__\
```

# pi-tools

> Power tools for [pi](https://github.com/mariozechner/pi-coding-agent). Clone repos and tear them apart. Type-check with the TypeScript 7 native compiler. Farm work out to Codex in background loops. Lease secrets safely. Quit when you want to quit.

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
| `ts-check` ⚡ | TypeScript diagnostics + intelligence via tsgo LSP (TypeScript 7 native) — hover, definitions, references, auto-diagnostics after edits |
| `codex-exec` 🚀 | Run codex tasks in the background with async result reporting |
| `ralph-loop` 🔁 | Autonomous coding loops via Codex — PRD-driven stories or free-form prompt loops with progress reporting |
| `agent-secrets` 🛡️ | Lease secrets with TTLs via [agent-secrets](https://github.com/joelhooks/agent-secrets) — status, revoke, audit, env generation |
| `session-reader` 📖 | Discover and parse sessions from pi, Claude Code, and Codex |
| `skill-shortcut` ⚡ | `$skill-name` autocomplete shortcut for `/skill:skill-name` |
| `aliases` 🚪 | `/quit` and `/q` → `/exit` |

## ralph-loop

Two modes:

**PRD mode** — reads `prd.json` in the working directory, picks stories by priority, spawns codex to implement each one. Marks stories as done when they pass. Reports each iteration back to pi.

```
Use ralph_loop in prd mode to implement the stories in this project
```

**Prompt mode** — runs a prompt repeatedly up to N iterations. Each iteration is a fresh codex session.

```
Use ralph_loop in prompt mode with "Run the tests and fix any failures" for 5 iterations
```

Progress appears as messages in your pi session. Use `ralph_jobs` to check status or cancel.

## agent-secrets

Lease credentials safely with TTLs. No env files committed, no plaintext on disk.

```
Use secrets_lease to get the slack_bot_token with a 30 minute TTL
```

Tools: `secrets_lease`, `secrets_status`, `secrets_revoke`, `secrets_audit`, `secrets_env`

Requires [agent-secrets](https://github.com/joelhooks/agent-secrets) daemon running.

## License

MIT
