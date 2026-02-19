/**
 * ralph-loop — Autonomous coding loops via Codex background workers.
 *
 * Spawns codex exec for each iteration, monitors JSONL events for progress,
 * reports back to pi via sendMessage. Can run stories from a prd.json or
 * free-form prompts in a loop with exit conditions.
 *
 * Supports skill injection: pass `skills: ["frontend-design"]` to prepend
 * skill SKILL.md content to every codex prompt. Add `context` for per-loop
 * aesthetic or technical direction.
 *
 * Based on: https://github.com/joelhooks/openclaw-codex-ralph
 * Adapted for pi extension API.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ───────────────────────────────────────────────────────────

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
  proc: ChildProcess | null;
  aborted: boolean;
  skills: string[];
  context?: string;
  skillContent?: string; // resolved skill text, cached once at start
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

// ── State ───────────────────────────────────────────────────────────

const jobs = new Map<string, LoopJob>();
let nextJobNum = 1;

function genId(): string {
  return `ralph-${nextJobNum++}`;
}

function elapsed(job: LoopJob): string {
  const end = job.status === "running" ? Date.now() : (job.results.at(-1)?.duration ?? 0) + job.startedAt;
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

// ── Skill helpers ───────────────────────────────────────────────────

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

// ── PRD helpers ─────────────────────────────────────────────────────

function readPRD(cwd: string): PRD | null {
  const p = join(cwd, "prd.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

function nextStory(prd: PRD): Story | null {
  return prd.stories.filter(s => !s.passes).sort((a, b) => a.priority - b.priority)[0] ?? null;
}

function markStoryDone(cwd: string, storyId: string) {
  const prd = readPRD(cwd);
  if (!prd) return;
  const story = prd.stories.find(s => s.id === storyId);
  if (story) story.passes = true;
  writeFileSync(join(cwd, "prd.json"), JSON.stringify(prd, null, 2));
}

function prdStats(cwd: string): { total: number; done: number; remaining: number; projectName: string } | null {
  const prd = readPRD(cwd);
  if (!prd) return null;
  const done = prd.stories.filter(s => s.passes).length;
  return { total: prd.stories.length, done, remaining: prd.stories.length - done, projectName: prd.projectName };
}

// ── Codex spawner ───────────────────────────────────────────────────

function spawnCodexWorker(
  job: LoopJob,
  prompt: string,
  pi: ExtensionAPI,
  onDone: (result: IterationResult) => void,
) {
  const startTime = Date.now();
  const args = [
    "exec", "--full-auto", "--json",
    "--skip-git-repo-check",
    "-m", job.model,
    "--sandbox", job.sandbox,
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

  // Stall detection: kill if no item.completed in 3 minutes
  let stallTimer = setTimeout(() => { stalled = true; child.kill("SIGTERM"); }, 180_000);
  const resetStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => { stalled = true; child.kill("SIGTERM"); }, 180_000); };

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
      } catch { }
    }
  });

  child.stderr!.on("data", () => { }); // swallow

  child.on("close", (code) => {
    clearTimeout(stallTimer);
    job.proc = null;
    const duration = Date.now() - startTime;
    const summary = lastMessage
      ? (lastMessage.length > 300 ? lastMessage.slice(0, 300) + "..." : lastMessage)
      : (stalled ? "Stalled — killed after 3 min inactivity" : `Exit code ${code}`);

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
      success: false, toolCalls: 0,
      duration: Date.now() - startTime,
      summary: `Spawn error: ${err.message}`,
    });
  });
}

// ── Loop runner ─────────────────────────────────────────────────────

async function runLoop(job: LoopJob, pi: ExtensionAPI) {
  // Resolve skills once at loop start
  if (job.skills.length > 0) {
    job.skillContent = resolveSkills(job.skills);
  }

  const prefix = buildPromptPrefix(job);

  const runIteration = (): Promise<IterationResult> => {
    return new Promise(resolve => {
      let prompt: string;

      if (job.mode === "prd") {
        const prd = readPRD(job.cwd);
        if (!prd) { resolve({ iteration: job.iteration, success: false, toolCalls: 0, duration: 0, summary: "No prd.json found" }); return; }
        const story = nextStory(prd);
        if (!story) { resolve({ iteration: job.iteration, success: true, toolCalls: 0, duration: 0, summary: "All stories complete!" }); return; }
        job.currentStory = { id: story.id, title: story.title };
        prompt = `${prefix}# Project: ${prd.projectName}\n${prd.description || ""}\n\n## Story: ${story.title} (${story.id})\n${story.description}\n\n${story.acceptanceCriteria?.map((c, i) => `${i + 1}. ${c}`).join("\n") || ""}\n\n${story.validationCommand ? `Validate: \`${story.validationCommand}\`` : ""}\n\nRULES:\n1. Implement ONLY this story\n2. Validation must pass\n3. Do NOT modify prd.json`;
      } else {
        prompt = prefix + job.prompt!;
      }

      spawnCodexWorker(job, prompt, pi, resolve);
    });
  };

  while (job.iteration < job.maxIterations && !job.aborted) {
    job.iteration++;
    const result = await runIteration();
    job.results.push(result);

    // Report iteration result back to pi
    pi.sendMessage({
      customType: "ralph-iteration",
      content: `Iteration ${result.iteration}/${job.maxIterations}`,
      display: true,
      details: {
        jobId: job.id,
        maxIterations: job.maxIterations,
        mode: job.mode,
        skills: job.skills,
        ...result,
      },
    }, { triggerTurn: false, deliverAs: "followUp" });

    // If PRD mode and successful, mark story done
    if (job.mode === "prd" && result.success && result.storyId) {
      markStoryDone(job.cwd, result.storyId);
      const prd = readPRD(job.cwd);
      if (prd && !nextStory(prd)) {
        job.status = "done";
        pi.sendMessage({
          customType: "ralph-complete",
          content: `All stories done`,
          display: true,
          details: {
            jobId: job.id,
            mode: job.mode,
            skills: job.skills,
            totalIterations: job.iteration,
            elapsed: elapsed(job),
            results: job.results,
          },
        }, { triggerTurn: true, deliverAs: "followUp" });
        return;
      }
    }

    // If prompt mode and failed, stop
    if (job.mode === "prompt" && !result.success) {
      job.status = "failed";
      pi.sendMessage({
        customType: "ralph-failed",
        content: `Failed on iteration ${result.iteration}`,
        display: true,
        details: {
          jobId: job.id,
          mode: job.mode,
          skills: job.skills,
          failedIteration: result.iteration,
          elapsed: elapsed(job),
          results: job.results,
        },
      }, { triggerTurn: true, deliverAs: "followUp" });
      return;
    }

    // Small delay between iterations
    await new Promise(r => setTimeout(r, 2000));
  }

  job.status = job.aborted ? "cancelled" : "done";
  const reason = job.aborted ? "Cancelled" : `Completed ${job.iteration} iterations`;
  pi.sendMessage({
    customType: "ralph-complete",
    content: reason,
    display: true,
    details: {
      jobId: job.id,
      mode: job.mode,
      skills: job.skills,
      totalIterations: job.iteration,
      elapsed: elapsed(job),
      results: job.results,
      cancelled: job.aborted,
    },
  }, { triggerTurn: true, deliverAs: "followUp" });
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // Cleanup on shutdown
  pi.on("session_shutdown", () => {
    for (const job of jobs.values()) {
      job.aborted = true;
      if (job.proc) job.proc.kill("SIGTERM");
    }
  });

  // ── Main tool: ralph_loop ───────────────────────────────────────

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
      mode: Type.Union([Type.Literal("prd"), Type.Literal("prompt")], { description: "prd = story-driven from prd.json, prompt = repeat a prompt" }),
      prompt: Type.Optional(Type.String({ description: "Prompt for each iteration (prompt mode only)" })),
      max_iterations: Type.Optional(Type.Number({ description: "Max iterations (default: 10)" })),
      model: Type.Optional(Type.String({ description: "Codex model (default: o4-mini)" })),
      sandbox: Type.Optional(Type.String({ description: "Sandbox: read-only, workspace-write, danger-full-access (default: workspace-write)" })),
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
        proc: null,
        aborted: false,
        skills: params.skills || [],
        context: params.context,
      };
      jobs.set(job.id, job);

      // Validate
      if (job.mode === "prd" && !readPRD(job.cwd)) {
        return text(`No prd.json found in ${job.cwd}`);
      }
      if (job.mode === "prompt" && !job.prompt) {
        return text("Prompt mode requires a prompt parameter");
      }

      // Validate skills exist
      const missing = job.skills.filter(s => !existsSync(join(homedir(), ".pi", "agent", "skills", s, "SKILL.md")));
      if (missing.length > 0) {
        return text(`Skills not found: ${missing.join(", ")}`);
      }

      // Fire and forget
      runLoop(job, pi).catch(err => {
        job.status = "failed";
        pi.sendMessage({
          customType: "ralph-failed",
          content: `Error: ${err.message || err}`,
          display: true,
          details: {
            jobId: job.id,
            mode: job.mode,
            skills: job.skills,
            error: err.message || String(err),
            elapsed: elapsed(job),
            results: job.results,
          },
        }, { triggerTurn: true, deliverAs: "followUp" });
      });

      const stats = prdStats(job.cwd);
      return {
        content: [{ type: "text" as const, text: `Ralph loop started. Use ralph_jobs to check status.` }],
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
      let icon: string;
      const status = job?.status ?? "done";
      switch (status) {
        case "running": icon = theme.fg("warning", "◆"); break;
        case "done": icon = theme.fg("success", "✓"); break;
        case "failed": icon = theme.fg("error", "✗"); break;
        case "cancelled": icon = theme.fg("muted", "○"); break;
        default: icon = theme.fg("warning", "◆");
      }

      const meta: string[] = [status];
      if (job) meta.push(elapsed(job));
      if (d.storiesRemaining != null) meta.push(`${d.storiesRemaining}/${d.storiesTotal} stories`);
      if (d.skills?.length) meta.push(`+${d.skills.join(",")}`);

      let line = `${icon} ${theme.fg("toolTitle", theme.bold(`ralph #${d.jobId}`))}`;
      line += " " + theme.fg("dim", meta.join(" · "));
      if (d.projectName) line += "\n" + theme.fg("dim", `  ${d.projectName}`);

      return new Text(line, 0, 0);
    },
  });

  // ── Status tool: ralph_jobs ─────────────────────────────────────

  pi.registerTool({
    name: "ralph_jobs",
    label: "Ralph Jobs",
    description: "Check status of ralph loop jobs. Optionally cancel a running job.",
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
            jobId: job.id,
            status: job.status,
            mode: job.mode,
            model: job.model,
            iteration: job.iteration,
            maxIterations: job.maxIterations,
            skills: job.skills,
            context: job.context,
            elapsed: elapsed(job),
            currentStory: job.currentStory,
            successCount: job.results.filter(r => r.success).length,
            totalResults: job.results.length,
            results: job.results.slice(-5),
          },
        };
      }

      if (jobs.size === 0) return text("No ralph jobs.");
      const all = [...jobs.values()].map(j => ({
        jobId: j.id,
        status: j.status,
        mode: j.mode,
        iteration: j.iteration,
        maxIterations: j.maxIterations,
        elapsed: elapsed(j),
        skills: j.skills,
        successCount: j.results.filter(r => r.success).length,
        totalResults: j.results.length,
      }));
      return {
        content: [{ type: "text" as const, text: `${all.length} ralph job${all.length === 1 ? "" : "s"}` }],
        details: { jobs: all },
      };
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (!d) {
        const txt = result.content[0];
        return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
      }

      // Single job detail
      if (d.jobId && d.status) {
        const j = d;
        let icon: string;
        switch (j.status) {
          case "running": icon = theme.fg("warning", "◆"); break;
          case "done": icon = theme.fg("success", "✓"); break;
          case "failed": icon = theme.fg("error", "✗"); break;
          case "cancelled": icon = theme.fg("muted", "○"); break;
          default: icon = theme.fg("warning", "◆");
        }

        const meta = [j.status, j.elapsed, `${j.iteration}/${j.maxIterations}`];
        if (j.skills?.length) meta.push(`+${j.skills.join(",")}`);

        const container = new Container();
        let header = `${icon} ${theme.fg("toolTitle", theme.bold(`ralph #${j.jobId}`))}`;
        header += " " + theme.fg("dim", meta.join(" · "));
        container.addChild(new Text(header, 0, 0));

        if (j.currentStory) {
          container.addChild(new Text(theme.fg("accent", `  ▸ ${j.currentStory.title}`), 0, 0));
        }

        container.addChild(new Text(
          theme.fg("dim", `  ${j.successCount}/${j.totalResults} succeeded`) +
          (j.model !== "o4-mini" ? theme.fg("dim", ` · ${j.model}`) : ""),
          0, 0,
        ));

        if (expanded && j.results?.length > 0) {
          container.addChild(new Spacer(1));
          for (const r of j.results) {
            const ri = r.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
            const storyLabel = r.storyTitle || "prompt";
            container.addChild(new Text(
              `  ${ri} ${theme.fg("text", `#${r.iteration}`)} ${theme.fg("dim", storyLabel)} ${theme.fg("dim", `${fmtDuration(r.duration)} · ${r.toolCalls} calls`)}`,
              0, 0,
            ));
          }
        }
        return container;
      }

      // Job list
      if (d.jobs) {
        const container = new Container();
        for (const j of d.jobs) {
          let icon: string;
          switch (j.status) {
            case "running": icon = theme.fg("warning", "◆"); break;
            case "done": icon = theme.fg("success", "✓"); break;
            case "failed": icon = theme.fg("error", "✗"); break;
            case "cancelled": icon = theme.fg("muted", "○"); break;
            default: icon = theme.fg("warning", "◆");
          }
          const meta = [j.status, j.mode, j.elapsed, `${j.iteration}/${j.maxIterations}`];
          if (j.skills?.length) meta.push(`+${j.skills.join(",")}`);
          container.addChild(new Text(
            `${icon} ${theme.fg("toolTitle", theme.bold(`#${j.jobId}`))} ${theme.fg("dim", meta.join(" · "))} ${theme.fg("dim", `${j.successCount}/${j.totalResults} ok`)}`,
            0, 0,
          ));
        }
        return container;
      }

      const txt = result.content[0];
      return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
    },
  });

  // ── Message renderers ───────────────────────────────────────────

  pi.registerMessageRenderer<any>("ralph-iteration", (message, { expanded }, theme) => {
    const d = message.details;
    if (!d) return undefined;

    const icon = d.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const container = new Container();

    // Header: icon + job + iteration + story
    const meta: string[] = [`${d.iteration}/${d.maxIterations}`];
    if (d.toolCalls > 0) meta.push(`${d.toolCalls} tool${d.toolCalls === 1 ? "" : "s"}`);
    meta.push(fmtDuration(d.duration));
    if (d.skills?.length) meta.push(`+${d.skills.join(",")}`);

    let header = `${icon} ${theme.fg("toolTitle", theme.bold(`ralph #${d.jobId}`))}`;
    header += " " + theme.fg("dim", meta.join(" · "));
    if (d.storyTitle) {
      header += "\n" + theme.fg("accent", `  ${d.storyTitle}`);
    }
    container.addChild(new Text(header, 1, 0));

    if (expanded && d.summary) {
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(d.summary, 1, 0, getMarkdownTheme()));
      if (d.sessionId) {
        container.addChild(new Text(theme.fg("dim", `session ${d.sessionId}`), 1, 0));
      }
    } else if (!expanded && d.summary) {
      // Collapsed: one-line preview
      const preview = d.summary.split("\n")[0]?.trim() || "";
      if (preview) {
        const short = preview.length > 100 ? preview.slice(0, 97) + "…" : preview;
        container.addChild(new Text(theme.fg("dim", `  ${short}`), 1, 0));
      }
    }

    return container;
  });

  pi.registerMessageRenderer<any>("ralph-complete", (message, { expanded }, theme) => {
    const d = message.details;
    if (!d) return undefined;

    const container = new Container();
    const icon = d.cancelled
      ? theme.fg("muted", "○")
      : theme.fg("success", "✓");
    const label = d.cancelled ? "cancelled" : "complete";

    const meta: string[] = [label, d.elapsed, `${d.totalIterations} iterations`];
    if (d.skills?.length) meta.push(`+${d.skills.join(",")}`);

    let header = `${icon} ${theme.fg("toolTitle", theme.bold(`ralph #${d.jobId}`))}`;
    header += " " + theme.fg("dim", meta.join(" · "));
    container.addChild(new Text(header, 1, 0));

    // Summary line: success/fail counts
    const results: IterationResult[] = d.results || [];
    const ok = results.filter(r => r.success).length;
    const fail = results.length - ok;
    let summary = theme.fg("success", `${ok} passed`);
    if (fail > 0) summary += theme.fg("error", ` · ${fail} failed`);
    container.addChild(new Text(`  ${summary}`, 1, 0));

    if (expanded && results.length > 0) {
      container.addChild(new Spacer(1));
      for (const r of results) {
        const ri = r.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
        const storyLabel = r.storyTitle || "prompt";
        container.addChild(new Text(
          `  ${ri} ${theme.fg("text", `#${r.iteration}`)} ${theme.fg("dim", storyLabel)} ${theme.fg("dim", `${fmtDuration(r.duration)} · ${r.toolCalls} calls`)}`,
          1, 0,
        ));
      }
    }

    return container;
  });

  pi.registerMessageRenderer<any>("ralph-failed", (message, { expanded }, theme) => {
    const d = message.details;
    if (!d) return undefined;

    const container = new Container();
    const icon = theme.fg("error", "✗");

    const meta: string[] = ["failed", d.elapsed];
    if (d.failedIteration) meta.push(`iteration ${d.failedIteration}`);
    if (d.skills?.length) meta.push(`+${d.skills.join(",")}`);

    let header = `${icon} ${theme.fg("toolTitle", theme.bold(`ralph #${d.jobId}`))}`;
    header += " " + theme.fg("dim", meta.join(" · "));
    container.addChild(new Text(header, 1, 0));

    if (d.error) {
      const errPreview = d.error.length > 120 ? d.error.slice(0, 117) + "…" : d.error;
      container.addChild(new Text(theme.fg("error", `  ${errPreview}`), 1, 0));
    }

    if (expanded) {
      const results: IterationResult[] = d.results || [];
      if (results.length > 0) {
        container.addChild(new Spacer(1));
        for (const r of results) {
          const ri = r.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
          const storyLabel = r.storyTitle || "prompt";
          container.addChild(new Text(
            `  ${ri} ${theme.fg("text", `#${r.iteration}`)} ${theme.fg("dim", storyLabel)} ${theme.fg("dim", `${fmtDuration(r.duration)} · ${r.toolCalls} calls`)}`,
            1, 0,
          ));
          if (!r.success && expanded && r.summary) {
            const short = r.summary.length > 100 ? r.summary.slice(0, 97) + "…" : r.summary;
            container.addChild(new Text(theme.fg("dim", `    ${short}`), 1, 0));
          }
        }
      }
    }

    return container;
  });
}
