import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { Effect, Schema } from "effect";
import { assessCaptureHealth, resolveCentralUrl } from "./capture-paths.ts";
import {
  evidence,
  extractTranscript,
  inspectTranscript,
  type LocalSessionHit,
  type SessionAgentFilter,
  SessionReaderError,
  type SessionSource,
} from "./domain.ts";
import { type FlowingRecallInput, runFlowingRecall } from "./flowing-recall.ts";
import { JoelclawIndex, JoelclawIndexLive } from "./joelclaw-index.ts";
import {
  capText,
  expansionDetails,
  inspectDetails,
  MAX_TOOL_TEXT_CHARS,
  remoteDetails,
  renderAdapterHealth,
  renderCaptureHealth,
  renderCaptureState,
  renderExpansion,
  renderExtraction,
  renderFlowingRecall,
  renderInspect,
  renderLocalHits,
  renderRemote,
  type ToolPayload,
  ToolPayloadSchema,
} from "./presenter.ts";
import { SessionStore, SessionStoreLive } from "./session-store.ts";

interface SearchInput {
  readonly query: string;
  readonly agent: SessionAgentFilter;
  readonly source: SessionSource;
  readonly machine: string;
  readonly limit: number;
  readonly maxFiles: number;
  readonly cwd: string;
  readonly extract: boolean;
}

interface RecallInput extends FlowingRecallInput {
  readonly cwd: string;
}

interface InspectInput {
  readonly sessionId: string;
  readonly around: string;
  readonly before: number;
  readonly after: number;
}

interface ExtractInput {
  readonly sessionId: string;
  readonly query: string;
  readonly compatibilityAgent?: string;
  readonly ignoredModel?: string;
}

interface ExpandInput {
  readonly sessionId: string;
  readonly cursor?: string;
  readonly direction?: "forward" | "backward";
  readonly limit: number;
}

interface ChunksInput {
  readonly query: string;
  readonly source: SessionSource;
  readonly machine: string;
  readonly limit: number;
  readonly contextBefore: number;
  readonly contextAfter: number;
  readonly maxFiles: number;
  readonly cwd: string;
  readonly excludeCurrent: boolean;
  readonly currentSessionId?: string;
  readonly currentSessionFile?: string;
  readonly warnings: readonly string[];
}

interface CaptureInput {
  readonly cwd: string;
}

export const SessionOperationSchema = Schema.TaggedUnion({
  Recall: {
    query: Schema.String,
    project: Schema.String,
    workstream: Schema.String,
    allowedPrivacy: Schema.Array(
      Schema.Union([
        Schema.Literal("public"),
        Schema.Literal("private"),
        Schema.Literal("sensitive"),
      ]),
    ),
    includeSuperseded: Schema.Boolean,
    limits: Schema.Struct({
      curated: Schema.Number,
      observations: Schema.Number,
      reflections: Schema.Number,
    }),
    cwd: Schema.String,
  },
  Search: {
    query: Schema.String,
    agent: Schema.Union([
      Schema.Literal("all"),
      Schema.Literal("pi"),
      Schema.Literal("claude"),
      Schema.Literal("codex"),
      Schema.Literal("cursor"),
      Schema.Literal("grok"),
      Schema.Literal("opencode"),
    ]),
    source: Schema.Union([
      Schema.Literal("typesense"),
      Schema.Literal("ssh"),
      Schema.Literal("local"),
      Schema.Literal("both"),
    ]),
    machine: Schema.String,
    limit: Schema.Number,
    maxFiles: Schema.Number,
    cwd: Schema.String,
    extract: Schema.Boolean,
  },
  Inspect: {
    sessionId: Schema.String,
    around: Schema.String,
    before: Schema.Number,
    after: Schema.Number,
  },
  Extract: {
    sessionId: Schema.String,
    query: Schema.String,
    compatibilityAgent: Schema.optional(Schema.String),
    ignoredModel: Schema.optional(Schema.String),
  },
  Expand: {
    sessionId: Schema.String,
    cursor: Schema.optional(Schema.String),
    direction: Schema.optional(
      Schema.Union([Schema.Literal("forward"), Schema.Literal("backward")]),
    ),
    limit: Schema.Number,
  },
  Chunks: {
    query: Schema.String,
    source: Schema.Union([
      Schema.Literal("typesense"),
      Schema.Literal("ssh"),
      Schema.Literal("local"),
      Schema.Literal("both"),
    ]),
    machine: Schema.String,
    limit: Schema.Number,
    contextBefore: Schema.Number,
    contextAfter: Schema.Number,
    maxFiles: Schema.Number,
    cwd: Schema.String,
    excludeCurrent: Schema.Boolean,
    currentSessionId: Schema.optional(Schema.String),
    currentSessionFile: Schema.optional(Schema.String),
    warnings: Schema.Array(Schema.String),
  },
  Capture: { cwd: Schema.String },
});

