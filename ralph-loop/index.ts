/**
 * ralph-loop — Autonomous coding loops via Codex background workers.
 *
 * Spawns codex exec for each iteration, monitors JSONL events for progress,
 * reports back to pi via sendMessage. Can run stories from a prd.json or
 * free-form prompts in a loop with exit conditions.
 *
 * Based on: https://github.com/joelhooks/openclaw-codex-ralph
 * Adapted for pi extension API.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
  const sec = Math.round((Date.now() - job.startedAt) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }], details: {} };
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
  const runIteration = (): Promise<IterationResult> => {
    return new Promise(resolve => {
      let prompt: string;

      if (job.mode === "prd") {
        const prd = readPRD(job.cwd);
        if (!prd) { resolve({ iteration: job.iteration, success: false, toolCalls: 0, duration: 0, summary: "No prd.json found" }); return; }
        const story = nextStory(prd);
        if (!story) { resolve({ iteration: job.iteration, success: true, toolCalls: 0, duration: 0, summary: "All stories complete!" }); return; }
        job.currentStory = { id: story.id, title: story.title };
        prompt = `# Project: ${prd.projectName}\n${prd.description || ""}\n\n## Story: ${story.title} (${story.id})\n${story.description}\n\n${story.acceptanceCriteria?.map((c, i) => `${i + 1}. ${c}`).join("\n") || ""}\n\n${story.validationCommand ? `Validate: \`${story.validationCommand}\`` : ""}\n\nRULES:\n1. Implement ONLY this story\n2. Validation must pass\n3. Do NOT modify prd.json`;
      } else {
        prompt = job.prompt!;
      }

      spawnCodexWorker(job, prompt, pi, resolve);
    });
  };

  while (job.iteration < job.maxIterations && !job.aborted) {
    job.iteration++;
    const result = await runIteration();
    job.results.push(result);

    const icon = result.success ? "✅" : "❌";
    const storyInfo = result.storyTitle ? ` — ${result.storyTitle}` : "";
    const sessionHint = result.sessionId ? `\nCodex session: \`${result.sessionId}\`` : "";

    // Report iteration result back to pi
    pi.sendMessage({
      customType: "ralph-iteration",
      content: `${icon} **Ralph #${job.id} iteration ${result.iteration}/${job.maxIterations}**${storyInfo} (${Math.round(result.duration / 1000)}s, ${result.toolCalls} tool calls)\n\n${result.summary}${sessionHint}`,
      display: true,
      details: { jobId: job.id, ...result },
    }, { triggerTurn: false, deliverAs: "followUp" });

    // If PRD mode and successful, mark story done
    if (job.mode === "prd" && result.success && result.storyId) {
      markStoryDone(job.cwd, result.storyId);
      const prd = readPRD(job.cwd);
      if (prd && !nextStory(prd)) {
        job.status = "done";
        pi.sendMessage({
          customType: "ralph-complete",
          content: `🎉 **Ralph #${job.id} complete!** All stories done in ${job.iteration} iterations (${elapsed(job)}).`,
          display: true,
          details: { jobId: job.id, results: job.results },
        }, { triggerTurn: true, deliverAs: "followUp" });
        return;
      }
    }

    // If prompt mode and failed, stop
    if (job.mode === "prompt" && !result.success) {
      job.status = "failed";
      pi.sendMessage({
        customType: "ralph-failed",
        content: `💀 **Ralph #${job.id} failed** on iteration ${result.iteration}. ${result.summary}`,
        display: true,
        details: { jobId: job.id, results: job.results },
      }, { triggerTurn: true, deliverAs: "followUp" });
      return;
    }

    // Small delay between iterations
    await new Promise(r => setTimeout(r, 2000));
  }

  job.status = job.aborted ? "cancelled" : (job.iteration >= job.maxIterations ? "done" : "done");
  const reason = job.aborted ? "Cancelled" : `Completed ${job.iteration} iterations`;
  pi.sendMessage({
    customType: "ralph-complete",
    content: `🏁 **Ralph #${job.id} finished** — ${reason} (${elapsed(job)}). ${job.results.filter(r => r.success).length}/${job.results.length} succeeded.`,
    display: true,
    details: { jobId: job.id, results: job.results },
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

  // Main tool: ralph_loop
  pi.registerTool({
    name: "ralph_loop",
    label: "Ralph Loop",
    description: [
      "Run autonomous coding loops via Codex background workers.",
      "Two modes: (1) PRD mode — reads prd.json, picks stories by priority, implements one per iteration.",
      "(2) Prompt mode — runs a single prompt repeatedly with optional exit condition.",
      "Each iteration spawns a fresh codex exec. Reports progress via messages.",
      "Returns immediately with a job ID.",
    ].join(" "),
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("prd"), Type.Literal("prompt")], { description: "prd = story-driven from prd.json, prompt = repeat a prompt" }),
      prompt: Type.Optional(Type.String({ description: "Prompt for each iteration (prompt mode only)" })),
      max_iterations: Type.Optional(Type.Number({ description: "Max iterations (default: 10)" })),
      model: Type.Optional(Type.String({ description: "Codex model (default: o4-mini)" })),
      sandbox: Type.Optional(Type.String({ description: "Sandbox: read-only, workspace-write, danger-full-access (default: workspace-write)" })),
      cwd: Type.Optional(Type.String({ description: "Working directory" })),
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
      };
      jobs.set(job.id, job);

      // Validate
      if (job.mode === "prd" && !readPRD(job.cwd)) {
        return text(`No prd.json found in ${job.cwd}`);
      }
      if (job.mode === "prompt" && !job.prompt) {
        return text("Prompt mode requires a prompt parameter");
      }

      // Fire and forget
      runLoop(job, pi).catch(err => {
        job.status = "failed";
        pi.sendMessage({
          customType: "ralph-error",
          content: `💀 **Ralph #${job.id} error:** ${err.message || err}`,
          display: true,
        }, { triggerTurn: true, deliverAs: "followUp" });
      });

      const prdInfo = job.mode === "prd" ? (() => {
        const prd = readPRD(job.cwd);
        const remaining = prd?.stories.filter(s => !s.passes).length || 0;
        return ` — ${remaining} stories remaining in ${prd?.projectName || "project"}`;
      })() : "";

      return text(`🚀 Ralph loop #${job.id} started (${job.mode} mode, max ${job.maxIterations} iterations, model: ${job.model})${prdInfo}\n\nProgress will be reported as messages. Use ralph_jobs to check status.`);
    },
  });

  // Status tool
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
        const lines = [
          `**Ralph #${job.id}** — ${job.status} (${elapsed(job)})`,
          `Mode: ${job.mode} | Model: ${job.model} | Iteration: ${job.iteration}/${job.maxIterations}`,
          job.currentStory ? `Current: ${job.currentStory.title}` : "",
          `Results: ${job.results.filter(r => r.success).length}/${job.results.length} succeeded`,
        ];
        for (const r of job.results.slice(-5)) {
          const icon = r.success ? "✅" : "❌";
          lines.push(`  ${icon} #${r.iteration}: ${r.storyTitle || "prompt"} (${Math.round(r.duration / 1000)}s, ${r.toolCalls} calls)`);
        }
        return text(lines.filter(Boolean).join("\n"));
      }

      if (jobs.size === 0) return text("No ralph jobs.");
      const lines: string[] = [];
      for (const job of jobs.values()) {
        const icon = job.status === "running" ? "⏳" : job.status === "done" ? "✅" : "❌";
        lines.push(`${icon} #${job.id} [${job.status}] ${job.mode} — ${job.iteration}/${job.maxIterations} iterations (${elapsed(job)})`);
      }
      return text(lines.join("\n"));
    },
  });
}
