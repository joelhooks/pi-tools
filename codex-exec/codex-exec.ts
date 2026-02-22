import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Contextual Name Generator ──────────────────────────

// Stop words to filter out when extracting keywords
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "out", "off",
  "over", "under", "again", "further", "then", "once", "here", "there",
  "when", "where", "why", "how", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not", "only",
  "own", "same", "so", "than", "too", "very", "just", "because", "but",
  "and", "or", "if", "while", "that", "this", "these", "those", "it",
  "its", "i", "you", "he", "she", "we", "they", "me", "him", "her", "us",
  "them", "my", "your", "his", "our", "their", "what", "which", "who",
  "whom", "up", "about", "make", "use", "using", "used", "set", "get",
  "also", "new", "like", "etc", "any", "don", "don't", "doesn", "doesn't",
  "file", "files", "code", "ensure", "implement", "create", "update",
  "add", "change", "write", "read", "check", "run", "make", "build",
  "following", "based", "existing", "current", "given", "specific",
]);

// Templates: $W = extracted keyword. Fully unhinged. No guardrails.
const TEMPLATES = [
  // Drama
  "revenge-of-$W", "$W-apocalypse", "the-$W-incident", "$W-strikes-back",
  "escape-from-$W", "return-of-$W", "$W-reloaded",
  "the-$W-conspiracy", "$W-rising", "operation-$W",
  // Feral energy
  "$W-whisperer", "feral-$W", "unhinged-$W", "rabid-$W",
  "cursed-$W", "chaotic-$W", "deranged-$W", "frothing-$W",
  "$W-wrangler", "bewildered-$W", "feverish-$W", "psychotic-$W",
  // Action
  "$W-goes-brrr", "yeet-$W", "$W-speedrun", "turbo-$W",
  "full-send-$W", "LEEROY-$W",
  // Aussie
  "crikey-$W", "$W-down-under", "mad-$W", "fair-dinkum-$W",
  // Absurd
  "$W-in-a-trenchcoat", "definitely-not-$W", "$W-but-worse",
  "forbidden-$W", "artisanal-$W", "$W-noir",
  "two-$Ws-in-a-trenchcoat", "$W-cinematic-universe",
  "$W-extended-lore", "free-range-$W", "cage-free-$W",
  "organic-$W", "gluten-free-$W", "$W-asmr",
  "$W-fanfic", "$W-lore-drop", "pregnant-$W",
  "$W-but-sentient", "$W-gained-consciousness", "the-$W-hungers",
  "$W-final-form", "mega-ultra-$W", "$W-requiem",
  // Existential dread
  "$W-was-a-mistake", "why-$W", "$W-at-3am", "the-$W-question",
  "allegedly-$W", "$W-sleep-paralysis", "$W-void",
  "staring-into-$W", "$W-has-no-god", "pray-for-$W",
  "$W-cries-alone", "existential-$W", "the-$W-abyss",
  // Profane
  "oh-shit-$W", "$W-from-hell", "goddamn-$W", "bloody-$W",
  "what-the-$W", "absolute-unit-$W", "$W-shitshow",
  "clusterfuck-$W", "dumpster-fire-$W", "flaming-$W",
  "hold-my-$W", "$W-on-crack", "wtf-$W", "fuckin-$W",
  "$W-of-doom", "shitstorm-$W", "hellspawn-$W",
  "shitting-out-$W", "ass-blast-$W", "$W-on-bath-salts",
  "unholy-$W", "$W-from-the-sewer", "toxic-$W-dump",
  "shit-flavored-$W", "deep-fried-$W", "microwaved-$W",
  "$W-ate-my-homework", "sorry-about-$W", "oops-all-$W",
  // Crude body horror
  "$W-shart", "moist-$W", "sweaty-$W", "sus-$W",
  "$W-chungus", "thicc-$W", "crusty-$W", "greasy-$W",
  "hot-$W-garbage", "raw-dog-$W", "bruh-$W",
  "no-lube-$W", "buttclenching-$W", "rectal-$W",
  "throbbing-$W", "$W-discharge", "infected-$W",
  "prolapsed-$W", "oozing-$W", "engorged-$W",
  "$W-suppository", "gangrenous-$W", "festering-$W",
  "turgid-$W", "weeping-$W", "curdled-$W",
  // Violence
  "fight-me-$W", "$W-can-die", "eat-shit-$W", "nuke-$W",
  "punt-$W", "dropkick-$W", "strangle-$W", "$W-must-perish",
  "suplex-$W", "tombstone-$W", "falcon-punch-$W",
  "murder-$W", "euthanize-$W", "$W-gets-the-hose",
  "old-yeller-$W", "sacrifice-$W", "$W-to-the-woodchipper",
  // Unhinged escalation
  "$W-gained-sentience-and-chose-violence",
  "help-$W-is-in-my-walls",
  "$W-called-the-police",
  "officer-i-dropkicked-$W-in-self-defense",
  "i-showed-$W-to-my-therapist",
  "$W-is-my-sleep-paralysis-demon",
  "hot-girl-$W", "girlboss-$W", "gaslight-gatekeep-$W",
  "$W-and-it-was-personal",
  "i-will-not-apologize-for-$W",
];

