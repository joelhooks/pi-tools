---
name: session-search
description: Search and verify Joel's Pi, Claude, Codex, Cursor, Grok, and OpenCode session history. Use when asked to recover prior context, find exact transcript evidence, inspect session receipts, continue old work, or verify capture health. Prefer flowing recall before raw transcript search when the question is about prior decisions or project memory.
---

# Session Search

Use transcripts as receipts. Do not guess from memory when session history can answer.

## Source order

1. Use flowing recall for vague prior context, project decisions, or "what did we decide?"
2. Read supporting flowing observations and their evidence references.
3. Search native sessions only when exact transcript evidence is needed.
4. Verify capture health before claiming Central has the runtime history.

Flowing recall has exactly three lanes:

1. `flowing-reflections`
2. `flowing-observations`
3. `curated-pages`

Never merge lane scores. Raw transcripts are explicit drill-down evidence, not a fourth lane.

## Pi tools

- `flowing_recall` — exact project/workstream semantic recall.
- `session_search` — bounded local native session search. Remote search stays disabled until the CLI accepts stdin.
- `session_context` — bounded structured extraction from one session.
- `session_inspect` — exact line evidence around one regex.
- `session_expand` — bounded continuation through an opaque cursor.
- `session_chunks` — bounded transcript snippets; excludes the current session by default.
- `session_capture_status` — native adapter and capture-delivery health.

The native reader supports:

```text
pi
claude
codex
cursor
grok
opencode
```

## Executor Code Mode

Executor owns the saved `memory` MCP connection. Use one `executor_execute` call for multi-step recall and evidence work. Inside Executor, discover exact paths before calling them:

```js
const recallMatches = await tools.search({ query: "recall exact project workstream", limit: 20 });
const sessionMatches = await tools.search({ query: "search native sessions", limit: 20 });
const recallTool = recallMatches.items.find(
  (item) => item.path.startsWith("memory.") && item.name === "recall",
);
const searchTool = sessionMatches.items.find(
  (item) => item.path.startsWith("memory.") && item.name === "search_sessions",
);
if (!recallTool || !searchTool) return { error: "memory tools unavailable" };

const recall = await tools[recallTool.path]({ query, project, workstream, limit: 10 });
if (!recall.ok) return recall;

// Drill into raw sessions only when recall needs exact evidence.
const sessions = await tools[searchTool.path]({
  query: evidencePhrase,
  runtime: "all",
  limit: 5,
});
return { recall: recall.data, sessions: sessions.ok ? sessions.data : sessions };
```

Do not pass a private query in argv. Executor sends MCP arguments over authenticated loopback HTTP. Direct CLI requests use stdin or a mode-0600 request file.

## Native roots

```text
~/.pi/agent/sessions/**/*.jsonl
~/.claude/projects/**/*.jsonl
~/.codex/sessions/**/*.jsonl
~/.cursor/acp-sessions/*/{meta.json,store.db}
~/.grok/sessions/**/chat_history.jsonl
~/.local/share/opencode/opencode.db
```

## Capture health

`session_capture_status` checks native adapters for all six runtimes. It separately checks the canonical JoelClaw delivery namespace for Pi, Claude Code, and Codex:

```text
~/.joelclaw/capture/<machine_id>/<runtime>/{state.json,capture.log,outbox/}
```

A readable native transcript is not proof of successful Central ingest. Pending outbox files mean delivery is queued or degraded. Legacy flat files remain historical evidence.

## Privacy

Do not paste secrets, raw transcript dumps, customer private data, or paid source text. Keep results bounded. Cite session IDs, paths, and line windows. Do not copy private recall results into outward messages or public artifacts.
