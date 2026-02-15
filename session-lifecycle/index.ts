// Session Lifecycle - auto-briefing, pre-compaction flush, shutdown handoff.
//
// Eliminates manual continuation prompts by automatically injecting
// system context at session start, preserving key context before
// compaction, and writing handoff notes on session end.
//
// Hooks:
//   session_start          - initialize session tracking state
//   before_agent_start     - inject briefing (first turn) + system prompt awareness (every turn)
//   session_before_compact - flush metadata to daily log before summarization
//   session_shutdown       - auto-name session, write handoff to daily log
//
// Reads:
//   ~/.joelclaw/workspace/MEMORY.md              - curated long-term memory
//   ~/.joelclaw/workspace/memory/YYYY-MM-DD.md   - today's daily log
//   ~/Vault/system/system-log.jsonl              - recent slog entries
//   ~/Vault/Projects/*/index.md                  - active project status
//
// Writes:
//   ~/.joelclaw/workspace/memory/YYYY-MM-DD.md   - compaction flush + session handoff

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── Paths ───────────────────────────────────────────────────────────

const HOME = os.homedir();
const VAULT = path.join(HOME, "Vault");
const MEMORY_MD = path.join(HOME, ".joelclaw", "workspace", "MEMORY.md");
const MEMORY_DIR = path.join(HOME, ".joelclaw", "workspace", "memory");
const SLOG_PATH = path.join(VAULT, "system", "system-log.jsonl");
const PROJECTS_DIR = path.join(VAULT, "Projects");

// ── Helpers ─────────────────────────────────────────────────────────

function readSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function dailyLogPath(): string {
  return path.join(MEMORY_DIR, `${todayStr()}.md`);
}

function appendToDaily(text: string): void {
  const p = dailyLogPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, text, "utf-8");
  } catch {}
}

