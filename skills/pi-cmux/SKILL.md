---
name: pi-cmux
description: "Control cmux terminal multiplexer from pi — read other terminal screens, send commands to other workspaces, manage panes/splits, set sidebar status/progress, send notifications, and open browser surfaces. Use when asked to: check what's running in another terminal, send a command to another pane, split the workspace, show progress in the sidebar, notify the user, open a URL in a browser pane, orchestrate multi-workspace workflows, or interact with cmux in any way. Triggers on: 'cmux', 'other terminal', 'other workspace', 'read screen', 'send command to', 'split pane', 'sidebar status', 'progress bar', 'notify', 'browser pane', 'terminal multiplexer'."
---

# cmux Integration for Pi

Pi runs inside cmux with full access to the cmux CLI via three extension tools: `cmux`, `cmux_status`, and `cmux_notify`. The cmux extension also automatically manages sidebar status (Running/Idle/Needs input) through pi lifecycle hooks.

## Concepts

**Refs** — cmux uses short refs to identify objects: `workspace:1`, `pane:2`, `surface:3`, `window:1`. Always run `cmux tree` first to discover current refs before targeting specific surfaces.

**Surfaces** — a surface is a single terminal or browser tab inside a pane. Each pane can have multiple surfaces (shown as tabs). Each workspace has one or more panes (splits).

**Environment** — cmux auto-sets `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`, and `CMUX_SOCKET_PATH` in every terminal it manages. Commands default to the caller's workspace/surface when flags are omitted.

## Tools

### `cmux` — Workspace, Pane, and Surface Control

The main tool for multiplexer operations. Takes an `action` and optional `args` array.

#### Discover layout

```
cmux action="tree"
cmux action="tree" args=["--all"]
cmux action="identify"
cmux action="list-workspaces"
cmux action="current-workspace"
cmux action="list-panes"
cmux action="list-panes" args=["--workspace", "workspace:2"]
```

#### Read another terminal's screen

```
cmux action="read-screen" args=["--surface", "surface:1", "--lines", "50"]
cmux action="read-screen" args=["--surface", "surface:3", "--scrollback"]
cmux action="read-screen" args=["--workspace", "workspace:2"]
```

