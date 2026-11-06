import { Result, Schema } from "effect";

export const SessionAgentSchema = Schema.Union([
  Schema.Literal("pi"),
  Schema.Literal("claude"),
  Schema.Literal("codex"),
  Schema.Literal("cursor"),
  Schema.Literal("grok"),
  Schema.Literal("opencode"),
]);
export type SessionAgent = typeof SessionAgentSchema.Type;

export const SessionAgentFilterSchema = Schema.Union([SessionAgentSchema, Schema.Literal("all")]);
export type SessionAgentFilter = typeof SessionAgentFilterSchema.Type;

export const SessionSourceSchema = Schema.Union([
  Schema.Literal("typesense"),
  Schema.Literal("ssh"),
  Schema.Literal("local"),
  Schema.Literal("both"),
]);
export type SessionSource = typeof SessionSourceSchema.Type;

export class SessionReaderError extends Schema.TaggedErrorClass<SessionReaderError>()(
  "SessionReaderError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const OptionalString = Schema.optional(Schema.String);

export const SessionMetaSchema = Schema.Struct({
  sessionId: OptionalString,
  startedAt: OptionalString,
  cwdKey: OptionalString,
});
export interface SessionMeta extends Schema.Schema.Type<typeof SessionMetaSchema> {}

export const TranscriptEntrySchema = Schema.Struct({
  line: Schema.Number,
  raw: Schema.Unknown,
  truncated: Schema.optional(Schema.Boolean),
  text: Schema.String,
  role: OptionalString,
  kind: OptionalString,
});
export interface TranscriptEntry extends Schema.Schema.Type<typeof TranscriptEntrySchema> {}

export const EvidenceSchema = Schema.Struct({
  line: Schema.Number,
  truncated: Schema.optional(Schema.Boolean),
  role: OptionalString,
  kind: OptionalString,
  text: Schema.String,
});
export interface Evidence extends Schema.Schema.Type<typeof EvidenceSchema> {}

export const TranscriptSchema = Schema.Struct({
  ...SessionMetaSchema.fields,
  path: Schema.String,
  entries: Schema.Array(TranscriptEntrySchema),
  redacted: Schema.Boolean,
  truncated: Schema.optional(Schema.Boolean),
  truncationReason: OptionalString,
});
export interface Transcript extends Schema.Schema.Type<typeof TranscriptSchema> {}

export const InspectMatchSchema = Schema.Struct({
  matchLine: Schema.Number,
  startLine: Schema.Number,
  endLine: Schema.Number,
  entries: Schema.Array(EvidenceSchema),
});
export interface InspectMatch extends Schema.Schema.Type<typeof InspectMatchSchema> {}

export const InspectResultSchema = Schema.Struct({
  ...SessionMetaSchema.fields,
  path: Schema.String,
  around: Schema.String,
  matches: Schema.Array(InspectMatchSchema),
  redacted: Schema.Boolean,
  truncated: Schema.optional(Schema.Boolean),
  truncationReason: OptionalString,
});
export interface InspectResult extends Schema.Schema.Type<typeof InspectResultSchema> {}

export const ExtractionSchema = Schema.Struct({
  ...SessionMetaSchema.fields,
  path: Schema.String,
  query: Schema.String,
  lineCount: Schema.Number,
  evidence: Schema.Array(EvidenceSchema),
  userPrompts: Schema.Array(EvidenceSchema),
  decisions: Schema.Array(EvidenceSchema),
  commandsRun: Schema.Array(EvidenceSchema),
  filesTouched: Schema.Array(Schema.String),
  outputsReceipts: Schema.Array(EvidenceSchema),
  verification: Schema.Array(EvidenceSchema),
  blockers: Schema.Array(EvidenceSchema),
  nextActions: Schema.Array(EvidenceSchema),
  redacted: Schema.Boolean,
  truncated: Schema.optional(Schema.Boolean),
  truncationReason: OptionalString,
});
export interface Extraction extends Schema.Schema.Type<typeof ExtractionSchema> {}

export const LocalSessionHitSchema = Schema.Struct({
  ...SessionMetaSchema.fields,
  agent: SessionAgentSchema,
  path: Schema.String,
  mtime: Schema.String,
  snippets: Schema.Array(Schema.String),
  score: Schema.Number,
  truncated: Schema.optional(Schema.Boolean),
});
export interface LocalSessionHit extends Schema.Schema.Type<typeof LocalSessionHitSchema> {}

export const SessionFileSchema = Schema.Struct({
  agent: SessionAgentSchema,
  path: Schema.String,
  mtimeMs: Schema.Number,
  mtime: Schema.String,
});
export interface SessionFile extends Schema.Schema.Type<typeof SessionFileSchema> {}

const TranscriptJsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeTranscriptJsonObject = Schema.decodeUnknownResult(TranscriptJsonObjectSchema);

const SENSITIVE_KEY =
  /(?:api.?key|auth(?:orization)?|token|secret|password|cookie|private.?key|access.?key)/iu;

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /(["']?(?:api.?key|auth(?:orization)?|token|secret|password|cookie|private.?key|access.?key)["']?\s*:\s*)["'][^"']*["']/giu,
    '$1"[REDACTED]"',
  ],
  [/Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]"],
  [/(authorization\s*[:=]\s*)[^\s"']+/giu, "$1[REDACTED]"],
  [/(cookie\s*[:=]\s*)[^\n]+/giu, "$1[REDACTED]"],
  [/sk_live_[A-Za-z0-9]+/gu, "sk_live_[REDACTED]"],
  [/sk_test_[A-Za-z0-9]+/gu, "sk_test_[REDACTED]"],
  [/rk_live_[A-Za-z0-9]+/gu, "rk_live_[REDACTED]"],
  [/vercel_[A-Za-z0-9]+/giu, "vercel_[REDACTED]"],
  [/lin_api_[A-Za-z0-9]+/giu, "lin_api_[REDACTED]"],
  [/[a-z][a-z0-9+.-]+:\/\/[^\s:@]+:[^\s@]+@[^\s"']+/giu, "[REDACTED_DATABASE_URL]"],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [
    /([A-Z0-9_]*(?:API|AUTH|TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*\s*[:=]\s*)["']?[^"'\s]+["']?/giu,
    "$1[REDACTED]",
  ],
];

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function detachedText(value: string): string {
  // A V8 sliced string can pin a multi-MiB parent. UTF-16 copying preserves
  // code units exactly, including a surrogate split at a preview boundary.
  return Buffer.from(value, "utf16le").toString("utf16le");
}

function normalizedText(value: string): string {
  // Single ASCII spaces already have the normalized form. Avoid allocating a
  // replacement for every word in multi-MiB tool output when nothing changes.
  return (/[^\S ]| {2}/u.test(value) ? value.replace(/\s+/g, " ") : value).trim();
}

export function compactText(value: unknown, maxChars = 600): string | undefined {
  if (typeof value !== "string") return undefined;
  const compacted = normalizedText(value);
  if (!compacted) return undefined;
  if (maxChars <= 0) return "";
  return compacted.length > maxChars
    ? detachedText(`${compacted.slice(0, Math.max(0, maxChars - 1))}…`)
    : detachedText(compacted);
}

export function redactSecrets(input: string): {
  readonly text: string;
  readonly redacted: boolean;
} {
  let text = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return { text, redacted: text !== input };
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value).text;
  if (Array.isArray(value)) {
    const safe = value.map(redactUnknown);
    return safe.every((item, index) => item === value[index]) ? value : safe;
  }
  if (typeof value !== "object" || value === null) return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    const safe = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactUnknown(item);
    changed ||= safe !== item;
    return [key, safe];
  });
  return changed ? Object.fromEntries(entries) : value;
}

const TRANSCRIPT_TEXT_KEYS = [
  "role", "type", "payload", "toolName", "name", "command", "path", "content",
  "text", "summary", "message", "stdout", "stderr", "arguments", "input", "result",
] as const;

function flattenTranscript(value: unknown): string {
  // Join once. Joining at each message/content/part level creates several full
  // copies of a near-cap payload and lets transient heap growth dominate RSS.
  const parts: string[] = [];
  const collect = (item: unknown): void => {
    if (item == null) return;
    if (Array.isArray(item)) { for (const child of item) collect(child); return; }
    if (typeof item !== "object") { if (item !== "") parts.push(String(item)); return; }
    const record = item as Record<string, unknown>;
    let known = false;
    for (const key of TRANSCRIPT_TEXT_KEYS) {
      if (key in record) {
        // Compaction summaries are text; native adapters also use a boolean
        // summary metadata field, which must not become new transcript text.
        if (key === "summary" && typeof record[key] !== "string") continue;
        known = true;
        collect(record[key]);
      }
    }
    if (!known) for (const child of Object.values(record)) collect(child);
  };
  collect(value);
  return parts.join(" ");
}

function roleOf(raw: unknown, text: string): string | undefined {
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    const message =
      typeof record.message === "object" && record.message !== null
        ? (record.message as Record<string, unknown>)
        : undefined;
    const role = asString(record.role) ?? asString(message?.role);
    if (role) return role;

    switch (asString(record.type)) {
      case "user":
      case "user_message":
        return "user";
      case "assistant":
      case "agent_message":
      case "reasoning":
        return "assistant";
      case "tool":
      case "tool_result":
      case "backend_tool_call":
      case "function_call":
      case "function_call_output":
      case "custom_tool_call":
      case "custom_tool_call_output":
        return "tool";
    }
  }
  if (/\buser\b/iu.test(text)) return "user";
  if (/\bassistant\b/iu.test(text)) return "assistant";
  return undefined;
}

function kindOf(raw: unknown, text: string): string | undefined {
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    return asString(record.type) ?? asString(record.kind) ?? asString(record.toolName);
  }
  if (/toolCall|tool call/iu.test(text)) return "tool_call";
  if (/toolResult|tool result/iu.test(text)) return "tool_result";
  return undefined;
}

