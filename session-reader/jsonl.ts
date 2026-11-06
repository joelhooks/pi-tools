import { open } from "node:fs/promises";

function configuredCaps(): readonly [number, number] {
  const defaults = [2 * 1024 * 1024, 256 * 1024] as const;
  const decode = process.env.SESSION_READER_JSONL_DECODE_BYTES;
  const prefix = process.env.SESSION_READER_JSONL_PREFIX_BYTES;
  const full = decode === undefined ? defaults[0] : Number(decode);
  const retained = prefix === undefined ? Math.min(defaults[1], full) : Number(prefix);
  if (![full, retained].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 64 * 1024 * 1024) || retained > full) {
    // One warning per module load, no values echoed, no broken tool imports.
    console.warn("session-reader: invalid JSONL byte caps; using 2 MiB decode / 256 KiB prefix defaults.");
    return defaults;
  }
  return [full, retained];
}
const [decodeBytes, prefixBytes] = configuredCaps();

/** Fully decode ordinary large records, including compaction summaries. */
export const MAX_JSONL_LINE_BYTES = decodeBytes;
/** Above the decode tier, retain searchable JSON string content from this prefix. */
export const JSONL_PREFIX_BYTES = prefixBytes;
export const TRUNCATION_NOTICE = `Truncated: oversized JSONL records use only their first ${JSONL_PREFIX_BYTES} bytes; matches beyond that prefix may be missed (full decode cap ${MAX_JSONL_LINE_BYTES} bytes).`;

export interface JsonlLine {
  readonly line: number;
  readonly offset: number;
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Byte-offset scanner: one 64 KiB read and one capped line buffer. Above the
 * decode cap, discard the remainder but retain the prefix at its physical line
 * number. Early iterator return, errors and cancellation close the descriptor.
 */
export async function* scanJsonl(
  path: string,
  signal: AbortSignal,
  maxLineBytes = MAX_JSONL_LINE_BYTES,
): AsyncGenerator<JsonlLine> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new RangeError("Line byte cap must be a positive safe integer");
  }
  const readBuffer = Buffer.allocUnsafe(64 * 1024);
  const lineBuffer = Buffer.allocUnsafe(maxLineBytes);
  const handle = await open(path, "r");
  const prefixBytes = Math.min(JSONL_PREFIX_BYTES, maxLineBytes);
  let length = 0;
  let oversized = false;
  let line = 1;
  let offset = 0;
  let position = 0;
  const text = () => lineBuffer.toString("utf8", 0, oversized ? prefixBytes : length).replace(/\r$/u, "");
  try {
    while (true) {
      signal.throwIfAborted();
      // Reuse one read buffer rather than allocating a Buffer for every chunk.
      // Large sequential scans otherwise accumulate external memory between GCs.
      const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, null);
      signal.throwIfAborted();
      if (bytesRead === 0) break;
      const bytes = readBuffer.subarray(0, bytesRead);
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const end = newline === -1 ? bytes.length : newline;
        const size = end - start;
        if (!oversized) {
          const copied = Math.min(size, maxLineBytes - length);
          bytes.copy(lineBuffer, length, start, start + copied);
          length += copied;
          if (copied < size) oversized = true;
        }
        position += size;
        if (newline !== -1) {
          yield { line: line++, offset, text: text(), truncated: oversized };
          length = 0;
          oversized = false;
          position += 1;
          offset = position;
        }
        start = end + 1;
      }
    }
    if (position > offset) yield { line, offset, text: text(), truncated: oversized };
  } finally {
    await handle.close();
  }
}
