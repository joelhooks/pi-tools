import { parseTranscriptLine, parseTranscriptValue, redactUnknown } from "./domain.ts";
import type { JsonlLine } from "./jsonl.ts";

/**
 * Decode a possibly unfinished JSON prefix. Only values already in the prefix
 * survive: a partial string value is unescaped, an unfinished key is ignored,
 * and incomplete containers return their existing children. Never invent a
 * suffix of transcript text. Depth is bounded independently of byte size.
 */
function prefixValue(input: string): unknown {
  let position = 0;
  const whitespace = () => { while (position < input.length && /\s/u.test(input[position])) position++; };
  const string = (partial: boolean): string | undefined => {
    if (input[position] !== '"') throw new SyntaxError("Expected JSON string");
    const start = position++;
    let escaped = false;
    while (position < input.length) {
      const char = input[position++];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') return JSON.parse(input.slice(start, position));
    }
    if (!partial) return undefined;
    // The prefix may end in a backslash or partial \uXXXX escape. At most six
    // trailing code units need dropping to finish the preceding string content.
    const token = input.slice(start);
    for (let trim = 0; trim <= Math.min(6, token.length - 1); trim++) {
      try { return JSON.parse(`${token.slice(0, token.length - trim)}"`); } catch { /* try the preceding complete escape */ }
    }
    throw new SyntaxError("Invalid JSON string prefix");
  };
  const value = (depth: number): unknown => {
    if (depth > 64) throw new SyntaxError("JSON prefix nesting exceeds 64 levels");
    whitespace();
    const char = input[position];
    if (char === '"') return string(true);
    if (char === "{") {
      position++;
      const object = Object.create(null) as Record<string, unknown>;
      whitespace();
      while (position < input.length && input[position] !== "}") {
        const key = string(false);
        if (key === undefined) break;
        whitespace();
        if (input[position++] !== ":") break;
        const item = value(depth + 1);
        if (item === undefined) break;
        object[key] = item;
        whitespace();
        if (input[position] !== ",") break;
        position++;
        whitespace();
      }
      if (input[position] === "}") position++;
      return object;
    }
    if (char === "[") {
      position++;
      const array: unknown[] = [];
      whitespace();
      while (position < input.length && input[position] !== "]") {
        const item = value(depth + 1);
        if (item === undefined) break;
        array.push(item);
        whitespace();
        if (input[position] !== ",") break;
        position++;
      }
      if (input[position] === "]") position++;
      return array;
    }
    const start = position;
    while (position < input.length && !/[,\]}\s]/u.test(input[position])) position++;
    // A primitive touching the cut may be a prefix of a larger number/literal.
    if (position === input.length) return undefined;
    try { return JSON.parse(input.slice(start, position)); } catch { return undefined; }
  };
  const parsed = value(0);
  if (parsed === undefined) throw new SyntaxError("No JSON prefix value");
  return parsed;
}

// A tool-result string can itself contain serialized JSON. Cutting its outer
// string may leave an inner secret value without a closing quote, which the
// normal complete-value redactor cannot recognize. Mask only that unfinished
// value (including escaped quotes), not unrelated evidence after closed values.
const PARTIAL_SECRET = /(["']?(?:api.?key|auth(?:orization)?|token|secret|password|cookie|private.?key|access.?key)["']?\s*:\s*)(["'])(?:\\[\s\S]|(?!\2)[^\\])*\\?$/giu;
function redactPrefix(value: unknown): unknown {
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return item.replace(PARTIAL_SECRET, "$1$2[REDACTED]$2");
    if (Array.isArray(item)) {
      const safe = item.map(walk);
      return safe.every((child, index) => child === item[index]) ? item : safe;
    }
    if (item && typeof item === "object") {
      let changed = false;
      const entries = Object.entries(item).map(([key, child]) => {
        const safe = walk(child);
        changed ||= safe !== child;
        return [key, safe];
      });
      return changed ? Object.fromEntries(entries) : item;
    }
    return item;
  };
  return walk(redactUnknown(value));
}

/** Shared parsing contract for inspect, search, context, legacy reads and pages. */
export function parseJsonlLine(line: JsonlLine): ReturnType<typeof parseTranscriptLine> {
  if (!line.truncated) return parseTranscriptLine(line.text, line.line);
  try {
    const raw = prefixValue(line.text);
    // Prefixes include only some keys, so redact unknown fields before flattening
    // too. Never expose an incomplete secret value as generic plain-text JSON.
    const safe = redactPrefix(raw);
    const parsed = safe !== null && typeof safe === "object" && !Array.isArray(safe)
      ? parseTranscriptValue(safe, line.line)
      : parseTranscriptLine(JSON.stringify(safe), line.line);
    return {
      entry: parsed.entry && { ...parsed.entry, raw: undefined, truncated: true },
      redacted: parsed.redacted || safe !== raw,
    };
  } catch {
    // Plain-text transcripts and malformed JSON remain useful prefix evidence.
    // Apply complete-value and unfinished-secret redaction before flattening.
    const safe = String(redactPrefix(line.text));
    const parsed = parseTranscriptLine(safe, line.line);
    return {
      entry: parsed.entry && { ...parsed.entry, raw: undefined, truncated: true },
      redacted: parsed.redacted || safe !== line.text,
    };
  }
}
