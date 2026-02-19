import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface TaskItem {
  id: number;
  prompt: string;
  sessionId: string | null;
  cwd: string;
  status: "running" | "done" | "error" | "aborted";
  startedAt: number;
  finishedAt: number | null;
  output: string;
  reasoning: string[];
  toolCalls: { type: string; text: string }[];
  usage: { input: number; cached: number; output: number } | null;
  exitCode: number | null;
  stderr: string;
  proc: ChildProcess | null;
}

let nextTaskId = 1;
const tasks = new Map<number, TaskItem>();

function shortId(sessionId: string | null): string {
  if (!sessionId) return "?";
  return sessionId.slice(0, 8);
}

function elapsed(task: TaskItem): string {
  const end = task.finishedAt ?? Date.now();
  const sec = Math.round((end - task.startedAt) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

function fmtTokens(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function spawnCodex(task: TaskItem, args: string[], onDone: () => void): void {
  const proc = spawn("codex", args, {
    cwd: task.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  task.proc = proc;

  let buffer = "";

  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "thread.started" && ev.thread_id) task.sessionId = ev.thread_id;
        if (ev.type === "item.completed" && ev.item) {
          if (ev.item.type === "agent_message") task.output = ev.item.text || task.output;
          if (ev.item.type === "reasoning") task.reasoning.push(ev.item.text || "");
          if (ev.item.type === "tool_call" || ev.item.type === "function_call") {
            task.toolCalls.push({
              type: ev.item.name || ev.item.type,
              text: ev.item.text || JSON.stringify(ev.item.arguments || {}),
            });
          }
        }
        if (ev.type === "turn.completed" && ev.usage) {
          task.usage = {
            input: ev.usage.input_tokens || 0,
            cached: ev.usage.cached_input_tokens || 0,
            output: ev.usage.output_tokens || 0,
          };
        }
      } catch {}
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => { task.stderr += chunk.toString(); });

  proc.on("close", (code) => {
    if (buffer.trim()) {
      try {
        const ev = JSON.parse(buffer);
        if (ev.type === "thread.started" && ev.thread_id) task.sessionId = ev.thread_id;
        if (ev.type === "item.completed" && ev.item?.type === "agent_message")
          task.output = ev.item.text || task.output;
      } catch {}
    }
    task.exitCode = code ?? 1;
    task.finishedAt = Date.now();
    task.status = code === 0 ? "done" : "error";
    task.proc = null;
    onDone();
  });

  proc.on("error", (err) => {
    task.stderr += err.message;
    task.status = "error";
    task.finishedAt = Date.now();
    task.proc = null;
    onDone();
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", () => {
    for (const task of tasks.values()) {
      if (task.proc) { task.proc.kill("SIGTERM"); task.status = "aborted"; }
    }
  });

  pi.registerTool({
    name: "codex",
    label: "Codex",
    description: [
      "Run a task with codex exec in the background. Returns immediately with a task ID.",
      "The result is reported back automatically when the task finishes.",
      "Use session_id to resume a previous codex session with a follow-up prompt.",
      "Use codex_tasks to check status of running tasks.",
    ].join(" "),
    parameters: Type.Object({
      prompt: Type.String({ description: "The task/prompt to send to codex" }),
      session_id: Type.Optional(Type.String({ description: "Resume a previous codex session by thread ID" })),
      model: Type.Optional(Type.String({ description: "Model override (e.g. o3, o4-mini)" })),
      sandbox: Type.Optional(Type.String({ description: "Sandbox mode: read-only, workspace-write, danger-full-access" })),
      cwd: Type.Optional(Type.String({ description: "Working directory" })),
      full_auto: Type.Optional(Type.Boolean({ description: "Run in full-auto mode (default: true)", default: true })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const taskId = nextTaskId++;
      const cwd = params.cwd || ctx.cwd;
      const task: TaskItem = {
        id: taskId, prompt: params.prompt, sessionId: params.session_id || null,
        cwd, status: "running", startedAt: Date.now(), finishedAt: null,
        output: "", reasoning: [], toolCalls: [], usage: null, exitCode: null, stderr: "", proc: null,
      };
      tasks.set(taskId, task);

      const args: string[] = [];
      if (params.session_id) {
        args.push("exec", "resume", params.session_id, "--json");
      } else {
        args.push("exec", "--json");
      }
      if (params.full_auto !== false) args.push("--full-auto");
      args.push("--skip-git-repo-check");
      args.push("--cd", cwd);
      if (params.model) args.push("--model", params.model);
      if (params.sandbox) args.push("--sandbox", params.sandbox);
      args.push("--", params.prompt);

      spawnCodex(task, args, () => {
        const statusLabel = task.status === "done" ? "completed" : "failed";
        const preview = task.output
          ? (task.output.length > 500 ? task.output.slice(0, 500) + "…" : task.output)
          : "(no output)";
        const sessionHint = task.sessionId
          ? `\nCodex session: \`${task.sessionId}\` (use with session_id to continue)`
          : "";
        const errorHint = task.status === "error" && task.stderr
          ? `\nError: ${task.stderr.slice(0, 300)}`
          : "";

        pi.sendMessage({
          customType: "codex-result",
          content: [
            `Codex #${task.id} ${statusLabel} (${elapsed(task)})`,
            errorHint,
            preview,
            sessionHint,
          ].filter(Boolean).join("\n"),
          display: true,
          details: {
            taskId: task.id,
            sessionId: task.sessionId,
            status: task.status,
            output: task.output,
            toolCalls: task.toolCalls,
            usage: task.usage,
          },
        }, { triggerTurn: true, deliverAs: "followUp" });
      });

      const sessionInfo = params.session_id ? ` (resuming session ${shortId(params.session_id)})` : "";
      return {
        content: [{ type: "text", text: `Codex task #${taskId} started${sessionInfo}. It will report back when finished. Use codex_tasks to check status.` }],
        details: { taskId, sessionId: params.session_id || null },
      };
    },

    renderCall(args, theme) {
      const mode = args.session_id ? `resume ${shortId(args.session_id)}` : "exec";
      const meta: string[] = [mode];
      if (args.model) meta.push(args.model);
      if (args.sandbox && args.sandbox !== "workspace-write") meta.push(args.sandbox);
      let text = theme.fg("toolTitle", theme.bold("codex"));
      text += " " + theme.fg("dim", meta.join(" · "));
      const preview = args.prompt.length > 100 ? args.prompt.slice(0, 97) + "…" : args.prompt;
      text += "\n" + theme.fg("dim", `  ${preview}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as { taskId: number; sessionId: string | null } | undefined;
      const task = details ? tasks.get(details.taskId) : undefined;
      if (!task) {
        const txt = result.content[0];
        return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
      }
      let icon: string;
      switch (task.status) {
        case "running": icon = theme.fg("warning", "◆"); break;
        case "done": icon = theme.fg("success", "✓"); break;
        case "error": icon = theme.fg("error", "✗"); break;
        case "aborted": icon = theme.fg("muted", "○"); break;
        default: icon = theme.fg("warning", "◆");
      }
      const meta: string[] = [task.status, elapsed(task)];
      if (task.sessionId) meta.push(shortId(task.sessionId));
      let text = `${icon} ${theme.fg("toolTitle", theme.bold(`codex #${task.id}`))}`;
      text += " " + theme.fg("dim", meta.join(" · "));
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "codex_tasks",
    label: "Codex Tasks",
    description: "List all codex background tasks and their current status.",
    parameters: Type.Object({ task_id: Type.Optional(Type.Number({ description: "Get details for a specific task" })) }),
    async execute(_id, params) {
      if (params.task_id) {
        const task = tasks.get(params.task_id);
        if (!task) return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }], details: {} };
        const lines = [`Task #${task.id} — ${task.status} (${elapsed(task)})`, `Prompt: ${task.prompt}`, `Session: ${task.sessionId || "(none)"}`, `CWD: ${task.cwd}`];
        if (task.toolCalls.length > 0) { lines.push(`Tool calls: ${task.toolCalls.length}`); for (const tc of task.toolCalls.slice(-10)) lines.push(`  → ${tc.type}: ${tc.text.slice(0, 100)}`); }
        if (task.usage) lines.push(`Usage: ↑${task.usage.input} cached:${task.usage.cached} ↓${task.usage.output}`);
        if (task.output) lines.push(`\nOutput:\n${task.output}`);
        if (task.stderr) lines.push(`\nStderr:\n${task.stderr.slice(0, 500)}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      }
      if (tasks.size === 0) return { content: [{ type: "text", text: "No codex tasks." }], details: {} };
      const lines: string[] = [];
      for (const task of tasks.values()) {
        const icon = task.status === "running" ? "⏳" : task.status === "done" ? "✅" : "❌";
        const session = task.sessionId ? ` session:${shortId(task.sessionId)}` : "";
        const preview = task.output ? ` — ${task.output.slice(0, 60).replace(/\n/g, " ")}` : "";
        lines.push(`${icon} #${task.id} [${task.status}] ${elapsed(task)}${session}${preview}`);
        lines.push(`   ${task.prompt.slice(0, 80)}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  pi.registerMessageRenderer<any>("codex-result", (message, { expanded }, theme) => {
    const details = message.details;
    if (!details) return undefined;
    const container = new Container();
    const isDone = details.status === "done";
    const icon = isDone ? theme.fg("success", "✓") : theme.fg("error", "✗");

    // ── Header: status + inline metadata (always 1 line) ──
    let header = `${icon} ${theme.fg("toolTitle", theme.bold(`Codex #${details.taskId}`))}`;
    const meta: string[] = [];
    if (details.toolCalls?.length > 0) meta.push(`${details.toolCalls.length} tool${details.toolCalls.length === 1 ? "" : "s"}`);
    if (details.usage) meta.push(`↑${fmtTokens(details.usage.input)} ↓${fmtTokens(details.usage.output)}`);
    if (details.sessionId) meta.push(shortId(details.sessionId));
    if (meta.length > 0) header += " " + theme.fg("dim", meta.join(" · "));
    container.addChild(new Text(header, 1, 0));

    if (expanded) {
      // ── Tool calls ──
      if (details.toolCalls?.length > 0) {
        container.addChild(new Spacer(1));
        for (const tc of details.toolCalls.slice(-15)) {
          container.addChild(new Text(
            theme.fg("dim", "  →") + " " + theme.fg("accent", tc.type) + " " + theme.fg("dim", tc.text.slice(0, 70)),
            1, 0,
          ));
        }
        if (details.toolCalls.length > 15) {
          container.addChild(new Text(theme.fg("dim", `    … ${details.toolCalls.length - 15} more`), 1, 0));
        }
      }

      // ── Full output ──
      if (details.output) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(details.output, 1, 0, getMarkdownTheme()));
      }

      // ── Session ID (copyable) ──
      if (details.sessionId) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `session ${details.sessionId}`), 1, 0));
      }
    } else {
      // ── Collapsed: stable 1-2 line preview (no extra metadata lines) ──
      const output = details.output?.trim();
      if (output) {
        const previewLines = output.split("\n").filter((l: string) => l.trim()).slice(0, 2);
        container.addChild(new Text(theme.fg("toolOutput", previewLines.join("\n")), 1, 0));
      } else {
        container.addChild(new Text(theme.fg("dim", "(no output)"), 1, 0));
      }
    }

    return container;
  });
}