export function sessionMetaFromPath(path: string): SessionMeta {
  const parts = path.split("/");
  const base = parts.at(-1) ?? path;
  const stem = base.endsWith(".jsonl") ? base.slice(0, -6) : base;

  const cursorRoot = parts.lastIndexOf("acp-sessions");
  if (cursorRoot >= 0 && parts[cursorRoot + 1]) {
    return { sessionId: parts[cursorRoot + 1] };
  }

  if (path.includes("/.codex/sessions/") && stem.startsWith("rollout-")) {
    const match = stem.match(/^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)$/u);
    if (match) {
      return {
        sessionId: match[5],
        startedAt: `${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`,
        cwdKey: path.split("/").at(-2),
      };
    }
  }

  const grokRoot = parts.lastIndexOf("sessions");
  if (grokRoot >= 0 && parts[grokRoot + 2]) {
    const encodedCwd = parts[grokRoot + 1];
    let cwdKey = encodedCwd;
    try {
      cwdKey = decodeURIComponent(encodedCwd ?? "");
    } catch {
      // Keep the encoded path as a stable fallback.
    }
    return { sessionId: parts[grokRoot + 2], cwdKey };
  }

  const underscore = stem.lastIndexOf("_");
  const rawStarted = underscore >= 0 ? stem.slice(0, underscore) : undefined;
  return {
    sessionId: underscore >= 0 ? stem.slice(underscore + 1) : stem,
    startedAt: rawStarted?.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/u, "T$1:$2:$3.$4Z"),
    cwdKey: path.split("/").at(-2),
  };
}