export type SessionOperation = typeof SessionOperationSchema.Type;

export const SessionOperation = {
  Recall: (input: RecallInput): SessionOperation => SessionOperationSchema.cases.Recall.make(input),
  Search: (input: SearchInput): SessionOperation => SessionOperationSchema.cases.Search.make(input),
  Inspect: (input: InspectInput): SessionOperation =>
    SessionOperationSchema.cases.Inspect.make(input),
  Extract: (input: ExtractInput): SessionOperation =>
    SessionOperationSchema.cases.Extract.make(input),
  Expand: (input: ExpandInput): SessionOperation => SessionOperationSchema.cases.Expand.make(input),
  Chunks: (input: ChunksInput): SessionOperation => SessionOperationSchema.cases.Chunks.make(input),
  Capture: (input: CaptureInput): SessionOperation =>
    SessionOperationSchema.cases.Capture.make(input),
};

function readerError(operation: string, cause: unknown): SessionReaderError {
  return new SessionReaderError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function currentHit(
  hit: LocalSessionHit,
  input: Pick<ChunksInput, "currentSessionId" | "currentSessionFile">,
): boolean {
  if (input.currentSessionId && hit.sessionId === input.currentSessionId) return true;
  if (!input.currentSessionFile) return false;
  return (
    hit.path === input.currentSessionFile ||
    hit.path.endsWith(input.currentSessionFile) ||
    input.currentSessionFile.endsWith(hit.path)
  );
}

const runRecall = Effect.fn("SessionEngine.recall")(function* (input: RecallInput) {
  const result = yield* Effect.tryPromise({
    try: (signal) => runFlowingRecall(input, { cwd: input.cwd, signal }),
    catch: (cause) => readerError("SessionEngine.recall", cause),
  });
  return {
    text: renderFlowingRecall(result.composed),
    details: {
      wrapper: "flowing_recall actor",
      ok: true,
      engine: "effect-v4+xstate-v5",
      operation: "Recall",
      adapter: result.adapter,
      composed: result.composed,
      curatedBackend: result.curatedBackend,
      timings: result.timings,
    },
  } satisfies ToolPayload;
});

const runSearch = Effect.fn("SessionEngine.search")(function* (input: SearchInput) {
  if (input.source !== "local") {
    return {
      text: "Remote session search is disabled until joelclaw accepts queries on stdin.",
      details: {
        wrapper: "session_search actor",
        ok: false,
        engine: "effect-v4+xstate-v5",
        operation: "Search",
        code: "remote-query-transport-unavailable",
      },
      isError: true,
    } satisfies ToolPayload;
  }
  const store = yield* SessionStore;
  const localHits = yield* store.searchLocal({
    query: input.query,
    agent: input.agent,
    limit: input.limit,
    maxFiles: input.maxFiles,
  });

  const text = capText(
    [
      "# Session search",
      "Effect v4 local engine. Use flowing recall before raw evidence drill-down.",
      "\n## Local transcript details",
      renderLocalHits(localHits),
    ].join("\n"),
  );

  return {
    text,
    details: {
      wrapper: "session_search actor",
      ok: true,
      engine: "effect-v4+xstate-v5",
      operation: "Search",
      query: input.query,
      source: input.source,
      machine: input.machine,
      localHits,
    },
  } satisfies ToolPayload;
});

const runInspect = Effect.fn("SessionEngine.inspect")(function* (input: InspectInput) {
  const store = yield* SessionStore;
  const path = yield* store.resolvePath(input.sessionId);
  const transcript = yield* store.readTranscript(path);
  const result = yield* Effect.try({
    try: () => inspectTranscript(transcript, input.around, input.before, input.after),
    catch: (cause) => readerError("SessionEngine.inspect", cause),
  });

  return {
    text: renderInspect(result),
    details: {
      wrapper: "session_inspect actor",
      ok: true,
      engine: "effect-v4+xstate-v5",
      operation: "Inspect",
      result: inspectDetails(result),
      maxOutputChars: MAX_TOOL_TEXT_CHARS,
    },
  } satisfies ToolPayload;
});

const runExtract = Effect.fn("SessionEngine.extract")(function* (input: ExtractInput) {
  const store = yield* SessionStore;
  const path = yield* store.resolvePath(input.sessionId);
  const transcript = yield* store.readTranscript(path);
  const extraction = extractTranscript(transcript, input.query);
  return {
    text: renderExtraction(extraction),
    details: {
      wrapper: "session_context actor",
      ok: true,
      engine: "effect-v4+xstate-v5",
      operation: "Extract",
      sessionId: extraction.sessionId,
      path: extraction.path,
      query: input.query,
      lineCount: extraction.lineCount,
      redacted: extraction.redacted,
      compatibilityAgent: input.compatibilityAgent,
      ignoredModel: input.ignoredModel,
    },
  } satisfies ToolPayload;
});

const ExpansionCursorSchema = Schema.Struct({
  sessionId: Schema.String,
  path: Schema.String,
  offset: Schema.Number,
  direction: Schema.Union([Schema.Literal("forward"), Schema.Literal("backward")]),
});
type ExpansionCursor = typeof ExpansionCursorSchema.Type;
const expansionCursorKey = randomBytes(32);

function expansionCursorSignature(payload: string): string {
  return createHmac("sha256", expansionCursorKey).update(payload).digest("base64url");
}

function encodeExpansionCursor(cursor: ExpansionCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  return `${payload}.${expansionCursorSignature(payload)}`;
}

function decodeExpansionCursor(value: string): ExpansionCursor {
  try {
    const [payload, signature, overflow] = value.split(".");
    if (!payload || !signature || overflow !== undefined) throw new Error("invalid cursor shape");
    const expected = Buffer.from(expansionCursorSignature(payload), "utf8");
    const received = Buffer.from(signature, "utf8");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new Error("invalid cursor signature");
    }
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Schema.decodeUnknownSync(ExpansionCursorSchema)(parsed);
  } catch (cause) {
    throw readerError("SessionEngine.expand.decodeCursor", cause);
  }
}

