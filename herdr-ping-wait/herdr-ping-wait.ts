#!/usr/bin/env bun

import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const POLL_INTERVAL_MS = 1_000;
const DEFAULT_STATE_DIR = join(homedir(), ".local", "state", "herdr-pings");
const DEFAULT_CURSOR = join(DEFAULT_STATE_DIR, "cursor.json");

type Cursor = Record<string, number>;

type Options = {
  paneIds: string[];
  timeoutMs?: number;
  cursorPath: string;
};

class ArgumentError extends Error {}

function usage(): string {
  return "Usage: herdr-ping-wait <pane_id...> [--timeout <seconds>] [--cursor <file>]";
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function parseArgs(args: string[]): Options {
  const paneIds: string[] = [];
  let timeoutMs: number | undefined;
  let cursorPath = DEFAULT_CURSOR;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--timeout") {
      const value = args[++index];
      if (value === undefined) throw new ArgumentError("--timeout requires seconds");
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new ArgumentError("--timeout must be a non-negative number");
      }
      timeoutMs = seconds * 1_000;
      continue;
    }

    if (arg === "--cursor") {
      const value = args[++index];
      if (value === undefined || value.length === 0) throw new ArgumentError("--cursor requires a file");
      cursorPath = resolve(expandHome(value));
      continue;
    }

    if (arg.startsWith("-")) throw new ArgumentError(`unknown option: ${arg}`);
    paneIds.push(arg);
  }

  if (paneIds.length === 0) throw new ArgumentError("at least one pane id is required");
  return { paneIds, timeoutMs, cursorPath };
}

function spoolPath(paneId: string): string {
  return join(DEFAULT_STATE_DIR, `${paneId.replaceAll(":", "-")}.jsonl`);
}

async function loadCursor(path: string): Promise<Cursor> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("cursor must be a JSON object");
    }

    const cursor: Cursor = {};
    for (const [spool, offset] of Object.entries(parsed)) {
      if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
        throw new Error(`invalid byte offset for ${spool}`);
      }
      cursor[spool] = offset as number;
    }
    return cursor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot read cursor ${path}: ${(error as Error).message}`);
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function saveCursor(path: string, cursor: Cursor): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function initializeSpools(paths: string[], cursorPath: string, cursor: Cursor): Promise<void> {
  let changed = false;
  for (const path of paths) {
    if (!(path in cursor)) {
      cursor[path] = await fileSize(path);
      changed = true;
    }
  }
  if (changed) await saveCursor(cursorPath, cursor);
}

async function firstCompleteLine(path: string, offset: number): Promise<{ line: string; nextOffset: number } | undefined> {
  const size = await fileSize(path);
  if (size <= offset) return undefined;

  const length = size - offset;
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, offset);
    const content = bytes.subarray(0, bytesRead);
    const newlineIndex = content.indexOf(0x0a);
    if (newlineIndex === -1) return undefined;

    return {
      line: content.subarray(0, newlineIndex).toString("utf8"),
      nextOffset: offset + newlineIndex + 1,
    };
  } finally {
    await handle.close();
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function run(options: Options): Promise<number> {
  await mkdir(DEFAULT_STATE_DIR, { recursive: true });
  const paths = options.paneIds.map(spoolPath);
  const cursor = await loadCursor(options.cursorPath);
  await initializeSpools(paths, options.cursorPath, cursor);
  const startedAt = Date.now();

  while (true) {
    for (const path of paths) {
      const event = await firstCompleteLine(path, cursor[path]);
      if (!event) continue;

      cursor[path] = event.nextOffset;
      await saveCursor(options.cursorPath, cursor);
      process.stdout.write(`${event.line}\n`);
      return 0;
    }

    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) return 2;

    const remaining = options.timeoutMs === undefined
      ? POLL_INTERVAL_MS
      : Math.min(POLL_INTERVAL_MS, Math.max(0, options.timeoutMs - (Date.now() - startedAt)));
    await sleep(remaining);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  process.exitCode = await run(options);
} catch (error) {
  if (error instanceof ArgumentError) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
  } else {
    process.stderr.write(`${(error as Error).message}\n`);
  }
  process.exitCode = 1;
}
