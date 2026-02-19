/**
 * Session Reader — non-blocking background transcript parser.
 *
 * Discovers session files from pi, Claude Code, and Codex, then spawns
 * a background pi agent to read + summarize them.
 *
 * Status shown in persistent widget — no polling needed.
 *
 * Tools:
 *   sessions        — list recent sessions across all agents
 *   session_context  — spawn a background pi to parse a session and extract context
 *   session_tasks    — detailed task info (check widget first)
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

// ── Types ───────────────────────────────────────────────

interface SessionInfo {
  agent: "pi" | "claude" | "codex";
  id: string;
  path: string;
  cwd: string | null;
  date: Date;
  sizeBytes: number;
  preview: string;
}

interface ReaderTask {
  id: number;
  sessionInfo: SessionInfo;
  query: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt: number | null;
  output: string;
  proc: ChildProcess | null;
}

// ── State ───────────────────────────────────────────────

let nextTaskId = 1;
const readerTasks = new Map<number, ReaderTask>();
let widgetTui: { requestRender: () => void } | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
const COMPLETED_LINGER_MS = 15_000;

// ── Formatting ──────────────────────────────────────────

function elapsed(task: ReaderTask): string {
  const end = task.finishedAt ?? Date.now();
  const sec = Math.round((end - task.startedAt) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDate(d: Date): string {
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toISOString().slice(0, 10);
}

function shortSessionId(id: string): string {
  return id.length > 16 ? id.slice(0, 16) : id;
}

// ── Widget ──────────────────────────────────────────────

function refreshWidget(): void {
  widgetTui?.requestRender();
}

function ensureStatusTimer(): void {
  if (statusTimer) return;
  statusTimer = setInterval(() => {
    const now = Date.now();
    const hasVisible = [...readerTasks.values()].some(
      (t) => t.status === "running" || (t.finishedAt && now - t.finishedAt < COMPLETED_LINGER_MS),
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
  const visible = [...readerTasks.values()].filter(
    (t) => t.status === "running" || (t.finishedAt && now - t.finishedAt < COMPLETED_LINGER_MS),
  );
  if (visible.length === 0) return [];

  return visible.map((t) => {
    const icon =
      t.status === "running"
        ? theme.fg("warning", "◆")
        : t.status === "done"
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");
    // Show output snippet for completed, query snippet for running
    let snippet: string;
    if (t.status !== "running" && t.output) {
      const firstLine = t.output.split("\n").find((l) => l.trim()) || "";
      snippet = firstLine.length > 45 ? firstLine.slice(0, 42) + "…" : firstLine;
    } else {
      snippet = t.query.length > 45 ? t.query.slice(0, 42) + "…" : t.query;
    }
    return `${icon} ${theme.fg("text", `reader #${t.id}`)} ${theme.fg("dim", `${elapsed(t)} · ${t.sessionInfo.agent}`)} ${theme.fg("muted", snippet)}`;
  });
}

// ── Session discovery ───────────────────────────────────

function discoverPiSessions(limit: number): SessionInfo[] {
  const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
  if (!fs.existsSync(sessionsDir)) return [];

  const results: SessionInfo[] = [];
  const projectDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(sessionsDir, dir.name);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter(Boolean);

        let sessionCwd: string | null = null;
        let preview = "";
        let sessionId = file.replace(".jsonl", "");

        for (const line of lines.slice(0, 20)) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === "session") {
              sessionCwd = entry.cwd || null;
              if (entry.id) sessionId = entry.id;
            }
            if (entry.type === "message" && entry.message?.role === "user" && !preview) {
              const content = entry.message.content;
              if (Array.isArray(content)) {
                const textPart = content.find((c: any) => c.type === "text");
                if (textPart) preview = textPart.text.slice(0, 120);
              } else if (typeof content === "string") {
                preview = content.slice(0, 120);
              }
            }
          } catch {}
        }

        results.push({
          agent: "pi",
          id: sessionId,
          path: filePath,
          cwd: sessionCwd,
          date: stat.mtime,
          sizeBytes: stat.size,
          preview: preview || "(no preview)",
        });
      } catch {}
    }
  }

  return results.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, limit);
}

function discoverClaudeSessions(limit: number): SessionInfo[] {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return [];

  const results: SessionInfo[] = [];
  const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(projectsDir, dir.name);
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(dirPath, entry.name);

      try {
        const stat = fs.statSync(filePath);
        if (stat.size < 100) continue;

        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter(Boolean);

        let sessionCwd: string | null = null;
        let preview = "";
        const sessionId = entry.name.replace(".jsonl", "");
        const cwdFromDir = dir.name.replace(/^-/, "/").replace(/-/g, "/");
        sessionCwd = cwdFromDir;

        for (const line of lines.slice(0, 30)) {
          try {
            const e = JSON.parse(line);
            if (e.cwd) sessionCwd = e.cwd;
            if (e.type === "user" && e.message?.content && !preview) {
              const c = e.message.content;
              if (typeof c === "string") preview = c.slice(0, 120);
              else if (Array.isArray(c)) {
                const t = c.find((p: any) => p.type === "text");
                if (t) preview = (t.text || "").slice(0, 120);
              }
            }
          } catch {}
        }

        results.push({
          agent: "claude",
          id: sessionId,
          path: filePath,
          cwd: sessionCwd,
          date: stat.mtime,
          sizeBytes: stat.size,
          preview: preview || "(no preview)",
        });
      } catch {}
    }
  }

  return results.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, limit);
}

function discoverCodexSessions(limit: number): SessionInfo[] {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(sessionsDir)) return [];

  const results: SessionInfo[] = [];

  const walk = (dir: string) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".jsonl")) {
          try {
            const stat = fs.statSync(full);
            if (stat.size < 100) continue;

            const content = fs.readFileSync(full, "utf-8");
            const lines = content.split("\n").filter(Boolean);

            let sessionCwd: string | null = null;
            let sessionId = entry.name;
            let preview = "";

            for (const line of lines.slice(0, 10)) {
              try {
                const e = JSON.parse(line);
                if (e.type === "session_meta" && e.payload) {
                  sessionId = e.payload.id || sessionId;
                  sessionCwd = e.payload.cwd || null;
                }
                if (e.type === "event_msg" && e.role === "user") {
                  preview = (e.content || "").slice(0, 120);
                }
              } catch {}
            }

            results.push({
              agent: "codex",
              id: sessionId,
              path: full,
              cwd: sessionCwd,
              date: stat.mtime,
              sizeBytes: stat.size,
              preview: preview || "(no preview)",
            });
          } catch {}
        }
      }
    } catch {}
  };

  walk(sessionsDir);
  return results.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, limit);
}

function discoverAllSessions(agents: ("pi" | "claude" | "codex")[], limit: number): SessionInfo[] {
  const all: SessionInfo[] = [];
  if (agents.includes("pi")) all.push(...discoverPiSessions(limit));
  if (agents.includes("claude")) all.push(...discoverClaudeSessions(limit));
  if (agents.includes("codex")) all.push(...discoverCodexSessions(limit));
  return all.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, limit);
}

// ── Extension ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Widget lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWidget("session-reader", (tui, theme) => {
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
  });

  pi.on("session_shutdown", () => {
    stopStatusTimer();
    for (const task of readerTasks.values()) {
      if (task.proc) {
        task.proc.kill("SIGTERM");
        task.status = "error";
      }
    }
  });

  // ── sessions tool ─────────────────────────────────────

  pi.registerTool({
    name: "sessions",
    label: "Sessions",
    description: [
      "List recent sessions from pi, Claude Code, and/or Codex.",
      "Returns session IDs, dates, working directories, and first-message previews.",
      "Use session_context to read and extract context from a specific session.",
    ].join(" "),
    parameters: Type.Object({
      agents: Type.Optional(
        Type.Array(StringEnum(["pi", "claude", "codex"] as const), {
          description: "Which agents to search. Default: all three.",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max sessions to return. Default: 20.", default: 20 })),
      cwd_filter: Type.Optional(Type.String({ description: "Filter sessions by working directory (substring match)" })),
    }),

    async execute(_id, params) {
      const agents = (params.agents as ("pi" | "claude" | "codex")[] | undefined) ?? ["pi", "claude", "codex"];
      const limit = params.limit ?? 20;
      let sessions = discoverAllSessions(agents, limit * 2);

      if (params.cwd_filter) {
        const filter = params.cwd_filter.toLowerCase();
        sessions = sessions.filter(
          (s) => s.cwd?.toLowerCase().includes(filter) || s.path.toLowerCase().includes(filter),
        );
      }

      sessions = sessions.slice(0, limit);

      if (sessions.length === 0) {
        return {
          content: [{ type: "text", text: `No sessions found for ${agents.join(", ")}${params.cwd_filter ? ` matching "${params.cwd_filter}"` : ""}.` }],
          details: { count: 0, agents },
        };
      }

      // Build structured details for renderer
      const sessionDetails = sessions.map((s) => ({
        agent: s.agent,
        id: s.id,
        cwd: s.cwd?.replace(os.homedir(), "~") || "?",
        date: formatDate(s.date),
        size: formatSize(s.sizeBytes),
        preview: s.preview,
      }));

      const lines = sessions.map((s) => {
        const cwdShort = s.cwd ? s.cwd.replace(os.homedir(), "~") : "?";
        return [
          `[${s.agent}] ${s.id.slice(0, 20)} — ${formatDate(s.date)} (${formatSize(s.sizeBytes)})`,
          `  cwd: ${cwdShort}`,
          `  ${s.preview}`,
        ].join("\n");
      });

      return {
        content: [{ type: "text", text: `Found ${sessions.length} sessions:\n\n${lines.join("\n\n")}` }],
        details: { count: sessions.length, agents, sessions: sessionDetails },
      };
    },

    renderCall(args, theme) {
      const agents = args.agents?.join(", ") || "all";
      let text = theme.fg("toolTitle", theme.bold("sessions"));
      text += theme.fg("dim", ` [${agents}]`);
      if (args.cwd_filter) text += theme.fg("dim", ` filter: ${args.cwd_filter}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (!d || d.count === 0) {
        return new Text(theme.fg("dim", "No sessions found."), 0, 0);
      }

      // Count by agent
      const counts: Record<string, number> = {};
      for (const s of d.sessions || []) counts[s.agent] = (counts[s.agent] || 0) + 1;
      const countParts = Object.entries(counts).map(([a, n]) => theme.fg("muted", `${n} ${a}`));

      let text = theme.fg("toolTitle", theme.bold("sessions")) + " " + theme.fg("dim", `${d.count} found`) + "  " + countParts.join(theme.fg("dim", " · "));

      if (expanded && d.sessions) {
        for (const s of d.sessions.slice(0, 15)) {
          const agentTag = theme.fg("dim", `[${s.agent}]`);
          text += `\n  ${agentTag} ${theme.fg("text", shortSessionId(s.id))} ${theme.fg("dim", `${s.date} ${s.size}`)}`;
          const prevSnip = s.preview.length > 60 ? s.preview.slice(0, 57) + "…" : s.preview;
          text += `\n    ${theme.fg("muted", prevSnip)}`;
        }
        if (d.sessions.length > 15) text += `\n  ${theme.fg("dim", `… ${d.sessions.length - 15} more`)}`;
      } else if (d.sessions?.length > 0) {
        // Collapsed: show most recent
        const latest = d.sessions[0];
        const prevSnip = latest.preview.length > 60 ? latest.preview.slice(0, 57) + "…" : latest.preview;
        text += `\n  ${theme.fg("dim", `[${latest.agent}]`)} ${theme.fg("muted", prevSnip)}`;
      }

      return new Text(text, 0, 0);
    },
  });

  // ── session_context tool ──────────────────────────────

  pi.registerTool({
    name: "session_context",
    label: "Session Context",
    description: [
      "Read a session transcript and extract context using a background pi agent.",
      "Returns immediately with a task ID. Status shown in widget.",
      "The parsed context is reported back automatically when finished.",
      "Provide a query to focus the extraction (e.g. 'what files were modified').",
    ].join(" "),
    parameters: Type.Object({
      session_id: Type.String({ description: "Session ID (from the sessions tool) or full path to a session file" }),
      agent: Type.Optional(StringEnum(["pi", "claude", "codex"] as const, { description: "Which agent's sessions to search. Helps narrow the lookup." })),
      query: Type.Optional(Type.String({ description: 'What to extract from the session. Default: "Summarize the key decisions, changes made, and current state."' })),
      model: Type.Optional(Type.String({ description: "Model for the background reader agent" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      // Find the session file
      let sessionPath: string | null = null;
      let sessionInfo: SessionInfo | null = null;

      if (fs.existsSync(params.session_id)) {
        sessionPath = params.session_id;
        const stat = fs.statSync(sessionPath);
        sessionInfo = {
          agent: (params.agent as any) || "pi",
          id: path.basename(sessionPath),
          path: sessionPath,
          cwd: null,
          date: stat.mtime,
          sizeBytes: stat.size,
          preview: "",
        };
      } else {
        const agents: ("pi" | "claude" | "codex")[] = params.agent ? [params.agent as any] : ["pi", "claude", "codex"];
        const all = discoverAllSessions(agents, 100);
        sessionInfo =
          all.find(
            (s) => s.id === params.session_id || s.id.startsWith(params.session_id) || s.path.includes(params.session_id),
          ) || null;
        if (sessionInfo) sessionPath = sessionInfo.path;
      }

      if (!sessionPath || !sessionInfo) {
        return {
          content: [{ type: "text", text: `Session "${params.session_id}" not found. Use the sessions tool to list available sessions.` }],
        };
      }

      const query = params.query || "Summarize the key decisions, changes made, files touched, and current state of this session.";

      const taskId = nextTaskId++;
      const task: ReaderTask = {
        id: taskId,
        sessionInfo,
        query,
        status: "running",
        startedAt: Date.now(),
        finishedAt: null,
        output: "",
        proc: null,
      };
      readerTasks.set(taskId, task);

      // Read session content (truncate if huge)
      let sessionContent: string;
      try {
        const raw = fs.readFileSync(sessionPath, "utf-8");
        if (raw.length > 200_000) {
          const head = raw.slice(0, 50_000);
          const tail = raw.slice(-150_000);
          sessionContent = `${head}\n\n[... ${formatSize(raw.length - 200_000)} truncated ...]\n\n${tail}`;
        } else {
          sessionContent = raw;
        }
      } catch (err) {
        task.status = "error";
        task.finishedAt = Date.now();
        task.output = `Failed to read session: ${err}`;
        return { content: [{ type: "text", text: task.output }], isError: true };
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-reader-"));
      const promptFile = path.join(tmpDir, "prompt.md");

      const prompt = [
        `You are reading a session transcript from ${sessionInfo.agent}.`,
        `Session file: ${sessionInfo.path}`,
        sessionInfo.cwd ? `Working directory: ${sessionInfo.cwd}` : "",
        "",
        "## Query",
        query,
        "",
        "## Session Transcript",
        "```jsonl",
        sessionContent,
        "```",
        "",
        "Parse the transcript above and answer the query.",
        "Focus on extracting actionable context: what was discussed, what was changed,",
        "what decisions were made, and what the current state is.",
        "Be concise but thorough.",
      ]
        .filter(Boolean)
        .join("\n");

      fs.writeFileSync(promptFile, prompt, "utf-8");

      const args = ["-p", "--no-session", "--no-skills"];
      if (params.model) args.push("--model", params.model);
      args.push(`@${promptFile}`);

      const proc = spawn("pi", args, {
        cwd: ctx.cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      task.proc = proc;
      ensureStatusTimer();
      refreshWidget();

      let stdout = "";
      proc.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      let stderr = "";
      proc.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        task.output = stdout.trim() || stderr.trim() || "(no output)";
        task.status = code === 0 ? "done" : "error";
        task.finishedAt = Date.now();
        task.proc = null;
        refreshWidget();

        try {
          fs.unlinkSync(promptFile);
          fs.rmdirSync(tmpDir);
        } catch {}

        // Smart turn triggering: only trigger when no other readers are running
        const othersRunning = [...readerTasks.values()].some((t) => t.id !== task.id && t.status === "running");
        const isError = task.status === "error";
        const shouldTrigger = isError || !othersRunning;

        pi.sendMessage(
          {
            customType: "session-context",
            content: task.output,
            display: false,
            details: {
              taskId: task.id,
              agent: sessionInfo!.agent,
              sessionId: sessionInfo!.id,
              query: task.query,
              status: task.status,
              output: task.output,
              elapsed: elapsed(task),
            },
          },
          { triggerTurn: shouldTrigger, deliverAs: "followUp" },
        );
      });

      proc.on("error", (err) => {
        task.output = `Failed to spawn pi: ${err.message}`;
        task.status = "error";
        task.finishedAt = Date.now();
        task.proc = null;
        refreshWidget();

        try {
          fs.unlinkSync(promptFile);
          fs.rmdirSync(tmpDir);
        } catch {}
      });

      return {
        content: [{ type: "text", text: `Reader #${taskId} started (${sessionInfo.agent}, ${formatSize(sessionInfo.sizeBytes)}). Status in widget.` }],
        details: { taskId, agent: sessionInfo.agent, sessionId: sessionInfo.id },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("session_context"));
      if (args.agent) text += theme.fg("dim", ` [${args.agent}]`);
      text += " " + theme.fg("accent", (args.session_id || "").slice(0, 20));
      if (args.query) {
        const q = args.query.length > 60 ? args.query.slice(0, 57) + "…" : args.query;
        text += "\n" + theme.fg("dim", `  ${q}`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as { taskId: number; agent: string; sessionId: string } | undefined;
      const task = d ? readerTasks.get(d.taskId) : undefined;

      if (task) {
        const icon = task.status === "running" ? theme.fg("warning", "◆") : task.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
        return new Text(
          `${icon} ${theme.fg("toolTitle", theme.bold(`reader #${task.id}`))} ${theme.fg("dim", `${elapsed(task)} · ${task.sessionInfo.agent}`)}`,
          0, 0,
        );
      }

      const txt = result.content[0];
      return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
    },
  });

  // ── session_tasks tool ────────────────────────────────

  pi.registerTool({
    name: "session_tasks",
    label: "Session Tasks",
    description: "Get detailed session reader task info. Check the widget first — this is for full output.",
    parameters: Type.Object({
      task_id: Type.Optional(Type.Number({ description: "Get details for a specific task" })),
    }),

    async execute(_id, params) {
      if (params.task_id) {
        const task = readerTasks.get(params.task_id);
        if (!task)
          return {
            content: [{ type: "text", text: `Task #${params.task_id} not found.` }],
            details: { mode: "detail", notFound: true },
          };
        return {
          content: [
            {
              type: "text",
              text: [
                `Task #${task.id} — ${task.status} (${elapsed(task)})`,
                `Agent: ${task.sessionInfo.agent}`,
                `Session: ${task.sessionInfo.id}`,
                `Query: ${task.query}`,
                task.output ? `\nOutput:\n${task.output}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          details: {
            mode: "detail",
            taskId: task.id,
            status: task.status,
            elapsed: elapsed(task),
            agent: task.sessionInfo.agent,
            sessionId: task.sessionInfo.id,
            query: task.query,
            output: task.output,
          },
        };
      }

      if (readerTasks.size === 0) {
        return {
          content: [{ type: "text", text: "No session reader tasks." }],
          details: { mode: "list", tasks: [] },
        };
      }

      const summaries: any[] = [];
      const lines: string[] = [];
      for (const task of readerTasks.values()) {
        const icon = task.status === "running" ? "◆" : task.status === "done" ? "✓" : "✗";
        lines.push(`${icon} #${task.id} [${task.status}] ${elapsed(task)} — ${task.sessionInfo.agent} ${shortSessionId(task.sessionInfo.id)}`);
        summaries.push({
          id: task.id,
          status: task.status,
          elapsed: elapsed(task),
          agent: task.sessionInfo.agent,
          sessionId: task.sessionInfo.id,
          query: task.query,
        });
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { mode: "list", tasks: summaries },
      };
    },

    renderCall(args, theme) {
      if (args.task_id) {
        return new Text(theme.fg("toolTitle", theme.bold("session_tasks")) + " " + theme.fg("dim", `#${args.task_id}`), 0, 0);
      }
      return new Text(theme.fg("toolTitle", theme.bold("session_tasks")), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (!d) {
        const txt = result.content[0];
        return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
      }

      // Single task detail
      if (d.mode === "detail") {
        if (d.notFound) return new Text(theme.fg("error", "✗ Task not found"), 0, 0);

        const icon = d.status === "done" ? theme.fg("success", "✓") : d.status === "running" ? theme.fg("warning", "◆") : theme.fg("error", "✗");
        let text = `${icon} ${theme.fg("toolTitle", theme.bold(`reader #${d.taskId}`))} ${theme.fg("dim", `${d.elapsed} · ${d.agent}`)}`;

        if (expanded && d.output) {
          const outputLines = d.output.split("\n").slice(0, 20);
          text += "\n" + theme.fg("dim", "───");
          text += "\n" + outputLines.map((l: string) => `  ${l}`).join("\n");
          if (d.output.split("\n").length > 20) text += "\n" + theme.fg("dim", `… ${d.output.split("\n").length - 20} more`);
        } else {
          const qSnip = d.query.length > 80 ? d.query.slice(0, 77) + "…" : d.query;
          text += "\n" + theme.fg("muted", `  ${qSnip}`);
        }
        return new Text(text, 0, 0);
      }

      // Task list
      if (d.mode === "list") {
        if (!d.tasks?.length) return new Text(theme.fg("dim", "No session reader tasks."), 0, 0);

        const counts: Record<string, number> = {};
        for (const t of d.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
        const parts: string[] = [];
        if (counts.running) parts.push(theme.fg("warning", `${counts.running} running`));
        if (counts.done) parts.push(theme.fg("success", `${counts.done} done`));
        if (counts.error) parts.push(theme.fg("error", `${counts.error} failed`));

        let text =
          theme.fg("toolTitle", theme.bold("session_tasks")) +
          " " +
          theme.fg("dim", `${d.tasks.length} task${d.tasks.length === 1 ? "" : "s"}`) +
          "  " +
          parts.join(theme.fg("dim", " · "));

        if (expanded) {
          for (const t of d.tasks) {
            const icon = t.status === "running" ? theme.fg("warning", "◆") : t.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
            const qSnip = t.query.length > 50 ? t.query.slice(0, 47) + "…" : t.query;
            text += `\n  ${icon} #${t.id} ${theme.fg("dim", `${t.elapsed} · ${t.agent}`)} ${theme.fg("muted", qSnip)}`;
          }
        }
        return new Text(text, 0, 0);
      }

      const txt = result.content[0];
      return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
    },
  });

  // ── Completion message renderer ───────────────────────

  pi.registerMessageRenderer<any>("session-context", (message, { expanded }, theme) => {
    const details = message.details;
    if (!details) return undefined;

    const container = new Container();
    const isDone = details.status === "done";
    const icon = isDone ? theme.fg("success", "✓") : theme.fg("error", "✗");

    let header = `${icon} ${theme.fg("toolTitle", theme.bold(`Reader #${details.taskId}`))}`;
    const meta: string[] = [details.elapsed, details.agent];
    if (details.sessionId) meta.push(shortSessionId(details.sessionId));
    header += " " + theme.fg("dim", meta.join(" · "));
    container.addChild(new Text(header, 1, 0));

    if (expanded) {
      // Query
      container.addChild(new Text(theme.fg("muted", `  Q: ${details.query}`), 1, 0));
      // Full output
      if (details.output) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(details.output, 1, 0, getMarkdownTheme()));
      }
    } else {
      // Collapsed: 2-line preview of the output
      const output = details.output?.trim();
      if (output) {
        const previewLines = output
          .split("\n")
          .filter((l: string) => l.trim())
          .slice(0, 2);
        container.addChild(new Text(previewLines.join("\n"), 1, 0));
      } else {
        container.addChild(new Text(theme.fg("dim", "(no output)"), 1, 0));
      }
    }

    return container;
  });
}
