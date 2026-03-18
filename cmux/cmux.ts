/**
 * cmux — pi ↔ cmux integration extension.
 *
 * Lifecycle hooks:
 *   - session_start:     Set "Idle" status, auto-name session via haiku.
 *   - agent_start:       Set sidebar to "Running" (blue bolt).
 *   - tool_execution_start: Verbose mode — show tool name in sidebar.
 *   - agent_end:         Set sidebar to "Idle" (gray pause) + send notification + peon-ping.
 *   - session_shutdown:  Clear status and agent PID.
 *
 * Session naming:
 *   On first user prompt, spawns a cheap haiku call to generate a 2-4 word
 *   session name from the prompt + cwd. Sets it via pi.setSessionName() so
 *   it shows in the footer and cmux workspace title.
 *
 * peon-ping:
 *   If peon-ping is installed, plays notification sounds on agent_end.
 *
 * Tools:
 *   - cmux:        General workspace/pane/surface control — tree, read, send, split, etc.
 *   - cmux_status: Set sidebar status, progress, log entries.
 *   - cmux_notify: Send native notifications to the user.
 *
 * Requires: cmux CLI in PATH and CMUX_SOCKET_PATH env var.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execSync, execFileSync, spawn } from "node:child_process";
import * as path from "node:path";

// ── Config ─────────────────────────────────────────────

const STATUS_KEY = "pi_agent";
const VERBOSE_STATUS = process.env.PI_CMUX_VERBOSE_STATUS === "1";
const NAMING_MODEL = process.env.PI_CMUX_NAMING_MODEL || "claude-haiku-4-5";
// Helper pi subprocesses must not reload this extension or they recurse forever.
const CMUX_CHILD_ENV = "PI_CMUX_CHILD";

// SF Symbols + colors matching cmux Claude Code integration
const STATUS_RUNNING = { value: "Running", icon: "bolt.fill", color: "#4C8DFF" };
const STATUS_IDLE = { value: "Idle", icon: "pause.circle.fill", color: "#8E8E93" };
const STATUS_NEEDS_INPUT = { value: "Needs input", icon: "bell.fill", color: "#4C8DFF" };

// ── cmux CLI wrapper ───────────────────────────────────

function cmux(...args: string[]): string {
  try {
    return execFileSync("cmux", args, {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    }).trim();
  } catch (e: any) {
    const msg = e.stderr?.toString().trim() || e.message;
    throw new Error(`cmux ${args[0]} failed: ${msg}`);
  }
}

function cmuxSafe(...args: string[]): string | null {
  try {
    return cmux(...args);
  } catch {
    return null;
  }
}

function hasCmux(): boolean {
  try {
    execSync("which cmux", { encoding: "utf-8", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// ── peon-ping detection ────────────────────────────────

let peonPath: string | null = null;

function detectPeonPing(): string | null {
  // Check common locations
  const candidates = [
    `${process.env.HOME}/.claude/hooks/peon-ping/peon.sh`,
    `${process.env.HOME}/.openpeon/peon.sh`,
  ];
  for (const p of candidates) {
    try {
      execSync(`test -f "${p}"`, { timeout: 1000 });
      return p;
    } catch {}
  }
  // Check PATH
  try {
    const which = execSync("which peon", { encoding: "utf-8", timeout: 1000 }).trim();
    if (which) return which;
  } catch {}
  return null;
}

function playPeonPing(event: "stop" | "notification"): void {
  if (!peonPath) return;
  try {
    // peon.sh reads hook event type from stdin JSON
    const child = spawn("bash", [peonPath], {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
      env: { ...process.env, CLAUDE_HOOK_EVENT_NAME: event === "stop" ? "Stop" : "Notification" },
    });
    child.stdin?.write(JSON.stringify({ event: event === "stop" ? "Stop" : "Notification" }));
    child.stdin?.end();
    child.unref();
  } catch {}
}

// ── Sidebar status helpers ─────────────────────────────

function setStatus(status: { value: string; icon: string; color: string }): void {
  cmuxSafe("set-status", STATUS_KEY, status.value, "--icon", status.icon, "--color", status.color);
}

function clearStatus(): void {
  cmuxSafe("clear-status", STATUS_KEY);
}

// ── Notification helper ────────────────────────────────

function notify(title: string, body?: string, subtitle?: string): void {
  const args = ["notify", "--title", title];
  if (subtitle) args.push("--subtitle", subtitle);
  if (body) args.push("--body", body);
  cmuxSafe(...args);
}

// ── Session naming ─────────────────────────────────────

function generateSessionName(prompt: string, cwd: string): void {
  const dirName = path.basename(cwd);
  const input = `Project directory: ${dirName}\nFirst prompt: ${prompt.slice(0, 300)}`;

  try {
    const child = spawn("pi", [
      "-p",
      "--model", NAMING_MODEL,
      "--no-session",
      "--no-extensions",
      "--no-tools",
      "--no-skills",
      "--no-prompt-templates",
      "--system-prompt",
      "You are a session namer. Given a project directory and first user prompt, reply with ONLY a short 2-4 word session name that captures what the user is working on. No quotes, no explanation, no punctuation. Examples: 'cmux sidebar integration', 'auth refactor', 'deploy pipeline fix'",
    ], {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 15000,
      env: { ...process.env, [CMUX_CHILD_ENV]: "1" },
    });

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.stdin?.write(input);
    child.stdin?.end();

    child.on("close", () => {
      const name = output.trim().slice(0, 60);
      if (name && name.length > 1) {
        _pendingSessionName = name;
      }
    });
  } catch {}
}

let _pendingSessionName: string | null = null;
let _hasNamedSession = false;

// ── Turn summary for sidebar ───────────────────────────

function generateTurnSummary(assistantText: string, cwd: string): void {
  if (!assistantText || assistantText.length < 10) {
    // Too short to summarize, just show idle
    setStatus(STATUS_IDLE);
    return;
  }

  // Truncate to keep the haiku call cheap
  const truncated = assistantText.slice(0, 800);
  const dirName = path.basename(cwd);

  try {
    const child = spawn("pi", [
      "-p",
      "--model", NAMING_MODEL,
      "--no-session",
      "--no-extensions",
      "--no-tools",
      "--no-skills",
      "--no-prompt-templates",
      "--system-prompt",
      "Summarize what was just done in 3-8 words for a sidebar status. No quotes, no periods. Examples: 'Added cmux extension + tests', 'Fixed auth redirect bug', 'Refactored DB queries', 'Waiting for deploy config'",
    ], {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 10000,
      env: { ...process.env, [CMUX_CHILD_ENV]: "1" },
    });

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.stdin?.write(`Project: ${dirName}\nAssistant just said:\n${truncated}`);
    child.stdin?.end();

    child.on("close", () => {
      const summary = output.trim().slice(0, 50);
      if (summary && summary.length > 1) {
        cmuxSafe("set-status", STATUS_KEY, summary, "--icon", "pause.circle.fill", "--color", "#8E8E93");
      }
    });
  } catch {
    // Fall through — status stays as Idle from the sync call
  }
}

// ── Tool description helper ────────────────────────────

function describeToolUse(toolName: string, args: any): string {
  switch (toolName) {
    case "read":
      return `Reading ${shortenPath(args.path || "")}`;
    case "edit":
      return `Editing ${shortenPath(args.path || "")}`;
    case "write":
      return `Writing ${shortenPath(args.path || "")}`;
    case "bash": {
      const cmd = args.command || "";
      const first = cmd.split(/\s/)[0] || cmd;
      return `Running ${first.slice(0, 30)}`;
    }
    case "grep":
      return `Searching ${args.pattern || ""}`.slice(0, 40);
    case "find":
      return `Finding ${args.pattern || ""}`.slice(0, 40);
    case "web_search":
      return `Searching web`;
    case "codex":
      return `Spawning codex`;
    default:
      return `Using ${toolName}`;
  }
}

function shortenPath(p: string): string {
  const home = process.env.HOME || "";
  if (home && p.startsWith(home)) p = "~" + p.slice(home.length);
  const parts = p.split("/");
  if (parts.length > 3) return "…/" + parts.slice(-2).join("/");
  return p;
}

// ── Extension ──────────────────────────────────────────

export default function cmuxExtension(pi: ExtensionAPI) {
  if (process.env[CMUX_CHILD_ENV] === "1") return;
  if (!hasCmux()) return; // silently skip when not in cmux

  // Detect peon-ping on load
  peonPath = detectPeonPing();

  // ── Lifecycle: session start — just set idle, no log spam ──
  pi.on("session_start", async (_event, ctx) => {
    _pendingSessionName = null;
    _hasNamedSession = Boolean(pi.getSessionName());
    setStatus(STATUS_IDLE);
  });

  // ── Lifecycle: first prompt → auto-name session ──
  pi.on("before_agent_start", async (event, ctx) => {
    // Name the session from the first user prompt
    if (!_hasNamedSession && event.prompt) {
      _hasNamedSession = true;

      // If session already has a name (e.g. from /continue), skip
      const existing = pi.getSessionName();
      if (!existing) {
        generateSessionName(event.prompt, ctx.cwd);
      }
    }
  });

  // ── Lifecycle: agent running ──
  pi.on("agent_start", async () => {
    setStatus(STATUS_RUNNING);

    // Apply pending session name from async haiku call
    if (_pendingSessionName) {
      pi.setSessionName(_pendingSessionName);
      // Also update cmux workspace title
      cmuxSafe("rename-workspace", _pendingSessionName);
      _pendingSessionName = null;
    }
  });

  // ── Lifecycle: tool execution (verbose mode) ──
  pi.on("tool_execution_start", async (event) => {
    if (!VERBOSE_STATUS) return;
    const desc = describeToolUse(event.toolName, event.args);
    cmuxSafe("set-status", STATUS_KEY, desc, "--icon", "bolt.fill", "--color", "#4C8DFF");
  });

  // ── Lifecycle: agent done → idle + summary, peon-ping ──
  pi.on("agent_end", async (event, ctx) => {
    // Set idle immediately (summary will overwrite async)
    setStatus(STATUS_IDLE);

    // Extract last assistant message text for summary
    let lastAssistantText = "";
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const msg = event.messages[i] as any;
      if (msg.role === "assistant" && msg.content) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            lastAssistantText = block.text;
            break;
          }
        }
        if (lastAssistantText) break;
      }
    }

    // Async: generate tiny summary for sidebar
    generateTurnSummary(lastAssistantText, ctx.cwd);

    // Play peon-ping sound if available
    playPeonPing("stop");
  });

  // ── Lifecycle: session shutdown ──
  pi.on("session_shutdown", async () => {
    _pendingSessionName = null;
    _hasNamedSession = false;
    clearStatus();
    cmuxSafe("clear-progress");
  });

  // ── System prompt: encourage session naming ──
  pi.on("context", async () => {
    // Apply pending name if it arrived between turns
    if (_pendingSessionName) {
      pi.setSessionName(_pendingSessionName);
      cmuxSafe("rename-workspace", _pendingSessionName);
      _pendingSessionName = null;
    }
  });

  // ────────────────────────────────────────────────────────
  // Tool: cmux — workspace/pane/surface control
  // ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "cmux",
    label: "cmux",
    description: [
      "Control the cmux terminal multiplexer. Actions:",
      "• tree — show workspace/pane/surface hierarchy",
      "• identify — which workspace/surface pi is running in",
      "• list-workspaces — list all workspaces",
      "• read-screen — read terminal content from any surface (--surface, --lines, --scrollback)",
      "• send — send text to a surface (--surface <ref> <text>)",
      "• send-key — send a key to a surface (--surface <ref> <key>)",
      "• new-workspace — create a workspace (--cwd <path>)",
      "• new-split — split pane (left|right|up|down)",
      "• new-pane — create pane (--type terminal|browser, --direction, --url)",
      "• select-workspace — switch workspace (--workspace <ref>)",
      "• close-surface — close a surface",
      "Use refs like surface:1, workspace:2, pane:3. Run 'tree' first to discover refs.",
    ].join("\n"),
    parameters: Type.Object({
      action: Type.String({ description: "cmux command: tree, identify, list-workspaces, read-screen, send, send-key, new-workspace, new-split, new-pane, select-workspace, close-surface, list-panes" }),
      args: Type.Optional(Type.Array(Type.String(), { description: "Additional arguments for the command" })),
    }),

    async execute(_id, params) {
      const action = params.action;
      const args = params.args || [];

      // Allowlist of safe commands
      const allowed = new Set([
        "tree", "identify", "list-workspaces", "current-workspace",
        "read-screen", "send", "send-key",
        "new-workspace", "new-split", "new-pane", "new-surface",
        "select-workspace", "close-surface", "close-workspace",
        "list-panes", "list-pane-surfaces",
        "focus-pane", "rename-workspace",
        "surface-health",
      ]);

      if (!allowed.has(action)) {
        return {
          content: [{ type: "text", text: `Unknown or disallowed action: ${action}\nAllowed: ${[...allowed].join(", ")}` }],
          isError: true,
        };
      }

      try {
        const result = cmux(action, ...args);
        return { content: [{ type: "text", text: result || "OK" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    },

    renderCall(args, theme) {
      const cmdArgs = args.args?.length ? " " + args.args.join(" ") : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("cmux")) + " " + theme.fg("accent", args.action) + theme.fg("dim", cmdArgs),
        0, 0,
      );
    },

    renderResult(result, _opts, theme) {
      const txt = result.content[0];
      const text = txt?.type === "text" ? txt.text : "";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const lines = text.split("\n");
      const preview = lines.slice(0, 5).join("\n");
      const suffix = lines.length > 5 ? theme.fg("dim", `\n… ${lines.length - 5} more lines`) : "";
      return new Text(`${icon} ${preview}${suffix}`, 0, 0);
    },
  });

  // ────────────────────────────────────────────────────────
  // Tool: cmux_status — sidebar status, progress, logs
  // ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "cmux_status",
    label: "cmux Status",
    description: [
      "Set cmux sidebar status, progress bar, or log entries.",
      "Actions:",
      "• set-status <key> <value> — set a status entry (optional: icon, color)",
      "• clear-status <key> — clear a status entry",
      "• set-progress <0.0-1.0> — set progress bar (optional: label)",
      "• clear-progress — clear progress bar",
      "• log <message> — add a log entry (optional: level info|warn|error)",
      "• clear-log — clear all log entries",
      "• sidebar-state — get current sidebar state",
    ].join("\n"),
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("set-status"),
        Type.Literal("clear-status"),
        Type.Literal("set-progress"),
        Type.Literal("clear-progress"),
        Type.Literal("log"),
        Type.Literal("clear-log"),
        Type.Literal("sidebar-state"),
      ]),
      key: Type.Optional(Type.String({ description: "Status key (for set-status/clear-status)" })),
      value: Type.Optional(Type.String({ description: "Status value or progress (0.0-1.0) or log message" })),
      icon: Type.Optional(Type.String({ description: "SF Symbol name (e.g. bolt.fill, checkmark.circle)" })),
      color: Type.Optional(Type.String({ description: "Hex color (e.g. #4C8DFF)" })),
      level: Type.Optional(Type.Union([
        Type.Literal("info"),
        Type.Literal("warn"),
        Type.Literal("error"),
      ], { description: "Log level" })),
      label: Type.Optional(Type.String({ description: "Progress bar label" })),
    }),

    async execute(_id, params) {
      try {
        switch (params.action) {
          case "set-status": {
            if (!params.key || !params.value)
              return { content: [{ type: "text", text: "set-status requires key and value" }], isError: true };
            const args = ["set-status", params.key, params.value];
            if (params.icon) args.push("--icon", params.icon);
            if (params.color) args.push("--color", params.color);
            cmux(...args);
            return { content: [{ type: "text", text: `Status ${params.key}=${params.value}` }] };
          }
          case "clear-status": {
            if (!params.key)
              return { content: [{ type: "text", text: "clear-status requires key" }], isError: true };
            cmux("clear-status", params.key);
            return { content: [{ type: "text", text: `Cleared ${params.key}` }] };
          }
          case "set-progress": {
            if (!params.value)
              return { content: [{ type: "text", text: "set-progress requires value (0.0-1.0)" }], isError: true };
            const args = ["set-progress", params.value];
            if (params.label) args.push("--label", params.label);
            cmux(...args);
            return { content: [{ type: "text", text: `Progress: ${params.value}${params.label ? ` (${params.label})` : ""}` }] };
          }
          case "clear-progress":
            cmux("clear-progress");
            return { content: [{ type: "text", text: "Progress cleared" }] };
          case "log": {
            if (!params.value)
              return { content: [{ type: "text", text: "log requires a message" }], isError: true };
            const args = ["log"];
            if (params.level) args.push("--level", params.level);
            args.push("--source", "pi", "--", params.value);
            cmux(...args);
            return { content: [{ type: "text", text: `Logged: ${params.value}` }] };
          }
          case "clear-log":
            cmux("clear-log");
            return { content: [{ type: "text", text: "Log cleared" }] };
          case "sidebar-state": {
            const result = cmux("sidebar-state");
            return { content: [{ type: "text", text: result }] };
          }
        }
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    },

    renderCall(args, theme) {
      const parts = [args.action];
      if (args.key) parts.push(args.key);
      if (args.value) parts.push(args.value);
      return new Text(
        theme.fg("toolTitle", theme.bold("cmux_status")) + " " + theme.fg("dim", parts.join(" ")),
        0, 0,
      );
    },

    renderResult(result, _opts, theme) {
      const txt = result.content[0];
      const text = txt?.type === "text" ? txt.text : "";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      return new Text(`${icon} ${text}`, 0, 0);
    },
  });

  // ────────────────────────────────────────────────────────
  // Tool: cmux_notify — native notifications
  // ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "cmux_notify",
    label: "cmux Notify",
    description: "Send a native macOS notification via cmux. Use to alert the user about completed tasks, errors, or anything requiring attention.",
    parameters: Type.Object({
      title: Type.String({ description: "Notification title" }),
      body: Type.Optional(Type.String({ description: "Notification body text" })),
      subtitle: Type.Optional(Type.String({ description: "Notification subtitle" })),
    }),

    async execute(_id, params) {
      try {
        notify(params.title, params.body, params.subtitle);
        return { content: [{ type: "text", text: `Notification sent: ${params.title}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("cmux_notify")) + " " + theme.fg("dim", args.title),
        0, 0,
      );
    },

    renderResult(result, _opts, theme) {
      const txt = result.content[0];
      const text = txt?.type === "text" ? txt.text : "";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "🔔");
      return new Text(`${icon} ${text}`, 0, 0);
    },
  });
}
