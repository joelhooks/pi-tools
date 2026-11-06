import { readFile, readdir, stat } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import {
  type CaptureFileStatus,
  capturePathSpecs,
  machineIdFromAuth,
} from "./capture-paths.ts";
import {
  compactText,
  evidence,
  inspectTranscript,
  extractTranscript,
  type InspectResult,
  type Extraction,
  type LocalSessionHit,
  LocalSessionHitSchema,
  matchesQuery,
  matchesLowerQuery,
  lowercaseText,
  queryTerms,
  type SessionAgent,
  type SessionAgentFilter,
  type SessionFile,
  SessionReaderError,
  sessionMetaFromPath,
  type Transcript,
  TranscriptSchema,
} from "./domain.ts";
import {
  createSessionAdapters,
  readJsonlTranscript,
  readRedactedTail,
  type AdapterHealth,
  type SessionAdapter,
} from "./adapters.ts";

import { scanJsonl, MAX_JSONL_LINE_BYTES, JSONL_PREFIX_BYTES, TRUNCATION_NOTICE, type JsonlLine } from "./jsonl.ts";
import { parseJsonlLine } from "./jsonl-entry.ts";
import { inspectJsonl, extractJsonl } from "./streaming.ts";
import { readJsonlPage, type TranscriptPage } from "./jsonl-page.ts";

const DISCOVERY_HARD_LIMIT = 50_000;
const CAPTURE_TAIL_BYTES = 64 * 1024;

export type { CaptureFileStatus } from "./capture-paths.ts";

/** Inputs for bounded local transcript search. */
export interface SearchLocalInput {
  readonly query: string;
  readonly agent: SessionAgentFilter;
  readonly limit: number;
  readonly maxFiles: number;
}

/** Effect service boundary for native session stores and capture health. */
export interface Interface {
  readonly resolvePath: (idOrPath: string) => Effect.Effect<string, SessionReaderError>;
  readonly readTranscript: (path: string) => Effect.Effect<Transcript, SessionReaderError>;
  readonly inspect: (path: string, around: string, before: number, after: number) => Effect.Effect<InspectResult, SessionReaderError>;
  readonly extract: (path: string, query: string) => Effect.Effect<Extraction, SessionReaderError>;
  readonly readPage: (path: string, offset: number | undefined, direction: "forward" | "backward", limit: number) => Effect.Effect<TranscriptPage, SessionReaderError>;
  readonly searchLocal: (
    input: SearchLocalInput,
  ) => Effect.Effect<{ readonly hits: readonly LocalSessionHit[]; readonly truncatedFiles: number }, SessionReaderError>;
  readonly captureState: Effect.Effect<readonly CaptureFileStatus[], SessionReaderError>;
  readonly adapterHealth: Effect.Effect<readonly AdapterHealth[], SessionReaderError>;
}

/** Effect service key for the local native session adapters. */
export class SessionStore extends Context.Service<SessionStore, Interface>()(
  "@pi-tools/session-reader/SessionStore",
) {}

const adapters = createSessionAdapters();

