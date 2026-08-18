import { Effect, Schema } from "effect";
import {
  extractTranscript,
  inspectTranscript,
  type LocalSessionHit,
  type SessionAgentFilter,
  SessionReaderError,
  type SessionSource,
} from "./domain.ts";
import { JoelclawIndex, JoelclawIndexLive } from "./joelclaw-index.ts";
import {
  capText,
  inspectDetails,
  MAX_TOOL_TEXT_CHARS,
  remoteDetails,
  renderCaptureState,
  renderExtraction,
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
  Search: {
    query: Schema.String,
    agent: Schema.Union([
      Schema.Literal("all"),
      Schema.Literal("pi"),
      Schema.Literal("claude"),
      Schema.Literal("codex"),
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
  Search: (input: SearchInput): SessionOperation => SessionOperationSchema.cases.Search.make(input),
  Inspect: (input: InspectInput): SessionOperation =>
    SessionOperationSchema.cases.Inspect.make(input),
  Extract: (input: ExtractInput): SessionOperation =>
    SessionOperationSchema.cases.Extract.make(input),
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

const runSearch = Effect.fn("SessionEngine.search")(function* (input: SearchInput) {
  const store = yield* SessionStore;
  const index = yield* JoelclawIndex;
  const localHits = yield* store.searchLocal({
    query: input.query,
    agent: input.agent,
    limit: input.limit,
    maxFiles: input.maxFiles,
  });

  const remote =
    input.source === "local"
      ? undefined
      : yield* index.run(
          [
            "session",
            "search",
            input.query,
            "--source",
            input.source,
            "--machine",
            input.machine,
            "--limit",
            String(input.limit),
            ...(input.extract ? ["--extract"] : []),
          ],
          input.cwd,
        );

  const text = capText(
    [
      "# Session search",
      "Effect v4 local engine with an optional joelclaw index adapter.",
      remote ? "\n## Joelclaw pointers" : undefined,
      remote ? renderRemote(remote) : undefined,
      "\n## Local transcript details",
      renderLocalHits(localHits),
    ]
      .filter((part): part is string => typeof part === "string")
      .join("\n"),
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
      remote: remote ? remoteDetails(remote) : undefined,
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

  const local = input.source === "both" ? yield* runLocalChunks(input) : undefined;
  const index = yield* JoelclawIndex;
  const remote = yield* index.run(
    [
      "session",
      "chunks",
      "--source",
      input.source === "both" ? "typesense" : input.source,
      "--machine",
      input.machine,
      "--limit",
      String(input.limit),
      "--context-before",
      String(input.contextBefore),
      "--context-after",
      String(input.contextAfter),
      "--",
      input.query,
    ],
    input.cwd,
  );

  if (local) {
    return {
      text: capText([local.text, "", "# Remote index pointers", renderRemote(remote)].join("\n")),
      details: {
        ...local.details,
        wrapper: "session_chunks actor",
        ok: true,
        source: "both",
        remote: remoteDetails(remote),
      },
    } satisfies ToolPayload;
  }

  return {
    text: renderRemote(remote),
    details: {
      wrapper: "session_chunks actor",
      ok: remote.ok,
      engine: "effect-v4+xstate-v5",
      operation: "Chunks",
      source: input.source,
      remote: remoteDetails(remote),
      warnings: input.warnings,
    },
    isError: !remote.ok,
  } satisfies ToolPayload;
});

const runCapture = Effect.fn("SessionEngine.capture")(function* (input: CaptureInput) {
  const store = yield* SessionStore;
  const index = yield* JoelclawIndex;
  const files = yield* store.captureState;
  const status = yield* index.run(["status"], input.cwd);
  return {
    text: capText(
      [
        "# Session capture status",
        "",
        renderCaptureState(files),
        "",
        "## joelclaw status",
        renderRemote(status),
      ].join("\n"),
    ),
    details: {
      wrapper: "session_capture_status actor",
      ok: true,
      engine: "effect-v4+xstate-v5",
      operation: "Capture",
      files,
      joelclaw: remoteDetails(status),
    },
  } satisfies ToolPayload;
});

export const runOperation = Effect.fn("SessionEngine.runOperation")(function* (
  operation: SessionOperation,
): Effect.fn.Return<ToolPayload, SessionReaderError, SessionStore | JoelclawIndex> {
  switch (operation._tag) {
    case "Search":
      return yield* runSearch(operation);
    case "Inspect":
      return yield* runInspect(operation);
    case "Extract":
      return yield* runExtract(operation);
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