// Domain keywords with specificity tiers (higher = more interesting in a name)
const DOMAIN_SCORES: Record<string, number> = {
  // Proper nouns / branded — most interesting
  inngest: 20, redis: 20, convex: 20, kubernetes: 20, k8s: 20, docker: 20,
  telegram: 20, nextjs: 20, typescript: 18, react: 18, qdrant: 20, typesense: 20,
  livekit: 20, mux: 20, vercel: 20, tailscale: 20, telnyx: 20,
  // Specific domain concepts
  gateway: 15, webhook: 15, schema: 15, pipeline: 15, migration: 15,
  middleware: 15, cron: 15, worker: 15, deploy: 15, auth: 14,
  // Generic domain words
  api: 12, test: 12, tests: 12, database: 12, query: 12, mutation: 12,
  function: 10, event: 10, component: 10, route: 10, plugin: 10, extension: 10,
  email: 12, slog: 14, otel: 14, vault: 14, memory: 12, adr: 14, review: 12,
  // Action words — good flavor but lower priority than nouns
  refactor: 8, debug: 8, fix: 8, error: 10, bug: 10, crash: 12, broken: 10,
};

function extractKeyword(prompt: string): string {
  // Normalize: lowercase, strip backticks/quotes, split on word boundaries
  const cleaned = prompt.toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/[^a-z0-9\-\/\.]/g, " ");

  // Extract tokens, including path segments (adr/review → adr, review)
  const tokens = cleaned
    .split(/[\s\/\.\-]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));

  if (tokens.length === 0) return "mystery";

  // Score tokens: domain words get tiered priority, length breaks ties
  const scored = tokens.map((t) => ({
    word: t,
    score: (DOMAIN_SCORES[t] || 0) + Math.min(t.length, 6),
  }));

  // Dedupe, keep highest score per word
  const seen = new Map<string, number>();
  for (const { word, score } of scored) {
    seen.set(word, Math.max(seen.get(word) || 0, score));
  }

  // Sort by score desc, take top
  const sorted = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0][0];
}

function generateName(prompt: string): string {
  const keyword = extractKeyword(prompt);
  const template = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
  return template.replace(/\$W/g, keyword);
}

// ── Text Sanitization ──────────────────────────────────

/** Strip control chars and collapse whitespace to produce safe single-line text */
function sanitize(s: string): string {
  return s.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
}

// ── Types ──────────────────────────────────────────────

interface TaskItem {
  id: number;
  name: string;
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

  const termWidth = process.stdout.columns || 80;

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

    // Build prefix first so we can measure how much room is left for the snippet
    const prefix = `${icon} ${theme.fg("text", t.name)} ${theme.fg("dim", parts.join(" · "))} `;
    const maxSnippetWidth = Math.max(8, termWidth - visibleWidth(prefix) - 1);

