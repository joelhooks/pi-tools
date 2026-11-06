import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { compactText, evidence, extractTranscript, inspectTranscript, lowercaseText, parseTranscript, parseTranscriptLine, queryTerms, redactUnknown } from "./domain.ts";
import { MAX_JSONL_LINE_BYTES, JSONL_PREFIX_BYTES, scanJsonl } from "./jsonl.ts";
import { readJsonlPage } from "./jsonl-page.ts";
import { parseJsonlLine } from "./jsonl-entry.ts";
import { createSessionAdapters, readRedactedTail } from "./adapters.ts";
import { extractJsonl, inspectJsonl, readBoundedJsonl } from "./streaming.ts";
import { LARGE_SEARCH_FILE_BYTES, scanJsonlSessionFile, searchFileBatches } from "./session-store.ts";
import { renderExpansion, renderExtraction, renderInspect } from "./presenter.ts";
import { SessionOperation } from "./engine.ts";
import { runSessionActor } from "./machine.ts";

async function collect<A>(input: AsyncIterable<A>): Promise<A[]> {
  const values: A[] = [];
  for await (const value of input) values.push(value);
  return values;
}

const signal = () => new AbortController().signal;
const exec = promisify(execFile);
const record = (text: string, role = "assistant") => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
const redactionKey = ["sk", "-", "1234".repeat(8)].join("");
const payload = (bytes: number) => "sample payload ".repeat(Math.ceil(bytes / 15)).slice(0, bytes);
async function fixture(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(process.env.SESSION_READER_TEST_TMPDIR ?? tmpdir(), "session-stream-"));
  try { await run(join(directory, "synthetic.jsonl")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

// No private transcript data: every record in this suite is generated here.
test("streamed inspection and extraction preserve normal-file semantics", async () => fixture(async (path) => {
  const lines = Array.from({ length: 240 }, (_, index) => index % 13 === 0 ? "" : record(
    `${index} ${index % 17 === 0 ? "needle" : "ordinary"} ${[
      "decided because scripts/task.ts", "npm test passed", "TODO next step", "error missing receipt", "ordinary text",
    ][index % 5]}`, index % 3 === 0 ? "user" : "assistant"));
  lines.splice(37, 0, "plain text needle", "{malformed", record("token=" + redactionKey),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Claude needle decided npm test passed" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex needle TODO next step" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "shell", input: "needle npm test passed" } }),
    JSON.stringify({ type: "compaction", summary: "needle accepted because tests passed" }));
  const raw = lines.join("\r\n");
  await writeFile(path, raw);
  const transcript = parseTranscript(path, raw);
  assert.equal(transcript.redacted, true);
  assert.ok(transcript.entries.every((entry) => !entry.text.includes(redactionKey)));
  assert.ok(transcript.entries.some((entry) => entry.text.includes("[REDACTED]")));
  for (const query of ["needle", "ordinary text", "absent", ""]) {
    assert.deepEqual(await extractJsonl(path, query, signal()), extractTranscript(transcript, query));
  }
  for (const around of ["needle", "absent", "", "ordinary|needle"]) {
    for (const [before, after] of [[0, 0], [2, 3], [100, 100], [50, 200]]) {
      assert.deepEqual(await inspectJsonl(path, around, before, after, signal()), inspectTranscript(transcript, around, before, after));
    }
  }
}));

test("flattening preserves whitespace normalization, empty known keys and UTF-16 preview text", () => {
  assert.equal(parseTranscriptLine(record("a\t b\n c\r\n d\u00a0e"), 1).entry!.text, "message assistant text a b c d e");
  assert.equal(parseTranscriptLine(JSON.stringify({ type: "", hidden: "not evidence" }), 1).entry!.text, "");
  assert.equal(parseTranscriptLine(JSON.stringify({ type: "message", summary: false, message: { role: "assistant", content: "evidence" } }), 1).entry!.text, "message assistant evidence");
  assert.equal(parseTranscriptLine(JSON.stringify({ events: [{ description: "a" }, { description: "b" }], hidden: "c" }), 1).entry!.text, "a b c");
  for (const value of ["lowercase payload", "MIXED Case", "CAFÉ", "𐐀", "😀"]) {
    assert.equal(lowercaseText(value), value.toLowerCase());
  }
  const text = "a".repeat(599) + "😀" + "z";
  assert.equal(evidence({ line: 1, raw: undefined, text }).text, text.slice(0, 600));
  assert.equal(compactText(text, 601), text.slice(0, 600) + "…");
});

