---
name: session-search
description: Search Joel's Pi, Claude, and Codex session history using the pi-tools session-reader flow. Use when the user asks to search past sessions, recover context, find prior decisions, inspect transcript history, continue old work, find support patterns from previous runs, or verify whether sessions are being captured by JoelClaw.
---

# Session Search

Use this skill when session history is the source of truth. Do not guess from memory when transcripts can answer it.

## Default flow

1. Search indexed pointers first:

```bash
joelclaw session search "<query>" --source local --machine "$(hostname -s)" --runtime all --limit 10 --extract
```

Use `--source both` when cross-machine/Typesense results matter and the backplane is healthy. Use `--runtime pi|claude-code|claude|codex|all` to narrow raw transcript roots or Typesense runtime filters.

2. Prefer the Pi tool when available:

- `session_search` for new work: pointer search plus local Pi/Claude/Codex transcript detail scan.
- `sessions` only for old prompts/compatibility.
- `session_context` after you have a session id or local JSONL path.
- `session_inspect` when exact transcript line evidence matters.
- `session_chunks` for small snippet searches, but watch for current-session self-matches.
- `session_capture_status` to verify capture health.

3. Dig locally for details.

Local transcript roots on this machine:

```bash
~/.pi/agent/sessions/**/*.jsonl
~/.claude/projects/**/*.jsonl
~/.codex/sessions/**/*.jsonl
```

When Joel asks “search my sessions” or similar, return useful local paths/session ids so the next agent can inspect the exact transcript.

## Capture verification

Check JoelClaw capture state before claiming history is complete:

```bash
joelclaw status
ls -l ~/.joelclaw/*capture.log ~/.joelclaw/*session-state.json 2>/dev/null
```

Current runtime capture belongs to the single-owner `joelclaw` flowing-memory host adapter. Native transcript readability is evidence availability, not proof of semantic admission. Flat state/log/outbox files are runtime-ambiguous legacy Central artifacts.

For Codex legacy diagnostics only, run the non-mutating repo-local doctor:

```bash
node joelclaw-session-capture/scripts/doctor-codex-session-capture.js
```

The doctor intentionally reports current Codex flowing capture as unproven. Do not install the archived Central-posting plugin or treat stale canonical files as liveness proof.

Codex-only smoke:

```bash
joelclaw session search "<codex-session-id-or-unique-phrase>" \
  --source local \
  --machine "$(hostname -s)" \
  --runtime codex \
  --limit 5 \
  --extract
```

Expected path prefix: `~/.codex/sessions/`.

## Output shape

Keep reports short:

- query used
- sources checked
- top session ids/paths
- what the transcripts actually show
- capture gaps or backplane health problems

## Privacy

Do not paste raw secrets, customer private data, or long transcript dumps. Summarize and cite paths/line evidence instead.
