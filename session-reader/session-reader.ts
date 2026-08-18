import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { type SessionAgent, type SessionAgentFilter, type SessionSource } from "./domain.ts";
import { SessionOperation, type SessionOperation as Operation } from "./engine.ts";
import { runSessionActor, type SessionReaderSnapshot } from "./machine.ts";
import type { ToolPayload } from "./presenter.ts";

const DEFAULT_LIMIT = 5;
const DEFAULT_MAX_FILES = 200;
const CHUNKS_SAFE_LIMIT = 10;
const CHUNKS_LARGE_LIMIT = 50;
const CHUNKS_SAFE_CONTEXT = 2;
const CHUNKS_LARGE_CONTEXT = 10;
const INSPECT_MAX_BEFORE = 50;
const INSPECT_MAX_AFTER = 200;
const ENGINE_LABEL = "Effect v4 + XState v5 session reader";

const SessionAgentSchema = Type.Union([
  Type.Literal("pi"),
  Type.Literal("claude"),
  Type.Literal("codex"),
]);
const SessionAgentFilterSchema = Type.Union([Type.Literal("all"), SessionAgentSchema]);
const SessionSourceSchema = Type.Union([
  Type.Literal("typesense"),
  Type.Literal("ssh"),
  Type.Literal("local"),
  Type.Literal("both"),
]);

function hostnameShort(): string {
  return os.hostname().replace(/\..*$/u, "");
}

function renderToolCall(name: string, suffix: string | undefined, theme: any): Text {
  let text = theme.fg("toolTitle", theme.bold(name));
  if (suffix)
    text += ` ${theme.fg("dim", suffix.length > 80 ? `${suffix.slice(0, 77)}…` : suffix)}`;
  return new Text(text, 0, 0);
}

function renderResult(result: any, _options: any, theme: any): Text {
  const details = result.details as Record<string, unknown> | undefined;
  const ok = details?.ok !== false && !result.isError;
  const icon = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const label = typeof details?.wrapper === "string" ? details.wrapper : ENGINE_LABEL;
  const lifecycle =
    typeof details?.lifecycle === "string" ? ` ${theme.fg("dim", details.lifecycle)}` : "";
  return new Text(`${icon} ${theme.fg("toolTitle", theme.bold(label))}${lifecycle}`, 0, 0);
}

function currentSession(ctx: unknown): {
  readonly sessionId?: string;
  readonly sessionFile?: string;
} {
  const manager = (
    ctx as {
      readonly sessionManager?: {
        readonly getSessionId?: () => string | null | undefined;
        readonly getSessionFile?: () => string | null | undefined;
      };
    }
  ).sessionManager;

  try {
    return {
      sessionId: manager?.getSessionId?.() || undefined,
      sessionFile: manager?.getSessionFile?.() || undefined,
    };
  } catch {
    return {};
  }
}

function boundedInteger(
  raw: unknown,
  options: {
    readonly fallback: number;
    readonly min: number;
    readonly max: number;
    readonly label: string;
    readonly warnings: string[];
  },
): number {
  const requested =
    typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : options.fallback;
  const bounded = Math.min(options.max, Math.max(options.min, requested));
  if (raw !== undefined && requested !== raw) {
    options.warnings.push(`${options.label} ${String(raw)} was normalized to ${requested}.`);
  }
  if (bounded !== requested) {
    options.warnings.push(`${options.label} ${requested} was capped to ${bounded}.`);
  }
  return bounded;
}

function lifecycleName(snapshot: SessionReaderSnapshot): string {
  return typeof snapshot.value === "string" ? snapshot.value : JSON.stringify(snapshot.value);
}

function errorMessage(error: unknown): string {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "object" && error !== null && "message" in error) {
    const candidate = (error as { readonly message?: unknown }).message;
    message = typeof candidate === "string" ? candidate : String(error);
  } else {
    message = String(error ?? "Unknown session reader failure");
  }
  return message.length > 4_000 ? `${message.slice(0, 3_970)}\n[error truncated]` : message;
}

