/**
 * Session Reader, Pi-first session recovery with joelclaw pointer search.
 *
 * The normal flow is: ask joelclaw for matching session pointers, then inspect
 * local transcript files for details. joelclaw is the index/backplane; local
 * JSONL transcripts remain the source of truth when available.
 *
 * Tools:
 *   sessions: wrapper for `joelclaw session search ... --extract`
 *   session_context: wrapper for `joelclaw session extract ...`
 *   session_inspect: wrapper for `joelclaw session inspect ...`
 *   session_chunks: wrapper for `joelclaw session chunks ...`
 *   session_tasks: deprecated, no background reader tasks remain
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";

const MAX_BUFFER = 20 * 1024 * 1024;
const DEFAULT_LIMIT = 5;
const SESSION_CHUNKS_DEFAULT_LIMIT = 5;
const SESSION_CHUNKS_SAFE_LIMIT = 10;
const SESSION_CHUNKS_LARGE_LIMIT = 50;
const SESSION_CHUNKS_DEFAULT_CONTEXT_BEFORE = 0;
const SESSION_CHUNKS_DEFAULT_CONTEXT_AFTER = 0;
const SESSION_CHUNKS_SAFE_CONTEXT = 2;
const SESSION_CHUNKS_LARGE_CONTEXT = 10;
const SESSION_CHUNKS_PREVIEW_CHARS = 700;
const DEPRECATION_NOTE =
  "session-reader uses joelclaw for cross-machine/index pointers, then local transcripts for details when available.";

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

interface LocalSessionHit {
  agent: PriorityAgent;
  sessionId: string;
  path: string;
  mtime: string;
  snippets: string[];
  score: number;
}

function walkJsonlFiles(root: string, maxFiles: number): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    if (files.length >= maxFiles || !existsSync(dir)) return;
    let entries: ReturnType<typeof readdirSync> = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  };
  visit(root);
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function sessionIdFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.jsonl$/, "").replace(/^rollout-\d{4}-\d{2}-\d{2}T[^-]+-/, "");
}

function localSessionRoots(agent: PriorityAgent | "all"): Array<{ agent: PriorityAgent; root: string }> {
  const home = os.homedir();
  const roots = [
    { agent: "pi" as const, root: join(home, ".pi/agent/sessions") },
    { agent: "claude" as const, root: join(home, ".claude/projects") },
    { agent: "codex" as const, root: join(home, ".codex/sessions") },
  ];
  return agent === "all" ? roots : roots.filter((root) => root.agent === agent);
}

function searchLocalSessions(query: string, options: { agent: PriorityAgent | "all"; limit: number; maxFiles: number }): LocalSessionHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: LocalSessionHit[] = [];

  for (const root of localSessionRoots(options.agent)) {
    for (const path of walkJsonlFiles(root.root, options.maxFiles)) {
      let raw = "";
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const lower = raw.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      if (score === 0) continue;

      const snippets = raw
        .split(/\n/)
        .filter((line) => terms.some((term) => line.toLowerCase().includes(term)))
        .slice(0, 3)
        .map((line) => truncateText(line, 320) ?? line.slice(0, 320));

      hits.push({
        agent: root.agent,
        sessionId: sessionIdFromPath(path),
        path,
        mtime: statSync(path).mtime.toISOString(),
        snippets,
        score,
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score || +new Date(b.mtime) - +new Date(a.mtime)).slice(0, options.limit);
}

function renderLocalHits(hits: LocalSessionHit[]): string {
  if (!hits.length) return "No local transcript matches found.";
  return hits
    .map((hit, index) => [
      `## ${index + 1}. ${hit.agent} ${hit.sessionId}`,
      `Path: ${hit.path}`,
      `Modified: ${hit.mtime}`,
      `Score: ${hit.score}`,
      ...hit.snippets.map((snippet) => `- ${snippet}`),
    ].join("\n"))
    .join("\n\n");
}

function readCaptureState(): string {
  const home = os.homedir();
  const files = [
    { label: "pi capture state", path: join(home, ".joelclaw/session-state.json") },
    { label: "pi capture log", path: join(home, ".joelclaw/capture.log") },
    { label: "codex capture state", path: join(home, ".joelclaw/codex-session-state.json") },
    { label: "codex capture log", path: join(home, ".joelclaw/codex-capture.log") },
    { label: "claude capture state", path: join(home, ".joelclaw/claude-session-state.json") },
    { label: "claude capture log", path: join(home, ".joelclaw/claude-capture.log") },
  ];

  return files
    .map(({ label, path }) => {
      if (!existsSync(path)) return `- ${label}: missing (${path})`;
      const stats = statSync(path);
      let tail = "";
      try {
        tail = readFileSync(path, "utf8").split(/\n/).filter(Boolean).slice(-3).join("\n  ");
      } catch {}
      return `- ${label}: present, modified ${stats.mtime.toISOString()} (${path})${tail ? `\n  ${tail}` : ""}`;
    })
    .join("\n");
}

function boundedInteger(
  raw: unknown,
  options: {
    fallback: number;
    min: number;
    safeMax: number;
    largeMax: number;
    allowLarge: boolean;
    label: string;
    warnings: string[];
  },
): number {
  const requested = typeof raw === "number" && Number.isFinite(raw) ? raw : options.fallback;
  const integer = Math.floor(requested);
  const minBounded = Math.max(options.min, integer);
  const max = options.allowLarge ? options.largeMax : options.safeMax;
  const bounded = Math.min(minBounded, max);

  if (raw !== undefined && (!Number.isFinite(requested) || requested !== integer)) {
    options.warnings.push(`${options.label} ${String(raw)} was normalized to ${integer}.`);
  }
  if (bounded !== integer) {
    const capReason = options.allowLarge
      ? "This is the hard safety cap."
      : "Pass allow_large_output:true for the larger cap.";
    options.warnings.push(`${options.label} ${integer} was capped to ${bounded}. ${capReason}`);
  }

  return bounded;
}

function truncateText(value: unknown, maxChars = SESSION_CHUNKS_PREVIEW_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const compacted = value.replace(/\s+/g, " ").trim();
  if (!compacted) return undefined;
  return compacted.length > maxChars ? `${compacted.slice(0, maxChars - 1)}…` : compacted;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getCurrentSessionRef(ctx: unknown): { sessionId?: string; sessionFile?: string } {
  const sessionManager = (ctx as {
    sessionManager?: {
      getSessionId?: () => string | null | undefined;
      getSessionFile?: () => string | null | undefined;
    };
  })?.sessionManager;

  let sessionId: string | null | undefined;
  let sessionFile: string | null | undefined;
  try {
    sessionId = sessionManager?.getSessionId?.();
  } catch {
    sessionId = undefined;
  }
  try {
    sessionFile = sessionManager?.getSessionFile?.();
  } catch {
    sessionFile = undefined;
  }

  return {
    sessionId: sessionId || undefined,
    sessionFile: sessionFile || undefined,
  };
}

function sessionItemMatchesCurrent(item: unknown, current: { sessionId?: string; sessionFile?: string }): boolean {
  if (!isRecord(item)) return false;

  const itemSessionId = [item.sessionId, item.session_id, item.runId, item.run_id].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (current.sessionId && itemSessionId === current.sessionId) return true;

  const itemPath = [item.path, item.sessionFile, item.file].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!current.sessionFile || !itemPath) return false;

  return itemPath === current.sessionFile || itemPath.endsWith(current.sessionFile) || current.sessionFile.endsWith(itemPath);
}

function filterCurrentSessionChunks(
  result: any,
  current: { sessionId?: string; sessionFile?: string },
  excludeCurrent: boolean,
): { result: any; excludedCurrent: number; shown: number; originalShown: number } {
  if (!excludeCurrent || (!current.sessionId && !current.sessionFile) || !isRecord(result)) {
    const chunks = Array.isArray(result?.chunks) ? result.chunks : Array.isArray(result?.hits) ? result.hits : [];
    return { result, excludedCurrent: 0, shown: chunks.length, originalShown: chunks.length };
  }

  const next = { ...result };
  const primaryChunks = Array.isArray(result.chunks) ? result.chunks : Array.isArray(result.hits) ? result.hits : [];
  const originalShown = primaryChunks.length;

  if (Array.isArray(result.chunks)) {
    next.chunks = result.chunks.filter((chunk: unknown) => !sessionItemMatchesCurrent(chunk, current));
  }
  if (Array.isArray(result.hits)) {
    next.hits = result.hits.filter((hit: unknown) => !sessionItemMatchesCurrent(hit, current));
  }
  if (isRecord(result.local)) {
    next.local = { ...result.local };
    if (Array.isArray(result.local.chunks)) {
      next.local.chunks = result.local.chunks.filter((chunk: unknown) => !sessionItemMatchesCurrent(chunk, current));
    }
    if (typeof next.local.emittedChunks === "number") {
      next.local.emittedChunks = Array.isArray(next.local.chunks)
        ? next.local.chunks.length
        : Array.isArray(next.chunks)
          ? next.chunks.length
          : next.local.emittedChunks;
    }
  }

  const shownChunks = Array.isArray(next.chunks) ? next.chunks : Array.isArray(next.hits) ? next.hits : [];
  return {
    result: next,
    excludedCurrent: Math.max(0, originalShown - shownChunks.length),
    shown: shownChunks.length,
    originalShown,
  };
}

function renderSessionChunksCompact(
  result: any,
  options: {
    warnings: string[];
    effectiveLimit: number;
    contextBefore: number;
    contextAfter: number;
    excludeCurrent: boolean;
    excludedCurrent: number;
    compact: boolean;
  },
): string {
  if (!isRecord(result)) return stringify(result);

  const chunks = Array.isArray(result.chunks) ? result.chunks : Array.isArray(result.hits) ? result.hits : [];
  const local = isRecord(result.local) ? result.local : undefined;
  const lines = [
    "Session chunks via joelclaw (compact Pi wrapper output).",
    DEPRECATION_NOTE,
    `Query: ${String(result.query ?? "")}`,
    `Source: ${String(result.source ?? "unknown")}`,
    `Machine: ${String(result.machine ?? "unknown")}`,
    `Effective limit: ${options.effectiveLimit}`,
    `Context: before=${options.contextBefore}, after=${options.contextAfter}`,
    `Shown chunks: ${chunks.length}`,
  ];

  if (local) {
    const localBits = [
      typeof local.found === "number" ? `found=${local.found}` : undefined,
      typeof local.rawReturned === "number" ? `rawReturned=${local.rawReturned}` : undefined,
      typeof local.emittedChunks === "number" ? `emittedChunks=${local.emittedChunks}` : undefined,
      typeof local.searchedFiles === "number" ? `searchedFiles=${local.searchedFiles}` : undefined,
    ].filter(Boolean);
    if (localBits.length) lines.push(`Local: ${localBits.join(", ")}`);
  }

  if (options.excludedCurrent > 0) {
    lines.push(
      `Excluded current session chunks: ${options.excludedCurrent}. Pass exclude_current:false to include current-session matches.`,
    );
  }
  if (options.warnings.length) {
    lines.push("Warnings:");
    for (const warning of options.warnings) lines.push(`- ${warning}`);
  }
  lines.push(
    "Large/raw output is guarded: pass allow_large_output:true for higher caps, and compact:false only when raw JSON is intentional.",
  );

  chunks.forEach((chunk: unknown, index: number) => {
    const record = isRecord(chunk) ? chunk : {};
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
    const startedAt = typeof record.startedAt === "string" ? record.startedAt : undefined;
    const cwdKey = typeof record.cwdKey === "string" ? record.cwdKey : undefined;
    const path = typeof record.path === "string" ? record.path : undefined;
    const matches = Array.isArray(record.matches) ? record.matches : [];
    const aroundPreview = truncateText(record.around);
    const matchPreview = matches
      .slice(0, 3)
      .map((match: unknown) => {
        if (!isRecord(match)) return undefined;
        const line = typeof match.matchLine === "number" ? `line ${match.matchLine}` : "line ?";
        const range = typeof match.startLine === "number" && typeof match.endLine === "number"
          ? `${match.startLine}-${match.endLine}`
          : undefined;
        const entries = Array.isArray(match.entries) ? `${match.entries.length} entries` : undefined;
        return [line, range, entries].filter(Boolean).join(" · ");
      })
      .filter(Boolean)
      .join("; ");

    lines.push("");
    lines.push(`## ${index + 1}. ${sessionId ? sessionId.slice(0, 12) : "unknown session"}`);
    if (startedAt) lines.push(`- startedAt: ${startedAt}`);
    if (cwdKey) lines.push(`- cwdKey: ${cwdKey}`);
    if (path) lines.push(`- path: ${path}`);
    lines.push(`- matches: ${matches.length}${matchPreview ? ` (${matchPreview})` : ""}`);
    if (typeof record.redacted === "boolean") lines.push(`- redacted: ${record.redacted}`);
    if (aroundPreview) lines.push(`- preview: ${aroundPreview}`);
  });

  return lines.join("\n");
}

function compactSessionChunksJson(json: any, result: any) {
  if (!isRecord(json) || !isRecord(result)) return json;
  const chunks = Array.isArray(result.chunks) ? result.chunks : Array.isArray(result.hits) ? result.hits : [];
  const local = isRecord(result.local) ? { ...result.local } : result.local;
  if (isRecord(local)) delete local.chunks;

  const compactChunks = chunks.map((chunk: unknown) => {
    const record = isRecord(chunk) ? chunk : {};
    const matches = Array.isArray(record.matches) ? record.matches : [];
    return {
      sessionId: record.sessionId,
      startedAt: record.startedAt,
      cwdKey: record.cwdKey,
      path: record.path,
      matchCount: matches.length,
      redacted: record.redacted,
      aroundPreview: truncateText(record.around),
    };
  });

  return {
    ...json,
    result: {
      query: result.query,
      source: result.source,
      machine: result.machine,
      contextBefore: result.contextBefore,
      contextAfter: result.contextAfter,
      local,
      chunks: compactChunks,
      hits: compactChunks,
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description:
      "Search agent sessions by asking joelclaw for pointers first, then searching local Pi/Claude/Codex JSONL transcripts for details.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      agent: Type.Optional(StringEnum(["all", "pi", "claude", "codex"] as const, { description: "Local transcript agent filter. Default all." })),
      source: Type.Optional(StringEnum(["typesense", "ssh", "local", "both"] as const, { description: "joelclaw pointer source. Default both." })),
      machine: Type.Optional(Type.String({ description: "joelclaw machine filter. Default hostname -s." })),
      limit: Type.Optional(Type.Number({ description: "Max joelclaw/local results. Default 5." })),
      max_files: Type.Optional(Type.Number({ description: "Max local JSONL files to scan per root. Default 200." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const limit = Math.max(1, Math.min(Math.floor(params.limit ?? DEFAULT_LIMIT), 20));
      const source = (params.source as Source | undefined) ?? "both";
      const machine = params.machine ?? hostnameShort();
      const joelclaw = runJoelclaw(
        ["session", "search", params.query, "--source", source, "--machine", machine, "--limit", String(limit), "--extract"],
        ctx.cwd,
      );
      const localHits = searchLocalSessions(params.query, {
        agent: (params.agent as PriorityAgent | "all" | undefined) ?? "all",
        limit,
        maxFiles: Math.max(1, Math.min(Math.floor(params.max_files ?? 200), 1000)),
      });

      const joelclawText = joelclaw.ok
        ? resultContent(joelclaw, joelclaw.stdout || "joelclaw returned no markdown.")
        : resultContent(joelclaw, "joelclaw search failed; local transcript search still ran.");

      return {
        content: [
          {
            type: "text",
            text: [
              "# Session search",
              DEPRECATION_NOTE,
              "",
              "## Joelclaw pointers",
              joelclawText,
              "",
              "## Local transcript details",
              renderLocalHits(localHits),
            ].join("\n"),
          },
        ],
        details: {
          wrapper: "session_search",
          ok: joelclaw.ok,
          joelclaw: toolDetails("joelclaw session search", joelclaw),
          localHits,
        },
      };
    },
    renderResult: renderJsonSummary,
    renderToolCall(args, theme) {
      return renderToolCall("session_search", args.query, theme);
    },
  });

  pi.registerTool({
    name: "session_capture_status",
    label: "Session Capture Status",
    description: "Verify local joelclaw capture state for Pi, Claude, and Codex transcripts.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const status = runJoelclaw(["status"], ctx.cwd);
      return {
        content: [{ type: "text", text: [`# Session capture status`, "", readCaptureState(), "", "## joelclaw status", resultContent(status, status.stdout)].join("\n") }],
        details: { wrapper: "session_capture_status", ok: status.ok, joelclawStatus: toolDetails("joelclaw status", status) },
      };
    },
    renderResult: renderJsonSummary,
    renderToolCall(_args, theme) {
      return renderToolCall("session_capture_status", undefined, theme);
    },
  });

  pi.registerTool({
    name: "sessions",
    label: "Sessions",
    description: [
      "Compatibility wrapper around session_search semantics for older prompts.",
      DEPRECATION_NOTE,
      "Prefer session_search for new work; use session_context/session_inspect once you have a pointer/path.",
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
            "Compatibility filter for local transcript detail search. joelclaw pointer search may still return all supported agents depending on source.",
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
      const localHits = searchLocalSessions(query, {
        agent: params.agents?.[0] ?? "all",
        limit: Math.max(1, Math.min(Math.floor(limit), 20)),
        maxFiles: 200,
      });
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
        content: [
          {
            type: "text",
            text: [
              resultContent(run, summary),
              "",
              "## Local transcript details",
              renderLocalHits(localHits),
            ].join("\n"),
          },
        ],
        details: toolDetails("joelclaw session search", run, {
          query,
          source,
          machine,
          limit,
          extract: shouldExtract,
          compatibilityAgents: (params.agents as PriorityAgent[] | undefined) ?? undefined,
          localHits,
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
      "Defaults are intentionally compact to avoid flooding the active Pi context.",
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
      limit: Type.Optional(
        Type.Number({
          description:
            "Results per source. Default: 5. Capped at 10 unless allow_large_output=true, then capped at 50.",
        }),
      ),
      context_before: Type.Optional(
        Type.Number({
          description:
            "Chunks or transcript lines before a match. Default: 0. Capped at 2 unless allow_large_output=true.",
        }),
      ),
      context_after: Type.Optional(
        Type.Number({
          description:
            "Chunks or transcript lines after a match. Default: 0. Capped at 2 unless allow_large_output=true.",
        }),
      ),
      exclude_current: Type.Optional(
        Type.Boolean({
          description: "Exclude matches from the current Pi session when Pi exposes the current session id/file. Default: true.",
          default: true,
        }),
      ),
      compact: Type.Optional(
        Type.Boolean({
          description: "Return compact markdown instead of raw JSON. Default: true. compact:false requires allow_large_output=true.",
          default: true,
        }),
      ),
      allow_large_output: Type.Optional(
        Type.Boolean({
          description: "Intentional override for larger limits/context and raw JSON output. Default: false.",
          default: false,
        }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const source = (params.source as Source | undefined) ?? "local";
      const machine = params.machine ?? hostnameShort();
      const warnings: string[] = [];
      const allowLargeOutput = params.allow_large_output === true;
      const limit = boundedInteger(params.limit, {
        fallback: SESSION_CHUNKS_DEFAULT_LIMIT,
        min: 1,
        safeMax: SESSION_CHUNKS_SAFE_LIMIT,
        largeMax: SESSION_CHUNKS_LARGE_LIMIT,
        allowLarge: allowLargeOutput,
        label: "limit",
        warnings,
      });
      const contextBefore = boundedInteger(params.context_before, {
        fallback: SESSION_CHUNKS_DEFAULT_CONTEXT_BEFORE,
        min: 0,
        safeMax: SESSION_CHUNKS_SAFE_CONTEXT,
        largeMax: SESSION_CHUNKS_LARGE_CONTEXT,
        allowLarge: allowLargeOutput,
        label: "context_before",
        warnings,
      });
      const contextAfter = boundedInteger(params.context_after, {
        fallback: SESSION_CHUNKS_DEFAULT_CONTEXT_AFTER,
        min: 0,
        safeMax: SESSION_CHUNKS_SAFE_CONTEXT,
        largeMax: SESSION_CHUNKS_LARGE_CONTEXT,
        allowLarge: allowLargeOutput,
        label: "context_after",
        warnings,
      });
      const compact = params.compact !== false || !allowLargeOutput;
      if (params.compact === false && !allowLargeOutput) {
        warnings.push("compact:false ignored; raw JSON requires allow_large_output:true.");
      }
      const excludeCurrent = params.exclude_current !== false;
      const currentSession = getCurrentSessionRef(ctx);

      const args = [
        "session",
        "chunks",
        "--source",
        source,
        "--machine",
        machine,
        "--limit",
        String(limit),
        "--context-before",
        String(contextBefore),
        "--context-after",
        String(contextAfter),
      ];
      args.push("--", params.query);

      const run = runJoelclaw(args, ctx.cwd);
      const filtered = run.ok
        ? filterCurrentSessionChunks(run.json?.result, currentSession, excludeCurrent)
        : { result: run.json?.result, excludedCurrent: 0, shown: 0, originalShown: 0 };
      if (filtered.excludedCurrent > 0) {
        warnings.push(
          `Excluded ${filtered.excludedCurrent} current-session chunk(s). Pass exclude_current:false to include them.`,
        );
      }

      const displayRun = run.ok && run.json ? { ...run, json: { ...run.json, result: filtered.result } } : run;
      const text = run.ok
        ? compact
          ? renderSessionChunksCompact(filtered.result, {
              warnings,
              effectiveLimit: limit,
              contextBefore,
              contextAfter,
              excludeCurrent,
              excludedCurrent: filtered.excludedCurrent,
              compact,
            })
          : resultContent(displayRun, filtered.result ? stringify(filtered.result) : "Session chunks completed via joelclaw.")
        : resultContent(run, "");

      return {
        content: [{ type: "text", text }],
        details: toolDetails("joelclaw session chunks", run, {
          json: compactSessionChunksJson(run.json, filtered.result),
          query: params.query,
          source,
          machine,
          limit,
          requestedLimit: params.limit,
          contextBefore,
          contextAfter,
          requestedContextBefore: params.context_before,
          requestedContextAfter: params.context_after,
          excludeCurrent,
          currentSessionId: currentSession.sessionId,
          currentSessionFileAvailable: Boolean(currentSession.sessionFile),
          excludedCurrent: filtered.excludedCurrent,
          shown: filtered.shown,
          originalShown: filtered.originalShown,
          compact,
          allowLargeOutput,
          warnings,
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
