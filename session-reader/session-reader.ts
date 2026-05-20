/**
 * Session Reader, deprecated UX wrappers around joelclaw session recovery.
 *
 * Session recovery is owned by `joelclaw session`. This extension only presents
 * thin Pi tool shortcuts and must not grow its own retrieval brain.
 * Delete this extension later if prompt/system guidance is enough.
 *
 * Tools:
 *   sessions: wrapper for `joelclaw session search ... --extract`
 *   session_context: wrapper for `joelclaw session extract ...`
 *   session_inspect: wrapper for `joelclaw session inspect ...`
 *   session_chunks: wrapper for `joelclaw session chunks ...`
 *   session_tasks: deprecated, no background reader tasks remain
 */

import { spawnSync } from "node:child_process";
import * as os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const MAX_BUFFER = 20 * 1024 * 1024;
const DEFAULT_LIMIT = 5;
const DEPRECATION_NOTE =
  "session recovery is owned by joelclaw, this extension only presents shortcuts.";

type Source = "typesense" | "ssh" | "local" | "both";
type PriorityAgent = "pi" | "claude" | "codex";

interface JoelclawRun {
  ok: boolean;
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  json: any | null;
  error?: string;
}

function hostnameShort(): string {
  return os.hostname().replace(/\..*$/, "");
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function runJoelclaw(args: string[], cwd: string): JoelclawRun {
  const command = ["joelclaw", ...args].join(" ");
  const result = spawnSync("joelclaw", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  let json: any | null = null;
  let parseError: string | undefined;

  if (stdout.trim()) {
    try {
      json = JSON.parse(stdout);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  const ok = result.status === 0 && !result.error && !parseError;

  return {
    ok,
    command,
    args,
    exitCode: result.status,
    stdout,
    stderr,
    json,
    error: result.error?.message ?? parseError,
  };
}

function resultContent(run: JoelclawRun, fallback: string): string {
  if (!run.ok) {
    return [
      `joelclaw session wrapper failed.`,
      `Command: ${run.command}`,
      run.exitCode !== null ? `Exit code: ${run.exitCode}` : "",
      run.error ? `Error: ${run.error}` : "",
      run.stderr ? `Stderr:\n${run.stderr.trim()}` : "",
      run.stdout ? `Stdout:\n${run.stdout.slice(0, 4000)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const markdown = run.json?.result?.markdown;
  if (typeof markdown === "string" && markdown.trim()) return markdown;

  return fallback;
}

function renderToolCall(name: string, suffix: string | undefined, theme: any): Text {
  let text = theme.fg("toolTitle", theme.bold(name));
  if (suffix) text += " " + theme.fg("dim", suffix.length > 80 ? `${suffix.slice(0, 77)}…` : suffix);
  return new Text(text, 0, 0);
}

function renderJsonSummary(result: any, _options: any, theme: any): Text {
  const details = result.details as any;
  if (!details) {
    const txt = result.content?.[0];
    return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
  }

  const icon = details.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const label = details.wrapper ?? "joelclaw session";
  let text = `${icon} ${theme.fg("toolTitle", theme.bold(label))}`;

  const local = details.json?.result?.local;
  if (local) {
    const bits = [
      local.emittedHits !== undefined ? `${local.emittedHits} hits` : undefined,
      local.emittedChunks !== undefined ? `${local.emittedChunks} chunks` : undefined,
      local.rawReturned !== undefined ? `${local.rawReturned} raw` : undefined,
    ].filter(Boolean);
    if (bits.length) text += " " + theme.fg("dim", bits.join(" · "));
  }

  if (!details.ok && details.error) text += "\n" + theme.fg("error", details.error);

  return new Text(text, 0, 0);
}

function toolDetails(wrapper: string, run: JoelclawRun, extra: Record<string, unknown> = {}) {
  return {
    wrapper,
    deprecation: DEPRECATION_NOTE,
    ok: run.ok,
    command: run.command,
    exitCode: run.exitCode,
    error: run.error,
    stderr: run.stderr,
    json: run.json,
    ...extra,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "sessions",
    label: "Sessions",
    description: [
      "Deprecated compatibility wrapper around `joelclaw session search`.",
      DEPRECATION_NOTE,
      "Use for bounded session recovery, not direct raw JSONL parsing or reader-agent spawning.",
    ].join(" "),
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Search query for joelclaw session search. Defaults to cwd_filter, then current working directory.",
        }),
      ),
      agents: Type.Optional(
        Type.Array(StringEnum(["pi", "claude", "codex"] as const), {
          description:
            "Compatibility only. joelclaw session is the canonical Pi session backend; non-pi agent filtering is no longer implemented here.",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Results per source. Default: 5.", default: DEFAULT_LIMIT })),
      cwd_filter: Type.Optional(
        Type.String({ description: "Compatibility query fallback. Prefer query for joelclaw session search." }),
      ),
      source: Type.Optional(
        StringEnum(["typesense", "ssh", "local", "both"] as const, {
          description: "Search source for joelclaw session search. Default: both.",
        }),
      ),
      machine: Type.Optional(Type.String({ description: "Machine filter. Default: hostname -s." })),
      extract: Type.Optional(Type.Boolean({ description: "Pass --extract. Default: true.", default: true })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const query = params.query ?? params.cwd_filter ?? ctx.cwd;
      const source = (params.source as Source | undefined) ?? "both";
      const machine = params.machine ?? hostnameShort();
      const limit = params.limit ?? DEFAULT_LIMIT;
      const shouldExtract = params.extract !== false;

      const args = [
        "session",
        "search",
        "--source",
        source,
        "--machine",
        machine,
        "--limit",
        String(limit),
      ];
      if (shouldExtract) args.push("--extract");
      args.push("--", query);

      const run = runJoelclaw(args, ctx.cwd);
      const hitCount = run.json?.result?.hits?.length ?? 0;
      const local = run.json?.result?.local;
      const summary = run.ok
        ? [
            `Session recovery search via joelclaw.`,
            DEPRECATION_NOTE,
            `Query: ${query}`,
            `Source: ${source}`,
            `Machine: ${machine}`,
            `Hits: ${hitCount}`,
            local ? `Local: ${stringify(local)}` : undefined,
            `Use per-hit .extraction for bounded context.`,
          ]
            .filter(Boolean)
            .join("\n")
        : "";

      return {
        content: [{ type: "text", text: resultContent(run, summary) }],
        details: toolDetails("joelclaw session search", run, {
          query,
          source,
          machine,
          limit,
          extract: shouldExtract,
          compatibilityAgents: (params.agents as PriorityAgent[] | undefined) ?? undefined,
        }),
        isError: !run.ok,
      };
    },

    renderCall(args, theme) {
      return renderToolCall("sessions → joelclaw session search", args.query ?? args.cwd_filter, theme);
    },

    renderResult: renderJsonSummary,
  });

  pi.registerTool({
    name: "session_context",
    label: "Session Context",
    description: [
      "Deprecated compatibility wrapper around `joelclaw session extract`.",
      DEPRECATION_NOTE,
      "Runs deterministic bounded extraction directly. It does not spawn a background reader agent.",
    ].join(" "),
    parameters: Type.Object({
      session_id: Type.String({ description: "Session ID or full local Pi session JSONL path" }),
      agent: Type.Optional(
        StringEnum(["pi", "claude", "codex"] as const, {
          description: "Compatibility only. joelclaw session extract operates on Pi session ids or paths.",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description:
            'What to extract from the session. Default: "Summarize the key decisions, changes made, and current state."',
        }),
      ),
      model: Type.Optional(
        Type.String({ description: "Deprecated and ignored. No background reader model is spawned." }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const query =
        params.query ?? "Summarize the key decisions, changes made, files touched, and current state of this session.";
      const args = [
        "session",
        "extract",
        "--query",
        query,
        "--format",
        "markdown",
        "--",
        params.session_id,
      ];
      const run = runJoelclaw(args, ctx.cwd);

      return {
        content: [{ type: "text", text: resultContent(run, "Session extraction completed via joelclaw.") }],
        details: toolDetails("joelclaw session extract", run, {
          sessionId: params.session_id,
          query,
          compatibilityAgent: params.agent,
          ignoredModel: params.model,
        }),
        isError: !run.ok,
      };
    },

    renderCall(args, theme) {
      return renderToolCall("session_context → joelclaw session extract", args.session_id, theme);
    },

    renderResult: renderJsonSummary,
  });

  pi.registerTool({
    name: "session_inspect",
    label: "Session Inspect",
    description: [
      "Thin wrapper around `joelclaw session inspect` for deterministic transcript line evidence.",
      DEPRECATION_NOTE,
    ].join(" "),
    parameters: Type.Object({
      session_id: Type.String({ description: "Session ID or full local Pi session JSONL path" }),
      around: Type.String({ description: "Regex to inspect around" }),
      before: Type.Optional(Type.Number({ description: "Transcript lines before inspect match. Default: 20." })),
      after: Type.Optional(Type.Number({ description: "Transcript lines after inspect match. Default: 80." })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const args = [
        "session",
        "inspect",
        "--around",
        params.around,
        "--before",
        String(params.before ?? 20),
        "--after",
        String(params.after ?? 80),
        "--",
        params.session_id,
      ];
      const run = runJoelclaw(args, ctx.cwd);
      return {
        content: [{ type: "text", text: resultContent(run, run.json ? stringify(run.json.result) : "Session inspect completed via joelclaw.") }],
        details: toolDetails("joelclaw session inspect", run, {
          sessionId: params.session_id,
          around: params.around,
        }),
        isError: !run.ok,
      };
    },

    renderCall(args, theme) {
      return renderToolCall("session_inspect → joelclaw session inspect", args.around, theme);
    },

    renderResult: renderJsonSummary,
  });

  pi.registerTool({
    name: "session_chunks",
    label: "Session Chunks",
    description: [
      "Thin wrapper around `joelclaw session chunks` for matching chunks with nearby transcript context.",
      DEPRECATION_NOTE,
    ].join(" "),
    parameters: Type.Object({
      query: Type.String({ description: "Search query for session chunks" }),
      source: Type.Optional(
        StringEnum(["typesense", "ssh", "local", "both"] as const, {
          description: "Search source. Default: local.",
        }),
      ),
      machine: Type.Optional(Type.String({ description: "Machine filter. Default: hostname -s." })),
      limit: Type.Optional(Type.Number({ description: "Results per source. Default: 20." })),
      context_before: Type.Optional(Type.Number({ description: "Chunks or transcript lines before a match" })),
      context_after: Type.Optional(Type.Number({ description: "Chunks or transcript lines after a match" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const source = (params.source as Source | undefined) ?? "local";
      const machine = params.machine ?? hostnameShort();
      const args = [
        "session",
        "chunks",
        "--source",
        source,
        "--machine",
        machine,
        "--limit",
        String(params.limit ?? 20),
      ];
      if (params.context_before !== undefined) args.push("--context-before", String(params.context_before));
      if (params.context_after !== undefined) args.push("--context-after", String(params.context_after));
      args.push("--", params.query);

      const run = runJoelclaw(args, ctx.cwd);
      return {
        content: [{ type: "text", text: resultContent(run, run.json ? stringify(run.json.result) : "Session chunks completed via joelclaw.") }],
        details: toolDetails("joelclaw session chunks", run, {
          query: params.query,
          source,
          machine,
        }),
        isError: !run.ok,
      };
    },

    renderCall(args, theme) {
      return renderToolCall("session_chunks → joelclaw session chunks", args.query, theme);
    },

    renderResult: renderJsonSummary,
  });

  pi.registerTool({
    name: "session_tasks",
    label: "Session Tasks Deprecated",
    description: [
      "Deprecated. Background session reader tasks were removed.",
      DEPRECATION_NOTE,
      "Use joelclaw session extract, inspect, or chunks instead.",
    ].join(" "),
    parameters: Type.Object({
      task_id: Type.Optional(Type.Number({ description: "Deprecated. No task registry exists." })),
    }),

    async execute() {
      const text = [
        "No session reader tasks exist.",
        DEPRECATION_NOTE,
        "Use `joelclaw session extract <session-id-or-path> --query \"<topic>\" --format markdown`, `inspect`, or `chunks` instead.",
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          wrapper: "session_tasks deprecated",
          deprecation: DEPRECATION_NOTE,
          tasks: [],
        },
      };
    },

    renderCall(_args, theme) {
      return renderToolCall("session_tasks deprecated", undefined, theme);
    },

    renderResult(result, _options, theme) {
      const txt = result.content[0];
      return new Text(txt?.type === "text" ? theme.fg("dim", txt.text) : "", 0, 0);
    },
  });
}