test("prefix redaction reuses unchanged values and reports nested changes without serializing", () => {
  const unchanged = { type: "message", content: ["ordinary text", { text: "evidence" }] };
  assert.equal(redactUnknown(unchanged), unchanged);
  const secret = { content: [{ token: redactionKey }, "ordinary text"] };
  assert.deepEqual(redactUnknown(secret), { content: [{ token: "[REDACTED]" }, "ordinary text"] });
  assert.equal(secret.content[0] && typeof secret.content[0] === "object" && secret.content[0].token, redactionKey);
  for (const text of [record("prefix evidence"), JSON.stringify(secret), '"plain string"', '["plain array"]', "1234,"]) {
    const parsed = parseJsonlLine({ line: 7, offset: 0, text, truncated: true });
    assert.equal(parsed.entry?.truncated, true);
    assert.equal(parsed.entry?.line, 7);
    assert.equal(parsed.entry?.raw, undefined);
    assert.equal(parsed.redacted, text === JSON.stringify(secret));
    if (text === record("prefix evidence")) assert.equal(parsed.entry?.text, parseTranscriptLine(text, 7).entry?.text);
    if (text.startsWith('"') || text.startsWith("[")) assert.equal(parsed.entry?.text, text);
    assert.ok(!parsed.entry?.text.includes(redactionKey));
  }
});

test("byte scanner caps unterminated lines and preserves UTF-8, CRLF, offsets and line numbers", async () => fixture(async (path) => {
  const first = `${"x".repeat(65535)}é`;
  const huge = "x".repeat(MAX_JSONL_LINE_BYTES + 1);
  const raw = `${first}\r\n\n${huge}\nlast`;
  await writeFile(path, raw);
  const lines = await collect(scanJsonl(path, signal()));
  assert.deepEqual(lines.map(({ line, text, truncated }) => ({ line, text, truncated })), [
    { line: 1, text: first, truncated: false }, { line: 2, text: "", truncated: false },
    { line: 3, text: huge.slice(0, JSONL_PREFIX_BYTES), truncated: true }, { line: 4, text: "last", truncated: false },
  ]);
  assert.deepEqual(lines.map((line) => line.offset), [0, Buffer.byteLength(first) + 2, Buffer.byteLength(first) + 3, Buffer.byteLength(first) + 4 + huge.length]);
  await writeFile(path, huge);
  const unterminated = await collect(scanJsonl(path, signal()));
  assert.equal(unterminated.length, 1);
  assert.equal(unterminated[0].truncated, true);
  assert.equal(unterminated[0].text, huge.slice(0, JSONL_PREFIX_BYTES));
  await writeFile(path, "z".repeat(MAX_JSONL_LINE_BYTES));
  assert.equal((await collect(scanJsonl(path, signal())))[0].truncated, false);
}));

test("oversized JSONL prefixes stay searchable and carry per-entry truncation",  async () => fixture(async (path) => {
  await writeFile(path, [record("before"), record("hidden needle " + payload(MAX_JSONL_LINE_BYTES)), record("needle", "user"), "", record("after")].join("\n"));
  const inspected = await inspectJsonl(path, "needle", 1, 1, signal());
  assert.equal(inspected.truncated, true);
  assert.deepEqual(inspected.matches.map((match) => match.matchLine), [2, 3]);
  assert.deepEqual(inspected.matches[0].entries.map((entry) => entry.line), [1, 2, 3]);
  assert.equal(inspected.matches[0].entries[1].truncated, true);
  assert.ok(inspected.matches.every((match) => match.entries.every((entry) => entry.text.length <= 600)));
  assert.match(renderInspect(inspected), /L2.*truncated prefix/);
  assert.match(renderInspect(inspected), /Truncated/);
  const extracted = await extractJsonl(path, "needle", signal());
  assert.equal(extracted.truncated, true);
  assert.equal(extracted.lineCount, 4);
  assert.equal(extracted.evidence.find((entry) => entry.line === 2)?.truncated, true);
  assert.match(renderExtraction(extracted), /Truncated/);
  const file = { path, agent: "pi" as const, mtimeMs: 0, mtime: new Date(0).toISOString() };
  const hit = await scanJsonlSessionFile(file, "needle", queryTerms("needle"), signal());
  assert.equal(hit?.truncated, true);
  assert.match(hit!.snippets.join(" "), /Truncated/);
  assert.match(hit!.snippets.join(" "), /L2 \[truncated prefix\]/);
  const outcome = await runSessionActor(SessionOperation.Inspect({ sessionId: path, around: "needle", before: 1, after: 1 }), signal());
  assert.equal(outcome.status, "succeeded");
  if (outcome.status === "succeeded") assert.match(outcome.result.text, /Truncated/);
}));