    // Show output snippet for completed, prompt snippet for running
    let rawSnippet: string;
    if (t.status !== "running" && t.output) {
      rawSnippet = t.output.split("\n").find((l) => l.trim()) || "";
    } else {
      rawSnippet = t.prompt;
    }
    // Strip ALL control chars and collapse whitespace — newlines in widget lines crash pi
    rawSnippet = sanitize(rawSnippet);
    const snippetWidth = visibleWidth(rawSnippet);
    const snippet = snippetWidth > maxSnippetWidth
      ? truncateToWidth(rawSnippet, maxSnippetWidth - 1) + "…"
      : rawSnippet;

    const line = `${prefix}${theme.fg("muted", snippet)}`;
    // Safety net: truncate final composed line to terminal width
    return truncateToWidth(line, termWidth);
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
      const taskName = generateName(params.prompt);
      const cwd = params.cwd || ctx.cwd;
      const task: TaskItem = {
        id: taskId,
        name: taskName,
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
            content: [`Codex ${task.name} ${statusLabel} (${elapsed(task)})`, errorHint, preview, sessionHint]
              .filter(Boolean)
              .join("\n"),
            display: false,
            details: {
              taskId: task.id,
              taskName: task.name,
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
        content: [{ type: "text", text: `Codex task ${taskName} started${sessionInfo}. Status in widget.` }],
        details: { taskId, taskName, sessionId: params.session_id || null },
      };
    },

    renderCall(args, theme) {
      const mode = args.session_id ? `resume ${shortId(args.session_id)}` : "exec";
      const meta: string[] = [mode];
      if (args.model) meta.push(args.model);
      if (args.sandbox && args.sandbox !== "workspace-write") meta.push(args.sandbox);
      let text = theme.fg("toolTitle", theme.bold("codex"));
      text += " " + theme.fg("dim", meta.join(" · "));
      const cleanPreview = sanitize(args.prompt);
      const preview = cleanPreview.length > 100 ? cleanPreview.slice(0, 97) + "…" : cleanPreview;
      text += "\n" + theme.fg("dim", `  ${preview}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as { taskId: number; taskName: string; sessionId: string | null } | undefined;
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
      return new Text(`${icon} ${theme.fg("toolTitle", theme.bold(`codex ${task.name}`))} ${theme.fg("dim", meta.join(" · "))}`, 0, 0);
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
          `Task ${task.name} — ${task.status} (${elapsed(task)})`,
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
            taskName: task.name,
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
        const preview = task.output ? ` — ${sanitize(task.output).slice(0, 60)}` : "";
        lines.push(`${icon} ${task.name} [${task.status}] ${elapsed(task)}${session}${preview}`);
        summaries.push({
          id: task.id,
          name: task.name,
          status: task.status,
          elapsed: elapsed(task),
          sessionId: task.sessionId,
          prompt: task.prompt,
          outputPreview: sanitize(task.output || "").slice(0, 100),
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

        let text = `${icon} ${theme.fg("toolTitle", theme.bold(d.taskName || `#${d.taskId}`))} ${theme.fg("dim", meta.join(" · "))}`;

        if (expanded && d.output) {
          const outputLines = d.output.split("\n").slice(0, 20);
          text += "\n" + theme.fg("dim", "───");
          text += "\n" + outputLines.map((l: string) => `  ${sanitize(l)}`).join("\n");
          if (d.output.split("\n").length > 20) text += "\n" + theme.fg("dim", `… ${d.output.split("\n").length - 20} more`);
        } else {
          const cleanPrompt = sanitize(d.prompt);
          const snip = cleanPrompt.length > 80 ? cleanPrompt.slice(0, 77) + "…" : cleanPrompt;
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
            const cleanP = sanitize(t.prompt || "");
            const snip = cleanP.length > 60 ? cleanP.slice(0, 57) + "…" : cleanP;
            text += `\n  ${icon} ${t.name || `#${t.id}`} ${theme.fg("dim", t.elapsed)} ${theme.fg("muted", snip)}`;
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

    let header = `${icon} ${theme.fg("toolTitle", theme.bold(`Codex ${details.taskName || `#${details.taskId}`}`))}`;
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
            new Text(theme.fg("dim", "  →") + " " + theme.fg("accent", tc.type) + " " + theme.fg("dim", sanitize(tc.text).slice(0, 70)), 1, 0),
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
