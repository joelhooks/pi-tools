# Pi session change ledger

Additive Pi extension that records successful `write` and `edit` results as hash-proven JSONL mutations. It never parses shell command text. Successful `bash` results emit a `bash-mutation-unattributed` marker in v1.

## Ledger

Daily append-only files follow the Pi-side local state convention used by `herdr-turn-ping`:

```txt
~/.local/state/joelclaw/change-ledger/YYYY-MM-DD.jsonl
```

Set `PI_CHANGE_LEDGER_STATE_DIR` for isolated tests. Each turn gets one immutable `changeSetId`.

## Load without installing

```bash
HERDR_PANE_ID=scratch-change-ledger \
PI_CHANGE_LEDGER_STATE_DIR=/tmp/change-ledger-state \
pi -p --no-session --no-context-files \
  --extension ./change-ledger/index.ts \
  'Use the write tool to create ./proof.txt containing exactly proof.'
```

This ticket intentionally does not install or symlink the extension. Fleet activation is separate.

## Attribute a commit

```bash
bun change-ledger/scripts/attribute-commit.ts \
  /path/to/repo COMMIT_SHA \
  ~/.local/state/joelclaw/change-ledger/2026-07-12.jsonl
```

The script compares each committed path's tree blob with mutation `postBlobHash` values. It appends a `commit-attribution` event to today's ledger. Paths without exact repo/path/blob equality are listed under `unattributedPaths`; identical blob candidates from distinct sessions/change sets stay explicitly ambiguous. Nothing is inferred from timestamps. Use `--output PATH` to select another append-only output.

Git-hook wiring, shell worktree diffing, supersession markers, rewrite lineage, and Claude/Codex runtime capture are follow-ups.

## Test

```bash
bun test change-ledger/change-ledger.test.ts
```