test("compaction summaries and large Claude/Codex records are decoded beyond the prefix tier", async () => fixture(async (path) => {
  const text = payload(350 * 1024) + " retained-summary-needle";
  const raw = [
    JSON.stringify({ type: "compaction", summary: text }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }),
  ].join("\n");
  await writeFile(path, raw);
  const full = parseTranscript(path, raw);
  const inspected = await inspectJsonl(path, "retained-summary-needle", 0, 0, signal());
  assert.deepEqual(inspected.matches.map((match) => match.matchLine), [1, 2, 3]);
  assert.equal(inspected.truncated, undefined);
  assert.deepEqual(inspected, inspectTranscript(full, "retained-summary-needle", 0, 0));
  assert.deepEqual(await extractJsonl(path, "retained-summary-needle", signal()), extractTranscript(full, "retained-summary-needle"));
  const hit = await scanJsonlSessionFile({ path, agent: "claude", mtimeMs: 0, mtime: new Date(0).toISOString() }, "retained-summary-needle", queryTerms("retained-summary-needle"), signal());
  assert.ok(hit);
  assert.equal(hit.truncated, undefined);
}));

test("partial JSON prefixes unescape content, redact keys, and tolerate incomplete escapes and keys", () => {
  const prefix = '{"type":"message","token":"never-expose","message":{"role":"assistant","content":[{"type":"text","text":"early \\u006eeedle\\nline \\u12';
  const parsed = parseJsonlLine({ line: 41, offset: 0, truncated: true, text: prefix });
  assert.equal(parsed.entry?.line, 41);
  assert.equal(parsed.entry?.truncated, true);
  assert.match(parsed.entry!.text, /early needle line/);
  assert.doesNotMatch(parsed.entry!.text, /never-expose/);
  assert.equal(parsed.redacted, true);
  const key = parseJsonlLine({ line: 42, offset: 0, truncated: true, text: '{"type":"compaction","summary":"kept needle","unfinished' });
  assert.match(key.entry!.text, /kept needle/);
  for (const inner of [
    String.raw`{"secret":"never-expose \\"quoted\\" unfinished`,
    '{"secret":"completed","text":"kept-needle"',
  ]) {
    const encoded = record(inner);
    const nested = parseJsonlLine({ line: 43, offset: 0, truncated: true, text: encoded.slice(0, encoded.lastIndexOf('"')) });
    assert.equal(nested.redacted, true);
    assert.doesNotMatch(nested.entry!.text, /never-expose|completed/);
    if (inner.includes("kept-needle")) assert.match(nested.entry!.text, /kept-needle/);
  }
});

test("expansion emits an explicit prefix notice, item marker, and physical line number", async () => fixture(async (path) => {
  await writeFile(path, ["", record("prefix-needle " + payload(MAX_JSONL_LINE_BYTES)), record("last")].join("\n"));
  const outcome = await runSessionActor(SessionOperation.Expand({ sessionId: path, direction: "forward", limit: 2 }), signal());
  assert.equal(outcome.status, "succeeded");
  if (outcome.status === "succeeded") {
    assert.equal(outcome.result.details.truncated, true);
    assert.match(outcome.result.text, /matches beyond that prefix may be missed/);
    assert.match(outcome.result.text, /L2.*truncated prefix.*prefix-needle/);
  }
  await writeFile(path, record(payload(JSONL_PREFIX_BYTES + 1024) + " beyond-prefix-needle " + payload(MAX_JSONL_LINE_BYTES)));
  const late = await inspectJsonl(path, "beyond-prefix-needle", 0, 0, signal());
  assert.equal(late.matches.length, 0);
  assert.equal(late.truncated, true);
}));

