import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Context, Effect, Layer, Schema } from "effect";
import {
  compactText,
  type LocalSessionHit,
  LocalSessionHitSchema,
  matchesQuery,
  parseTranscriptLine,
  queryTerms,
  redactSecrets,
  redactUnknown,
  type SessionAgent,
  type SessionAgentFilter,
  type SessionFile,
  sessionMetaFromPath,
  SessionReaderError,
  type Transcript,
  TranscriptSchema,
  type TranscriptEntry,
} from "./domain.ts";

const DISCOVERY_HARD_LIMIT = 50_000;
const CAPTURE_TAIL_BYTES = 64 * 1024;

export interface CaptureFileStatus {
  readonly label: string;
  readonly path: string;
  readonly present: boolean;
  readonly modified?: string;
  readonly tail?: string;
}

export interface SearchLocalInput {
  readonly query: string;
  readonly agent: SessionAgentFilter;
  readonly limit: number;
  readonly maxFiles: number;
}

export interface Interface {
  readonly resolvePath: (idOrPath: string) => Effect.Effect<string, SessionReaderError>;
  readonly readTranscript: (path: string) => Effect.Effect<Transcript, SessionReaderError>;
  readonly searchLocal: (
    input: SearchLocalInput,
  ) => Effect.Effect<readonly LocalSessionHit[], SessionReaderError>;
  readonly captureState: Effect.Effect<readonly CaptureFileStatus[], SessionReaderError>;
}

export class SessionStore extends Context.Service<SessionStore, Interface>()(
  "@pi-tools/session-reader/SessionStore",
) {}

function roots(
  agent: SessionAgentFilter,
): ReadonlyArray<{ readonly agent: SessionAgent; readonly root: string }> {
  const home = os.homedir();
  const all = [
    { agent: "pi" as const, root: join(home, ".pi/agent/sessions") },
    { agent: "claude" as const, root: join(home, ".claude/projects") },
    { agent: "codex" as const, root: join(home, ".codex/sessions") },
  ];
  return agent === "all" ? all : all.filter((item) => item.agent === agent);
}

function readerError(operation: string, cause: unknown): SessionReaderError {
  return new SessionReaderError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function walkJsonlFiles(
  root: string,
  agent: SessionAgent,
  signal: AbortSignal,
): Promise<readonly SessionFile[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (paths.length >= DISCOVERY_HARD_LIMIT) return;
    checkSignal(signal);

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (paths.length >= DISCOVERY_HARD_LIMIT) break;
      checkSignal(signal);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
    }
  };

  await visit(root);
  const files: SessionFile[] = [];
  for (let offset = 0; offset < paths.length; offset += 128) {
    checkSignal(signal);
    const batch = await Promise.all(
      paths.slice(offset, offset + 128).map(async (path) => {
        try {
          const metadata = await stat(path);
          return {
            agent,
            path,
            mtimeMs: metadata.mtimeMs,
            mtime: metadata.mtime.toISOString(),
          } satisfies SessionFile;
        } catch {
          return undefined;
        }
      }),
    );
    files.push(...batch.filter((file): file is SessionFile => file !== undefined));
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function listFiles(
  agent: SessionAgentFilter,
  maxFilesPerRoot: number,
  signal: AbortSignal,
): Promise<readonly SessionFile[]> {
  const groups = await Promise.all(
    roots(agent).map(async (item) =>
      (await walkJsonlFiles(item.root, item.agent, signal)).slice(0, maxFilesPerRoot),
    ),
  );
  return groups.flat().sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function readTranscriptFile(path: string, signal: AbortSignal): Promise<Transcript> {
  const entries: TranscriptEntry[] = [];
  let redacted = false;
  let lineNumber = 0;
  const stream = createReadStream(path, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const line of lines) {
      checkSignal(signal);
      lineNumber += 1;
      const parsed = parseTranscriptLine(line, lineNumber);
      if (parsed.redacted) redacted = true;
      if (parsed.entry) entries.push(parsed.entry);
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return { ...sessionMetaFromPath(path), path, entries, redacted };
}

async function scanSessionFile(
  file: SessionFile,
  query: string,
  terms: readonly string[],
  signal: AbortSignal,
): Promise<LocalSessionHit | undefined> {
  const snippets: string[] = [];
  const matchedTerms = new Set<string>();
  let directMatch = false;
  let lineNumber = 0;
  const stream = createReadStream(file.path, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const line of lines) {
      checkSignal(signal);
      lineNumber += 1;
      const parsed = parseTranscriptLine(line, lineNumber);
      const text = parsed.entry?.text;
      if (!text) continue;
      const lower = text.toLowerCase();
      for (const term of terms) {
        if (lower.includes(term)) matchedTerms.add(term);
      }
      if (matchesQuery(text, query)) {
        directMatch = true;
        if (snippets.length < 3) snippets.push(compactText(text, 320) ?? text.slice(0, 320));
      }
    }
  } catch (cause) {
    if (signal.aborted) throw cause;
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }

  const pathMatch = matchesQuery(file.path, query);
  if (!directMatch && matchedTerms.size === 0 && !pathMatch) return undefined;
  const meta = sessionMetaFromPath(file.path);
  return {
    agent: file.agent,
    ...meta,
    path: file.path,
    mtime: file.mtime,
    snippets: snippets.length > 0 ? snippets : [compactText(file.path, 320) ?? file.path],
    score: matchedTerms.size + (directMatch ? 1 : 0) + (pathMatch ? 1 : 0),
  };
}

function redactCaptureLine(line: string): string {
  try {
    return JSON.stringify(redactUnknown(JSON.parse(line)));
  } catch {
    return redactSecrets(line).text;
  }
}

async function readTail(path: string, signal: AbortSignal): Promise<string> {
  checkSignal(signal);
  const metadata = await stat(path);
  const length = Math.min(metadata.size, CAPTURE_TAIL_BYTES);
  if (length <= 0) return "";
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, metadata.size - length));
    checkSignal(signal);
    const tail = buffer
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-3)
      .map((line) => compactText(redactCaptureLine(line), 500) ?? "")
      .join("\n  ");
    return tail;
  } finally {
    await handle.close();
  }
}

