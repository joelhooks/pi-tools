/**
 * inbox-watcher — Background agent dispatch + file-based result inbox.
 *
 * Dispatches work to Inngest via system/agent.requested events.
 * Watches ~/.joelclaw/workspace/inbox/ for result files.
 * Status shown in widget — results update silently.
 */

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

// ── Types ───────────────────────────────────────────────

interface InboxPayload {
  status?: string;
  task?: string;
  result?: string;
  error?: string;
  tool?: string;
  requestId?: string;
}

interface TrackedRequest {
  requestId: string;
  task: string;
  tool: string;
  status: "dispatched" | "done" | "error";
  dispatchedAt: number;
  completedAt: number | null;
  result: string | null;
  error: string | null;
}

// ── State ───────────────────────────────────────────────

const HOME = os.homedir();
const INBOX_DIR = path.join(HOME, ".joelclaw", "workspace", "inbox");
const ACK_DIR = path.join(INBOX_DIR, "ack");
const DEFAULT_INNGEST_URL = process.env.INNGEST_URL ?? "http://localhost:8288";
const DEFAULT_INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY ?? "37aa349b89692d657d276a40e0e47a15";
const BACKGROUND_TOOLS = ["codex", "claude", "pi"] as const;

const tracked = new Map<string, TrackedRequest>();
let widgetTui: { requestRender: () => void } | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
const COMPLETED_LINGER_MS = 15_000;

// ── Formatting ──────────────────────────────────────────

function elapsedSince(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
}