function readerError(operation: string, cause: unknown): SessionReaderError {
  return new SessionReaderError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function adapterFor(
  agent: SessionAgent,
  registry: readonly SessionAdapter[] = adapters,
): SessionAdapter | undefined {
  return registry.find((adapter) => adapter.runtime === agent);
}

function adapterForPath(
  path: string,
  registry: readonly SessionAdapter[] = adapters,
): SessionAdapter | undefined {
  return registry.find((adapter) => adapter.canRead(path));
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function listFiles(
  agent: SessionAgentFilter,
  maxFiles: number,
  signal: AbortSignal,
): Promise<readonly SessionFile[]> {
  const selected = agent === "all" ? adapters : adapters.filter((adapter) => adapter.runtime === agent);
  const groups = await Promise.all(
    selected.map(async (adapter) => {
      const files: SessionFile[] = [];
      for await (const file of adapter.discover({ maxFiles, signal })) {
        files.push(file);
      }
      return files;
    }),
  );
  return groups
    .flat()
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, Math.min(maxFiles, DISCOVERY_HARD_LIMIT));
}

function readSessionFile(
  path: string,
  signal: AbortSignal,
): Promise<Transcript> {
  const adapter = adapterForPath(path);
  if (!adapter) return readJsonlTranscript(path, signal);
  const locator: SessionFile = {
    agent: adapter.runtime,
    path,
    mtimeMs: 0,
    mtime: new Date(0).toISOString(),
  };
  return adapter.read(locator, signal);
}

interface ScanJsonlLinesInput {
  readonly file: SessionFile;
  readonly query: string;
  readonly terms: readonly string[];
  readonly lines: AsyncIterable<string | JsonlLine>;
  readonly signal: AbortSignal;
}

export async function scanJsonlLines({
  file,
  query,
  terms,
  lines,
  signal,
}: ScanJsonlLinesInput): Promise<LocalSessionHit | undefined> {
  const snippets: string[] = [];
  const matchedTerms = new Set<string>();
  const maximumTermCount = new Set(terms).size;
  let directMatch = false;
  let lineNumber = 0;
  let truncated = false;

  for await (const line of lines) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
    lineNumber += 1;
    const oversized = typeof line === "string" && Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES;
    const record: JsonlLine = typeof line === "string" ? {
      line: lineNumber, offset: 0, truncated: oversized,
      text: oversized ? Buffer.from(line.slice(0, JSONL_PREFIX_BYTES)).subarray(0, JSONL_PREFIX_BYTES).toString("utf8") : line,
    } : line;
    truncated ||= record.truncated;
    const entry = parseJsonlLine(record).entry;
    if (!entry) continue;

    const lower = lowercaseText(entry.text);
    for (const term of terms) {
      if (lower.includes(term)) matchedTerms.add(term);
    }
    if (matchesLowerQuery(lower, query)) {
      directMatch = true;
      if (snippets.length < 3) {
        const preview = compactText(entry.text, 320) ?? entry.text.slice(0, 320);
        snippets.push(entry.truncated ? `L${entry.line} [truncated prefix]: ${preview}` : preview);
      }
    }

    if (directMatch && matchedTerms.size === maximumTermCount && snippets.length === 3) break;
  }

  const pathMatch = matchesQuery(file.path, query);
  if (!directMatch && matchedTerms.size === 0 && !pathMatch) return undefined;
  const metadata = sessionMetaFromPath(file.path);
  return {
    agent: file.agent,
    sessionId: metadata.sessionId,
    startedAt: metadata.startedAt,
    cwdKey: metadata.cwdKey,
    path: file.path,
    mtime: file.mtime,
    snippets: snippets.length > 0 ? snippets : [compactText(file.path, 320) ?? file.path],
    score: matchedTerms.size + (directMatch ? 1 : 0) + (pathMatch ? 1 : 0),
    ...(truncated ? { truncated: true } : {}),
  };
}

export async function scanJsonlSessionFile(
  file: SessionFile,
  query: string,
  terms: readonly string[],
  signal: AbortSignal,
  onTruncated?: () => void,
): Promise<LocalSessionHit | undefined> {
  let truncated = false;
  const lines = (async function* () {
    for await (const line of scanJsonl(file.path, signal)) {
      truncated ||= line.truncated;
      yield line;
    }
  })();
  const hit = await scanJsonlLines({ file, query, terms, lines, signal });
  if (truncated) onTruncated?.();
  return hit && truncated
    ? { ...hit, truncated: true, snippets: [...hit.snippets, TRUNCATION_NOTICE] }
    : hit;
}

