# JoelClaw Session Capture for Codex

Codex Stop-hook capture for JoelClaw `/api/runs`.

This promotes the local hook script into a versioned plugin shape so Codex capture is installable, reviewable, and doctorable instead of living as a mystery file in `~/.local/bin`.

## What it captures

- Runtime: `codex`
- Source: Codex hook stdin fields including `session_id`, `transcript_path`, `cwd`, `model`, and `turn_id`
- Payload: only the transcript delta since the last successful Central POST
- State: `~/.joelclaw/codex-session-state.json`
- Log: `~/.joelclaw/codex-capture.log`
- Failed posts: `~/.joelclaw/outbox/*.json`

## Safety contract

The hook must never break Codex:

- exits `0`
- emits valid JSON with `{ "continue": true, "suppressOutput": true }`
- never prints secrets
- writes failed payloads to the outbox
- advances byte offsets only after Central accepts the run

## Install/update the hook

```bash
node joelclaw-session-capture/scripts/install-hook.js
```

Default Central URL is the stable Tailscale name:

```txt
http://panda.tail7af24.ts.net:3000
```

Override with `JOELCLAW_CENTRAL_URL` if needed.

## Doctor

```bash
node joelclaw-session-capture/scripts/doctor-codex-session-capture.js
```

Checks:

- `~/.codex/hooks.json` has the Stop hook
- existing cmux hooks are preserved
- latest Codex transcript exists
- state/log freshness
- outbox count
- Central connectivity
- `joelclaw session search --source local` can return a Codex transcript path

## Known gap

Capture can be healthy while `joelclaw session search` is still Pi-biased. The CLI local search must scan all local transcript roots:

```txt
~/.pi/agent/sessions/**/*.jsonl
~/.claude/projects/**/*.jsonl
~/.codex/sessions/**/*.jsonl
```

Until that lands in JoelClaw proper, use the Pi `session_search` tool in this repo for pointer search plus local Pi/Claude/Codex detail scan.