function preview(text: unknown, max = 180): string {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return "(no result)";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// ── Widget ──────────────────────────────────────────────

function refreshWidget(): void {
  widgetTui?.requestRender();
}

function ensureStatusTimer(): void {
  if (statusTimer) return;
  statusTimer = setInterval(() => {
    const now = Date.now();
    const hasVisible = [...tracked.values()].some(
      (t) => t.status === "dispatched" || (t.completedAt && now - t.completedAt < COMPLETED_LINGER_MS),
    );
    if (hasVisible) {
      refreshWidget();
    } else {
      stopStatusTimer();
      refreshWidget();
    }
  }, 1000);
}

function stopStatusTimer(): void {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

function renderWidget(theme: any): string[] {
  const now = Date.now();
  const visible = [...tracked.values()].filter(
    (t) => t.status === "dispatched" || (t.completedAt && now - t.completedAt < COMPLETED_LINGER_MS),
  );
  if (visible.length === 0) return [];

  return visible.map((t) => {
    const icon =
      t.status === "dispatched"
        ? theme.fg("warning", "◆")
        : t.status === "done"
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");
    const elapsed = elapsedSince(t.dispatchedAt);
    const rid = t.requestId.slice(0, 12);

    let snippet: string;
    if (t.status !== "dispatched" && (t.result || t.error)) {
      const raw = t.error || t.result || "";
      const firstLine = raw.split("\n").find((l) => l.trim()) || "";
      snippet = firstLine.length > 45 ? firstLine.slice(0, 42) + "…" : firstLine;
    } else {
      snippet = t.task.length > 45 ? t.task.slice(0, 42) + "…" : t.task;
    }

    return `${icon} ${theme.fg("text", rid)} ${theme.fg("dim", `${t.tool} · ${elapsed}`)} ${theme.fg("muted", snippet)}`;
  });
}

// ── Inbox processing ────────────────────────────────────

function ensureDirs(): void {
  try {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    fs.mkdirSync(ACK_DIR, { recursive: true });
  } catch {}
}

function moveToAck(filename: string): void {
  try {
    fs.renameSync(path.join(INBOX_DIR, filename), path.join(ACK_DIR, filename));
  } catch {}
}

function processInboxFile(pi: ExtensionAPI, filename: string): void {
  if (!filename.endsWith(".json")) return;
  const filePath = path.join(INBOX_DIR, filename);

  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  let payload: InboxPayload;
  try {
    payload = JSON.parse(raw) as InboxPayload;
  } catch {
    return;
  }

  // Update tracked request if we know about it
  if (payload.requestId && tracked.has(payload.requestId)) {
    const req = tracked.get(payload.requestId)!;
    req.status = payload.error ? "error" : "done";
    req.completedAt = Date.now();
    req.result = payload.result || null;
    req.error = payload.error || null;
    refreshWidget();
  }

  // Send result to model silently
  const status = payload.status || "unknown";
  const task = payload.task || "(no task)";
  const resultText = payload.error || payload.result || "";
  const toolText = payload.tool ? ` (${payload.tool})` : "";
  const ridText = payload.requestId ? ` [${payload.requestId.slice(0, 12)}]` : "";

  pi.sendMessage(
    {
      customType: "background-result",
      content: `Background task ${status}${toolText}${ridText}\nTask: ${task}\nResult: ${preview(resultText)}`,
      display: false,
      details: {
        requestId: payload.requestId,
        status,
        task,
        tool: payload.tool,
        result: resultText,
      },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );

  moveToAck(filename);
}

// ── Inngest dispatch ────────────────────────────────────

function inngestEventUrl(): string {
  return `${DEFAULT_INNGEST_URL.replace(/\/+$/, "")}/e/${DEFAULT_INNGEST_EVENT_KEY}`;
}

function generateRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "").slice(0, 21)}`;
}

function extractSessionId(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const sessionId = (ctx as any).sessionId;
  if (typeof sessionId === "string" && sessionId.trim()) return sessionId.trim();
  const sessionManager = (ctx as any).sessionManager;
  if (sessionManager?.getSessionName) {
    try {
      const value = sessionManager.getSessionName();
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {}
  }
  return undefined;
}

// ── Extension ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let watcher: fs.FSWatcher | null = null;

  // ── Widget lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWidget("background-agents", (tui, theme) => {
      widgetTui = tui;
      return {
        render: () => renderWidget(theme),
        invalidate: () => {},
        dispose: () => {
          stopStatusTimer();
          widgetTui = null;
        },
      };
    });

    // Drain existing inbox files
    ensureDirs();
    try {
      for (const filename of fs.readdirSync(INBOX_DIR)) {
        processInboxFile(pi, filename);
      }
    } catch {}

    // Watch for new results
    if (!watcher) {
      try {
        watcher = fs.watch(INBOX_DIR, (eventType, filename) => {
          if (eventType !== "rename") return;
          const name = filename?.toString();
          if (!name?.endsWith(".json")) return;
          processInboxFile(pi, name);
        });
      } catch {}
    }
  });

  // ── background_agent tool ─────────────────────────────

  pi.registerTool({
    name: "background_agent",
    label: "Background Agent",
    description: "Dispatch background work by sending system/agent.requested to Inngest and returning immediately.",
    parameters: Type.Object({
      task: Type.String({ description: "Task prompt for the background agent." }),
      tool: Type.Optional(StringEnum(["codex", "claude", "pi"] as const, { default: "codex" })),
      cwd: Type.Optional(Type.String({ description: "Optional working directory override." })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 600).", default: 600 })),
      model: Type.Optional(Type.String({ description: "Optional model override for the target agent." })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const task = params.task?.trim();
      if (!task) {
        return { content: [{ type: "text", text: "background_agent: `task` is required." }], isError: true };
      }

      const tool = params.tool || "codex";
      const timeout = params.timeout ?? 600;
      const requestId = generateRequestId();
      const sessionId = extractSessionId(ctx);
      const cwd = params.cwd?.trim() || (ctx as any).cwd || undefined;
      const model = params.model?.trim() || undefined;

      // Track the request
      tracked.set(requestId, {
        requestId,
        task,
        tool,
        status: "dispatched",
        dispatchedAt: Date.now(),
        completedAt: null,
        result: null,
        error: null,
      });
      ensureStatusTimer();
      refreshWidget();

      // Dispatch to Inngest
      const data: Record<string, unknown> = { requestId, task, tool, timeout };
      if (cwd) data.cwd = cwd;
      if (model) data.model = model;
      if (sessionId) data.sessionId = sessionId;

      fetch(inngestEventUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "system/agent.requested", data }),
      }).catch(() => {});

      return {
        content: [{ type: "text", text: `Dispatched ${requestId.slice(0, 12)} (${tool}). Status in widget.` }],
        details: { requestId, tool, task },
      };
    },

    renderCall(args, theme) {
      const tool = args.tool || "codex";
      let text_str = theme.fg("toolTitle", theme.bold("background_agent"));
      text_str += " " + theme.fg("dim", tool);
      if (args.model) text_str += theme.fg("dim", ` · ${args.model}`);
      const taskSnip = args.task?.length > 80 ? args.task.slice(0, 77) + "…" : args.task || "";
      text_str += "\n" + theme.fg("dim", `  ${taskSnip}`);
      return new Text(text_str, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as any;
      if (!d?.requestId) {
        const txt = result.content[0];
        return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
      }

      const req = tracked.get(d.requestId);
      const icon = !req || req.status === "dispatched" ? theme.fg("warning", "◆") : req.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const rid = d.requestId.slice(0, 12);
      return new Text(`${icon} ${theme.fg("toolTitle", theme.bold(rid))} ${theme.fg("dim", d.tool)} ${theme.fg("muted", "dispatched")}`, 0, 0);
    },
  });

  // ── Message renderer for inbox results ────────────────

  pi.registerMessageRenderer<any>("background-result", (message, { expanded }, theme) => {
    const d = message.details;
    if (!d) return undefined;

    const icon = d.status === "error" ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const rid = d.requestId ? d.requestId.slice(0, 12) : "?";
    const toolTag = d.tool ? theme.fg("dim", ` ${d.tool}`) : "";

    let header = `${icon} ${theme.fg("toolTitle", theme.bold(rid))}${toolTag} ${theme.fg("dim", d.status)}`;

    if (expanded && d.result) {
      const resultSnip = d.result.length > 500 ? d.result.slice(0, 497) + "…" : d.result;
      header += `\n${theme.fg("muted", resultSnip)}`;
    } else if (!expanded && d.result) {
      const firstLine = d.result.split("\n").find((l: string) => l.trim()) || "";
      const snip = firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine;
      if (snip) header += `  ${theme.fg("muted", snip)}`;
    }

    return new Text(header, 1, 0);
  });
}
