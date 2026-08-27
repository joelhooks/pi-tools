---
name: session-search
description: Search and verify Joel's Pi, Claude, Codex, Cursor, Grok, and OpenCode session history. Use when asked to recover prior context, find exact transcript evidence, inspect session receipts, continue old work, or verify capture health. Prefer flowing recall before raw transcript search when the question is about prior decisions or project memory.
---

# Session Search

Use transcripts as receipts. Do not guess from memory when session history can answer.

## Source order

1. Use flowing recall for every memory request.
2. When recall reports `No projection head`, call `discover_scopes`, choose one returned exact pair, and retry recall.
3. Read supporting flowing observations and their evidence references.
4. Search native sessions only when exact transcript evidence remains necessary.
5. Verify capture health before claiming Central has the runtime history.

Flowing scope is exact. `project` is the persisted repository identity, commonly `owner.repo`. `workstream` is the persisted branch or bookmark, commonly `main` or `default`. A `No projection head` result means the scope is wrong or empty. Use persisted `discover_scopes` candidates to correct it. Never synthesize a pair from separate hints or fall back to raw transcripts.

Flowing recall has exactly three lanes:

1. `flowing-reflections`
2. `flowing-observations`
3. `curated-pages`

Never merge lane scores. Raw transcripts are explicit drill-down evidence, not a fourth lane.

## Pi tools

- `flowing_recall` — exact project/workstream semantic recall.
- `session_search` — compatibility-only local evidence search. Never use it as memory recall. Remote search stays disabled until the CLI accepts stdin.
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

Executor owns the saved `memory` MCP connection. Use one `executor_execute` call for multi-step recall and evidence work. Discover exact paths before calling them:

```js
const matches = await tools.search({
  query: "memory recall discover scopes drill down evidence",
  limit: 30,
});
const findMemoryTool = (name) =>
  matches.items.find(
    (item) => item.path.startsWith("memory.") && item.name === name,
  );
const recallTool = findMemoryTool("recall");
const discoverTool = findMemoryTool("discover_scopes");
const evidenceTool = findMemoryTool("drill_down_session_evidence");
if (!recallTool || !discoverTool || !evidenceTool)
  return { error: "memory tools unavailable" };

const recall = await tools[recallTool.path]({
  query,
  project,
  workstream,
  limit: 10,
});
if (!recall.ok) return recall;

const recallText = recall.data.structuredContent?.text ?? "";
if (recallText.includes("No projection head")) {
  const candidates = await tools[discoverTool.path]({
    project_hint: projectHint,
    workstream_hint: workstreamHint,
    allowed_privacy: ["public", "private"],
    limit: 10,
  });
  return {
    next: "Choose one returned exact project/workstream pair and retry recall.",
    candidates: candidates.ok ? candidates.data : candidates,
  };
}

// Raw evidence remains recall-gated. Scope discovery never supplies this receipt.
const receipt =
  recall.data.structuredContent?.details?.evidenceDrilldownReceipt;
if (typeof receipt !== "string")
  return { error: "recall did not authorize evidence drill-down" };
const sessions = await tools[evidenceTool.path]({
  query: evidencePhrase,
  evidenceDrilldownReceipt: receipt,
  runtime: "all",
  limit: 5,
});
return {
  recall: recall.data,
  sessions: sessions.ok ? sessions.data : sessions,
};
```

`discover_scopes` returns semantic metadata. It requires an explicit non-empty privacy grant and neither accepts nor mints an evidence receipt. The recall evidence receipt remains process-bound, expires after ten minutes, and gates raw transcript tools.

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