test("unknown non-JSONL adapter paths disclose bounded legacy prefixes", async () => fixture(async (path) => {
  const unknown = join(dirname(path), "synthetic.txt");
  await writeFile(unknown, Array.from({ length: 2100 }, (_, index) => record(index === 2099 ? "late-needle" : "ordinary")).join("\n"));
  for (const operation of [
    SessionOperation.Inspect({ sessionId: unknown, around: "late-needle", before: 1, after: 1 }),
    SessionOperation.Extract({ sessionId: unknown, query: "late-needle" }),
    SessionOperation.Expand({ sessionId: unknown, direction: "forward", limit: 1 }),
  ]) {
    const outcome = await runSessionActor(operation, signal());
    assert.equal(outcome.status, "succeeded");
    if (outcome.status === "succeeded") {
      assert.match(outcome.result.text, /Truncated: legacy adapter transcript prefix/);
      const details = outcome.result.details.result ?? outcome.result.details;
      assert.equal((details as { truncated: boolean }).truncated, true);
    }
  }
}));

test("search and chunks actors report truncation for hit and no-hit scans in an isolated home", async () => fixture(async (path) => {
  const home = dirname(path);
  const root = join(home, ".pi/agent/sessions");
  const grokRoot = join(home, ".grok/sessions");
  await mkdir(root, { recursive: true });
  await mkdir(grokRoot, { recursive: true });
  const grokLegacy = join(grokRoot, "synthetic-history.txt");
  await writeFile(grokLegacy, Array.from({ length: 2100 }, (_, index) => record(index === 2099 ? "late-grok-needle" : "ordinary")).join("\n"));
  await writeFile(join(root, "synthetic.jsonl"), [record(payload(MAX_JSONL_LINE_BYTES + 1)), record("needle")].join("\n"));
  const script = `
    const { SessionOperation } = await import(${JSON.stringify(new URL("./engine.ts", import.meta.url).href)});
    const { runSessionActor } = await import(${JSON.stringify(new URL("./machine.ts", import.meta.url).href)});
    const results = [];
    for (const query of ["needle", "notfound"]) {
      for (const operation of [
        SessionOperation.Search({ query, agent: "pi", source: "local", machine: "local", limit: 1, maxFiles: 10, cwd: process.env.HOME, extract: false }),
        SessionOperation.Chunks({ query, source: "local", machine: "local", limit: 1, maxFiles: 10, cwd: process.env.HOME, contextBefore: 1, contextAfter: 1, excludeCurrent: false, warnings: [] }),
      ]) results.push(await runSessionActor(operation, new AbortController().signal));
    }
    results.push(await runSessionActor(SessionOperation.Inspect({ sessionId: ${JSON.stringify(grokLegacy)}, around: "late-grok-needle", before: 0, after: 0 }), new AbortController().signal));
    console.log(JSON.stringify(results));
  `;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, GROK_HOME: join(home, ".grok") }, maxBuffer: 64 * 1024,
  });
  const outcomes = JSON.parse(stdout);
  assert.equal(outcomes.length, 5);
  for (const outcome of outcomes.slice(0, 4)) {
    assert.equal(outcome.status, "succeeded");
    assert.match(outcome.result.text, /Truncated/);
    assert.equal(outcome.result.details.truncatedFiles, 1);
  }
  assert.equal(outcomes[0].result.details.localHits.length, 1);
  assert.equal(outcomes[2].result.details.localHits.length, 0);
  assert.equal(outcomes[3].result.details.shown, 0);
  assert.equal(outcomes[4].status, "succeeded");
  assert.equal(outcomes[4].result.details.result.matches.length, 0);
  assert.match(outcomes[4].result.text, /Truncated: legacy adapter transcript prefix/);
}));

