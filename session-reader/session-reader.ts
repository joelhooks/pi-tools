/**
 * Session Reader — non-blocking background transcript parser.
 *
 * Discovers session files from pi, Claude Code, and Codex, then spawns
 * a background pi agent to read + summarize them. Reports back async.
 *
 * Tools:
 *   sessions       — list recent sessions across all agents
 *   session_context — spawn a background pi to parse a session and extract context
 *   session_tasks   — check status of running session reads
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

// ── Session discovery ───────────────────────────────────────────────

interface SessionInfo {
  agent: "pi" | "claude" | "codex";
  id: string;
  path: string;
  cwd: string | null;
  date: Date;
  sizeBytes: number;
  preview: string; // first user message or session name
}

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
            if (
              entry.type === "message" &&
              entry.message?.role === "user" &&
              !preview
            ) {
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

    // Claude stores sessions as .jsonl files or as subdirectories
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      let filePath: string;

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        filePath = path.join(dirPath, entry.name);
      } else {
        continue; // Skip directories (newer claude format without files)
      }

      try {
        const stat = fs.statSync(filePath);
        if (stat.size < 100) continue; // skip empty/tiny sessions

        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter(Boolean);

        let sessionCwd: string | null = null;
        let preview = "";
        const sessionId = entry.name.replace(".jsonl", "");

        // Parse CWD from project dir name
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

  // Codex stores in YYYY/MM/DD/rollout-*.jsonl
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

function discoverAllSessions(
  agents: ("pi" | "claude" | "codex")[],
  limit: number,
): SessionInfo[] {
  const all: SessionInfo[] = [];
  if (agents.includes("pi")) all.push(...discoverPiSessions(limit));
  if (agents.includes("claude")) all.push(...discoverClaudeSessions(limit));
  if (agents.includes("codex")) all.push(...discoverCodexSessions(limit));
  return all.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, limit);
}

// ── Background task state ───────────────────────────────────────────

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

let nextTaskId = 1;
const readerTasks = new Map<number, ReaderTask>();

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

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", () => {
    for (const task of readerTasks.values()) {
      if (task.proc) {
        task.proc.kill("SIGTERM");
        task.status = "error";
      }
    }
  });

  // ── sessions tool — discover and list ─────────────────────────

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
          description: 'Which agents to search. Default: all three.',
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max sessions to return. Default: 20.", default: 20 }),
      ),
      cwd_filter: Type.Optional(
        Type.String({ description: "Filter sessions by working directory (substring match)" }),
      ),
    }),

    async execute(_id, params) {
      const agents = (params.agents as ("pi" | "claude" | "codex")[] | undefined) ?? [
        "pi",
        "claude",
        "codex",
      ];
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
          content: [
            {
              type: "text",
              text: `No sessions found for ${agents.join(", ")}${params.cwd_filter ? ` matching "${params.cwd_filter}"` : ""}.`,
            },
          ],
        };
      }

      const lines = sessions.map((s) => {
        const cwdShort = s.cwd
          ? s.cwd.replace(os.homedir(), "~")
          : "?";
        return [
          `[${s.agent}] ${s.id.slice(0, 20)} — ${formatDate(s.date)} (${formatSize(s.sizeBytes)})`,
          `  cwd: ${cwdShort}`,
          `  ${s.preview}`,
        ].join("\n");
      });

      return {
        content: [
          {
            type: "text",
            text: `Found ${sessions.length} sessions:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    },

    renderCall(args, theme) {
      const agents = args.agents?.join(", ") || "pi, claude, codex";
      let text = theme.fg("toolTitle", theme.bold("sessions"));
      text += theme.fg("muted", ` [${agents}]`);
      if (args.cwd_filter) text += theme.fg("dim", ` filter: ${args.cwd_filter}`);
      return new Text(text, 0, 0);
    },
  });

  // ── session_context tool — async read + summarize ─────────────

  pi.registerTool({
    name: "session_context",
    label: "Session Context",
    description: [
      "Read a session transcript and extract context using a background pi agent.",
      "Returns immediately with a task ID. The parsed context is reported back automatically.",
      "Provide a query to focus the extraction (e.g. 'what files were modified' or 'summarize the auth changes').",
      "The background agent reads the raw session file and answers your query about it.",
    ].join(" "),
    parameters: Type.Object({
      session_id: Type.String({
        description: "Session ID (from the sessions tool) or full path to a session file",
      }),
      agent: Type.Optional(
        StringEnum(["pi", "claude", "codex"] as const, {
          description: "Which agent's sessions to search. Helps narrow the lookup.",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description:
            'What to extract from the session. Default: "Summarize the key decisions, changes made, and current state."',
        }),
      ),
      model: Type.Optional(
        Type.String({ description: "Model for the background reader agent" }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      // Find the session file
      let sessionPath: string | null = null;
      let sessionInfo: SessionInfo | null = null;

      if (fs.existsSync(params.session_id)) {
        // Direct path
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
        // Search by ID
        const agents: ("pi" | "claude" | "codex")[] = params.agent
          ? [params.agent as any]
          : ["pi", "claude", "codex"];
        const all = discoverAllSessions(agents, 100);
        sessionInfo =
          all.find(
            (s) =>
              s.id === params.session_id ||
              s.id.startsWith(params.session_id) ||
              s.path.includes(params.session_id),
          ) || null;
        if (sessionInfo) sessionPath = sessionInfo.path;
      }

      if (!sessionPath || !sessionInfo) {
        return {
          content: [
            {
              type: "text",
              text: `Session "${params.session_id}" not found. Use the sessions tool to list available sessions.`,
            },
          ],
        };
      }

      const query =
        params.query ||
        "Summarize the key decisions, changes made, files touched, and current state of this session.";

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

      // Read the session content (truncate if huge)
      let sessionContent: string;
      try {
        const raw = fs.readFileSync(sessionPath, "utf-8");
        // Truncate to ~200KB to fit in context
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
        return {
          content: [{ type: "text", text: task.output }],
          isError: true,
        };
      }

      // Write the session content + query to a temp file as a prompt
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

      // Spawn background pi agent with @file reference
      const args = ["-p", "--no-session", "--no-skills"];
      if (params.model) args.push("--model", params.model);
      args.push(`@${promptFile}`);

      const proc = spawn("pi", args, {
        cwd: ctx.cwd,
        shell: true, // resolve pi from PATH
        stdio: ["ignore", "pipe", "pipe"],
      });
      task.proc = proc;

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

        // Clean up temp files
        try {
          fs.unlinkSync(promptFile);
          fs.rmdirSync(tmpDir);
        } catch {}

        // Report back
        const icon = task.status === "done" ? "✅" : "❌";
        pi.sendMessage(
          {
            customType: "session-context",
            content: [
              `${icon} **Session context** from ${sessionInfo!.agent} (${elapsed(task)})`,
              `**Query:** ${task.query}`,
              `**Session:** ${sessionInfo!.id.slice(0, 20)}${sessionInfo!.cwd ? ` (${sessionInfo!.cwd.replace(os.homedir(), "~")})` : ""}`,
              "",
              task.output,
            ].join("\n"),
            display: true,
            details: {
              taskId: task.id,
              agent: sessionInfo!.agent,
              sessionId: sessionInfo!.id,
              query: task.query,
              status: task.status,
              output: task.output,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      });

      proc.on("error", (err) => {
        task.output = `Failed to spawn pi: ${err.message}`;
        task.status = "error";
        task.finishedAt = Date.now();
        task.proc = null;

        try {
          fs.unlinkSync(promptFile);
          fs.rmdirSync(tmpDir);
        } catch {}
      });

      return {
        content: [
          {
            type: "text",
            text: [
              `Session reader task #${taskId} started (${sessionInfo.agent} session, ${formatSize(sessionInfo.sizeBytes)}).`,
              `It will parse the transcript and report back. Use session_tasks to check status.`,
            ].join(" "),
          },
        ],
        details: { taskId },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("session_context"));
      if (args.agent) text += theme.fg("muted", ` [${args.agent}]`);
      text += " " + theme.fg("accent", (args.session_id || "").slice(0, 20));
      if (args.query) {
        const q = args.query.length > 60 ? args.query.slice(0, 60) + "..." : args.query;
        text += "\n  " + theme.fg("dim", q);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const txt = result.content[0];
      const details = result.details as { taskId: number } | undefined;
      const task = details ? readerTasks.get(details.taskId) : undefined;

      if (task) {
        const icon = task.status === "running" ? theme.fg("warning", "⏳") : theme.fg("success", "✓");
        let text = `${icon} ${theme.fg("toolTitle", theme.bold(`reader #${task.id}`))}`;
        text += theme.fg("dim", ` ${elapsed(task)}`);
        text += theme.fg("muted", ` [${task.sessionInfo.agent}]`);
        text += "\n  " + theme.fg("muted", "launched async");
        return new Text(text, 0, 0);
      }

      return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
    },
  });

  // ── session_tasks tool — check status ─────────────────────────

  pi.registerTool({
    name: "session_tasks",
    label: "Session Tasks",
    description: "List running/completed session reader tasks and their status.",
    parameters: Type.Object({
      task_id: Type.Optional(
        Type.Number({ description: "Get details for a specific task" }),
      ),
    }),

    async execute(_id, params) {
      if (params.task_id) {
        const task = readerTasks.get(params.task_id);
        if (!task)
          return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }] };

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
        };
      }

      if (readerTasks.size === 0) {
        return {
          content: [
            { type: "text", text: "No session reader tasks. Use session_context to start one." },
          ],
        };
      }

      const lines: string[] = [];
      for (const task of readerTasks.values()) {
        const icon =
          task.status === "running" ? "⏳" : task.status === "done" ? "✅" : "❌";
        lines.push(
          `${icon} #${task.id} [${task.status}] ${elapsed(task)} — ${task.sessionInfo.agent} ${task.sessionInfo.id.slice(0, 16)}`,
        );
        lines.push(`   ${task.query.slice(0, 80)}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