export function parseTranscriptLine(
  line: string,
  lineNumber: number,
): { readonly entry?: TranscriptEntry; readonly redacted: boolean } {
  if (!line.trim()) return { redacted: false };
  let raw: unknown = line;
  try {
    const decoded = decodeTranscriptJsonObject(JSON.parse(line));
    if (Result.isSuccess(decoded)) raw = decoded.success;
  } catch {
    // Plain text transcripts are valid evidence too.
  }
  return parseTranscriptValue(raw, lineNumber);
}

/** Flatten an already-decoded value without serializing and parsing it again. */
export function parseTranscriptValue(
  raw: unknown,
  lineNumber: number,
): { readonly entry: TranscriptEntry; readonly redacted: boolean } {
  const flattened = normalizedText(flattenTranscript(raw));
  const safe = redactSecrets(flattened);
  return {
    entry: {
      line: lineNumber,
      raw,
      text: safe.text,
      role: roleOf(raw, flattened),
      kind: kindOf(raw, flattened),
    },
    redacted: safe.redacted,
  };
}

export function parseTranscript(path: string, rawText: string): Transcript {
  let redacted = false;
  const entries = rawText.split("\n").flatMap((line, index): TranscriptEntry[] => {
    const parsed = parseTranscriptLine(line, index + 1);
    if (parsed.redacted) redacted = true;
    return parsed.entry ? [parsed.entry] : [];
  });

  return { ...sessionMetaFromPath(path), path, entries, redacted };
}

export function queryTerms(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 2);
}

export function lowercaseText(text: string): string {
  // Lowercase ASCII payloads need no full-size case-conversion allocation.
  return /[A-Z]|[^\x00-\x7f]/u.test(text) ? text.toLowerCase() : text;
}

/** Reuse a caller's folded text instead of allocating it again for direct hits. */
export function matchesLowerQuery(lower: string, query: string): boolean {
  const exact = query.toLowerCase().trim();
  if (exact && lower.includes(exact)) return true;
  const terms = queryTerms(query);
  return terms.length > 0 && terms.every((term) => lower.includes(term));
}

export function matchesQuery(text: string, query: string): boolean {
  return matchesLowerQuery(lowercaseText(text), query);
}

export function evidence(entry: TranscriptEntry): Evidence {
  return {
    line: entry.line,
    role: entry.role,
    kind: entry.kind,
    text: detachedText(entry.text.slice(0, 600)),
    ...(entry.truncated ? { truncated: true } : {}),
  };
}

