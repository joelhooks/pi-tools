import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
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
  role: Schema.Union([
    Schema.Literal("user"),
    Schema.Literal("assistant"),
    Schema.Literal("tool"),
  ]),
  content: Schema.optional(Schema.Unknown),
  id: Schema.optional(Schema.String),
});
type CursorBlob = typeof CursorBlobSchema.Type;

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

async function readCursorBlobs(storePath: string, signal: AbortSignal): Promise<readonly CursorBlob[]> {
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

async function readCursorTranscript(locator: SessionLocator, signal: AbortSignal): Promise<Transcript> {
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

function jsonlAdapter(
  runtime: Exclude<SessionAgent, "cursor">,
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
export function createSessionAdapters(): readonly SessionAdapter[] {
  const home = homedir();
  const grokHome = process.env.GROK_HOME?.trim() || join(home, ".grok");
  return [
    jsonlAdapter("pi", join(home, ".pi/agent/sessions"), (name) => name.endsWith(".jsonl")),
    jsonlAdapter("claude", join(home, ".claude/projects"), (name) => name.endsWith(".jsonl")),
    jsonlAdapter("codex", join(home, ".codex/sessions"), (name) => name.endsWith(".jsonl")),
    cursorAdapter(join(home, ".cursor/acp-sessions")),
    jsonlAdapter("grok", join(grokHome, "sessions"), (name) => name === "chat_history.jsonl"),
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
