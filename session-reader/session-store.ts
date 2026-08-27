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
  type LocalSessionHit,
  LocalSessionHitSchema,
  matchesQuery,
  queryTerms,
  type SessionAgent,
  type SessionAgentFilter,
  type SessionFile,
  SessionReaderError,
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
  readonly searchLocal: (
    input: SearchLocalInput,
  ) => Effect.Effect<readonly LocalSessionHit[], SessionReaderError>;
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
  maxFilesPerRoot: number,
  signal: AbortSignal,
): Promise<readonly SessionFile[]> {
  const selected = agent === "all" ? adapters : adapters.filter((adapter) => adapter.runtime === agent);
  const groups = await Promise.all(
    selected.map(async (adapter) => {
      const files: SessionFile[] = [];
      for await (const file of adapter.discover({ maxFiles: maxFilesPerRoot, signal })) {
        files.push(file);
      }
      return files;
    }),
  );
  return groups
    .flat()
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, DISCOVERY_HARD_LIMIT);
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

async function scanSessionFile(
  file: SessionFile,
  query: string,
  terms: readonly string[],
  signal: AbortSignal,
): Promise<LocalSessionHit | undefined> {
  const adapter = adapterFor(file.agent);
  if (!adapter) return undefined;

  const snippets: string[] = [];
  const matchedTerms = new Set<string>();
  let directMatch = false;
  let transcript: Transcript;

  try {
    transcript = await adapter.read(file, signal);
    for (const entry of transcript.entries) {
      const lower = entry.text.toLowerCase();
      for (const term of terms) {
        if (lower.includes(term)) matchedTerms.add(term);
      }
      if (matchesQuery(entry.text, query)) {
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

  const pathMatch = matchesQuery(file.path, query);
  if (!directMatch && matchedTerms.size === 0 && !pathMatch) return undefined;
  return {
    agent: file.agent,
    sessionId: transcript.sessionId,
    startedAt: transcript.startedAt,
    cwdKey: transcript.cwdKey,
    path: file.path,
    mtime: file.mtime,
    snippets: snippets.length > 0 ? snippets : [compactText(file.path, 320) ?? file.path],
    score: matchedTerms.size + (directMatch ? 1 : 0) + (pathMatch ? 1 : 0),
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

const searchLocal = Effect.fn("SessionStore.searchLocal")((input: SearchLocalInput) =>
  Effect.tryPromise({
    try: async (signal) => {
      const files = await listFiles(input.agent, input.maxFiles, signal);
      const terms = queryTerms(input.query);
      const hits: LocalSessionHit[] = [];

      for (let offset = 0; offset < files.length; offset += 8) {
        if (signal.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
        const batch = await Promise.all(
          files.slice(offset, offset + 8).map((file) => scanSessionFile(file, input.query, terms, signal)),
        );
        hits.push(...batch.filter((hit): hit is LocalSessionHit => hit !== undefined));
        if (hits.length >= input.limit) break;
      }

      return hits
        .sort((left, right) => right.score - left.score || +new Date(right.mtime) - +new Date(left.mtime))
        .slice(0, input.limit);
    },
    catch: (cause) => readerError("SessionStore.searchLocal", cause),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LocalSessionHitSchema))),
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
  searchLocal,
  captureState,
  adapterHealth,
});