function uniqueEvidence(entries: readonly TranscriptEntry[], limit: number): readonly Evidence[] {
  const seen = new Set<number>();
  const output: Evidence[] = [];
  for (const entry of entries) {
    if (seen.has(entry.line) || !entry.text) continue;
    seen.add(entry.line);
    output.push(evidence(entry));
    if (output.length >= limit) break;
  }
  return output;
}

function regexEntries(
  entries: readonly TranscriptEntry[],
  regex: RegExp,
  limit: number,
): readonly Evidence[] {
  return uniqueEvidence(
    entries.filter((entry) => regex.test(entry.text)),
    limit,
  );
}

function extractFiles(entries: readonly TranscriptEntry[]): readonly string[] {
  const files = new Set<string>();
  const pattern =
    /(?:\.{0,2}\/|~\/|\/Users\/|packages\/|apps\/|docs\/|skills\/|scripts\/)[A-Za-z0-9._/@:+-]+/gu;
  for (const entry of entries) {
    for (const match of entry.text.matchAll(pattern)) files.add(detachedText(match[0]));
    if (files.size >= 80) break;
  }
  return [...files].slice(0, 80);
}

export function inspectTranscript(
  transcript: Transcript,
  around: string,
  before: number,
  after: number,
): InspectResult {
  const regex = new RegExp(around, "iu");
  const matches = transcript.entries
    .flatMap((entry, index): InspectMatch[] => {
      if (!regex.test(entry.text)) return [];
      const start = Math.max(0, index - before);
      const end = Math.min(transcript.entries.length - 1, index + after);
      return [
        {
          matchLine: entry.line,
          startLine: transcript.entries[start]?.line ?? entry.line,
          endLine: transcript.entries[end]?.line ?? entry.line,
          entries: transcript.entries.slice(start, end + 1).map(evidence),
        },
      ];
    })
    .slice(0, 8);

  return {
    sessionId: transcript.sessionId,
    startedAt: transcript.startedAt,
    cwdKey: transcript.cwdKey,
    path: transcript.path,
    around,
    matches,
    redacted: transcript.redacted,
    ...(transcript.truncated ? { truncated: true, truncationReason: transcript.truncationReason } : {}),
  };
}

export function extractTranscript(transcript: Transcript, query: string): Extraction {
  const matchedIndexes = new Set<number>();
  transcript.entries.forEach((entry, index) => {
    if (!matchesQuery(entry.text, query)) return;
    for (
      let cursor = Math.max(0, index - 4);
      cursor <= Math.min(transcript.entries.length - 1, index + 10);
      cursor += 1
    ) {
      matchedIndexes.add(cursor);
    }
  });

  const relevant = [...matchedIndexes]
    .sort((a, b) => a - b)
    .map((index) => transcript.entries[index]);
  const fallback = relevant.length > 0 ? relevant : transcript.entries.slice(0, 80);
  const command =
    /\b(bun|pnpm|npm|yarn|git|ssh|scp|rsync|kubectl|curl|joelclaw|python3?|node|jq|rg|find|ls|cat|sed|awk)\b[^\n]{0,500}/iu;
  const decision =
    /\b(decid(?:e|ed|ing)|decision|ADR|accepted|rejected|instead|tradeoff|root cause|because)\b/iu;
  const output =
    /\b(receipt|output|result|returned|status|commit|run id|eventId|verified|passed|failed|error)\b/iu;
  const verification =
    /\b(test|check|verify|verified|passes|passed|build|tsc|biome|lint|smoke)\b/iu;
  const blocker =
    /\b(blocked|blocker|fail(?:ed|ing)?|error|missing|unavailable|timeout|denied|cannot|can't|stuck)\b/iu;
  const next = /\b(next action|next step|TODO|follow[- ]?up|remaining|blocker|handoff)\b/iu;

  return {
    sessionId: transcript.sessionId,
    startedAt: transcript.startedAt,
    cwdKey: transcript.cwdKey,
    path: transcript.path,
    query,
    lineCount: transcript.entries.length,
    evidence: uniqueEvidence(fallback, 16),
    userPrompts: uniqueEvidence(
      transcript.entries.filter(
        (entry) =>
          entry.role === "user" && (matchesQuery(entry.text, query) || relevant.includes(entry)),
      ),
      10,
    ),
    decisions: regexEntries(fallback, decision, 12),
    commandsRun: regexEntries(fallback, command, 16),
    filesTouched: extractFiles(fallback),
    outputsReceipts: regexEntries(fallback, output, 12),
    verification: regexEntries(fallback, verification, 12),
    blockers: regexEntries(fallback, blocker, 12),
    nextActions: regexEntries(fallback, next, 10),
    redacted: transcript.redacted,
    ...(transcript.truncated ? { truncated: true, truncationReason: transcript.truncationReason } : {}),
  };
}