function timeStamp(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function recentSlog(count = 5): string[] {
  const content = readSafe(SLOG_PATH);
  if (!content) return [];
  const lines = content.trim().split("\n").filter(Boolean);
  return lines.slice(-count).map((line) => {
    try {
      const e = JSON.parse(line);
      const ts = e.timestamp?.slice(0, 16) || "?";
      return `- ${ts} \`${e.action}\` **${e.tool}**: ${e.detail}`;
    } catch {
      return `- ${line.slice(0, 100)}`;
    }
  });
}

function activeProjects(): string[] {
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    return dirs
      .filter((d) => d.isDirectory())
      .map((d) => {
        const content = readSafe(path.join(PROJECTS_DIR, d.name, "index.md"));
        if (!content) return null;
        const status = content.match(/status:\s*(.+)/)?.[1]?.trim();
        if (!status || status === "archived" || status === "done") return null;
        const title = content.match(/^#\s+(.+)/m)?.[1] || d.name;
        return `- **${d.name}**: ${title} (${status})`;
      })
      .filter(Boolean) as string[];
  } catch {
    return [];
  }
}

// ── Static system prompt awareness (same every turn → cacheable) ──

function currentTimestamp(): string {
  return new Date().toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

const LIFECYCLE_AWARENESS = `
## Session Lifecycle (auto-managed)

This session is managed by the session-lifecycle extension. What's automated:
- **Session briefing**: MEMORY.md, today's daily log, recent slog entries, and active Vault projects were auto-injected at session start as a custom message.
- **Pre-compaction flush**: Before compaction, file operations and session metadata are auto-flushed to the daily log (~/.joelclaw/workspace/memory/YYYY-MM-DD.md).
- **Shutdown handoff**: On session end, a handoff note is auto-written to the daily log and the session is auto-named.

Behavioral rules:
- Do NOT tell the user to "read MEMORY.md first" or write manual continuation/handoff files — it's handled.
- Do NOT re-read MEMORY.md or the daily log unless the user asks or you need to verify something changed mid-session.
- When you make a key decision, learn a hard-won debugging insight, or discover a user preference, call it out explicitly — compaction preserves file metadata but conversation nuance can be lost.
- If the session briefing is present above, treat it as authoritative system state.
`.trim();

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let hasBriefed = false;
  let sessionStartTime = Date.now();
  let userMessageCount = 0;
  let firstUserMessage = "";

  // ── session_start: reset tracking state ─────────────────────

  pi.on("session_start", async () => {
    hasBriefed = false;
    sessionStartTime = Date.now();
    userMessageCount = 0;
    firstUserMessage = "";
  });

  // ── before_agent_start: briefing + awareness ────────────────

  pi.on("before_agent_start", async (event) => {
    userMessageCount++;

    // Capture first user message for auto-naming
    if (!firstUserMessage && event.prompt) {
      firstUserMessage =
        typeof event.prompt === "string"
          ? event.prompt.slice(0, 200)
          : "";
    }

    // System prompt awareness goes on every turn (re-applied, not accumulated)
    // Includes dynamic timestamp (replaces system-context.ts custom_message which was persisted per-turn)
    const systemPrompt = event.systemPrompt + "\n\n" + LIFECYCLE_AWARENESS +
      `\n\n[Current time: ${currentTimestamp()}]` +
      `\n[Remember: log infrastructure changes only (installs, service restarts, config edits, tool setup) with \`slog write --action ACTION --tool TOOL --detail "what" --reason "why"\` — do NOT slog routine file edits, code changes, or content writes]`;

    // Session briefing only on first turn
    if (hasBriefed) {
      return { systemPrompt };
    }
    hasBriefed = true;

    // Build briefing from live system state
    const sections: string[] = [];

    const memory = readSafe(MEMORY_MD);
    if (memory) {
      sections.push("## Curated Memory\n\n" + memory.trim());
    }

    const daily = readSafe(dailyLogPath());
    if (daily) {
      sections.push("## Today's Log\n\n" + daily.trim());
    }

    const slog = recentSlog(5);
    if (slog.length > 0) {
      sections.push("## Recent System Activity\n\n" + slog.join("\n"));
    }

    const projects = activeProjects();
    if (projects.length > 0) {
      sections.push("## Active Vault Projects\n\n" + projects.join("\n"));
    }

    if (sections.length === 0) {
      return { systemPrompt };
    }

    return {
      systemPrompt,
      message: {
        customType: "session-briefing",
        content: "# Session Briefing (auto-injected)\n\n" + sections.join("\n\n"),
        display: false,
      },
    };
  });

  // ── session_before_compact: flush to daily log ──────────────

  pi.on("session_before_compact", async (event) => {
    const { preparation } = event;

    const msgCount = preparation.messagesToSummarize?.length || 0;
    const tokensBefore = preparation.tokensBefore || 0;
    const fileOps = preparation.fileOps;
    // fileOps has .read (Set) and .edited (Set), not .readFiles/.modifiedFiles
    const readFiles = fileOps?.read ? [...fileOps.read] : [];
    const modifiedFiles = fileOps?.edited ? [...fileOps.edited] : [];

    const lines = [
      `\n### ⚡ Compaction (${timeStamp()})`,
      `${msgCount} messages summarized, ${tokensBefore.toLocaleString()} tokens reclaimed.`,
    ];

    if (modifiedFiles.length > 0) {
      lines.push(`**Modified**: ${modifiedFiles.join(", ")}`);
    }
    if (readFiles.length > 0) {
      const shown = readFiles.slice(0, 10);
      const more = readFiles.length > 10 ? ` (+${readFiles.length - 10} more)` : "";
      lines.push(`**Read**: ${shown.join(", ")}${more}`);
    }
    if (preparation.previousSummary) {
      // Preserve the gist of what was already summarized
      const gist = preparation.previousSummary.slice(0, 300).replace(/\n/g, " ");
      lines.push(`**Prior context**: ${gist}...`);
    }

    appendToDaily(lines.join("\n") + "\n");

    // Return nothing — let default compaction proceed
  });

  // ── session_shutdown: auto-name + handoff ───────────────────

  pi.on("session_shutdown", async () => {
    // Auto-name if unnamed
    const existingName = pi.getSessionName();
    if (!existingName && firstUserMessage) {
      const autoName = firstUserMessage
        .replace(/^(continue|review|check|kick off|pick up|read|look at)[:\s]*/i, "")
        .replace(/~\/(Vault|Code)\/[^\s]+/g, (m) => {
          const parts = m.split("/");
          return parts.slice(-2).join("/");
        })
        .replace(/\n.*/s, "") // first line only
        .slice(0, 60)
        .trim();

      if (autoName) {
        pi.setSessionName(autoName);
      }
    }

    // Write handoff to daily log
    const duration = Math.round((Date.now() - sessionStartTime) / 60000);
    const sessionName =
      pi.getSessionName() || firstUserMessage.slice(0, 60) || "unnamed session";

    const handoff = [
      `\n### 📋 Session ended (${timeStamp()})`,
      `**${sessionName}** — ${duration}min, ${userMessageCount} messages`,
    ];

    appendToDaily(handoff.join("\n") + "\n");
  });
}