async function executeOperation(
  operation: Operation,
  signal: AbortSignal | undefined,
  onUpdate: ((result: any) => void) | undefined,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}> {
  const operationSignal = signal ?? new AbortController().signal;
  let lifecycle = "dispatching";
  const outcome = await runSessionActor(operation, operationSignal, (snapshot) => {
    lifecycle = lifecycleName(snapshot);
    onUpdate?.({
      content: [{ type: "text", text: `Session reader: ${lifecycle}` }],
      details: { wrapper: ENGINE_LABEL, ok: true, lifecycle, operation: operation._tag },
    });
  });

  if (outcome.status === "succeeded") {
    const payload: ToolPayload = outcome.result;
    return {
      content: [{ type: "text", text: payload.text }],
      details: { ...payload.details, lifecycle: "succeeded" },
      isError: payload.isError,
    };
  }

  const cancelled = outcome.status === "cancelled";
  const message = cancelled ? "Session reader operation cancelled." : errorMessage(outcome.error);
  return {
    content: [{ type: "text", text: message }],
    details: {
      wrapper: ENGINE_LABEL,
      ok: false,
      lifecycle: cancelled ? "cancelled" : "failed",
      operation: operation._tag,
      error: message,
    },
    isError: true,
  };
}

export default function sessionReader(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description:
      "Search local Pi, Claude, and Codex transcripts through the Effect/XState session reader. Joelclaw is used only as an optional remote index adapter.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      agent: Type.Optional(SessionAgentFilterSchema),
      source: Type.Optional(SessionSourceSchema),
      machine: Type.Optional(
        Type.String({ description: "Remote index machine filter. Default hostname -s." }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum results. Default 5." })),
      max_files: Type.Optional(
        Type.Number({ description: "Maximum local JSONL files per runtime. Default 200." }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const warnings: string[] = [];
      const limit = boundedInteger(params.limit, {
        fallback: DEFAULT_LIMIT,
        min: 1,
        max: 20,
        label: "limit",
        warnings,
      });
      const maxFiles = boundedInteger(params.max_files, {
        fallback: DEFAULT_MAX_FILES,
        min: 1,
        max: 1_000,
        label: "max_files",
        warnings,
      });
      return executeOperation(
        SessionOperation.Search({
          query: params.query,
          agent: (params.agent ?? "all") as SessionAgentFilter,
          source: (params.source ?? "both") as SessionSource,
          machine: params.machine ?? hostnameShort(),
          limit,
          maxFiles,
          cwd: ctx.cwd,
          extract: true,
        }),
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      return renderToolCall("session_search", args.query, theme);
    },
    renderResult,
  });

  pi.registerTool({
    name: "session_capture_status",
    label: "Session Capture Status",
    description:
      "Check local Pi, Claude, and Codex capture files through the Effect/XState session reader.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, onUpdate, ctx) {
      return executeOperation(SessionOperation.Capture({ cwd: ctx.cwd }), signal, onUpdate);
    },
    renderCall(_args, theme) {
      return renderToolCall("session_capture_status", undefined, theme);
    },
    renderResult,
  });

  pi.registerTool({
    name: "sessions",
    label: "Sessions",
    description: "Compatibility search surface backed by the Effect/XState session reader.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      agents: Type.Optional(Type.Array(SessionAgentSchema)),
      limit: Type.Optional(Type.Number()),
      cwd_filter: Type.Optional(Type.String()),
      source: Type.Optional(SessionSourceSchema),
      machine: Type.Optional(Type.String()),
      extract: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const warnings: string[] = [];
      const limit = boundedInteger(params.limit, {
        fallback: DEFAULT_LIMIT,
        min: 1,
        max: 20,
        label: "limit",
        warnings,
      });
      const agent = (params.agents?.[0] ?? "all") as SessionAgentFilter;
      return executeOperation(
        SessionOperation.Search({
          query: params.query ?? params.cwd_filter ?? ctx.cwd,
          agent,
          source: (params.source ?? "both") as SessionSource,
          machine: params.machine ?? hostnameShort(),
          limit,
          maxFiles: DEFAULT_MAX_FILES,
          cwd: ctx.cwd,
          extract: params.extract !== false,
        }),
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      return renderToolCall("sessions", args.query ?? args.cwd_filter, theme);
    },
    renderResult,
  });

  pi.registerTool({
    name: "session_context",
    label: "Session Context",
    description:
      "Extract bounded structured context from one local transcript through the Effect/XState session reader.",
    parameters: Type.Object({
      session_id: Type.String(),
      agent: Type.Optional(SessionAgentSchema),
      query: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, onUpdate) {
      return executeOperation(
        SessionOperation.Extract({
          sessionId: params.session_id,
          query:
            params.query ??
            "Summarize the key decisions, changes made, files touched, and current state of this session.",
          compatibilityAgent: params.agent as SessionAgent | undefined,
          ignoredModel: params.model,
        }),
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      return renderToolCall("session_context", args.session_id, theme);
    },
    renderResult,
  });

  pi.registerTool({
    name: "session_inspect",
    label: "Session Inspect",
    description:
      "Inspect deterministic local transcript line evidence through a bounded Effect/XState actor. Overlapping windows are deduplicated.",
    parameters: Type.Object({
      session_id: Type.String(),
      around: Type.String(),
      before: Type.Optional(Type.Number()),
      after: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal, onUpdate) {
      const warnings: string[] = [];
      const before = boundedInteger(params.before, {
        fallback: 20,
        min: 0,
        max: INSPECT_MAX_BEFORE,
        label: "before",
        warnings,
      });
      const after = boundedInteger(params.after, {
        fallback: 80,
        min: 0,
        max: INSPECT_MAX_AFTER,
        label: "after",
        warnings,
      });
      const result = await executeOperation(
        SessionOperation.Inspect({
          sessionId: params.session_id,
          around: params.around,
          before,
          after,
        }),
        signal,
        onUpdate,
      );
      if (warnings.length > 0) result.details.warnings = warnings;
      return result;
    },
    renderCall(args, theme) {
      return renderToolCall("session_inspect", args.around, theme);
    },
    renderResult,
  });

  pi.registerTool({
    name: "session_chunks",
    label: "Session Chunks",
    description:
      "Find bounded transcript chunks through the Effect/XState session reader. Local is the default; non-local sources use joelclaw as an index adapter.",
    parameters: Type.Object({
      query: Type.String(),
      source: Type.Optional(SessionSourceSchema),
      machine: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      context_before: Type.Optional(Type.Number()),
      context_after: Type.Optional(Type.Number()),
      exclude_current: Type.Optional(Type.Boolean()),
      compact: Type.Optional(Type.Boolean()),
      allow_large_output: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const warnings: string[] = [];
      const allowLarge = params.allow_large_output === true;
      const limit = boundedInteger(params.limit, {
        fallback: DEFAULT_LIMIT,
        min: 1,
        max: allowLarge ? CHUNKS_LARGE_LIMIT : CHUNKS_SAFE_LIMIT,
        label: "limit",
        warnings,
      });
      const contextBefore = boundedInteger(params.context_before, {
        fallback: 0,
        min: 0,
        max: allowLarge ? CHUNKS_LARGE_CONTEXT : CHUNKS_SAFE_CONTEXT,
        label: "context_before",
        warnings,
      });
      const contextAfter = boundedInteger(params.context_after, {
        fallback: 0,
        min: 0,
        max: allowLarge ? CHUNKS_LARGE_CONTEXT : CHUNKS_SAFE_CONTEXT,
        label: "context_after",
        warnings,
      });
      if (params.compact === false)
        warnings.push("compact:false is ignored; actor output is always bounded.");
      const current = currentSession(ctx);
      return executeOperation(
        SessionOperation.Chunks({
          query: params.query,
          source: (params.source ?? "local") as SessionSource,
          machine: params.machine ?? hostnameShort(),
          limit,
          contextBefore,
          contextAfter,
          maxFiles: allowLarge ? 1_000 : DEFAULT_MAX_FILES,
          cwd: ctx.cwd,
          excludeCurrent: params.exclude_current !== false,
          currentSessionId: current.sessionId,
          currentSessionFile: current.sessionFile,
          warnings,
        }),
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      return renderToolCall("session_chunks", args.query, theme);
    },
    renderResult,
  });

  pi.registerTool({
    name: "session_tasks",
    label: "Session Tasks Deprecated",
    description:
      "Deprecated compatibility surface. The Effect/XState actor runs each request directly.",
    parameters: Type.Object({ task_id: Type.Optional(Type.Number()) }),
    async execute() {
      return {
        content: [
          {
            type: "text" as const,
            text: "No background session reader task registry exists. Each request is one cancellable XState actor.",
          },
        ],
        details: { wrapper: "session_tasks deprecated", ok: true, tasks: [] },
      };
    },
    renderCall(_args, theme) {
      return renderToolCall("session_tasks deprecated", undefined, theme);
    },
    renderResult,
  });
}
