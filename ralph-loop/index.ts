/**
 * ralph-loop — Autonomous coding loops via Codex background workers.
 *
 * Spawns codex exec for each iteration, monitors progress via widget.
 * No conversation spam — iterations update the widget silently.
 * Model gets results via hidden messages, responds once when loop completes.
 *
 * Two modes:
 *   PRD mode — reads prd.json, picks stories by priority, implements per iteration
 *   Prompt mode — runs a single prompt repeatedly
 *
 * Supports skill injection and free-form context.
 *
 * Based on: https://github.com/joelhooks/openclaw-codex-ralph
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ───────────────────────────────────────────────

interface Story {
  id: string;
  title: string;
  description: string;
  priority: number;
  passes: boolean;
  validationCommand?: string;
  acceptanceCriteria?: string[];
}

interface PRD {
  projectName: string;
  description?: string;
  stories: Story[];
}

interface LoopJob {
  id: string;
  status: "running" | "done" | "failed" | "cancelled";
  cwd: string;
  mode: "prd" | "prompt";
  prompt?: string;
  model: string;
  sandbox: string;
  iteration: number;
  maxIterations: number;
  currentStory?: { id: string; title: string };
  results: IterationResult[];
  startedAt: number;
  finishedAt: number | null;
  proc: ChildProcess | null;
  aborted: boolean;
  skills: string[];
  context?: string;
  skillContent?: string;
}

interface IterationResult {
  iteration: number;
  storyId?: string;
  storyTitle?: string;
  success: boolean;
  toolCalls: number;
  sessionId?: string;
  duration: number;
  summary: string;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    type?: string;
    command?: string;
    text?: string;
    path?: string;
    exit_code?: number | null;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
}

// ── State ───────────────────────────────────────────────

const jobs = new Map<string, LoopJob>();
let nextJobNum = 1;
let widgetTui: { requestRender: () => void } | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
const COMPLETED_LINGER_MS = 20_000;

function genId(): string {
  return `ralph-${nextJobNum++}`;
}

// ── Formatting ──────────────────────────────────────────

function elapsed(job: LoopJob): string {
  const sec = Math.round((Date.now() - job.startedAt) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
}

function fmtDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }], details: {} };
}

// ── Widget ──────────────────────────────────────────────

function refreshWidget(): void {
  widgetTui?.requestRender();
}

function ensureStatusTimer(): void {
  if (statusTimer) return;
  statusTimer = setInterval(() => {
    const now = Date.now();
    const hasVisible = [...jobs.values()].some(
      (j) => j.status === "running" || (j.finishedAt && now - j.finishedAt < COMPLETED_LINGER_MS),
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
  const visible = [...jobs.values()].filter(
    (j) => j.status === "running" || (j.finishedAt && now - j.finishedAt < COMPLETED_LINGER_MS),
  );
  if (visible.length === 0) return [];

  return visible.map((j) => {
    const icon =
      j.status === "running"
        ? theme.fg("warning", "◆")
        : j.status === "done"
          ? theme.fg("success", "✓")
          : j.status === "failed"
            ? theme.fg("error", "✗")
            : theme.fg("muted", "○");

    const ok = j.results.filter((r) => r.success).length;
    const fail = j.results.length - ok;
    const parts: string[] = [j.mode, `${j.iteration}/${j.maxIterations}`, elapsed(j)];
    if (j.skills.length) parts.push(`+${j.skills.join(",")}`);

    let line = `${icon} ${theme.fg("text", j.id)} ${theme.fg("dim", parts.join(" · "))}`;

    // Progress bar
    if (j.status === "running" && j.maxIterations > 0) {
      const pct = Math.round((j.iteration / j.maxIterations) * 100);
      line += theme.fg("dim", ` ${pct}%`);
    }

    // Result counts for completed
    if (j.status !== "running") {
      const summary = theme.fg("success", `${ok}✓`) + (fail > 0 ? theme.fg("error", ` ${fail}✗`) : "");
      line += ` ${summary}`;
    }

    // Current story or last result
    if (j.status === "running" && j.currentStory) {
      const title = j.currentStory.title.length > 40 ? j.currentStory.title.slice(0, 37) + "…" : j.currentStory.title;
      line += `  ${theme.fg("accent", `▸ ${title}`)}`;
    } else if (j.status !== "running" && j.results.length > 0) {
      const last = j.results[j.results.length - 1];
      const snippet = last.summary.split("\n")[0]?.trim() || "";
      const snip = snippet.length > 40 ? snippet.slice(0, 37) + "…" : snippet;
      if (snip) line += `  ${theme.fg("muted", snip)}`;
    }

    return line;
  });
}

// ── Skill helpers ───────────────────────────────────────

function resolveSkills(names: string[]): string {
  const skillsDir = join(homedir(), ".pi", "agent", "skills");
  const parts: string[] = [];
  for (const name of names) {
    const skillPath = join(skillsDir, name, "SKILL.md");
    if (existsSync(skillPath)) {
      parts.push(`# Skill: ${name}\n\n${readFileSync(skillPath, "utf-8")}`);
    }
  }
  return parts.join("\n\n---\n\n");
}

function buildPromptPrefix(job: LoopJob): string {
  const parts: string[] = [];
  if (job.skillContent) {
    parts.push("## Injected Skills\n\nFollow these skill guidelines for all work in this iteration:\n\n" + job.skillContent);
  }
  if (job.context) {
    parts.push("## Context\n\n" + job.context);
  }
  return parts.length > 0 ? parts.join("\n\n---\n\n") + "\n\n---\n\n" : "";
}

// ── PRD helpers ─────────────────────────────────────────

function readPRD(cwd: string): PRD | null {
  const p = join(cwd, "prd.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function nextStory(prd: PRD): Story | null {
  return prd.stories.filter((s) => !s.passes).sort((a, b) => a.priority - b.priority)[0] ?? null;
}

function markStoryDone(cwd: string, storyId: string) {
  const prd = readPRD(cwd);
  if (!prd) return;
  const story = prd.stories.find((s) => s.id === storyId);
  if (story) story.passes = true;
  writeFileSync(join(cwd, "prd.json"), JSON.stringify(prd, null, 2));
}

function prdStats(cwd: string): { total: number; done: number; remaining: number; projectName: string } | null {
  const prd = readPRD(cwd);
  if (!prd) return null;
  const done = prd.stories.filter((s) => s.passes).length;
  return { total: prd.stories.length, done, remaining: prd.stories.length - done, projectName: prd.projectName };
}

// ── Codex spawner ───────────────────────────────────────

function spawnCodexWorker(
  job: LoopJob,
  prompt: string,
  onDone: (result: IterationResult) => void,
) {
  const startTime = Date.now();
  const args = [
    "exec",
    "--full-auto",
    "--json",
    "--skip-git-repo-check",
    "-m",
    job.model,
    "--sandbox",
    job.sandbox,
    prompt,
  ];

  const child = spawn("codex", args, {
    cwd: job.cwd,
    env: {
      ...process.env,
      PATH: `${homedir()}/.local/bin:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  job.proc = child;

  let stdout = "";
  let sessionId: string | undefined;
  let toolCalls = 0;
  let lastMessage = "";
  let stalled = false;

  let stallTimer = setTimeout(() => {
    stalled = true;
    child.kill("SIGTERM");
  }, 180_000);
  const resetStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      child.kill("SIGTERM");
    }, 180_000);
  };

  child.stdout!.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev: CodexEvent = JSON.parse(line);
        if (ev.type === "thread.started" && ev.thread_id) sessionId = ev.thread_id;
        if (ev.type === "item.completed") {
          resetStall();
          if (ev.item?.type === "command_execution") toolCalls++;
          if (ev.item?.type === "agent_message" && ev.item.text) lastMessage = ev.item.text;
          if (ev.item?.type === "file_change") toolCalls++;
        }
      } catch {}
    }
    refreshWidget();
  });

  child.stderr!.on("data", () => {});

  child.on("close", (code) => {
    clearTimeout(stallTimer);
    job.proc = null;
    const duration = Date.now() - startTime;
    const summary = lastMessage
      ? lastMessage.length > 300
        ? lastMessage.slice(0, 300) + "..."
        : lastMessage
      : stalled
        ? "Stalled — killed after 3 min inactivity"
        : `Exit code ${code}`;

    onDone({
      iteration: job.iteration,
      storyId: job.currentStory?.id,
      storyTitle: job.currentStory?.title,
      success: code === 0,
      toolCalls,
      sessionId,
      duration,
      summary,
    });
  });

  child.on("error", (err) => {
    clearTimeout(stallTimer);
    job.proc = null;
    onDone({
      iteration: job.iteration,
      success: false,
      toolCalls: 0,
      duration: Date.now() - startTime,
      summary: `Spawn error: ${err.message}`,
    });
  });
}

// ── Loop runner ─────────────────────────────────────────

async function runLoop(job: LoopJob, pi: ExtensionAPI) {
  if (job.skills.length > 0) {
    job.skillContent = resolveSkills(job.skills);
  }

  const prefix = buildPromptPrefix(job);

  const runIteration = (): Promise<IterationResult> => {
    return new Promise((resolve) => {
      let prompt: string;

      if (job.mode === "prd") {
        const prd = readPRD(job.cwd);
        if (!prd) {
          resolve({ iteration: job.iteration, success: false, toolCalls: 0, duration: 0, summary: "No prd.json found" });
          return;
        }
        const story = nextStory(prd);
        if (!story) {
          resolve({ iteration: job.iteration, success: true, toolCalls: 0, duration: 0, summary: "All stories complete!" });
          return;
        }
        job.currentStory = { id: story.id, title: story.title };
        refreshWidget();
        prompt = `${prefix}# Project: ${prd.projectName}\n${prd.description || ""}\n\n## Story: ${story.title} (${story.id})\n${story.description}\n\n${story.acceptanceCriteria?.map((c, i) => `${i + 1}. ${c}`).join("\n") || ""}\n\n${story.validationCommand ? `Validate: \`${story.validationCommand}\`` : ""}\n\nRULES:\n1. Implement ONLY this story\n2. Validation must pass\n3. Do NOT modify prd.json`;
      } else {
        prompt = prefix + job.prompt!;
      }

      spawnCodexWorker(job, prompt, resolve);
    });
  };

  while (job.iteration < job.maxIterations && !job.aborted) {
    job.iteration++;
    refreshWidget();
    const result = await runIteration();
    job.results.push(result);
    refreshWidget();

    // Silent iteration report — model gets context, no conversation clutter
    pi.sendMessage(
      {
        customType: "ralph-iteration",
        content: `Ralph ${job.id} iteration ${result.iteration}/${job.maxIterations}: ${result.success ? "✓" : "✗"} ${result.storyTitle || "prompt"} (${fmtDuration(result.duration)}, ${result.toolCalls} tools)\n${result.summary}`,
        display: false,
        details: {
          jobId: job.id,
          maxIterations: job.maxIterations,
          mode: job.mode,
          skills: job.skills,
          ...result,
        },
      },
      { triggerTurn: false, deliverAs: "followUp" },
    );

    // PRD mode: mark story done, check if all complete
    if (job.mode === "prd" && result.success && result.storyId) {
      markStoryDone(job.cwd, result.storyId);
      const prd = readPRD(job.cwd);
      if (prd && !nextStory(prd)) {
        job.status = "done";
        job.finishedAt = Date.now();
        refreshWidget();
        pi.sendMessage(
          {
            customType: "ralph-complete",
            content: buildCompletionSummary(job),
            display: false,
            details: buildCompletionDetails(job),
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        return;
      }
    }

    // Prompt mode: stop on failure
    if (job.mode === "prompt" && !result.success) {
      job.status = "failed";
      job.finishedAt = Date.now();
      refreshWidget();
      pi.sendMessage(
        {
          customType: "ralph-failed",
          content: `Ralph ${job.id} failed on iteration ${result.iteration}: ${result.summary}`,
          display: false,
          details: {
            jobId: job.id,
            mode: job.mode,
            skills: job.skills,
            failedIteration: result.iteration,
            elapsed: elapsed(job),
            results: job.results,
          },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      return;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  job.status = job.aborted ? "cancelled" : "done";
  job.finishedAt = Date.now();
  refreshWidget();

  pi.sendMessage(
    {
      customType: "ralph-complete",
      content: buildCompletionSummary(job),
      display: false,
      details: buildCompletionDetails(job),
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function buildCompletionSummary(job: LoopJob): string {
  const ok = job.results.filter((r) => r.success).length;
  const fail = job.results.length - ok;
  const label = job.aborted ? "cancelled" : "complete";
  const lines = [`Ralph ${job.id} ${label} — ${job.iteration} iterations in ${elapsed(job)} (${ok} passed, ${fail} failed)`];
  for (const r of job.results) {
    lines.push(`  ${r.success ? "✓" : "✗"} #${r.iteration} ${r.storyTitle || "prompt"} (${fmtDuration(r.duration)}): ${r.summary.split("\n")[0]?.slice(0, 100) || ""}`);
  }
  return lines.join("\n");
}

function buildCompletionDetails(job: LoopJob): any {
  return {
    jobId: job.id,
    mode: job.mode,
    skills: job.skills,
    totalIterations: job.iteration,
    elapsed: elapsed(job),
    results: job.results,
    cancelled: job.aborted,
  };
}

// ── Extension ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Widget lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWidget("ralph-loop", (tui, theme) => {
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
    for (const job of jobs.values()) {
      job.aborted = true;
      if (job.proc) job.proc.kill("SIGTERM");
    }
  });

  // ── ralph_loop tool ───────────────────────────────────

  pi.registerTool({
    name: "ralph_loop",
    label: "Ralph Loop",
    description: [
      "Run autonomous coding loops via Codex background workers.",
      "Two modes: (1) PRD mode — reads prd.json, picks stories by priority, implements one per iteration.",
      "(2) Prompt mode — runs a single prompt repeatedly with optional exit condition.",
      "Each iteration spawns a fresh codex exec. Reports progress via messages.",
      "Returns immediately with a job ID.",
      "Supports skill injection: pass skills=['frontend-design'] to prepend skill content to every prompt.",
    ].join(" "),
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("prd"), Type.Literal("prompt")], {
        description: "prd = story-driven from prd.json, prompt = repeat a prompt",
      }),
      prompt: Type.Optional(Type.String({ description: "Prompt for each iteration (prompt mode only)" })),
      max_iterations: Type.Optional(Type.Number({ description: "Max iterations (default: 10)" })),
      model: Type.Optional(Type.String({ description: "Codex model (default: o4-mini)" })),
      sandbox: Type.Optional(
        Type.String({ description: "Sandbox: read-only, workspace-write, danger-full-access (default: workspace-write)" }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory" })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Skill names to inject into prompts (reads ~/.pi/agent/skills/{name}/SKILL.md)" })),
      context: Type.Optional(Type.String({ description: "Free-form context prepended to every prompt (e.g. 'brutalist dark theme, monospace')" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const job: LoopJob = {
        id: genId(),
        status: "running",
        cwd: params.cwd || ctx.cwd,
        mode: params.mode,
        prompt: params.prompt,
        model: params.model || "o4-mini",
        sandbox: params.sandbox || "workspace-write",
        iteration: 0,
        maxIterations: params.max_iterations || 10,
        results: [],
        startedAt: Date.now(),
        finishedAt: null,
        proc: null,
        aborted: false,
        skills: params.skills || [],
        context: params.context,
      };
      jobs.set(job.id, job);

      if (job.mode === "prd" && !readPRD(job.cwd)) return text(`No prd.json found in ${job.cwd}`);
      if (job.mode === "prompt" && !job.prompt) return text("Prompt mode requires a prompt parameter");

      const missing = job.skills.filter((s) => !existsSync(join(homedir(), ".pi", "agent", "skills", s, "SKILL.md")));
      if (missing.length > 0) return text(`Skills not found: ${missing.join(", ")}`);

      ensureStatusTimer();
      refreshWidget();

      runLoop(job, pi).catch((err) => {
        job.status = "failed";
        job.finishedAt = Date.now();
        refreshWidget();
        pi.sendMessage(
          {
            customType: "ralph-failed",
            content: `Ralph ${job.id} error: ${err.message || err}`,
            display: false,
            details: {
              jobId: job.id,
              mode: job.mode,
              skills: job.skills,
              error: err.message || String(err),
              elapsed: elapsed(job),
              results: job.results,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      });

      const stats = prdStats(job.cwd);
      return {
        content: [{ type: "text" as const, text: `Ralph loop ${job.id} started. Status in widget.` }],
        details: {
          jobId: job.id,
          mode: job.mode,
          model: job.model,
          sandbox: job.sandbox,
          maxIterations: job.maxIterations,
          skills: job.skills,
          context: job.context,
          ...(stats ? { projectName: stats.projectName, storiesRemaining: stats.remaining, storiesTotal: stats.total } : {}),
        },
      };
    },

    renderCall(args, theme) {
      const meta: string[] = [args.mode];
      if (args.model && args.model !== "o4-mini") meta.push(args.model);
      if (args.sandbox && args.sandbox !== "workspace-write") meta.push(args.sandbox);
      if (args.max_iterations) meta.push(`max ${args.max_iterations}`);
      if (args.skills?.length) meta.push(`+${args.skills.join(",")}`);

      let label = theme.fg("toolTitle", theme.bold("ralph"));
      label += " " + theme.fg("dim", meta.join(" · "));
      if (args.context) {
        label += "\n" + theme.fg("dim", `  ${args.context.length > 80 ? args.context.slice(0, 77) + "…" : args.context}`);
      }
      if (args.prompt) {
        const preview = args.prompt.length > 80 ? args.prompt.slice(0, 77) + "…" : args.prompt;
        label += "\n" + theme.fg("dim", `  ${preview}`);
      }
      return new Text(label, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as any;
      if (!d?.jobId) {
        const txt = result.content[0];
        return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
      }

      const job = jobs.get(d.jobId);
      const status = job?.status ?? "done";
      const icon =
        status === "running"
          ? theme.fg("warning", "◆")
          : status === "done"
            ? theme.fg("success", "✓")
            : status === "failed"
              ? theme.fg("error", "✗")
              : theme.fg("muted", "○");

      const meta: string[] = [status];
      if (job) meta.push(elapsed(job));
      if (d.storiesRemaining != null) meta.push(`${d.storiesRemaining}/${d.storiesTotal} stories`);
      if (d.skills?.length) meta.push(`+${d.skills.join(",")}`);

      let line = `${icon} ${theme.fg("toolTitle", theme.bold(d.jobId))}`;
      line += " " + theme.fg("dim", meta.join(" · "));
      if (d.projectName) line += "\n" + theme.fg("dim", `  ${d.projectName}`);

      return new Text(line, 0, 0);
    },
  });

  // ── ralph_jobs tool ───────────────────────────────────

  pi.registerTool({
    name: "ralph_jobs",
    label: "Ralph Jobs",
    description: "Get detailed ralph loop info or cancel a job. Check the widget first — this is for full iteration history.",
    parameters: Type.Object({
      job_id: Type.Optional(Type.String({ description: "Specific job ID" })),
      cancel: Type.Optional(Type.Boolean({ description: "Cancel the job" })),
    }),

    async execute(_id, params) {
      if (params.job_id) {
        const job = jobs.get(params.job_id);
        if (!job) return text(`Job ${params.job_id} not found`);
        if (params.cancel && job.status === "running") {
          job.aborted = true;
          if (job.proc) job.proc.kill("SIGTERM");
          return text(`Cancelled job ${job.id}`);
        }
        return {
          content: [{ type: "text" as const, text: `Ralph #${job.id} — ${job.status}` }],
          details: {
            mode: "detail",
            jobId: job.id,
            status: job.status,
            jobMode: job.mode,
            model: job.model,
            iteration: job.iteration,
            maxIterations: job.maxIterations,
            skills: job.skills,
            context: job.context,
            elapsed: elapsed(job),
            currentStory: job.currentStory,
            successCount: job.results.filter((r) => r.success).length,
            totalResults: job.results.length,
            results: job.results.slice(-5),
          },
        };
      }

      if (jobs.size === 0) return { content: [{ type: "text" as const, text: "No ralph jobs." }], details: { mode: "list", jobs: [] } };

      const all = [...jobs.values()].map((j) => ({
        jobId: j.id,
        status: j.status,
        jobMode: j.mode,
        iteration: j.iteration,
        maxIterations: j.maxIterations,
        elapsed: elapsed(j),
        skills: j.skills,
        successCount: j.results.filter((r) => r.success).length,
        totalResults: j.results.length,
      }));
      return {
        content: [{ type: "text" as const, text: `${all.length} ralph jobs` }],
        details: { mode: "list", jobs: all },
      };
    },

    renderCall(args, theme) {
      let text_str = theme.fg("toolTitle", theme.bold("ralph_jobs"));
      if (args.job_id) text_str += " " + theme.fg("dim", args.job_id);
      if (args.cancel) text_str += " " + theme.fg("error", "cancel");
      return new Text(text_str, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (!d) {
        const txt = result.content[0];
        return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
      }

      // Single job detail
      if (d.mode === "detail") {
        const icon =
          d.status === "running"
            ? theme.fg("warning", "◆")
            : d.status === "done"
              ? theme.fg("success", "✓")
              : d.status === "failed"
                ? theme.fg("error", "✗")
                : theme.fg("muted", "○");

        const meta = [d.status, d.elapsed, `${d.iteration}/${d.maxIterations}`];
        if (d.skills?.length) meta.push(`+${d.skills.join(",")}`);

        let text_str = `${icon} ${theme.fg("toolTitle", theme.bold(d.jobId))} ${theme.fg("dim", meta.join(" · "))}`;
        text_str += `\n  ${theme.fg("dim", `${d.successCount}/${d.totalResults} passed`)}`;
        if (d.currentStory) text_str += `  ${theme.fg("accent", `▸ ${d.currentStory.title}`)}`;

        if (expanded && d.results?.length > 0) {
          text_str += "\n" + theme.fg("dim", "  ───");
          for (const r of d.results) {
            const ri = r.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
            const storyLabel = r.storyTitle || "prompt";
            text_str += `\n  ${ri} #${r.iteration} ${theme.fg("dim", `${storyLabel} · ${fmtDuration(r.duration)} · ${r.toolCalls} calls`)}`;
            if (!r.success && r.summary) {
              const snip = r.summary.split("\n")[0]?.slice(0, 80) || "";
              text_str += `\n    ${theme.fg("muted", snip)}`;
            }
          }
        }
        return new Text(text_str, 0, 0);
      }

      // Job list
      if (d.mode === "list") {
        if (!d.jobs?.length) return new Text(theme.fg("dim", "No ralph jobs."), 0, 0);

        const counts: Record<string, number> = {};
        for (const j of d.jobs) counts[j.status] = (counts[j.status] || 0) + 1;
        const parts: string[] = [];
        if (counts.running) parts.push(theme.fg("warning", `${counts.running} running`));
        if (counts.done) parts.push(theme.fg("success", `${counts.done} done`));
        if (counts.failed) parts.push(theme.fg("error", `${counts.failed} failed`));

        let text_str =
          theme.fg("toolTitle", theme.bold("ralph_jobs")) +
          " " +
          theme.fg("dim", `${d.jobs.length} job${d.jobs.length === 1 ? "" : "s"}`) +
          "  " +
          parts.join(theme.fg("dim", " · "));

        if (expanded) {
          for (const j of d.jobs) {
            const icon =
              j.status === "running"
                ? theme.fg("warning", "◆")
                : j.status === "done"
                  ? theme.fg("success", "✓")
                  : theme.fg("error", "✗");
            text_str += `\n  ${icon} ${theme.fg("text", j.jobId)} ${theme.fg("dim", `${j.jobMode} ${j.iteration}/${j.maxIterations} ${j.elapsed} ${j.successCount}/${j.totalResults} ok`)}`;
          }
        }
        return new Text(text_str, 0, 0);
      }

      const txt = result.content[0];
      return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
    },
  });

  // ── Message renderers (for when display:true is used or history review) ──

  pi.registerMessageRenderer<any>("ralph-iteration", (message, { expanded }, theme) => {
    const d = message.details;
    if (!d) return undefined;

    const icon = d.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const meta: string[] = [`${d.iteration}/${d.maxIterations}`];
    if (d.toolCalls > 0) meta.push(`${d.toolCalls} tools`);
    meta.push(fmtDuration(d.duration));

    let header = `${icon} ${theme.fg("toolTitle", theme.bold(d.jobId))} ${theme.fg("dim", meta.join(" · "))}`;
    if (d.storyTitle) header += `  ${theme.fg("accent", d.storyTitle)}`;

    if (expanded && d.summary) {
      const container = new Container();
      container.addChild(new Text(header, 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(d.summary, 1, 0, getMarkdownTheme()));
      return container;
    }

    return new Text(header, 1, 0);
  });

  pi.registerMessageRenderer<any>("ralph-complete", (message, { expanded }, theme) => {
    const d = message.details;
    if (!d) return undefined;

    const icon = d.cancelled ? theme.fg("muted", "○") : theme.fg("success", "✓");
    const label = d.cancelled ? "cancelled" : "complete";
    const results: IterationResult[] = d.results || [];
    const ok = results.filter((r) => r.success).length;
    const fail = results.length - ok;

    let header = `${icon} ${theme.fg("toolTitle", theme.bold(d.jobId))} ${theme.fg("dim", `${label} · ${d.elapsed} · ${d.totalIterations} iterations`)}`;
    header += `  ${theme.fg("success", `${ok}✓`)}${fail > 0 ? theme.fg("error", ` ${fail}✗`) : ""}`;

    if (expanded && results.length > 0) {
      const container = new Container();
      container.addChild(new Text(header, 1, 0));
      container.addChild(new Spacer(1));
      for (const r of results) {
        const ri = r.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
        container.addChild(
          new Text(`  ${ri} #${r.iteration} ${theme.fg("dim", `${r.storyTitle || "prompt"} · ${fmtDuration(r.duration)} · ${r.toolCalls} calls`)}`, 1, 0),
        );
      }
      return container;
    }

    return new Text(header, 1, 0);
  });

  pi.registerMessageRenderer<any>("ralph-failed", (message, { expanded }, theme) => {
    const d = message.details;
    if (!d) return undefined;

    const icon = theme.fg("error", "✗");
    let header = `${icon} ${theme.fg("toolTitle", theme.bold(d.jobId))} ${theme.fg("dim", `failed · ${d.elapsed}`)}`;
    if (d.error) header += `\n  ${theme.fg("error", d.error.slice(0, 120))}`;

    if (expanded) {
      const results: IterationResult[] = d.results || [];
      if (results.length > 0) {
        const container = new Container();
        container.addChild(new Text(header, 1, 0));
        container.addChild(new Spacer(1));
        for (const r of results) {
          const ri = r.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
          container.addChild(
            new Text(`  ${ri} #${r.iteration} ${theme.fg("dim", `${r.storyTitle || "prompt"} · ${fmtDuration(r.duration)}`)}`, 1, 0),
          );
        }
        return container;
      }
    }

    return new Text(header, 1, 0);
  });
}
