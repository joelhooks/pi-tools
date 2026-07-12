# Task: Session Change Ledger — Pi runtime first (wayfinder ticket)

You are a pi worker in a herdr pane (cwd: pi-tools), steered by a Claude session in wJ:p1. Work autonomously. **Do not commit. Do not install/symlink anything into `~/.pi/agent/extensions` — the steering session does activation.** Print a `DONE` summary when finished.

## Read first

1. `~/Code/joelhooks/joelclaw/.brain/projects/wayfinder/instrument-session-change-ledger.svx` — your ticket.
2. `~/Code/joelhooks/joelclaw-wiki/.brain/session-edge-feasibility.svx` — **the contract.** The "Capture contract required before Phase 2" section is the spec; the failure-case list is your test plan.
3. `~/Code/joelhooks/pi-tools/joelclaw-session-capture/` — the existing capture extension: match its conventions (structure, config, state paths). Your extension is a SIBLING; do not modify it.
4. An existing hook-based extension for API patterns (e.g. `herdr-turn-ping` via its symlink) — how tool-result hooks, session ids, and turn boundaries are read in this pi version. Grep the real installed pi extension API, don't guess.

## The job — Pi runtime only, additive only

New extension `pi-tools/change-ledger/`:

- On each **successful** mutating tool result (`write`, `edit`; bash is out of scope for v1 — record a `bash-mutation-unattributed` marker event instead, per the memo's "never parse command text"), append one JSONL record: sessionId, machineId (hostname), repo identity (canonical remote + worktree path + HEAD at record time), repo-relative canonical path, operation, toolCallId, timestamp, **pre-blob hash and post-blob hash** (git hash-object), and a `changeSetId` (one per session-turn, immutable, ULID-ish).
- Ledger location: follow joelclaw-session-capture's state conventions (likely `~/.local/state/` or the Vault); append-only, one file per day or per session — pick what the existing capture does and say so.
- **Commit attribution**: provide `scripts/attribute-commit.sh` (or ts) that, given a repo + commit SHA, matches committed path+blob hashes against ledger records by **hash equality** and appends a commit-attribution event (changeSetId(s), sessionIds, SHA, parent, timestamps, matched paths). Deterministic only: unmatched paths are listed as unattributed, never guessed. Wiring it into git hooks is a documented follow-up, not this ticket.
- Tests over real fixtures: hash matching, multi-session non-collision (two ledgers, one commit — only hash-proven records attribute), uncommitted-edit records, no record on failed tool results.

## Definition of done

- Extension loads in a scratch pi session (`pi -p` with HERDR_PANE_ID overridden to a scratch id per the nested-run gotcha) and real ledger records appear with correct blob hashes for a test file edit in a throwaway git repo.
- attribute-commit run on a real test commit produces a hash-verified attribution event.
- A short `.brain` note in pi-tools documenting the record schema + how the feasibility verdict flips for Pi once this runs fleet-wide.
- DONE summary: record counts from your live test, exact ledger path, and what remains for Claude/Codex runtimes.

Do NOT edit the wayfinder ticket or map. Do not commit. Do not touch `~/.pi/agent/extensions`.