Use `--scrollback` to include scrollback buffer. Use `--lines N` to limit output. Without `--surface`, reads the focused surface of the specified workspace (or caller's workspace).

#### Send text or keys to another terminal

```
cmux action="send" args=["--surface", "surface:1", "npm run build\n"]
cmux action="send-key" args=["--surface", "surface:1", "Enter"]
cmux action="send-key" args=["--surface", "surface:2", "C-c"]
```

**Important**: Append `\n` to text to "press Enter". Use `send-key` for special keys: `Enter`, `C-c` (Ctrl+C), `C-d`, `Up`, `Down`, `Left`, `Right`, `Tab`, `Escape`, `BSpace` (backspace).

#### Create workspaces, panes, splits

```
cmux action="new-workspace" args=["--cwd", "/path/to/project"]
cmux action="new-split" args=["right"]
cmux action="new-split" args=["down", "--workspace", "workspace:1"]
cmux action="new-pane" args=["--type", "terminal", "--direction", "right"]
cmux action="new-pane" args=["--type", "browser", "--url", "http://localhost:3000"]
```

Split directions: `left`, `right`, `up`, `down`.

#### Navigate and manage

```
cmux action="select-workspace" args=["--workspace", "workspace:3"]
cmux action="rename-workspace" args=["my-project"]
cmux action="focus-pane" args=["--pane", "pane:2"]
cmux action="close-surface" args=["--surface", "surface:5"]
cmux action="close-workspace" args=["--workspace", "workspace:4"]
```

### `cmux_status` — Sidebar Status, Progress, and Logs

Control the cmux sidebar for the current workspace.

#### Status entries

```
cmux_status action="set-status" key="build" value="Compiling..." icon="hammer.fill" color="#FF9500"
cmux_status action="set-status" key="tests" value="14/20 passing" icon="checkmark.circle" color="#34C759"
cmux_status action="clear-status" key="build"
cmux_status action="sidebar-state"
```

Icons are SF Symbol names. Common ones:
- `bolt.fill` — running/active
- `pause.circle.fill` — idle/paused
- `checkmark.circle` — success
- `xmark.circle` — error/failure
- `hammer.fill` — building
- `magnifyingglass` — searching
- `arrow.down.circle` — downloading
- `bell.fill` — attention needed
- `circle.dashed` — pending

Colors are hex: `#4C8DFF` (blue), `#34C759` (green), `#FF3B30` (red), `#FF9500` (orange), `#8E8E93` (gray).

#### Progress bar

```
cmux_status action="set-progress" value="0.45" label="Deploying..."
cmux_status action="set-progress" value="1.0" label="Complete"
cmux_status action="clear-progress"
```

Value is 0.0 to 1.0.

#### Log entries

```
cmux_status action="log" value="Build started" level="info"
cmux_status action="log" value="Test failed: auth.test.ts" level="error"
cmux_status action="log" value="Deprecated API usage" level="warn"
cmux_status action="clear-log"
```

### `cmux_notify` — Native Notifications

Send macOS notifications via cmux. Appears in Notification Center.

```
cmux_notify title="Build Complete" body="All 47 tests passing" subtitle="my-project"
cmux_notify title="Deploy Failed" body="Error: connection timeout on staging"
cmux_notify title="pi" body="Task finished — ready for review"
```

## Common Patterns

### Check what's running in another workspace

```
# 1. Find the workspace
cmux action="tree"

# 2. Read its screen
cmux action="read-screen" args=["--workspace", "workspace:2", "--lines", "30"]
```

### Run a command in another terminal and check output

```
# Send the command
cmux action="send" args=["--surface", "surface:1", "npm test 2>&1\n"]

# Wait a moment, then read the result
cmux action="read-screen" args=["--surface", "surface:1", "--lines", "50"]
```

### Multi-workspace orchestration

```
# Create a new workspace for the task
cmux action="new-workspace" args=["--cwd", "/path/to/project"]

# Split it for parallel work
cmux action="new-split" args=["right"]

# Run frontend in one pane, backend in the other
cmux action="send" args=["--surface", "surface:7", "npm run dev\n"]
cmux action="send" args=["--surface", "surface:8", "npm run api\n"]

# Show progress
cmux_status action="set-progress" value="0.5" label="Starting services..."

# Open browser to preview
cmux action="new-pane" args=["--type", "browser", "--url", "http://localhost:3000"]
```

### Long task with progress tracking

```
# Set status at start
cmux_status action="set-status" key="task" value="Processing..." icon="bolt.fill" color="#4C8DFF"
cmux_status action="set-progress" value="0.0" label="Step 1/5"

# Update as you go
cmux_status action="set-progress" value="0.4" label="Step 3/5"
cmux_status action="log" value="Completed migration step 3"

# Finish
cmux_status action="set-progress" value="1.0" label="Done"
cmux_status action="set-status" key="task" value="Complete" icon="checkmark.circle" color="#34C759"
cmux_notify title="Task Complete" body="All 5 steps finished successfully"

# Clean up
cmux_status action="clear-progress"
cmux_status action="clear-status" key="task"
```

### Open a browser pane for preview

```
cmux action="new-pane" args=["--type", "browser", "--url", "http://localhost:3000"]
```

## Automatic Lifecycle Status

The cmux extension automatically manages a `pi_agent` sidebar status entry:

| Pi Event | Sidebar Status | Icon | Color |
|----------|---------------|------|-------|
| Session start | Idle + session name (if resuming) | `pause.circle.fill` / `text.bubble` | gray |
| First prompt | Generates session name → shown as `session` status entry | `text.bubble` | gray |
| Agent starts working | Running | `bolt.fill` | blue |
| Agent turn complete | Idle + turn summary | `pause.circle.fill` | gray |
| Session shutdown | *all cleared* | — | — |

The session name appears as a sidebar status entry (key `session`) — the workspace label is never modified by the extension and is left to the operator. A native notification fires on every `agent_end` so the user knows pi is waiting for input. Set `PI_CMUX_VERBOSE_STATUS=1` to see per-tool updates (e.g. "Reading ~/.zshrc", "Running grep").

## Allowed Actions

The `cmux` tool allows these actions: `tree`, `identify`, `list-workspaces`, `current-workspace`, `read-screen`, `send`, `send-key`, `new-workspace`, `new-split`, `new-pane`, `new-surface`, `select-workspace`, `close-surface`, `close-workspace`, `list-panes`, `list-pane-surfaces`, `focus-pane`, `rename-workspace`, `surface-health`.

For browser control, use `new-pane` with `--type browser` to create browser surfaces. For advanced browser automation, use the `agent-browser` skill or `cmux browser` subcommands via bash.

## Extension Safety: Fork-Bomb Prevention

The cmux extension spawns helper `pi -p` subprocesses for session naming and turn summaries. Without proper guards, each child process loads the cmux extension again, fires the same hooks, and spawns another child — exponential process explosion.

**Three-layer defense (all required):**

1. **`--no-extensions` flag** on every `pi -p` spawn — prevents the child from loading any extensions, including cmux itself. This is the critical flag; `--no-tools`/`--no-skills` alone are not enough.

2. **`--no-session` flag** — prevents the child from creating session files, which would compound the recursion with disk I/O.

3. **`PI_CMUX_CHILD` env guard** — the extension sets `PI_CMUX_CHILD=1` in the child's environment and bails out at the top of `cmuxExtension()` if that var is set. Belt-and-suspenders defense in case `--no-extensions` is somehow bypassed.

```typescript
// Top of extension — bail if we're a helper subprocess
if (process.env[CMUX_CHILD_ENV] === "1") return;

// Every pi subprocess spawn must include:
spawn("pi", [
  "-p",
  "--model", NAMING_MODEL,
  "--no-session",      // ← no session files
  "--no-extensions",   // ← THE critical flag — prevents self-recursion
  "--no-tools",
  "--no-skills",
  "--no-prompt-templates",
  "--system-prompt", "...",
], {
  env: { ...process.env, [CMUX_CHILD_ENV]: "1" },  // ← env guard
});
```

**State resets on lifecycle events:**

- `session_start`: reset `_pendingSessionName` and `_hasNamedSession`
- `session_shutdown`: reset both to prevent stale state across `/continue` sessions