const runExpand = Effect.fn("SessionEngine.expand")(function* (input: ExpandInput) {
  const store = yield* SessionStore;
  const path = yield* store.resolvePath(input.sessionId);
  const transcript = yield* store.readTranscript(path);
  const decoded = input.cursor
    ? decodeExpansionCursor(input.cursor)
    : {
        sessionId: input.sessionId,
        path: transcript.path,
        offset: input.direction === "backward" ? transcript.entries.length : 0,
        direction: input.direction ?? "forward",
      };
  if (decoded.sessionId !== input.sessionId || decoded.path !== transcript.path) {
    throw readerError(
      "SessionEngine.expand.cursorMismatch",
      new Error("Expansion cursor belongs to a different session or transcript path"),
    );
  }
  const direction = decoded.direction;
  const offset = Math.min(transcript.entries.length, Math.max(0, Math.floor(decoded.offset)));
  const limit = Math.min(40, Math.max(1, Math.floor(input.limit)));
  const start = direction === "backward" ? Math.max(0, offset - limit) : offset;
  const end =
    direction === "backward" ? offset : Math.min(transcript.entries.length, offset + limit);
  const entries = transcript.entries.slice(start, end).map(evidence);
  const nextOffset = direction === "backward" ? start : end;
  const hasMore = direction === "backward" ? start > 0 : end < transcript.entries.length;
  const page = {
    sessionId: transcript.sessionId,
    startedAt: transcript.startedAt,
    cwdKey: transcript.cwdKey,
    path: transcript.path,
    direction,
    offset: start,
    totalEntries: transcript.entries.length,
    entries,
    nextCursor: hasMore
      ? encodeExpansionCursor({
          sessionId: input.sessionId,
          path: transcript.path,
          offset: nextOffset,
          direction,
        })
      : undefined,
  } satisfies import("./presenter.ts").ExpansionPage;

  return {
    text: renderExpansion(page),
    details: {
      wrapper: "session_expand actor",
      ok: true,
      engine: "effect-v4+xstate-v5",
      operation: "Expand",
      ...expansionDetails(page),
      maxOutputChars: MAX_TOOL_TEXT_CHARS,
    },
  } satisfies ToolPayload;
});

