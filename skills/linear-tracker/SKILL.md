---
name: linear-tracker
description: >-
  Resolve project-local issue tracker routing and publish Linear issues safely.
  Use before creating Linear issues, PRDs, phase breakdown issues, or when deciding
  whether Linear/GitHub/local docs is the configured tracker. Enforces capability
  ≠ routing: Linear requires project-local policy, team association, auth, and
  verified readback.
---

# Linear Tracker

Use this when a task wants PRDs/issues published, especially from Rat King flows.

## The lock

Before publishing to Linear, call `linear_tracker_resolve` from the project cwd.

Linear publishing is allowed only when all three are true:

1. **Project-local policy says Linear**: nearest `AGENTS.md`, `CLAUDE.md`, `docs/agents/issue-tracker.md`, or `.pi/settings.json` points to Linear.
2. **Project-local association exists**: Linear `teamKey` or `teamId` is configured locally.
3. **Capability exists**: direct Linear API auth or authenticated Linear MCP exists. Direct auth may come from env vars, common agent-secrets names, or a project-local Linear skill/policy that names a secret such as `rubicon:linear_api_key`.

Global auth, global MCP, or a skill mentioning Linear is **capability**, not routing. Explicit GitHub/not-Linear local policy wins.

## Tool workflow

1. `linear_tracker_resolve`
   - If `publishMode` is `linear_direct`, use `linear_tracker_create_issue(s)`.
   - If `publishMode` is `linear_mcp`, use the Linear MCP create/read tools and verify readback.
   - If `publishMode` is `payload_only`, output ready-to-paste payloads and name the missing association/auth.
   - If `publishMode` is `not_linear`, use the configured non-Linear tracker.
   - If `publishMode` is `unknown`, do not guess. Ask for or create local tracker policy.
2. Publish blockers first.
3. Verify every created issue by fetching it back.
4. Return Linear identifiers + URLs only after readback.

## Local policy examples

`docs/agents/issue-tracker.md`:

```md
# Issue tracker

Issue tracker: Linear
Linear workspace: badass
Linear team key: AIH
Linear project: AI Hero Support
```

or in `.pi/settings.json`:

```json
{
  "issueTracker": {
    "provider": "linear",
    "linear": {
      "teamKey": "AIH",
      "projectId": "00000000-0000-0000-0000-000000000000"
    }
  }
}
```

## Hard rules

- Never claim Linear publishing without verified readback.
- Never publish to Linear because global MCP/auth exists.
- Never override explicit GitHub/not-Linear policy.
- Do not leak tokens. The tools only report auth source, never secret values.