async function scanSessionFile(
  file: SessionFile,
  query: string,
  terms: readonly string[],
  signal: AbortSignal,
  onTruncated?: () => void,
): Promise<LocalSessionHit | undefined> {
  const adapter = adapterFor(file.agent);
  if (!adapter) return undefined;

  if (file.path.endsWith(".jsonl")) {
    try {
      return await scanJsonlSessionFile(file, query, terms, signal, onTruncated);
    } catch (cause) {
      if (signal.aborted) throw cause;
      return undefined;
    }
  }

  const snippets: string[] = [];
  const matchedTerms = new Set<string>();
  let directMatch = false;
  let transcript: Transcript;

  try {
    transcript = await adapter.read(file, signal);
    for (const entry of transcript.entries) {
      const lower = lowercaseText(entry.text);
      for (const term of terms) {
        if (lower.includes(term)) matchedTerms.add(term);
      }
      if (matchesLowerQuery(lower, query)) {
        directMatch = true;
        if (snippets.length < 3) {
          snippets.push(compactText(entry.text, 320) ?? entry.text.slice(0, 320));
        }
      }
    }
  } catch (cause) {
    if (signal.aborted) throw cause;
    return undefined;
  }

  if (transcript.truncated) onTruncated?.();
  const pathMatch = matchesQuery(file.path, query);
  if (!directMatch && matchedTerms.size === 0 && !pathMatch) return undefined;
  if (transcript.truncated) {
    if (snippets.length === 0) snippets.push(compactText(file.path, 320) ?? file.path);
    snippets.push(transcript.truncationReason ?? TRUNCATION_NOTICE);
  }
  return {
    agent: file.agent,
    sessionId: transcript.sessionId,
    startedAt: transcript.startedAt,
    cwdKey: transcript.cwdKey,
    path: file.path,
    mtime: file.mtime,
    snippets: snippets.length > 0 ? snippets : [compactText(file.path, 320) ?? file.path],
    score: matchedTerms.size + (directMatch ? 1 : 0) + (pathMatch ? 1 : 0),
    ...(transcript.truncated ? { truncated: true } : {}),
  };
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function outboxCount(path: string): Promise<number> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

async function captureStatuses(signal: AbortSignal): Promise<readonly CaptureFileStatus[]> {
  const home = os.homedir();
  let machineId = "unknown-machine";
  try {
    const authPath = process.env.JOELCLAW_AUTH_PATH ?? join(home, ".joelclaw/auth.json");
    machineId = machineIdFromAuth(JSON.parse(await readFile(authPath, "utf8")));
  } catch {
    // Preserve an explicit unknown namespace when auth is unavailable.
  }

  const statuses: CaptureFileStatus[] = [];
  for (const spec of capturePathSpecs(home, machineId)) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
    const isDirectory = spec.kind === "outbox";
    const present = isDirectory ? await pathIsDirectory(spec.path) : await pathIsFile(spec.path);
    if (!present) {
      statuses.push({ ...spec, present: false, pendingCount: isDirectory ? 0 : undefined });
      continue;
    }
    const metadata = await stat(spec.path);
    let tail: string | undefined;
    if (spec.kind === "log") {
      try {
        tail = await readRedactedTail(spec.path, signal, CAPTURE_TAIL_BYTES);
      } catch (cause) {
        if (signal.aborted) throw cause;
      }
    }
    statuses.push({
      ...spec,
      present: true,
      modified: metadata.mtime.toISOString(),
      tail,
      pendingCount: isDirectory ? await outboxCount(spec.path) : undefined,
    });
  }
  return statuses;
}

const resolvePath = Effect.fn("SessionStore.resolvePath")((idOrPath: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      if (await pathIsFile(idOrPath)) return idOrPath;
      const files = await listFiles("all", DISCOVERY_HARD_LIMIT, signal);
      const match = files.find((file) => file.path.includes(idOrPath));
      if (!match) throw new Error(`No local Pi/Claude/Codex/Cursor/Grok/OpenCode transcript found for ${idOrPath}`);
      return match.path;
    },
    catch: (cause) => readerError("SessionStore.resolvePath", cause),
  }),
);

const readTranscriptEffect = Effect.fn("SessionStore.readTranscript")((path: string) =>
  Effect.tryPromise({
    try: (signal) => readSessionFile(path, signal),
    catch: (cause) => readerError("SessionStore.readTranscript", cause),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TranscriptSchema)),
    Effect.mapError((cause) => readerError("SessionStore.decodeTranscript", cause)),
  ),
);

function isLineTranscript(path: string): boolean {
  const adapter = adapterForPath(path);
  return path.endsWith(".jsonl") && adapter?.runtime !== "cursor" && adapter?.runtime !== "opencode";
}

const inspect = Effect.fn("SessionStore.inspect")((path: string, around: string, before: number, after: number) =>
  Effect.tryPromise({
    try: async (signal) => isLineTranscript(path)
      ? inspectJsonl(path, around, before, after, signal)
      : inspectTranscript(await readSessionFile(path, signal), around, before, after),
    catch: (cause) => readerError("SessionStore.inspect", cause),
  }),
);

