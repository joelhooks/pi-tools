<!-- brain-first-workflow:start -->
# Brain-first planning workflow

This is Joel's default planning law across active projects.

- Brain is canonical. Linear/GitHub/issues are mirrors and execution surfaces, not the memory system.
- When asked for a PRD, use the PRD skill to create/update structured Brain notes first: Project, Area, Resource, and Decision notes under `.brain/` using PARA. The PRD surface belongs in Brain before tracker work.
- When running PRD-to-plan, assemble the PRD plus linked Brain context, repo docs, decisions/ADRs, code evidence, and relevant tracker comments before drafting the execution plan. Prefer saving plans in `.brain/`.
- When running `to-issues`, publish dependency-ordered vertical slices to Linear when the project is configured for Linear. Search first, link each issue back to Brain, and keep Linear concise.
- Keep Brain and Linear synced intentionally: update Brain first for durable scope/decision changes, then mirror useful issue/project state in Linear.
- For clarification, Grill Me, PRD interviews, and planning questions, use inline voice-friendly prose. Ask one question at a time with a recommended answer and why. Do not use interactive MCQ unless Joel explicitly asks for it.
- If a project lacks `.brain/`, create the minimal PARA scaffold when the first durable PRD/plan/decision appears.
<!-- brain-first-workflow:end -->

<!-- session-search:start -->
# Session search

When asked to search, recover, inspect, continue, or summarize prior Pi/Claude/Codex sessions, use the `session-search` skill. Default to `session_search`: joelclaw pointers first, then local transcript files for receipts. Use `session_capture_status` before claiming this machine is syncing sessions to JoelClaw.
<!-- session-search:end -->