test("Cursor preserves large metadata, blobs and output beyond the former 2 MiB cap", async () => fixture(async (path) => {
  const adapter = createSessionAdapters({ home: dirname(path) }).find((entry) => entry.runtime === "cursor")!;
  const locator = { path, agent: "cursor" as const, mtimeMs: 0, mtime: new Date(0).toISOString() };
  await writeFile(path, JSON.stringify({ agentId: "synthetic-session", padding: payload(350 * 1024) }));
  const database = new DatabaseSync(join(dirname(path), "store.db"));
  try {
    database.exec("CREATE TABLE blobs (data BLOB)");
    const insert = database.prepare("INSERT INTO blobs (data) VALUES (?)");
    for (let index = 0; index < 4; index++) {
      insert.run(Buffer.from(JSON.stringify({ id: `synthetic-${index}`, role: "assistant", content: payload(600 * 1024) + ` needle-${index}` })));
    }
  } finally { database.close(); }
  const result = await adapter.read(locator, signal());
  assert.equal(result.sessionId, "synthetic-session");
  assert.equal(result.entries.length, 4);
  assert.ok(result.entries[3].text.includes("needle-3"));
  assert.equal(result.truncated, undefined);
}));

test("JSONL byte caps accept overrides and warn once with default fallback on bad settings", async () => {
  const script = `const { MAX_JSONL_LINE_BYTES, JSONL_PREFIX_BYTES } = await import(${JSON.stringify(new URL("./jsonl.ts", import.meta.url).href)}); console.log(JSON.stringify([MAX_JSONL_LINE_BYTES, JSONL_PREFIX_BYTES]));`;
  const env = { ...process.env, SESSION_READER_JSONL_DECODE_BYTES: "4096", SESSION_READER_JSONL_PREFIX_BYTES: "1024" };
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], { env });
  assert.deepEqual(JSON.parse(stdout), [4096, 1024]);
  for (const invalid of [
    { ...env, SESSION_READER_JSONL_PREFIX_BYTES: "8192" },
    { ...env, SESSION_READER_JSONL_DECODE_BYTES: "not-a-number" },
    { ...env, SESSION_READER_JSONL_PREFIX_BYTES: "-1" },
  ]) {
    const { stdout, stderr } = await exec(process.execPath, ["--input-type=module", "-e", script + ` await import(${JSON.stringify(new URL("./jsonl.ts", import.meta.url).href)});`], { env: invalid });
    assert.deepEqual(JSON.parse(stdout), [2 * 1024 * 1024, 256 * 1024]);
    assert.equal(stderr.trim().split("\n").length, 1);
    assert.match(stderr, /invalid JSONL byte caps; using/);
    assert.doesNotMatch(stderr, /not-a-number/);
  }
});

test("search keeps eight small files parallel and isolates large/unknown-size files", () => {
  const files = Array.from({ length: 8 }, (_, index) => ({ file: { path: `synthetic-${index}.jsonl`, agent: "pi" as const, mtimeMs: 0, mtime: new Date(0).toISOString() }, size: 1024 }));
  assert.deepEqual(searchFileBatches(files).map((batch) => batch.length), [8]);
  files[2].size = LARGE_SEARCH_FILE_BYTES + 1;
  files[5].size = Infinity;
  assert.deepEqual(searchFileBatches(files).map((batch) => batch.length), [2, 1, 2, 1, 2]);
});

test("oversized plain-text prefixes remain searchable and redact runtime-built credentials", async () => fixture(async (path) => {
  await writeFile(path, `plain-prefix-needle token=${redactionKey} ${payload(MAX_JSONL_LINE_BYTES + 1)}`);
  const result = await inspectJsonl(path, "plain-prefix-needle", 0, 0, signal());
  assert.equal(result.matches.length, 1);
  assert.equal(result.redacted, true);
  assert.equal(result.matches[0].entries[0].truncated, true);
  assert.doesNotMatch(result.matches[0].entries[0].text, new RegExp(redactionKey));
  assert.match(result.matches[0].entries[0].text, /\[REDACTED\]/);
  const cut = parseJsonlLine({ line: 1, offset: 0, truncated: true, text: '{"amount":1234' });
  assert.equal(cut.entry!.text, "");
  const delimited = parseJsonlLine({ line: 1, offset: 0, truncated: true, text: '{"amount":1234,' });
  assert.equal(delimited.entry!.text, "1234");
}));

