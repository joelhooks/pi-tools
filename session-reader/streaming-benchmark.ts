/** Synthetic only. Run via streaming.test.ts with SESSION_READER_LARGE_TEST=1. */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { compactText, inspectTranscript, matchesQuery, parseTranscriptLine, queryTerms, type TranscriptEntry } from "./domain.ts";
import { scanJsonlLines, scanJsonlSessionFile } from "./session-store.ts";
import { createSessionAdapters } from "./adapters.ts";
import { SessionOperation } from "./engine.ts";
import { runSessionActor } from "./machine.ts";
import { inspectJsonl, extractJsonl } from "./streaming.ts";
import { renderExpansion, renderInspect, renderExtraction, renderLocalHits } from "./presenter.ts";
import { readJsonlPage } from "./jsonl-page.ts";

const [mode, path] = process.argv.slice(2);
if (!path || !["baseline-inspect", "baseline-search", "inspect", "search", "extract", "expand", "search-small-before", "search-small-after", "search-batch"].includes(mode)) {
  throw new Error("Expected a benchmark mode and synthetic fixture path");
}
const signal = new AbortController().signal;
const file = { agent: "pi" as const, path, mtimeMs: 0, mtime: new Date(0).toISOString() };
const query = "synthetic-needle";
const start = performance.now();
const cpuStart = process.cpuUsage();
let answer: unknown;
let found = false;
let truncated = false;
const wallSamples: number[] = [];
if (mode.startsWith("search-small-") || mode === "search-batch") {
  const runs = mode.startsWith("search-small-") ? 5 : 1;
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    if (mode === "search-small-before") {
      // Control: original eight-way readline search, same parser and discovery.
      const adapter = createSessionAdapters({ home: path }).find((adapter) => adapter.runtime === "pi")!;
      const files = [];
      for await (const file of adapter.discover({ maxFiles: 8, signal })) files.push(file);
      const hits = await Promise.all(files.map(async (file) => {
        const stream = createReadStream(file.path, { encoding: "utf8" });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try { return await scanJsonlLines({ file, query, terms: queryTerms(query), lines, signal }); }
        finally { lines.close(); stream.destroy(); }
      }));
      const present = hits.filter((hit) => hit !== undefined);
      found = present.length === 8;
      answer = renderLocalHits(present);
    } else {
      const outcome = await runSessionActor(SessionOperation.Search({ query, agent: "pi", source: "local", machine: "local", limit: 8, maxFiles: 8, cwd: path, extract: false }), signal);
      if (outcome.status !== "succeeded") throw new Error("Batch search failed");
      found = (outcome.result.details.localHits as unknown[]).length === 8;
      truncated = Number(outcome.result.details.truncatedFiles) > 0;
      answer = outcome.result.text;
    }
    wallSamples.push(performance.now() - started);
  }
} else if (mode === "baseline-inspect") {
  // The previous implementation: readline capped neither the line nor entries[].
  const entries: TranscriptEntry[] = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    const parsed = parseTranscriptLine(line, ++lineNumber);
    if (parsed.entry) entries.push(parsed.entry);
  }
  const result = inspectTranscript({ path, entries, redacted: false }, query, 20, 80);
  found = result.matches.length > 0;
  answer = renderInspect(result);
} else if (mode === "baseline-search") {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    const snippets: string[] = [];
    let number = 0;
    for await (const line of lines) {
      const entry = parseTranscriptLine(line, ++number).entry;
      if (entry && matchesQuery(entry.text, query)) {
        snippets.push(compactText(entry.text, 320) ?? entry.text.slice(0, 320));
        if (snippets.length === 3) break;
      }
    }
    found = snippets.length > 0;
    answer = { snippets };
  } finally {
    lines.close();
    stream.destroy();
  }
} else if (mode === "inspect") {
  const result = await inspectJsonl(path, query, 20, 80, signal);
  found = result.matches.length > 0;
  truncated = result.truncated ?? false;
  answer = renderInspect(result);
} else if (mode === "search") {
  const result = await scanJsonlSessionFile(file, query, queryTerms(query), signal);
  found = result !== undefined;
  truncated = result?.truncated ?? false;
  answer = result;
} else if (mode === "expand") {
  const page = await readJsonlPage(path, undefined, "backward", 10, signal);
  found = page.transcript.entries.some((entry) => entry.text.includes(query));
  truncated = page.transcript.truncated ?? false;
  answer = renderExpansion({ ...page.transcript, direction: "backward", offset: page.start, totalEntries: page.totalEntries, entries: page.transcript.entries });
} else {
  const result = await extractJsonl(path, query, signal);
  found = result.evidence.some((entry) => entry.text.includes(query));
  truncated = result.truncated ?? false;
  answer = renderExtraction(result);
}
const serialized = JSON.stringify(answer ?? null);
const cpu = process.cpuUsage(cpuStart);
console.log(JSON.stringify({
  mode, milliseconds: Math.round(wallSamples.length ? [...wallSamples].sort((a, b) => a - b)[Math.floor(wallSamples.length / 2)] : performance.now() - start),
  runs: wallSamples.length || 1, wallSamplesMilliseconds: wallSamples.map((value) => Math.round(value)),
  maxRssKiB: process.resourceUsage().maxRSS, answerBytes: Buffer.byteLength(serialized),
  cpuMilliseconds: Math.round((cpu.user + cpu.system) / 1000 / (wallSamples.length || 1)),
  found, truncated,
}));
