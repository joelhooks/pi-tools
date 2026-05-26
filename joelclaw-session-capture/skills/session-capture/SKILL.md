---
name: session-capture
description: Install, verify, and debug JoelClaw Codex session capture hooks and compare Codex/Claude/Pi capture health.
---

# Session Capture

Use when capture health matters. Do not claim sessions are in JoelClaw unless the state/log files and search path prove it.

## Codex

- Hook config: `~/.codex/hooks.json`
- Script: `joelclaw-session-capture/scripts/capture-codex-session.js`
- State: `~/.joelclaw/codex-session-state.json`
- Log: `~/.joelclaw/codex-capture.log`
- Transcript root: `~/.codex/sessions/**/*.jsonl`

Doctor:

```bash
node joelclaw-session-capture/scripts/doctor-codex-session-capture.js
```

## Claude

- Hook config: `~/.claude/settings.json`
- Script: `~/.bun/bin/joelclaw-capture-session`
- Expected state/log if verified:
  - `~/.joelclaw/claude-session-state.json`
  - `~/.joelclaw/claude-capture.log`
- Transcript root: `~/.claude/projects/**/*.jsonl`

Current risk: the historical Claude hook writes generic `session-state.json` / `capture.log` and uses runtime `claude-code`, so it can look like Pi capture unless the capture script is namespaced.

## Pi

- State: `~/.joelclaw/session-state.json`
- Log: `~/.joelclaw/capture.log`
- Transcript root: `~/.pi/agent/sessions/**/*.jsonl`

## Search model

1. Ask `joelclaw session search` first for indexed/cross-machine pointers.
2. Then inspect local transcript roots for exact receipts.
3. Verify capture health before saying a runtime is indexed.
