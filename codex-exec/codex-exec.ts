import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Types ──────────────────────────────────────────────

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

// ── State ──────────────────────────────────────────────

let nextTaskId = 1;
const tasks = new Map<number, TaskItem>();
let widgetTui: { requestRender: () => void } | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
const COMPLETED_LINGER_MS = 15_000;

// ── Formatting ─────────────────────────────────────────

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

// ── Widget ─────────────────────────────────────────────

function refreshWidget(): void {
  widgetTui?.requestRender();
}

function ensureStatusTimer(): void {
  if (statusTimer) return;
  statusTimer = setInterval(() => {
    const now = Date.now();
    const hasVisible = [...tasks.values()].some(
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
  const visible = [...tasks.values()].filter(
    (t) => t.status === "running" || (t.finishedAt && now - t.finishedAt < COMPLETED_LINGER_MS),
  );
  if (visible.length === 0) return [];

  return visible.map((t) => {
    const icon =
      t.status === "running"
        ? theme.fg("warning", "◆")
        : t.status === "done"
          ? theme.fg("success", "✓")
          : t.status === "error"
            ? theme.fg("error", "✗")
            : theme.fg("muted", "○");
    const parts: string[] = [elapsed(t)];
    if (t.toolCalls.length) parts.push(`${t.toolCalls.length} tool${t.toolCalls.length === 1 ? "" : "s"}`);
    if (t.usage) parts.push(`↑${fmtTokens(t.usage.input)} ↓${fmtTokens(t.usage.output)}`);
    if (t.sessionId) parts.push(shortId(t.sessionId));
    // Show output snippet for completed, prompt snippet for running
    let snippet: string;
    if (t.status !== "running" && t.output) {
      const firstLine = t.output.split("\n").find((l) => l.trim()) || "";
      snippet = firstLine.length > 50 ? firstLine.slice(0, 47) + "…" : firstLine;
    } else {
      snippet = t.prompt.length > 50 ? t.prompt.slice(0, 47) + "…" : t.prompt;
    }
    return `${icon} ${theme.fg("text", `#${t.id}`)} ${theme.fg("dim", parts.join(" · "))} ${theme.fg("muted", snippet)}`;
  });
}

// ── Prompt wrapping ────────────────────────────────────

const WORKER_PREAMBLE = [
  "You are a background worker agent. Complete the task efficiently.",
  "",
  "Guidelines:",
  "- Focus on the work. Don't narrate each step.",
  "- Report key milestones: files created/changed, tests passing/failing, blocking errors.",
  "- Keep your final summary to 2-3 sentences: what you did and the outcome.",
  "- If you hit a blocker you can't resolve, describe it clearly and stop.",
  "",
  "Task:",
].join("\n");

function wrapPrompt(prompt: string): string {
  return WORKER_PREAMBLE + "\n" + prompt;
}

// ── Process management ─────────────────────────────────

function spawnCodex(task: TaskItem, args: string[], onDone: () => void): void {
  const proc = spawn("codex", args, {
    cwd: task.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  task.proc = proc;
  ensureStatusTimer();

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
    refreshWidget();
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    task.stderr += chunk.toString();
  });

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
    refreshWidget();
    onDone();
  });

  proc.on("error", (err) => {
    task.stderr += err.message;
    task.status = "error";
    task.finishedAt = Date.now();
    task.proc = null;
    refreshWidget();
    onDone();
  });
}

// ── Extension ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Widget lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWidget("codex-tasks", (tui, theme) => {
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
    for (const task of tasks.values()) {
      if (task.proc) {
        task.proc.kill("SIGTERM");
        task.status = "aborted";
      }
    }
  });

  // ── codex tool ──

  pi.registerTool({
    name: "codex",
    label: "Codex",
    description: [
      "Run a task with codex exec in the background. Returns immediately with a task ID.",
      "Live status shown in the widget above the editor — no need to poll.",
      "Spawn multiple tasks in parallel for concurrent work — results batch into one turn.",
      "Use session_id to resume a previous codex session with a follow-up prompt.",
      "Use codex_tasks only when you need full output details.",
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
        id: taskId,
        prompt: params.prompt,
        sessionId: params.session_id || null,
        cwd,
        status: "running",
        startedAt: Date.now(),
        finishedAt: null,
        output: "",
        reasoning: [],
        toolCalls: [],
        usage: null,
        exitCode: null,
        stderr: "",
        proc: null,
      };
      tasks.set(taskId, task);

      const wrappedPrompt = wrapPrompt(params.prompt);
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
      args.push("--", wrappedPrompt);

      spawnCodex(task, args, () => {
        const statusLabel = task.status === "done" ? "completed" : "failed";
        const preview = task.output
          ? task.output.length > 500
            ? task.output.slice(0, 500) + "…"
            : task.output
          : "(no output)";
        const sessionHint = task.sessionId
          ? `\nCodex session: \`${task.sessionId}\` (use with session_id to continue)`
          : "";
        const errorHint = task.status === "error" && task.stderr ? `\nError: ${task.stderr.slice(0, 300)}` : "";

        // Batch turn triggering:
        // - Errors always trigger (needs immediate attention)
        // - Success while siblings still running: silent (widget shows status)
        // - Last task completing: trigger once for the whole batch
        const isError = task.status === "error";
        const othersRunning = [...tasks.values()].some((t) => t.id !== task.id && t.status === "running");
        const shouldTrigger = isError || !othersRunning;

        pi.sendMessage(
          {
            customType: "codex-result",
            content: [`Codex #${task.id} ${statusLabel} (${elapsed(task)})`, errorHint, preview, sessionHint]
              .filter(Boolean)
              .join("\n"),
            display: false,
            details: {
              taskId: task.id,
              sessionId: task.sessionId,
              status: task.status,
              output: task.output,
              toolCalls: task.toolCalls,
              usage: task.usage,
            },
          },
          { triggerTurn: shouldTrigger, deliverAs: "followUp" },
        );
      });

      const sessionInfo = params.session_id ? ` (resuming session ${shortId(params.session_id)})` : "";
      return {
        content: [{ type: "text", text: `Codex task #${taskId} started${sessionInfo}. Status in widget.` }],
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
      const icon =
        task.status === "running"
          ? theme.fg("warning", "◆")
          : task.status === "done"
            ? theme.fg("success", "✓")
            : task.status === "error"
              ? theme.fg("error", "✗")
              : theme.fg("muted", "○");
      const meta: string[] = [task.status, elapsed(task)];
      if (task.sessionId) meta.push(shortId(task.sessionId));
      return new Text(`${icon} ${theme.fg("toolTitle", theme.bold(`codex #${task.id}`))} ${theme.fg("dim", meta.join(" · "))}`, 0, 0);
    },
  });

  // ── codex_tasks tool ──

  pi.registerTool({
    name: "codex_tasks",
    label: "Codex Tasks",
    description: "Get detailed codex task info. Check the widget first — this is for when you need full output or stderr.",
    parameters: Type.Object({
      task_id: Type.Optional(Type.Number({ description: "Get details for a specific task" })),
    }),

    async execute(_id, params) {
      if (params.task_id) {
        const task = tasks.get(params.task_id);
        if (!task)
          return {
            content: [{ type: "text", text: `Task #${params.task_id} not found.` }],
            details: { mode: "detail", notFound: true },
          };
        const lines = [
          `Task #${task.id} — ${task.status} (${elapsed(task)})`,
          `Prompt: ${task.prompt}`,
          `Session: ${task.sessionId || "(none)"}`,
          `CWD: ${task.cwd}`,
        ];
        if (task.toolCalls.length > 0) {
          lines.push(`Tool calls: ${task.toolCalls.length}`);
          for (const tc of task.toolCalls.slice(-10)) lines.push(`  → ${tc.type}: ${tc.text.slice(0, 100)}`);
        }
        if (task.usage)
          lines.push(
            `Usage: ↑${fmtTokens(task.usage.input)} cached:${fmtTokens(task.usage.cached)} ↓${fmtTokens(task.usage.output)}`,
          );
        if (task.output) lines.push(`\nOutput:\n${task.output}`);
        if (task.stderr) lines.push(`\nStderr:\n${task.stderr.slice(0, 500)}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            mode: "detail",
            taskId: task.id,
            status: task.status,
            elapsed: elapsed(task),
            sessionId: task.sessionId,
            prompt: task.prompt,
            output: task.output,
            toolCallCount: task.toolCalls.length,
            usage: task.usage,
            stderr: task.stderr,
          },
        };
      }

      if (tasks.size === 0)
        return { content: [{ type: "text", text: "No codex tasks." }], details: { mode: "list", tasks: [] } };

      const summaries: any[] = [];
      const lines: string[] = [];
      for (const task of tasks.values()) {
        const icon = task.status === "running" ? "◆" : task.status === "done" ? "✓" : "✗";
        const session = task.sessionId ? ` ${shortId(task.sessionId)}` : "";
        const preview = task.output ? ` — ${task.output.slice(0, 60).replace(/\n/g, " ")}` : "";
        lines.push(`${icon} #${task.id} [${task.status}] ${elapsed(task)}${session}${preview}`);
        summaries.push({
          id: task.id,
          status: task.status,
          elapsed: elapsed(task),
          sessionId: task.sessionId,
          prompt: task.prompt,
          outputPreview: task.output?.slice(0, 100)?.replace(/\n/g, " ") || "",
        });
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "list", tasks: summaries } };
    },

    renderCall(args, theme) {
      if (args.task_id) {
        return new Text(theme.fg("toolTitle", theme.bold("codex_tasks")) + " " + theme.fg("dim", `#${args.task_id}`), 0, 0);
      }
      return new Text(theme.fg("toolTitle", theme.bold("codex_tasks")), 0, 0);
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
        const meta: string[] = [d.status, d.elapsed];
        if (d.sessionId) meta.push(shortId(d.sessionId));
        if (d.toolCallCount > 0) meta.push(`${d.toolCallCount} tools`);
        if (d.usage) meta.push(`↑${fmtTokens(d.usage.input)} ↓${fmtTokens(d.usage.output)}`);

        let text = `${icon} ${theme.fg("toolTitle", theme.bold(`#${d.taskId}`))} ${theme.fg("dim", meta.join(" · "))}`;

        if (expanded && d.output) {
          const outputLines = d.output.split("\n").slice(0, 20);
          text += "\n" + theme.fg("dim", "───");
          text += "\n" + outputLines.map((l: string) => `  ${l}`).join("\n");
          if (d.output.split("\n").length > 20) text += "\n" + theme.fg("dim", `… ${d.output.split("\n").length - 20} more`);
        } else {
          const snip = d.prompt.length > 80 ? d.prompt.slice(0, 77) + "…" : d.prompt;
          text += "\n" + theme.fg("muted", `  ${snip}`);
        }
        return new Text(text, 0, 0);
      }

      // Task list
      if (d.mode === "list") {
        if (!d.tasks?.length) return new Text(theme.fg("dim", "No codex tasks."), 0, 0);

        const counts: Record<string, number> = {};
        for (const t of d.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
        const parts: string[] = [];
        if (counts.running) parts.push(theme.fg("warning", `${counts.running} running`));
        if (counts.done) parts.push(theme.fg("success", `${counts.done} done`));
        if (counts.error) parts.push(theme.fg("error", `${counts.error} failed`));

        let text =
          theme.fg("toolTitle", theme.bold("codex_tasks")) +
          " " +
          theme.fg("dim", `${d.tasks.length} task${d.tasks.length === 1 ? "" : "s"}`) +
          "  " +
          parts.join(theme.fg("dim", " · "));

        if (expanded) {
          for (const t of d.tasks) {
            const icon = t.status === "running" ? theme.fg("warning", "◆") : t.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
            const snip = t.prompt.length > 60 ? t.prompt.slice(0, 57) + "…" : t.prompt;
            text += `\n  ${icon} #${t.id} ${theme.fg("dim", t.elapsed)} ${theme.fg("muted", snip)}`;
          }
        }
        return new Text(text, 0, 0);
      }

      const txt = result.content[0];
      return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
    },
  });

  // ── Completion message renderer ──

  pi.registerMessageRenderer<any>("codex-result", (message, { expanded }, theme) => {
    const details = message.details;
    if (!details) return undefined;
    const container = new Container();
    const isDone = details.status === "done";
    const icon = isDone ? theme.fg("success", "✓") : theme.fg("error", "✗");

    let header = `${icon} ${theme.fg("toolTitle", theme.bold(`Codex #${details.taskId}`))}`;
    const meta: string[] = [];
    if (details.toolCalls?.length > 0) meta.push(`${details.toolCalls.length} tool${details.toolCalls.length === 1 ? "" : "s"}`);
    if (details.usage) meta.push(`↑${fmtTokens(details.usage.input)} ↓${fmtTokens(details.usage.output)}`);
    if (details.sessionId) meta.push(shortId(details.sessionId));
    if (meta.length > 0) header += " " + theme.fg("dim", meta.join(" · "));
    container.addChild(new Text(header, 1, 0));

    if (expanded) {
      if (details.toolCalls?.length > 0) {
        container.addChild(new Spacer(1));
        for (const tc of details.toolCalls.slice(-15)) {
          container.addChild(
            new Text(theme.fg("dim", "  →") + " " + theme.fg("accent", tc.type) + " " + theme.fg("dim", tc.text.slice(0, 70)), 1, 0),
          );
        }
        if (details.toolCalls.length > 15) {
          container.addChild(new Text(theme.fg("dim", `    … ${details.toolCalls.length - 15} more`), 1, 0));
        }
      }
      if (details.output) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(details.output, 1, 0, getMarkdownTheme()));
      }
      if (details.sessionId) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `session ${details.sessionId}`), 1, 0));
      }
    } else {
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
