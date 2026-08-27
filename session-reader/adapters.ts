import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { Result, Schema } from "effect";
import {
  compactText,
  parseTranscriptLine,
  redactSecrets,
  sessionMetaFromPath,
  type SessionAgent,
  type SessionFile,
  type Transcript,
  type TranscriptEntry,
} from "./domain.ts";

const DISCOVERY_HARD_LIMIT = 50_000;
const OPENCODE_MAX_MESSAGES_PER_SESSION = 2_000;
const OPENCODE_MAX_PARTS_PER_SESSION = 5_000;
const OPENCODE_MAX_DATA_BYTES = 8 * 1024;

/** Query bounds shared by every native session adapter. */
export interface SessionQuery {
  readonly maxFiles: number;
  readonly signal: AbortSignal;
}

/** A native session source discovered by an adapter. */
export type SessionLocator = SessionFile;

/** Health state for one runtime's local native store. */
export interface AdapterHealth {
  readonly runtime: SessionAgent;
  readonly root: string;
  readonly status: "healthy" | "missing" | "degraded";
  readonly detail: string;
}

/**
 * Reads one runtime's native session store into the common transcript model.
 *
 * Adapters own runtime-specific discovery and decoding. The session store only
 * composes them, so adding a runtime does not spread path checks through the
 * search and inspection workflows.
 */
export interface SessionAdapter {
  readonly runtime: SessionAgent;
  readonly root: string;
  readonly discover: (query: SessionQuery) => AsyncIterable<SessionLocator>;
  readonly canRead: (path: string) => boolean;
  readonly read: (locator: SessionLocator, signal: AbortSignal) => Promise<Transcript>;
  readonly health: (signal: AbortSignal) => Promise<AdapterHealth>;
}

/** Throw the native abort reason before doing more filesystem work. */
function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function pathWithin(root: string, path: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(normalizedRoot);
}

async function discoverFiles(
  root: string,
  runtime: SessionAgent,
  matches: (name: string) => boolean,
  query: SessionQuery,
): Promise<readonly SessionLocator[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (paths.length >= DISCOVERY_HARD_LIMIT) return;
    checkSignal(query.signal);

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (paths.length >= DISCOVERY_HARD_LIMIT) break;
      checkSignal(query.signal);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && matches(entry.name)) paths.push(path);
    }
  };

  await visit(root);
  const files: SessionLocator[] = [];
  for (let offset = 0; offset < paths.length; offset += 128) {
    checkSignal(query.signal);
    const batch = await Promise.all(
      paths.slice(offset, offset + 128).map(async (path) => {
        try {
          const metadata = await stat(path);
          return {
            agent: runtime,
            path,
            mtimeMs: metadata.mtimeMs,
            mtime: metadata.mtime.toISOString(),
          } satisfies SessionLocator;
        } catch {
          return undefined;
        }
      }),
    );
    files.push(...batch.filter((file): file is SessionLocator => file !== undefined));
  }

  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, Math.max(0, query.maxFiles));
}

export async function readJsonlTranscript(path: string, signal: AbortSignal): Promise<Transcript> {
  const entries: TranscriptEntry[] = [];
  let redacted = false;
  let lineNumber = 0;
  const stream = createReadStream(path, { encoding: "utf8" });
  const onAbort = () => stream.destroy(new Error("Operation aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
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
    signal.removeEventListener("abort", onAbort);
    lines.close();
    stream.destroy();
  }

  return { ...sessionMetaFromPath(path), path, entries, redacted };
}

const CursorMetaSchema = Schema.Struct({
  agentId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Number),
});
const CursorBlobSchema = Schema.Struct({
  rowid: Schema.Number,
  role: Schema.Union([Schema.Literal("user"), Schema.Literal("assistant"), Schema.Literal("tool")]),
  content: Schema.optional(Schema.Unknown),
  id: Schema.optional(Schema.String),
});
type CursorBlob = typeof CursorBlobSchema.Type;

const OpenCodeMessageDataSchema = Schema.Struct({
  role: Schema.Union([Schema.Literal("user"), Schema.Literal("assistant")]),
  summary: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      completed: Schema.optional(Schema.Number),
    }),
  ),
});
const OpenCodePartDataSchema = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  ignored: Schema.optional(Schema.Boolean),
  synthetic: Schema.optional(Schema.Boolean),
});

interface OpenCodeSessionRow {
  readonly id: string;
  readonly directory: string;
  readonly time_created: number;
  readonly time_updated: number;
}

interface OpenCodeMessageRow {
  readonly id: string;
  readonly data: string;
  readonly data_length: number;
  readonly time_created: number;
  readonly time_updated: number;
}

