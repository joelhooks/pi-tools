# herdr-ping-wait

Wait for the next complete Pi turn event from one or more herdr pane spools.

## Install

Requires [Bun](https://bun.sh/).

```bash
chmod +x "$HOME/Code/joelhooks/pi-tools/herdr-ping-wait/herdr-ping-wait.ts"
mkdir -p "$HOME/.local/bin"
ln -sfn "$HOME/Code/joelhooks/pi-tools/herdr-ping-wait/herdr-ping-wait.ts" \
  "$HOME/.local/bin/herdr-ping-wait"
```

## Usage

```bash
herdr-ping-wait <pane_id...> [--timeout <seconds>] [--cursor <file>]
```

Examples:

```bash
herdr-ping-wait wF:p1 wF:p2
herdr-ping-wait wF:p1 --timeout 30
herdr-ping-wait wF:p1 --cursor ~/.local/state/herdr-pings/claude-orchestrator.json
```

- Events are read from `~/.local/state/herdr-pings/<pane-id-with-dashes>.jsonl`.
- The default consumer cursor is `~/.local/state/herdr-pings/cursor.json`.
- A new cursor starts at each spool's current EOF, so old history is not replayed.
- One invocation prints and consumes exactly one complete JSONL line.
- Partial lines remain unconsumed until their trailing newline arrives.
- Timeout exits `2` without consuming anything. Bad arguments or runtime failures exit `1`.