const runLocalChunks = Effect.fn("SessionEngine.localChunks")(function* (input: ChunksInput) {
  const store = yield* SessionStore;
  const rawHits = yield* store.searchLocal({
    query: input.query,
    agent: "all",
    limit: input.limit + 1,
    maxFiles: input.maxFiles,
  });
  const excluded = input.excludeCurrent
    ? rawHits.filter((hit) => currentHit(hit, input)).length
    : 0;
  const hits = rawHits
    .filter((hit) => !input.excludeCurrent || !currentHit(hit, input))
    .slice(0, input.limit);
  const chunks: Array<{
    readonly hit: LocalSessionHit;
    readonly inspect: ReturnType<typeof inspectTranscript>;
  }> = [];

  for (const hit of hits) {
    const transcript = yield* store.readTranscript(hit.path);
    const inspect = yield* Effect.try({
      try: () =>
        inspectTranscript(
          transcript,
          escapeRegex(input.query),
          input.contextBefore,
          input.contextAfter,
        ),
      catch: (cause) => readerError("SessionEngine.localChunks", cause),
    });
    chunks.push({ hit, inspect });
  }

  const lines = [
    "# Session chunks",
    "Effect v4 local engine output.",
    `- query: ${input.query}`,
    `- shown: ${chunks.length}`,
    `- excluded current session: ${excluded}`,
    `- context: before=${input.contextBefore}, after=${input.contextAfter}`,
    ...(input.warnings.length > 0
      ? ["- warnings:", ...input.warnings.map((warning) => `  - ${warning}`)]
      : []),
  ];
  for (const [index, chunk] of chunks.entries()) {
    lines.push(
      "",
      `## ${index + 1}. ${chunk.hit.agent} ${chunk.hit.sessionId ?? "unknown"}`,
      `- path: ${chunk.hit.path}`,
      `- matches: ${chunk.inspect.matches.length}`,
      ...chunk.inspect.matches.map((match) => {
        const direct = match.entries.find((entry) => entry.line === match.matchLine);
        return `- L${match.matchLine}: ${direct?.text ?? "match text unavailable"}`;
      }),
    );
  }

  return {
    text: capText(lines.join("\n")),
    details: {
      wrapper: "session_chunks actor",
      ok: true,
      engine: "effect-v4+xstate-v5",
      operation: "Chunks",
      source: "local",
      shown: chunks.length,
      excludedCurrent: excluded,
      warnings: input.warnings,
      chunks: chunks.map(({ hit, inspect }) => ({
        sessionId: hit.sessionId,
        path: hit.path,
        matchCount: inspect.matches.length,
      })),
    },
  } satisfies ToolPayload;
});

const runChunks = Effect.fn("SessionEngine.chunks")(function* (input: ChunksInput) {
  if (input.source === "local") return yield* runLocalChunks(input);
  return {
    text: "Remote session chunks are disabled until joelclaw accepts queries on stdin.",
    details: {
      wrapper: "session_chunks actor",
      ok: false,
      engine: "effect-v4+xstate-v5",
      operation: "Chunks",
      source: input.source,
      code: "remote-query-transport-unavailable",
      warnings: input.warnings,
    },
    isError: true,
  } satisfies ToolPayload;
});

const runCapture = Effect.fn("SessionEngine.capture")(function* (input: CaptureInput) {
  const store = yield* SessionStore;
  const index = yield* JoelclawIndex;
  const files = yield* store.captureState;
  const adapters = yield* store.adapterHealth;
  const machineId =
    files
      .find((file) => file.namespace === "canonical")
      ?.path.split("/.joelclaw/capture/")[1]
      ?.split("/")[0] ?? "unknown-machine";
  const systemBusText = yield* Effect.promise(() =>
    readFile(`${homedir()}/.config/system-bus.env`, "utf8").catch(() => ""),
  );
  const health = assessCaptureHealth({
    machineId,
    files,
    central: resolveCentralUrl({
      envUrl: process.env.JOELCLAW_CENTRAL_URL,
      systemBusText,
    }),
  });
  const status = yield* index.run(["status"], input.cwd);
  return {
    text: capText(
      [
        "# Session capture status",
        "",
        renderCaptureHealth(health),
        "",
        "## Native transcript adapters",
        renderAdapterHealth(adapters),
        "",
        "## Capture files and outboxes",
        renderCaptureState(files),
        "",
        "## joelclaw status",
        renderRemote(status),
      ].join("\n"),
    ),
    details: {
      wrapper: "session_capture_status actor",
      ok: health.ok,
      engine: "effect-v4+xstate-v5",
      operation: "Capture",
      adapters,
      files,
      health,
      joelclaw: remoteDetails(status),
    },
    isError: !health.ok,
  } satisfies ToolPayload;
});

export const runOperation = Effect.fn("SessionEngine.runOperation")(function* (
  operation: SessionOperation,
): Effect.fn.Return<ToolPayload, SessionReaderError, SessionStore | JoelclawIndex> {
  switch (operation._tag) {
    case "Recall":
      return yield* runRecall(operation);
    case "Search":
      return yield* runSearch(operation);
    case "Inspect":
      return yield* runInspect(operation);
    case "Extract":
      return yield* runExtract(operation);
    case "Expand":
      return yield* runExpand(operation);
    case "Chunks":
      return yield* runChunks(operation);
    case "Capture":
      return yield* runCapture(operation);
  }
});

export function operationProgram(
  operation: SessionOperation,
): Effect.Effect<ToolPayload, SessionReaderError> {
  return Schema.decodeUnknownEffect(SessionOperationSchema)(operation).pipe(
    Effect.mapError((cause) => readerError("SessionEngine.decodeOperation", cause)),
    Effect.flatMap(runOperation),
    Effect.flatMap((payload) =>
      Schema.decodeUnknownEffect(ToolPayloadSchema)(payload).pipe(
        Effect.mapError((cause) => readerError("SessionEngine.decodeToolPayload", cause)),
      ),
    ),
    Effect.provide(SessionStoreLive),
    Effect.provide(JoelclawIndexLive),
  );
}
