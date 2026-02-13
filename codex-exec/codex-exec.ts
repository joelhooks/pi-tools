import { spawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";
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
        const icon = task.status === "done" ? "✅" : "❌";
        const preview = task.output ? (task.output.length > 500 ? task.output.slice(0, 500) + "..." : task.output) : "(no output)";
        const sessionHint = task.sessionId ? `\nCodex session ID: \`${task.sessionId}\` (use with session_id to continue)` : "";
        const errorHint = task.status === "error" && task.stderr ? `\nError: ${task.stderr.slice(0, 300)}` : "";

        pi.sendMessage({
          customType: "codex-result",
          content: [`${icon} **Codex task #${task.id}** finished (${elapsed(task)})`, `**Prompt:** ${task.prompt}`, errorHint, `**Output:**\n${preview}`, sessionHint].filter(Boolean).join("\n"),
          display: true,
          details: { taskId: task.id, sessionId: task.sessionId, status: task.status, output: task.output, toolCalls: task.toolCalls, usage: task.usage },
        }, { triggerTurn: true, deliverAs: "followUp" });
      });

      const sessionInfo = params.session_id ? ` (resuming session ${shortId(params.session_id)})` : "";
      return {
        content: [{ type: "text", text: `Codex task #${taskId} started${sessionInfo}. It will report back when finished. Use codex_tasks to check status.` }],
        details: { taskId, sessionId: params.session_id || null },
      };
    },

    renderCall(args, theme) {
      const label = args.session_id ? `codex resume ${shortId(args.session_id)}` : "codex";
      const preview = args.prompt.length > 80 ? args.prompt.slice(0, 80) + "..." : args.prompt;
      let text = theme.fg("toolTitle", theme.bold(label));
      if (args.model) text += theme.fg("muted", ` [${args.model}]`);
      text += "\n  " + theme.fg("dim", preview);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as { taskId: number; sessionId: string | null } | undefined;
      const task = details ? tasks.get(details.taskId) : undefined;
      if (!task) { const txt = result.content[0]; return new Text(txt?.type === "text" ? txt.text : "", 0, 0); }
      const icon = task.status === "running" ? theme.fg("warning", "⏳") : task.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
      let text = `${icon} ${theme.fg("toolTitle", theme.bold(`codex #${task.id}`))}`;
      text += theme.fg("dim", ` ${elapsed(task)}`);
      if (task.sessionId) text += theme.fg("muted", ` [${shortId(task.sessionId)}]`);
      text += "\n  " + theme.fg("muted", "launched async");
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
        if (!task) return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }] };
        const lines = [`Task #${task.id} — ${task.status} (${elapsed(task)})`, `Prompt: ${task.prompt}`, `Session: ${task.sessionId || "(none)"}`, `CWD: ${task.cwd}`];
        if (task.toolCalls.length > 0) { lines.push(`Tool calls: ${task.toolCalls.length}`); for (const tc of task.toolCalls.slice(-10)) lines.push(`  → ${tc.type}: ${tc.text.slice(0, 100)}`); }
        if (task.usage) lines.push(`Usage: ↑${task.usage.input} cached:${task.usage.cached} ↓${task.usage.output}`);
        if (task.output) lines.push(`\nOutput:\n${task.output}`);
        if (task.stderr) lines.push(`\nStderr:\n${task.stderr.slice(0, 500)}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
      if (tasks.size === 0) return { content: [{ type: "text", text: "No codex tasks." }] };
      const lines: string[] = [];
      for (const task of tasks.values()) {
        const icon = task.status === "running" ? "⏳" : task.status === "done" ? "✅" : "❌";
        const session = task.sessionId ? ` session:${shortId(task.sessionId)}` : "";
        const preview = task.output ? ` — ${task.output.slice(0, 60).replace(/\n/g, " ")}` : "";
        lines.push(`${icon} #${task.id} [${task.status}] ${elapsed(task)}${session}${preview}`);
        lines.push(`   ${task.prompt.slice(0, 80)}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  pi.registerMessageRenderer<any>("codex-result", (message, { expanded }, theme) => {
    const details = message.details;
    if (!details) return undefined;
    const mdTheme = getMarkdownTheme();
    const container = new Container();
    const icon = details.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
    let header = `${icon} ${theme.fg("toolTitle", theme.bold(`Codex #${details.taskId}`))}`;
    if (details.sessionId) header += theme.fg("muted", ` [${shortId(details.sessionId)}]`);
    container.addChild(new Text(header, 1, 0));
    if (expanded) {
      if (details.toolCalls?.length > 0) {
        container.addChild(new Spacer(1));
        for (const tc of details.toolCalls.slice(-15))
          container.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("accent", tc.type) + " " + theme.fg("dim", tc.text.slice(0, 80)), 1, 0));
      }
      if (details.output) { container.addChild(new Spacer(1)); container.addChild(new Markdown(details.output, 1, 0, mdTheme)); }
      if (details.usage) container.addChild(new Text(theme.fg("dim", `↑${details.usage.input} cached:${details.usage.cached} ↓${details.usage.output}`), 1, 0));
      if (details.sessionId) container.addChild(new Text(theme.fg("muted", `Session: ${details.sessionId}`), 1, 0));
    } else {
      const preview = details.output ? details.output.split("\n").slice(0, 3).join("\n") : "(no output)";
      container.addChild(new Text(theme.fg("toolOutput", preview), 1, 0));
      if (details.sessionId) container.addChild(new Text(theme.fg("dim", `session: ${shortId(details.sessionId)}`), 1, 0));
    }
    return container;
  });
}
