import { evidence, sessionMetaFromPath, type Transcript, type TranscriptEntry } from "./domain.ts";
import { scanJsonl } from "./jsonl.ts";
import { parseJsonlLine } from "./jsonl-entry.ts";

export interface TranscriptPage {
  readonly transcript: Transcript;
  readonly start: number;
  readonly totalEntries: number;
}

/** Entry-index pagination preserves opaque expansion cursors without loading the file. */
export async function readJsonlPage(
  path: string, offset: number | undefined, direction: "forward" | "backward", limit: number, signal: AbortSignal,
): Promise<TranscriptPage> {
  limit = Math.min(40, Math.max(1, Math.floor(limit)));
  const requested = offset === undefined ? direction === "backward" ? Infinity : 0 : Math.max(0, Math.floor(offset));
  const selected: TranscriptEntry[] = [];
  const tail: TranscriptEntry[] = [];
  let totalEntries = 0;
  let redacted = false;
  let truncated = false;
  for await (const line of scanJsonl(path, signal)) {
    truncated ||= line.truncated;
    const parsed = parseJsonlLine(line);
    redacted ||= parsed.redacted;
    if (!parsed.entry) continue;
    const index = totalEntries++;
    const item: TranscriptEntry = { ...evidence(parsed.entry), raw: undefined };
    if (direction === "backward") {
      tail.push(item);
      if (tail.length > limit) tail.shift();
      if (index >= Math.max(0, requested - limit) && index < requested) selected.push(item);
    } else if (index >= requested && index < requested + limit) selected.push(item);
  }
  const clamped = Math.min(totalEntries, requested);
  const start = direction === "backward" ? Math.max(0, clamped - limit) : clamped;
  const entries = direction === "backward" && requested > totalEntries ? tail : selected;
  return {
    transcript: { ...sessionMetaFromPath(path), path, entries, redacted, ...(truncated ? { truncated: true } : {}) },
    start, totalEntries,
  };
}
