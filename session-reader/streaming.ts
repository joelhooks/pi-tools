import {
  evidence, extractTranscript, matchesQuery, sessionMetaFromPath,
  type Evidence, type Extraction, type InspectResult, type Transcript, type TranscriptEntry,
} from "./domain.ts";
import { scanJsonl } from "./jsonl.ts";
import { parseJsonlLine } from "./jsonl-entry.ts";

/** Public tools clamp windows too; enforce the bound at the IO boundary as well. */
const windowSize = (value: number) => Number.isFinite(value) ? Math.min(200, Math.max(0, Math.floor(value))) : 0;

/** Keep only eight evidence windows, never parsed records or their raw payloads. */
export async function inspectJsonl(
  path: string, around: string, before: number, after: number, signal: AbortSignal,
): Promise<InspectResult> {
  const regex = new RegExp(around, "iu");
  before = windowSize(before);
  after = windowSize(after);
  const previous: Evidence[] = [];
  const windows: Array<{ matchLine: number; entries: Evidence[]; remaining: number }> = [];
  let redacted = false;
  let truncated = false;
  for await (const line of scanJsonl(path, signal)) {
    truncated ||= line.truncated;
    const parsed = parseJsonlLine(line);
    redacted ||= parsed.redacted;
    if (!parsed.entry) continue;
    const item = evidence(parsed.entry);
    for (const window of windows) {
      if (window.remaining > 0) {
        window.entries.push(item);
        window.remaining -= 1;
      }
    }
    if (windows.length < 8 && regex.test(parsed.entry.text)) {
      windows.push({ matchLine: item.line, entries: [...previous, item], remaining: after });
    }
    if (before > 0) {
      previous.push(item);
      if (previous.length > before) previous.shift();
    }
  }
  return {
    ...sessionMetaFromPath(path), path, around, redacted,
    ...(truncated ? { truncated: true } : {}),
    matches: windows.map(({ matchLine, entries }) => ({
      matchLine, startLine: entries[0].line, endLine: entries.at(-1)!.line, entries,
    })),
  };
}

const categoryLimits = {
  evidence: 16, userPrompts: 10, decisions: 12, commandsRun: 16,
  outputsReceipts: 12, verification: 12, blockers: 12, nextActions: 10,
} as const;

/** Fold existing domain classifiers into capped evidence lists, not entry lists. */
function extractionCollector(path: string, query: string, includePrompts: boolean) {
  const result = extractTranscript({ ...sessionMetaFromPath(path), path, entries: [], redacted: false }, query);
  const lists: Record<keyof typeof categoryLimits, Evidence[]> = {
    evidence: [], userPrompts: [], decisions: [], commandsRun: [],
    outputsReceipts: [], verification: [], blockers: [], nextActions: [],
  };
  const files = new Set<string>();
  return {
    add(entry: TranscriptEntry) {
      const single = extractTranscript({ path, entries: [entry], redacted: false }, query);
      for (const key of Object.keys(categoryLimits) as Array<keyof typeof categoryLimits>) {
        if (lists[key].length >= categoryLimits[key]) continue;
        const values = key === "userPrompts"
          ? includePrompts && entry.role === "user" && entry.text ? [evidence(entry)] : []
          : single[key];
        lists[key].push(...values.slice(0, categoryLimits[key] - lists[key].length));
      }
      for (const file of single.filesTouched) {
        if (files.size >= 80) break;
        files.add(file);
      }
    },
    finish(): Extraction { return { ...result, ...lists, filesTouched: [...files] }; },
  };
}

/**
 * Context's union of [-4,+10] entry windows is consumed in source order. The
 * four preceding records are the only full texts retained; category lists hold
 * evidence (600 chars) and the no-hit fallback consumes only the first 80 entries.
 */
export async function extractJsonl(path: string, query: string, signal: AbortSignal): Promise<Extraction> {
  const relevant = extractionCollector(path, query, true);
  const fallback = extractionCollector(path, query, false);
  const previous: TranscriptEntry[] = [];
  let remaining = 0;
  let lastAddedLine = 0;
  let found = false;
  let lineCount = 0;
  let redacted = false;
  let truncated = false;
  for await (const line of scanJsonl(path, signal)) {
    truncated ||= line.truncated;
    const parsed = parseJsonlLine(line);
    redacted ||= parsed.redacted;
    if (!parsed.entry) continue;
    // Raw objects can contain a second copy of the text. Never retain them.
    const entry = { ...parsed.entry, raw: undefined };
    lineCount += 1;
    if (lineCount <= 80) fallback.add(entry);
    if (matchesQuery(entry.text, query)) {
      found = true;
      for (const prior of previous) {
        if (prior.line > lastAddedLine) {
          relevant.add(prior);
          lastAddedLine = prior.line;
        }
      }
      remaining = 11;
    }
    if (remaining > 0) {
      relevant.add(entry);
      lastAddedLine = entry.line;
      remaining -= 1;
    }
    previous.push(entry);
    if (previous.length > 4) previous.shift();
  }
  return {
    ...(found ? relevant : fallback).finish(), lineCount, redacted,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Legacy adapter callers must propagate this transcript's truncation flag. */
export async function readBoundedJsonl(path: string, signal: AbortSignal): Promise<Transcript> {
  const entries: TranscriptEntry[] = [];
  let prefixLimited = false;
  let bytes = 0;
  let redacted = false;
  let truncated = false;
  for await (const line of scanJsonl(path, signal)) {
    truncated ||= line.truncated;
    const parsed = parseJsonlLine(line);
    redacted ||= parsed.redacted;
    if (!parsed.entry) continue;
    bytes += Buffer.byteLength(parsed.entry.text, "utf8");
    if (bytes > 2 * 1024 * 1024 || entries.length >= 2_000) {
      prefixLimited = true;
      truncated = true;
      break;
    }
    entries.push({ ...parsed.entry, raw: undefined });
  }
  return {
    ...sessionMetaFromPath(path), path, entries, redacted,
    ...(truncated ? { truncated: true } : {}),
    ...(prefixLimited ? { truncationReason: "Truncated: legacy adapter transcript prefix limited to 2 MiB / 2,000 entries; use a proven JSONL streaming path for complete scanning." } : {}),
  };
}