const extract = Effect.fn("SessionStore.extract")((path: string, query: string) =>
  Effect.tryPromise({
    try: async (signal) => isLineTranscript(path)
      ? extractJsonl(path, query, signal)
      : extractTranscript(await readSessionFile(path, signal), query),
    catch: (cause) => readerError("SessionStore.extract", cause),
  }),
);

const readPage = Effect.fn("SessionStore.readPage")((path: string, offset: number | undefined, direction: "forward" | "backward", limit: number) =>
  Effect.tryPromise({
    try: async (signal) => {
      if (isLineTranscript(path)) return readJsonlPage(path, offset, direction, limit, signal);
      const transcript = await readSessionFile(path, signal);
      const totalEntries = transcript.entries.length;
      const clamped = Math.min(totalEntries, Math.max(0, Math.floor(offset ?? (direction === "backward" ? totalEntries : 0))));
      const start = direction === "backward" ? Math.max(0, clamped - limit) : clamped;
      const end = direction === "backward" ? clamped : Math.min(totalEntries, clamped + limit);
      return {
        transcript: { ...transcript, entries: transcript.entries.slice(start, end).map((entry) => ({ ...evidence(entry), raw: undefined })) },
        start, totalEntries,
      };
    },
    catch: (cause) => readerError("SessionStore.readPage", cause),
  }),
);

/** Keep ordinary stores parallel; a >64 MiB (or unknown-size) file runs alone. */
export const LARGE_SEARCH_FILE_BYTES = 64 * 1024 * 1024;
export function searchFileBatches(files: readonly { readonly file: SessionFile; readonly size: number }[]): readonly (readonly SessionFile[])[] {
  const batches: SessionFile[][] = [];
  let small: SessionFile[] = [];
  const flush = () => { if (small.length > 0) batches.push(small); small = []; };
  for (const { file, size } of files) {
    if (size > LARGE_SEARCH_FILE_BYTES || !Number.isFinite(size)) {
      flush();
      batches.push([file]);
    } else {
      small.push(file);
      if (small.length === 8) flush();
    }
  }
  flush();
  return batches;
}

const searchLocal = Effect.fn("SessionStore.searchLocal")((input: SearchLocalInput) =>
  Effect.tryPromise({
    try: async (signal) => {
      const files = await listFiles(input.agent, input.maxFiles, signal);
      const terms = queryTerms(input.query);
      const hits: LocalSessionHit[] = [];
      let truncatedFiles = 0;

      for (let offset = 0; offset < files.length; offset += 8) {
        if (signal.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
        const sized = await Promise.all(files.slice(offset, offset + 8).map(async (file) => {
          let size = Infinity;
          try { size = (await stat(file.path)).size; } catch { /* native locator or disappearing file: scan alone */ }
          return { file, size };
        }));
        for (const group of searchFileBatches(sized)) {
          const batch = await Promise.all(group.map((file) =>
            scanSessionFile(file, input.query, terms, signal, () => { truncatedFiles += 1; }),
          ));
          hits.push(...batch.filter((hit): hit is LocalSessionHit => hit !== undefined));
        }
        if (hits.length >= input.limit) break;
      }

      return {
        hits: hits
          .sort((left, right) => right.score - left.score || +new Date(right.mtime) - +new Date(left.mtime))
          .slice(0, input.limit),
        truncatedFiles,
      };
    },
    catch: (cause) => readerError("SessionStore.searchLocal", cause),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ hits: Schema.Array(LocalSessionHitSchema), truncatedFiles: Schema.Number }))),
    Effect.mapError((cause) => readerError("SessionStore.decodeSearchResults", cause)),
  ),
);

const captureState = Effect.tryPromise({
  try: (signal) => captureStatuses(signal),
  catch: (cause) => readerError("SessionStore.captureState", cause),
});

const adapterHealth = Effect.tryPromise({
  try: async (signal) => Promise.all(adapters.map((adapter) => adapter.health(signal))),
  catch: (cause) => readerError("SessionStore.adapterHealth", cause),
});

/** Live Effect layer for the native session adapter registry. */
export const SessionStoreLive = Layer.succeed(SessionStore)({
  resolvePath,
  readTranscript: readTranscriptEffect,
  inspect,
  extract,
  readPage,
  searchLocal,
  captureState,
  adapterHealth,
});
