/**
 * Pi extension: Herdr Monitor
 *
 * Watch another Herdr pane (agent session) from inside a Pi session without
 * attaching to it. Polls `herdr agent get` / `herdr agent read` on an
 * interval, surfaces status (working/idle/blocked/done/unknown) + last
 * line in a compact status-bar widget, and can pop/focus the pane.
 *
 * Read-only against the target pane: never sends input, never runs
 * `report-agent` or anything that mutates the watched agent's state.
 *
 * Commands:
 *   /herdr-panes           List Herdr panes/agents (read-only snapshot)
 *   /herdr-watch [target]  Start watching a pane (prompts to pick if no target)
 *   /herdr-unwatch [target] Stop watching (all, or one pane if multiple watched)
 *   /herdr-focus [target]  Focus/pop the watched (or given) pane in Herdr
 *   /herdr-peek [target]   One-off dump of recent lines from a pane
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const POLL_MS = Number(process.env.HERDR_MONITOR_INTERVAL_MS || 8000);
const MAX_CONSECUTIVE_ERRORS = 3;

type AgentStatus = "working" | "idle" | "blocked" | "done" | "unknown" | "error";

interface PaneRow {
  pane_id: string;
  agent?: string;
  name?: string;
  agent_status?: string;
  cwd?: string;
  label?: string; // some herdr builds use "label" instead of "name"
}

interface WatchEntry {
  paneId: string;
  displayName: string;
  status: AgentStatus;
  lastLine: string;
  lastCheckedAt: number;
  lastChangedAt: number;
  consecutiveErrors: number;
  errorMessage?: string;
}

const watched = new Map<string, WatchEntry>();
let widgetTui: { requestRender: () => void } | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function runHerdr(args: string[]): { ok: true; data: any } | { ok: false; error: string } {
  try {
    const res = spawnSync("herdr", args, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    if (res.error) return { ok: false, error: res.error.message };
    const out = (res.stdout || "").trim();
    if (!out) return { ok: false, error: (res.stderr || "empty output").trim().slice(0, 200) };
    const parsed = JSON.parse(out);
    if (parsed?.error) return { ok: false, error: typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error).slice(0, 200) };
    return { ok: true, data: parsed?.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function listPanes(): PaneRow[] {
  const res = runHerdr(["pane", "list"]);
  if (!res.ok) return [];
  return (res.data?.panes || []) as PaneRow[];
}

function paneDisplayName(p: PaneRow): string {
  return p.name || p.label || `${p.agent || "?"} ${p.pane_id}`;
}

function statusIcon(status: AgentStatus): string {
  switch (status) {
    case "working": return "⚡";
    case "idle": return "💤";
    case "blocked": return "🛑";
    case "done": return "✅";
    case "error": return "⚠️";
    default: return "❓";
  }
}

// Strip prompt-box chrome (rules, bare "❯", permission hint lines) and
// return the last meaningful line of text, truncated.
function extractLastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^[─—-]{3,}$/.test(l))
    .filter((l) => l !== "❯")
    .filter((l) => !/bypass permissions on|esc to (interrupt|cancel)|enter to select/i.test(l));
  const last = lines[lines.length - 1] || "";
  return truncateToWidth(last, 90);
}

function refreshOne(entry: WatchEntry) {
  const getRes = runHerdr(["agent", "get", entry.paneId]);
  if (!getRes.ok) {
    entry.consecutiveErrors++;
    entry.status = "error";
    entry.errorMessage = getRes.error;
    entry.lastCheckedAt = Date.now();
    return;
  }
  entry.consecutiveErrors = 0;
  entry.errorMessage = undefined;
  const agent = getRes.data?.agent as PaneRow | undefined;
  const newStatus = ((agent?.agent_status as AgentStatus) || "unknown") as AgentStatus;
  if (newStatus !== entry.status) entry.lastChangedAt = Date.now();
  entry.status = newStatus;
  if (agent) entry.displayName = paneDisplayName(agent);

  const readRes = runHerdr(["agent", "read", entry.paneId, "--lines", "8"]);
  if (readRes.ok) {
    const text = readRes.data?.read?.text || "";
    entry.lastLine = extractLastLine(text);
  }
  entry.lastCheckedAt = Date.now();
}

function pollAll() {
  for (const [id, entry] of watched) {
    refreshOne(entry);
    if (entry.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      watched.delete(id);
    }
  }
  widgetTui?.requestRender();
  if (watched.size === 0 && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function ensurePolling() {
  if (!pollTimer) {
    pollTimer = setInterval(pollAll, POLL_MS);
  }
}

function ageStr(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function renderWidget(): string[] {
  if (watched.size === 0) return [];
  const width = 100;
  const lines: string[] = [`  🐑 Herdr: ${watched.size} watched`];
  const now = Date.now();
  for (const entry of watched.values()) {
    const icon = statusIcon(entry.status);
    const age = ageStr(now - entry.lastCheckedAt);
    const detail = entry.status === "error" ? `error: ${entry.errorMessage}` : entry.lastLine;
    lines.push(truncateToWidth(`  ${icon} ${entry.displayName} (${entry.paneId})  checked ${age} ago  — ${detail}`, width));
  }
  return lines;
}

async function pickPaneId(pi: ExtensionAPI, ctx: any, promptTitle: string): Promise<string | null> {
  const panes = listPanes();
  if (panes.length === 0) {
    ctx.ui.notify("No Herdr panes found (herdr pane list returned empty)", "warning");
    return null;
  }
  const items = panes.map(
    (p) => `${p.pane_id}  [${p.agent_status || "unknown"}]  ${paneDisplayName(p)}  ${p.cwd || ""}`,
  );
  const selected = await ctx.ui.select(promptTitle, items);
  if (!selected) return null;
  return selected.split(/\s+/)[0];
}

function resolveWatchTarget(args: string, fallbackToSoleWatched: boolean): string | null {
  const t = args.trim();
  if (t) return t;
  if (fallbackToSoleWatched && watched.size === 1) return [...watched.keys()][0];
  return null;
}

export default function herdrMonitor(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWidget("herdr-monitor", (tui: { requestRender: () => void }) => {
      widgetTui = tui;
      return {
        render: () => renderWidget(),
        invalidate: () => {},
        dispose: () => {
          widgetTui = null;
        },
      };
    });
  });

  pi.registerCommand("herdr-panes", {
    description: "List Herdr panes/agents (read-only)",
    handler: async (_args, ctx) => {
      const panes = listPanes();
      if (panes.length === 0) {
        ctx.ui.notify("No Herdr panes found", "warning");
        return;
      }
      const lines = panes
        .map((p) => `${statusIcon(((p.agent_status as AgentStatus) || "unknown"))} ${p.pane_id}  ${paneDisplayName(p)}  ${p.cwd || ""}`)
        .join("\n");
      ctx.ui.notify(lines.slice(0, 1800), "info");
    },
  });

  pi.registerCommand("herdr-watch", {
    description: "Watch a Herdr pane's agent status (polls in background)",
    handler: async (args, ctx) => {
      let paneId = args.trim();
      if (!paneId) {
        const picked = await pickPaneId(pi, ctx, "Watch which Herdr pane?");
        if (!picked) return;
        paneId = picked;
      }
      const getRes = runHerdr(["agent", "get", paneId]);
      if (!getRes.ok) {
        ctx.ui.notify(`Could not resolve target "${paneId}": ${getRes.error}`, "error");
        return;
      }
      const agent = getRes.data?.agent as PaneRow | undefined;
      const entry: WatchEntry = {
        paneId: agent?.pane_id || paneId,
        displayName: agent ? paneDisplayName(agent) : paneId,
        status: (agent?.agent_status as AgentStatus) || "unknown",
        lastLine: "",
        lastCheckedAt: Date.now(),
        lastChangedAt: Date.now(),
        consecutiveErrors: 0,
      };
      watched.set(entry.paneId, entry);
      ensurePolling();
      refreshOne(entry);
      widgetTui?.requestRender();
      ctx.ui.notify(`Watching ${entry.displayName} (${entry.paneId}) — polling every ${Math.round(POLL_MS / 1000)}s`, "info");
    },
  });

  pi.registerCommand("herdr-unwatch", {
    description: "Stop watching a Herdr pane (all, or the sole watched one)",
    handler: async (args, ctx) => {
      const target = resolveWatchTarget(args, true);
      if (!target) {
        if (watched.size === 0) {
          ctx.ui.notify("Nothing is being watched", "info");
          return;
        }
        const items = [...watched.values()].map((e) => `${e.paneId}  ${e.displayName}`);
        const selected = await ctx.ui.select("Stop watching which pane?", ["(all)", ...items]);
        if (!selected) return;
        if (selected === "(all)") {
          watched.clear();
        } else {
          watched.delete(selected.split(/\s+/)[0]);
        }
      } else {
        watched.delete(target);
      }
      widgetTui?.requestRender();
      if (watched.size === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      ctx.ui.notify("Updated watch list", "info");
    },
  });

  pi.registerCommand("herdr-focus", {
    description: "Focus/pop a Herdr pane (defaults to the sole watched pane)",
    handler: async (args, ctx) => {
      let target = resolveWatchTarget(args, true);
      if (!target) {
        const picked = await pickPaneId(pi, ctx, "Focus which Herdr pane?");
        if (!picked) return;
        target = picked;
      }
      const res = runHerdr(["agent", "focus", target]);
      if (!res.ok) {
        ctx.ui.notify(`Focus failed: ${res.error}`, "error");
        return;
      }
      ctx.ui.notify(`Focused ${target}`, "info");
    },
  });

  pi.registerCommand("herdr-peek", {
    description: "One-off: show recent lines from a Herdr pane",
    handler: async (args, ctx) => {
      let target = resolveWatchTarget(args, true);
      if (!target) {
        const picked = await pickPaneId(pi, ctx, "Peek at which Herdr pane?");
        if (!picked) return;
        target = picked;
      }
      const res = runHerdr(["agent", "read", target, "--lines", "15"]);
      if (!res.ok) {
        ctx.ui.notify(`Read failed: ${res.error}`, "error");
        return;
      }
      const text = (res.data?.read?.text || "").trim();
      ctx.ui.notify(text.slice(0, 1500) || "(empty)", "info");
    },
  });

  pi.on("session_shutdown", () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    watched.clear();
    widgetTui = null;
  });

  // Token-efficient summary hook for other extensions (e.g. a footer/header).
  (globalThis as any).__herdrMonitor = {
    watched,
    getSummary(): string {
      if (watched.size === 0) return "";
      return [...watched.values()]
        .map((e) => `${statusIcon(e.status)} ${e.displayName}`)
        .join("  ");
    },
  };
}
