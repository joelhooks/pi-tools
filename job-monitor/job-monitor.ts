/**
 * Pi extension: Job Monitor
 *
 * TUI widget showing active background jobs — DAG pipelines, codex tasks,
 * worker rebuilds. Updates live via Redis pub/sub for DAG completions.
 *
 * Widget renders a compact status bar at the top of the session.
 * Jobs appear when dispatched, update on state changes, fade after completion.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";

type JobStatus = "running" | "completed" | "failed" | "dispatched";

interface TrackedJob {
  id: string;
  type: "dag" | "codex" | "build" | "custom";
  label: string;
  status: JobStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  summary?: string;
}

const jobs = new Map<string, TrackedJob>();
let widgetTui: { requestRender: () => void } | null = null;
let redisSubscriber: any = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

const FADE_AFTER_MS = 30_000; // completed jobs fade after 30s

function addJob(job: TrackedJob) {
  jobs.set(job.id, job);
  widgetTui?.requestRender();
}

function updateJob(id: string, update: Partial<TrackedJob>) {
  const job = jobs.get(id);
  if (job) {
    Object.assign(job, update);
    widgetTui?.requestRender();
  }
}

function ageStr(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function statusIcon(status: JobStatus): string {
  switch (status) {
    case "running": return "⚡";
    case "dispatched": return "📤";
    case "completed": return "✅";
    case "failed": return "❌";
  }
}

function renderWidget(theme: any): string[] {
  const now = Date.now();

  // Remove faded completed jobs
  for (const [id, job] of jobs) {
    if ((job.status === "completed" || job.status === "failed") && job.completedAt) {
      if (now - job.completedAt > FADE_AFTER_MS) {
        jobs.delete(id);
      }
    }
  }

  if (jobs.size === 0) return []; // auto-hide when empty

  const lines: string[] = [];
  const width = 78;

  // Header
  const running = [...jobs.values()].filter(j => j.status === "running" || j.status === "dispatched").length;
  const done = [...jobs.values()].filter(j => j.status === "completed" || j.status === "failed").length;
  lines.push(truncateToWidth(`  🔧 Jobs: ${running} active${done > 0 ? `, ${done} recent` : ""}`, width));

  // Job lines
  for (const job of jobs.values()) {
    const age = ageStr(now - job.startedAt);
    const dur = job.durationMs ? ` (${ageStr(job.durationMs)})` : "";
    const icon = statusIcon(job.status);
    const summary = job.summary ? ` — ${job.summary}` : "";
    lines.push(truncateToWidth(`  ${icon} ${job.label}  ${age}${dur}${summary}`, width));
  }

  return lines;
}

export default function jobMonitor(pi: ExtensionAPI) {
  // Widget
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWidget("job-monitor", (tui, theme) => {
      widgetTui = tui;
      return {
        render: () => renderWidget(theme),
        invalidate: () => {},
        dispose: () => {
          widgetTui = null;
          if (cleanupTimer) clearInterval(cleanupTimer);
        },
      };
    });

    // Periodic re-render to update ages and fade completed jobs
    cleanupTimer = setInterval(() => {
      widgetTui?.requestRender();
    }, 5_000);

    // Subscribe to DAG completion events
    try {
      const { default: Redis } = await import("ioredis");
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
      redisSubscriber = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      redisSubscriber.on("error", () => {});
      await redisSubscriber.connect();
      await redisSubscriber.subscribe("joelclaw:dag:completed");

      redisSubscriber.on("message", (_channel: string, message: string) => {
        try {
          const event = JSON.parse(message);
          const id = event.workflowId;
          if (!id) return;

          if (jobs.has(id)) {
            updateJob(id, {
              status: event.success === false ? "failed" : "completed",
              completedAt: Date.now(),
              durationMs: event.durationMs,
              summary: event.summary,
            });
          } else {
            // DAG we didn't dispatch — still show it
            addJob({
              id,
              type: "dag",
              label: event.pipeline || id,
              status: event.success === false ? "failed" : "completed",
              startedAt: Date.now() - (event.durationMs || 0),
              completedAt: Date.now(),
              durationMs: event.durationMs,
              summary: event.summary,
            });
          }
        } catch { /* ignore */ }
      });
    } catch {
      // Redis unavailable — widget still works, just no live updates
    }
  });

  pi.on("session_shutdown", () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (redisSubscriber) {
      try { redisSubscriber.unsubscribe(); redisSubscriber.disconnect(); } catch {}
      redisSubscriber = null;
    }
    widgetTui = null;
  });

  // Expose addJob/updateJob for other extensions (like dag-dispatch)
  (globalThis as any).__jobMonitor = { addJob, updateJob, jobs };
}
