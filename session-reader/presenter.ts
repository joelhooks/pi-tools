import { Schema } from "effect";
import type { Evidence, Extraction, InspectResult, LocalSessionHit } from "./domain.ts";
import { compactText } from "./domain.ts";
import type { JoelclawResult } from "./joelclaw-index.ts";
import type { CaptureFileStatus } from "./session-store.ts";

export const MAX_TOOL_TEXT_CHARS = 24_000;
const ENTRY_PREVIEW_CHARS = 360;

export const ToolPayloadSchema = Schema.Struct({
  text: Schema.String,
  details: Schema.Record(Schema.String, Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
});
export interface ToolPayload extends Schema.Schema.Type<typeof ToolPayloadSchema> {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function capText(value: string, maxChars = MAX_TOOL_TEXT_CHARS): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  const notice = "\n\n[Output capped. Use a narrower query or smaller context values.]";
  if (notice.length >= maxChars) return notice.slice(0, maxChars);
  const sliceEnd = maxChars - notice.length;
  const lineBreak = value.lastIndexOf("\n", sliceEnd);
  return `${value.slice(0, lineBreak > 0 ? lineBreak : sliceEnd)}${notice}`;
}

function evidenceLine(item: Evidence): string {
  return `- L${item.line}${item.role ? ` ${item.role}` : ""}${item.kind ? `/${item.kind}` : ""}: ${item.text}`;
}

export function renderExtraction(extraction: Extraction): string {
  const section = (title: string, items: readonly Evidence[]) =>
    [`## ${title}`, ...(items.length > 0 ? items.map(evidenceLine) : ["- none found"]), ""].join(
      "\n",
    );

  return capText(
    [
      "# Session extraction",
      `- session: ${extraction.sessionId ?? "unknown"}`,
      `- path: ${extraction.path}`,
      `- started: ${extraction.startedAt ?? "unknown"}`,
      `- cwd: ${extraction.cwdKey ?? "unknown"}`,
      `- query: ${compactText(extraction.query, ENTRY_PREVIEW_CHARS) ?? ""}`,
      `- lines: ${extraction.lineCount}`,
      `- redacted: ${extraction.redacted}`,
      "",
      section("User prompts", extraction.userPrompts),
      section("Decisions", extraction.decisions),
      section("Commands run", extraction.commandsRun),
      `## Files touched\n${extraction.filesTouched.length > 0 ? extraction.filesTouched.map((file) => `- ${file}`).join("\n") : "- none found"}\n`,
      section("Outputs / receipts", extraction.outputsReceipts),
      section("Verification", extraction.verification),
      section("Blockers", extraction.blockers),
      section("Next actions", extraction.nextActions),
      section("Evidence", extraction.evidence),
    ].join("\n"),
  );
}

export function renderInspect(result: InspectResult, maxChars = MAX_TOOL_TEXT_CHARS): string {
  const matches = result.matches;
  const matchLines = new Set(matches.map((match) => match.matchLine));
  const contextByLine = new Map<number, Evidence>();
  for (const match of matches) {
    for (const entry of match.entries) {
      if (!matchLines.has(entry.line) && !contextByLine.has(entry.line))
        contextByLine.set(entry.line, entry);
    }
  }

  const lines = [
    "# Session inspect",
    "Local Effect engine output. Overlapping windows are deduplicated.",
    `- session: ${result.sessionId ?? "unknown"}`,
    `- path: ${result.path}`,
    `- regex: ${compactText(result.around, ENTRY_PREVIEW_CHARS) ?? ""}`,
    `- matches: ${matches.length}`,
    `- redacted: ${result.redacted}`,
    "",
    "## Direct matches",
  ];

  if (matches.length === 0) lines.push("- none found");
  for (const match of matches) {
    const direct = match.entries.find((entry) => entry.line === match.matchLine);
    lines.push(
      `- L${match.matchLine}${direct?.kind ? ` ${direct.kind}` : ""} · window L${match.startLine}-L${match.endLine}: ${compactText(direct?.text, ENTRY_PREVIEW_CHARS) ?? "match text unavailable"}`,
    );
  }

  lines.push("", "## Deduplicated context");
  const context = [...contextByLine.values()].sort((left, right) => left.line - right.line);
  if (context.length === 0) lines.push("- none");
  for (const entry of context) {
    lines.push(
      `- L${entry.line}${entry.kind ? ` ${entry.kind}` : ""}: ${compactText(entry.text, ENTRY_PREVIEW_CHARS) ?? ""}`,
    );
  }
  return capText(lines.join("\n"), maxChars);
}

export function inspectDetails(result: InspectResult): Record<string, unknown> {
  return {
    sessionId: result.sessionId,
    startedAt: result.startedAt,
    cwdKey: result.cwdKey,
    path: result.path,
    around: compactText(result.around, ENTRY_PREVIEW_CHARS),
    redacted: result.redacted,
    matches: result.matches.map((match) => ({
      matchLine: match.matchLine,
      startLine: match.startLine,
      endLine: match.endLine,
      entryCount: match.entries.length,
    })),
  };
}

export function renderLocalHits(hits: readonly LocalSessionHit[]): string {
  if (hits.length === 0) return "No local transcript matches found.";
  return hits
    .map((hit, index) =>
      [
        `## ${index + 1}. ${hit.agent} ${hit.sessionId ?? "unknown"}`,
        `Path: ${hit.path}`,
        `Modified: ${hit.mtime}`,
        `Score: ${hit.score}`,
        ...hit.snippets.map((snippet) => `- ${snippet}`),
      ].join("\n"),
    )
    .join("\n\n");
}

export function renderCaptureState(files: readonly CaptureFileStatus[]): string {
  return files
    .map((file) => {
      if (!file.present) return `- ${file.label}: missing (${file.path})`;
      return `- ${file.label}: present, modified ${file.modified ?? "unknown"} (${file.path})${file.tail ? `\n  ${file.tail}` : ""}`;
    })
    .join("\n");
}

function remoteResult(result: JoelclawResult): unknown {
  if (!isRecord(result.json)) return undefined;
  return result.json.result;
}

export function renderRemote(result: JoelclawResult): string {
  if (!result.ok) {
    return capText(
      [
        "joelclaw index adapter failed.",
        `Command: ${result.command}`,
        result.exitCode !== null ? `Exit code: ${result.exitCode}` : "",
        result.error ? `Error: ${result.error}` : "",
        result.stderr ? `Stderr: ${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      8_000,
    );
  }

  const value = remoteResult(result);
  if (isRecord(value) && typeof value.markdown === "string") return capText(value.markdown, 12_000);
  return capText(JSON.stringify(value ?? { ok: true }, null, 2), 12_000);
}

export function remoteDetails(result: JoelclawResult): Record<string, unknown> {
  const value = remoteResult(result);
  const record = isRecord(value) ? value : {};
  const hits = Array.isArray(record.hits) ? record.hits : [];
  return {
    ok: result.ok,
    command: result.command,
    exitCode: result.exitCode,
    error: result.error,
    stderr: result.stderr,
    hitCount: hits.length,
    local: isRecord(record.local)
      ? {
          found: record.local.found,
          rawReturned: record.local.rawReturned,
          emittedHits: record.local.emittedHits,
          emittedChunks: record.local.emittedChunks,
          searchedFiles: record.local.searchedFiles,
        }
      : undefined,
  };
}
