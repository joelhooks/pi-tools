# herdr-turn-ping

Pi extension that wakes a herdr orchestrator exactly once when a worker run is truly idle.

It caches `agent_end`/`turn_end` data, then appends one event when Pi 0.80.6 emits `agent_settled` (after retries, compaction recovery, and queued continuations). A settled assistant error becomes `turn_error`; intermediate tool or retry errors do not wake the orchestrator.

Outside a herdr pane it does nothing. Pane identity comes from `HERDR_PANE_ID`, with one startup fallback to `herdr pane current`.

## Spool contract

- Directory: `~/.local/state/herdr-pings/`
- File: `<pane_id with ":" replaced by "-">.jsonl`, e.g. `wF-p2.jsonl`
- One awaited, serialized `fs.appendFile` per settled run
- Required fields: `event`, raw `pane_id`, ISO-8601 UTC `timestamp`
- Optional fields: Pi `session`, zero-based `turn_index`, final assistant `last_message_tail` (last 500 characters), and `error` for `turn_error`

Example:

```json
{"event":"turn_ended","pane_id":"wF:p2","session":"...","turn_index":3,"last_message_tail":"Done.","timestamp":"2026-07-12T17:00:00.000Z"}
```

## Install

Source lives in this repo. Install it as an unmanaged local symlink so `pi update --extensions` cannot overwrite it:

```bash
ln -sfn "$HOME/Code/joelhooks/pi-tools/herdr-turn-ping" "$HOME/.pi/agent/extensions/herdr-turn-ping"
```

No package install, build step, or patched Pi is required. The extension targets the public `agent_settled` API in installed `@earendil-works/pi-coding-agent` 0.80.6.

On **flagg**, clone/update `pi-tools` first, then run the same symlink command there. There is intentionally no fleet graft until a real second-machine install proves the one-liner inadequate.