interface OpenCodePartRow {
  readonly id: string;
  readonly message_id: string;
  readonly data: string;
  readonly data_length: number;
}

const CURSOR_BLOB_EXPORTER = String.raw`
import json
import sqlite3
import sys

database = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
for rowid, data in database.execute("select rowid, data from blobs order by rowid"):
    try:
        value = json.loads(bytes(data))
    except Exception:
        continue
    if not isinstance(value, dict) or value.get("role") not in {"user", "assistant", "tool"}:
        continue
    print(json.dumps({
        "rowid": rowid,
        "role": value.get("role"),
        "content": value.get("content"),
        "id": value.get("id"),
    }, ensure_ascii=False))
`;

function decodeJson<T>(schema: Schema.ConstraintDecoder<T>, value: string): T | undefined {
  try {
    const decoded = Schema.decodeUnknownResult(schema)(JSON.parse(value));
    return Result.isSuccess(decoded) ? decoded.success : undefined;
  } catch {
    return undefined;
  }
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readCursorBlobs(
  storePath: string,
  signal: AbortSignal,
): Promise<readonly CursorBlob[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      ["-c", CURSOR_BLOB_EXPORTER, storePath],
      { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Cursor store read failed: ${String(stderr || error.message)}`));
          return;
        }
        const entries = String(stdout)
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            const decoded = decodeJson(CursorBlobSchema, line);
            return decoded ? [decoded] : [];
          })
          .sort((left, right) => left.rowid - right.rowid);
        resolve(entries);
      },
    );
  });
}

async function readCursorTranscript(
  locator: SessionLocator,
  signal: AbortSignal,
): Promise<Transcript> {
  const metadata = decodeJson(CursorMetaSchema, await readFile(locator.path, "utf8")) ?? {};
  const storePath = join(dirname(locator.path), "store.db");
  const rawEntries = (await pathIsFile(storePath)) ? await readCursorBlobs(storePath, signal) : [];
  const entries: TranscriptEntry[] = [];
  let redacted = false;
  const timestamp =
    metadata.createdAt !== undefined ? new Date(metadata.createdAt).toISOString() : undefined;

  for (const [index, raw] of rawEntries.entries()) {
    const parsed = parseTranscriptLine(
      JSON.stringify({ ...raw, type: raw.role, timestamp }),
      index + 1,
    );
    if (parsed.redacted) redacted = true;
    if (parsed.entry) entries.push(parsed.entry);
  }

  return {
    sessionId: metadata.agentId ?? sessionMetaFromPath(locator.path).sessionId,
    startedAt: timestamp,
    cwdKey: metadata.cwd,
    path: locator.path,
    entries,
    redacted,
  };
}

function openCodeLocator(databasePath: string, sessionId: string): string {
  return `${databasePath}#session=${encodeURIComponent(sessionId)}`;
}

function openCodeSessionId(databasePath: string, locator: string): string | undefined {
  const prefix = `${databasePath}#session=`;
  if (!locator.startsWith(prefix)) return undefined;
  try {
    const value = decodeURIComponent(locator.slice(prefix.length));
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function withOpenCodeDatabase<A>(databasePath: string, run: (database: DatabaseSync) => A): A {
  const databaseOptions: NonNullable<ConstructorParameters<typeof DatabaseSync>[1]> & {
    readonly timeout: number;
  } = {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    open: true,
    readOnly: true,
    timeout: 2_500,
  };
  const database = new DatabaseSync(databasePath, databaseOptions);
  let transactionOpen = false;
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2500");
    const queryOnly = database.prepare("PRAGMA query_only").get() as
      | { readonly query_only?: unknown }
      | undefined;
    const journalMode = database.prepare("PRAGMA journal_mode").get() as
      | { readonly journal_mode?: unknown }
      | undefined;
    if (queryOnly?.query_only !== 1 || String(journalMode?.journal_mode).toLowerCase() !== "wal") {
      throw new Error("OpenCode SQLite is not configured for a read-only WAL snapshot");
    }
    database.exec("BEGIN DEFERRED TRANSACTION");
    transactionOpen = true;
    database.prepare("SELECT count(*) FROM sqlite_schema").get();
    const result = run(database);
    database.exec("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the first bounded source failure.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

function openCodeAdapter(databasePath: string): SessionAdapter {
  const runtime = "opencode" as const;
  return {
    runtime,
    root: databasePath,
    discover: async function* (query) {
      checkSignal(query.signal);
      if (!(await pathIsFile(databasePath))) return;
      const rows = withOpenCodeDatabase(
        databasePath,
        (database) =>
          database
            .prepare(
              `SELECT id, directory, time_created, time_updated
             FROM session
             ORDER BY time_updated DESC, id DESC
             LIMIT ?`,
            )
            .all(Math.max(0, query.maxFiles)) as unknown as readonly OpenCodeSessionRow[],
      );
      for (const row of rows) {
        checkSignal(query.signal);
        if (
          typeof row.id !== "string" ||
          typeof row.directory !== "string" ||
          !Number.isSafeInteger(row.time_created) ||
          !Number.isSafeInteger(row.time_updated)
        ) {
          continue;
        }
        yield {
          agent: runtime,
          path: openCodeLocator(databasePath, row.id),
          mtimeMs: row.time_updated,
          mtime: new Date(row.time_updated).toISOString(),
        };
      }
    },
    canRead: (path) => openCodeSessionId(databasePath, path) !== undefined,
    read: async (locator, signal) => {
      checkSignal(signal);
      const sessionId = openCodeSessionId(databasePath, locator.path);
      if (!sessionId) throw new Error("Invalid OpenCode session locator");
      const transcript = withOpenCodeDatabase(databasePath, (database) => {
        const session = database
          .prepare(
            `SELECT id, directory, time_created, time_updated
             FROM session
             WHERE id = ?`,
          )
          .get(sessionId) as unknown as OpenCodeSessionRow | undefined;
        if (!session) throw new Error("OpenCode session not found");
        checkSignal(signal);
        const messages = database
          .prepare(
            `SELECT id,
                    substr(data, 1, ?) AS data,
                    length(data) AS data_length,
                    time_created,
                    time_updated
             FROM message
             WHERE session_id = ?
             ORDER BY time_created, id
             LIMIT ?`,
          )
          .all(
            OPENCODE_MAX_DATA_BYTES + 1,
            sessionId,
            OPENCODE_MAX_MESSAGES_PER_SESSION + 1,
          ) as unknown as readonly OpenCodeMessageRow[];
        checkSignal(signal);
        const parts = database
          .prepare(
            `SELECT id,
                    message_id,
                    substr(data, 1, ?) AS data,
                    length(data) AS data_length
             FROM part
             WHERE session_id = ?
             ORDER BY time_created, id
             LIMIT ?`,
          )
          .all(
            OPENCODE_MAX_DATA_BYTES + 1,
            sessionId,
            OPENCODE_MAX_PARTS_PER_SESSION + 1,
          ) as unknown as readonly OpenCodePartRow[];
        if (
          messages.length > OPENCODE_MAX_MESSAGES_PER_SESSION ||
          parts.length > OPENCODE_MAX_PARTS_PER_SESSION ||
          messages.some(
            (message) =>
              !Number.isSafeInteger(message.data_length) ||
              message.data_length < 0 ||
              message.data_length > OPENCODE_MAX_DATA_BYTES,
          ) ||
          parts.some(
            (part) =>
              !Number.isSafeInteger(part.data_length) ||
              part.data_length < 0 ||
              part.data_length > OPENCODE_MAX_DATA_BYTES,
          )
        ) {
          throw new Error("OpenCode session exceeds bounded reader limits");
        }
        const partsByMessage = new Map<string, OpenCodePartRow[]>();
        for (const [index, part] of parts.entries()) {
          if (index % 128 === 0) checkSignal(signal);
          const current = partsByMessage.get(part.message_id) ?? [];
          current.push(part);
          partsByMessage.set(part.message_id, current);
        }
        const entries: TranscriptEntry[] = [];
        let redacted = false;
        for (const [index, message] of messages.entries()) {
          if (index % 128 === 0) checkSignal(signal);
          const data = decodeJson(OpenCodeMessageDataSchema, message.data);
          if (!data || (data.role === "assistant" && data.summary === true)) continue;
          if (
            data.role === "assistant" &&
            (!Number.isSafeInteger(data.time?.completed) || Number(data.time?.completed) < 0)
          ) {
            continue;
          }
          const visible = (partsByMessage.get(message.id) ?? []).flatMap((part) => {
            const decoded = decodeJson(OpenCodePartDataSchema, part.data);
            if (
              !decoded ||
              decoded.type !== "text" ||
              decoded.ignored === true ||
              decoded.synthetic === true ||
              !decoded.text?.trim()
            ) {
              return [];
            }
            return [decoded.text];
          });
          if (visible.length === 0) continue;
          const protectedText = redactSecrets(visible.join("\n"));
          redacted ||= protectedText.redacted;
          entries.push({
            line: entries.length + 1,
            raw: { messageId: message.id },
            text: protectedText.text,
            role: data.role,
            kind: "message",
          });
        }
        return {
          sessionId: session.id,
          startedAt: new Date(session.time_created).toISOString(),
          cwdKey: session.directory,
          path: locator.path,
          entries,
          redacted,
        } satisfies Transcript;
      });
      checkSignal(signal);
      return transcript;
    },
    health: async (signal) => {
      checkSignal(signal);
      if (!(await pathIsFile(databasePath))) {
        return {
          runtime,
          root: databasePath,
          status: "missing",
          detail: "SQLite store is not present",
        };
      }
      try {
        withOpenCodeDatabase(databasePath, (database) => {
          database.prepare("SELECT id FROM session ORDER BY time_updated DESC LIMIT 1").get();
        });
        return {
          runtime,
          root: databasePath,
          status: "healthy",
          detail: "read-only SQLite store is readable",
        };
      } catch {
        return {
          runtime,
          root: databasePath,
          status: "degraded",
          detail: "read-only SQLite store could not be queried",
        };
      }
    },
  };
}

function jsonlAdapter(
  runtime: Exclude<SessionAgent, "cursor" | "opencode">,
  root: string,
  matches: (name: string) => boolean,
): SessionAdapter {
  return {
    runtime,
    root,
    discover: async function* (query) {
      const files = await discoverFiles(root, runtime, matches, query);
      for (const file of files) yield file;
    },
    canRead: (path) => pathWithin(root, path),
    read: (locator, signal) => readJsonlTranscript(locator.path, signal),
    health: async (signal) => {
      checkSignal(signal);
      try {
        const metadata = await stat(root);
        return metadata.isDirectory()
          ? { runtime, root, status: "healthy", detail: "native root is readable" }
          : { runtime, root, status: "degraded", detail: "native root is not a directory" };
      } catch {
        return { runtime, root, status: "missing", detail: "native root is not present" };
      }
    },
  };
}

function cursorAdapter(root: string): SessionAdapter {
  const runtime = "cursor" as const;
  return {
    runtime,
    root,
    discover: async function* (query) {
      const files = await discoverFiles(root, runtime, (name) => name === "meta.json", query);
      for (const file of files) yield file;
    },
    canRead: (path) => pathWithin(root, path) && path.endsWith("/meta.json"),
    read: readCursorTranscript,
    health: async (signal) => {
      checkSignal(signal);
      try {
        const metadata = await stat(root);
        return metadata.isDirectory()
          ? { runtime, root, status: "healthy", detail: "ACP session root is readable" }
          : { runtime, root, status: "degraded", detail: "ACP session root is not a directory" };
      } catch {
        return { runtime, root, status: "missing", detail: "ACP session root is not present" };
      }
    },
  };
}

/** Build the runtime adapter registry from the current user's native roots. */
export function createSessionAdapters(
  options: {
    readonly home?: string;
    readonly grokHome?: string;
    readonly openCodeDatabase?: string;
  } = {},
): readonly SessionAdapter[] {
  const home = options.home ?? homedir();
  const grokHome = options.grokHome ?? process.env.GROK_HOME?.trim() ?? join(home, ".grok");
  const openCodeDatabase =
    options.openCodeDatabase ?? join(home, ".local/share/opencode/opencode.db");
  return [
    jsonlAdapter("pi", join(home, ".pi/agent/sessions"), (name) => name.endsWith(".jsonl")),
    jsonlAdapter("claude", join(home, ".claude/projects"), (name) => name.endsWith(".jsonl")),
    jsonlAdapter("codex", join(home, ".codex/sessions"), (name) => name.endsWith(".jsonl")),
    cursorAdapter(join(home, ".cursor/acp-sessions")),
    jsonlAdapter("grok", join(grokHome, "sessions"), (name) => name === "chat_history.jsonl"),
    openCodeAdapter(openCodeDatabase),
  ];
}

/** Read a bounded tail without exposing raw capture secrets. */
export async function readRedactedTail(
  path: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<string> {
  checkSignal(signal);
  const metadata = await stat(path);
  const length = Math.min(metadata.size, maxBytes);
  if (length <= 0) return "";
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, metadata.size - length));
    checkSignal(signal);
    return buffer
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-3)
      .map((line) => {
        try {
          return compactText(redactSecrets(JSON.stringify(JSON.parse(line))).text, 500) ?? "";
        } catch {
          return compactText(redactSecrets(line).text, 500) ?? "";
        }
      })
      .join("\n  ");
  } finally {
    await handle.close();
  }
}