test("capture tails honor caller byte windows above 64 KiB", async () => fixture(async (path) => {
  await writeFile(path, record("tail-window-marker " + payload(100 * 1024)));
  assert.match(await readRedactedTail(path, signal(), 128 * 1024), /tail-window-marker/);
  assert.doesNotMatch(await readRedactedTail(path, signal(), 64 * 1024), /tail-window-marker/);
}));

test("scanner closes on early return and honors cancellation before and during IO", async () => fixture(async (path) => {
  await writeFile(path, `${record("first")}\n${"x".repeat(MAX_JSONL_LINE_BYTES * 4)}`);
  const controller = new AbortController();
  const iterator = scanJsonl(path, controller.signal);
  assert.equal((await iterator.next()).value?.line, 1);
  controller.abort();
  await assert.rejects(iterator.next(), /abort/i);
  await assert.rejects(collect(scanJsonl(path, controller.signal)), /abort/i);
  const early = scanJsonl(path, signal());
  await early.next();
  await early.return(undefined);
  assert.equal((await early.next()).done, true);
  await assert.rejects(inspectJsonl(path, "[", 1, 1, signal()), SyntaxError);
}));

test("entry pagination scans the whole file but retains only its requested page", async () => fixture(async (path) => {
  const lines = Array.from({ length: 2500 }, (_, index) => index % 13 === 0 ? "" : record(`entry ${index} ${payload(800)}`));
  const raw = lines.join("\n");
  await writeFile(path, raw);
  const full = parseTranscript(path, raw);
  for (const direction of ["forward", "backward"] as const) {
    for (const offset of [undefined, 0, 19, 2200, 10000]) {
      const page = await readJsonlPage(path, offset, direction, 17, signal());
      const clamped = Math.min(full.entries.length, offset ?? (direction === "backward" ? full.entries.length : 0));
      const start = direction === "backward" ? Math.max(0, clamped - 17) : clamped;
      const end = direction === "backward" ? clamped : Math.min(full.entries.length, clamped + 17);
      assert.equal(page.start, start);
      assert.equal(page.totalEntries, full.entries.length);
      assert.deepEqual(page.transcript.entries.map(({ raw, ...entry }) => entry), full.entries.slice(start, end).map(evidence));
      assert.equal(renderExpansion({ ...page.transcript, direction, offset: start, totalEntries: page.totalEntries, entries: page.transcript.entries }),
        renderExpansion({ ...full, direction, offset: start, totalEntries: full.entries.length, entries: full.entries.slice(start, end).map(evidence) }));
    }
    const outcome = await runSessionActor(SessionOperation.Expand({ sessionId: path, direction, limit: 17 }), signal());
    assert.equal(outcome.status, "succeeded");
    if (outcome.status === "succeeded") {
      const start = direction === "backward" ? full.entries.length - 17 : 0;
      assert.equal(outcome.result.text, renderExpansion({
        ...full, direction, offset: start, totalEntries: full.entries.length,
        entries: full.entries.slice(start, start + 17).map(evidence), nextCursor: "opaque-next-page",
      }));
    }
  }
}));

test("legacy transcript reads retain only a bounded prefix", async () => fixture(async (path) => {
  await writeFile(path, Array.from({ length: 5000 }, () => record("sample ".repeat(146))).join("\n"));
  const result = await readBoundedJsonl(path, signal());
  assert.equal(result.truncated, true);
  assert.ok(result.entries.length <= 2000);
  assert.ok(result.entries.every((entry) => entry.raw === undefined));
  assert.match(result.truncationReason!, /legacy adapter.*2 MiB/);
}));