const resolvePath = Effect.fn("SessionStore.resolvePath")((idOrPath: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      if (await pathIsFile(idOrPath)) return idOrPath;
      const files = await listFiles("all", DISCOVERY_HARD_LIMIT, signal);
      const match = files.find((file) => file.path.includes(idOrPath));
      if (!match) throw new Error(`No local Pi/Claude/Codex transcript found for ${idOrPath}`);
      return match.path;
    },
    catch: (cause) => readerError("SessionStore.resolvePath", cause),
  }),
);

const readTranscriptEffect = Effect.fn("SessionStore.readTranscript")((path: string) =>
  Effect.tryPromise({
    try: (signal) => readTranscriptFile(path, signal),
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
        checkSignal(signal);
        const batch = await Promise.all(
          files
            .slice(offset, offset + 8)
            .map((file) => scanSessionFile(file, input.query, terms, signal)),
        );
        hits.push(...batch.filter((hit): hit is LocalSessionHit => hit !== undefined));
        if (hits.length >= input.limit) break;
      }

      return hits
        .sort(
          (left, right) =>
            right.score - left.score || +new Date(right.mtime) - +new Date(left.mtime),
        )
        .slice(0, input.limit);
    },
    catch: (cause) => readerError("SessionStore.searchLocal", cause),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LocalSessionHitSchema))),
    Effect.mapError((cause) => readerError("SessionStore.decodeSearchResults", cause)),
  ),
);

const captureState = Effect.tryPromise({
  try: async (signal) => {
    const home = os.homedir();
    const files = [
      { label: "pi capture state", path: join(home, ".joelclaw/session-state.json") },
      { label: "pi capture log", path: join(home, ".joelclaw/capture.log") },
      { label: "codex capture state", path: join(home, ".joelclaw/codex-session-state.json") },
      { label: "codex capture log", path: join(home, ".joelclaw/codex-capture.log") },
      { label: "claude capture state", path: join(home, ".joelclaw/claude-session-state.json") },
      { label: "claude capture log", path: join(home, ".joelclaw/claude-capture.log") },
    ];

    const statuses: CaptureFileStatus[] = [];
    for (const file of files) {
      checkSignal(signal);
      if (!(await pathIsFile(file.path))) {
        statuses.push({ ...file, present: false });
        continue;
      }
      const metadata = await stat(file.path);
      let tail = "";
      try {
        tail = await readTail(file.path, signal);
      } catch (cause) {
        if (signal.aborted) throw cause;
      }
      statuses.push({
        ...file,
        present: true,
        modified: metadata.mtime.toISOString(),
        tail,
      });
    }
    return statuses;
  },
  catch: (cause) => readerError("SessionStore.captureState", cause),
});

export const SessionStoreLive = Layer.succeed(SessionStore)({
  resolvePath,
  readTranscript: readTranscriptEffect,
  searchLocal,
  captureState,
});