async function measure(t: TestContext, path: string, modes: readonly string[], truncated: boolean, options: { home?: string; bytes?: number } = {}) {
  const failures: string[] = [];
  for (const mode of modes) {
    const { stdout } = await exec(process.execPath, ["--max-old-space-size=12288", fileURLToPath(new URL("./streaming-benchmark.ts", import.meta.url)), mode, path], { timeout: 500_000, maxBuffer: 64 * 1024,
      env: { ...process.env, ...(options.home ? { HOME: options.home, GROK_HOME: join(options.home, ".grok") } : {}) },
    });
    const result = JSON.parse(stdout.trim());
    t.diagnostic(JSON.stringify({ fixtureBytes: options.bytes ?? (await stat(path)).size, ...result }));
    if (!(result.found === true && result.answerBytes < 24_000
      && (mode.startsWith("baseline") || (result.maxRssKiB < 300 * 1024 && result.truncated === truncated)))) {
      failures.push(JSON.stringify(result));
    }
  }
  // Collect every operation's measurement before failing an expensive fixture.
  assert.deepEqual(failures, [], failures.join("\n"));
}

test("eight-file small-store latency and decode-heavy batch RSS", {
  skip: process.env.SESSION_READER_LARGE_TEST !== "1", timeout: 600_000,
}, async (t) => fixture(async (path) => {
  for (const kind of ["small", "heavy"] as const) {
    const home = join(dirname(path), kind);
    const root = join(home, ".pi/agent/sessions");
    await mkdir(root, { recursive: true });
    let total = 0;
    const body = record(kind === "heavy" ? "MIXED " + payload(MAX_JSONL_LINE_BYTES - 262) : payload(512)) + "\n";
    for (let index = 0; index < 8; index++) {
      const target = join(root, `synthetic-${index}.jsonl`);
      const handle = await open(target, "wx");
      try {
        for (let line = 0; line < (kind === "heavy" ? 34 : 256); line++) await handle.write(body);
        await handle.write(record("synthetic-needle", "user") + "\n");
      } finally { await handle.close(); }
      const bytes = (await stat(target)).size;
      if (kind === "heavy") assert.ok(bytes > LARGE_SEARCH_FILE_BYTES);
      total += bytes;
    }
    await measure(t, home, kind === "small" ? ["search-small-before", "search-small-after"] : ["search-batch"], false, { home, bytes: total });
  }
}));

test("decode-heavy near-cap records and compaction-sized summaries stay bounded", {
  skip: process.env.SESSION_READER_LARGE_TEST !== "1", timeout: 600_000,
}, async (t) => fixture(async (path) => {
  const handle = await open(path, "wx");
  try {
    const largeLine = record("MIXED " + payload(MAX_JSONL_LINE_BYTES - 262)) + "\n";
    assert.ok(Buffer.byteLength(largeLine) < MAX_JSONL_LINE_BYTES);
    for (let index = 0; index < 128; index++) await handle.write(largeLine);
    for (let index = 0; index < 4; index++) {
      await handle.write(JSON.stringify({ type: "compaction", summary: payload(350 * 1024) }) + "\n");
    }
    await handle.write(record("synthetic-needle", "user") + "\n");
  } finally { await handle.close(); }
  await measure(t, path, ["inspect", "search", "extract", "expand"], false);
}));

test("2 GiB synthetic transcript: baseline comparison and <300 MiB peak RSS", {
  skip: process.env.SESSION_READER_LARGE_TEST !== "1", timeout: 600_000,
}, async (t) => fixture(async (path) => {
  const handle = await open(path, "wx");
  try {
    // Delimit words like real tool output. One 10 MiB token also exercises the
    // old redactor's quadratic regex behavior, obscuring this IO/RSS benchmark.
    const largeLine = record("synthetic payload ".repeat(Math.ceil(10 * 1024 * 1024 / 18)).slice(0, 10 * 1024 * 1024)) + "\n";
    for (let index = 0; index < 205; index++) {
      await handle.write(largeLine);
      await handle.write(record(`ordinary ${index}`) + "\n");
    }
    await handle.write(record("synthetic-needle", "user") + "\n");
  } finally { await handle.close(); }
  assert.ok((await stat(path)).size >= 2 * 1024 ** 3);
  const modes = process.env.SESSION_READER_BENCH_BASELINE === "1"
    ? ["baseline-inspect", "baseline-search", "inspect", "search", "extract", "expand"]
    : ["inspect", "search", "extract", "expand"];
  await measure(t, path, modes, true);
}));
