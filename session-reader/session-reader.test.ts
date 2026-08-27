import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { Result, Schema } from "effect";
import {
  extractTranscript,
  InspectResultSchema,
  inspectTranscript,
  parseTranscript,
  redactSecrets,
  sessionMetaFromPath,
  redactUnknown,
} from "./domain.ts";
import { SessionOperation, SessionOperationSchema } from "./engine.ts";
import { FlowingRecallError, runFlowingRecall } from "./flowing-recall.ts";
import { runSessionActor } from "./machine.ts";
import { inspectDetails, renderCaptureHealth, renderInspect } from "./presenter.ts";
import { createSessionAdapters } from "./adapters.ts";
import { assessCaptureHealth, type CaptureFileStatus, capturePathSpecs } from "./capture-paths.ts";
import sessionReader from "./session-reader.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const path = temporaryDirectories.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

async function openCodeFixture(): Promise<{
  readonly databasePath: string;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "session-reader-opencode-"));
  temporaryDirectories.push(root);
  const databasePath = join(root, "opencode.db");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  database
    .prepare("INSERT INTO session VALUES (?, ?, ?, ?)")
    .run("open-session", "/tmp/opencode-project", 1_700_000_000_000, 1_700_000_001_000);
  database
    .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    .run(
      "message-user",
      "open-session",
      1_700_000_000_100,
      1_700_000_000_100,
      JSON.stringify({ role: "user" }),
    );
  database
    .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "part-user",
      "message-user",
      "open-session",
      1_700_000_000_101,
      1_700_000_000_101,
      JSON.stringify({ type: "text", text: "OpenCode targetLoad evidence" }),
    );
  database
    .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    .run(
      "message-incomplete",
      "open-session",
      1_700_000_000_150,
      1_700_000_000_150,
      JSON.stringify({ role: "assistant", time: {} }),
    );
  database
    .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "part-incomplete",
      "message-incomplete",
      "open-session",
      1_700_000_000_151,
      1_700_000_000_151,
      JSON.stringify({ type: "text", text: "unfinished assistant text" }),
    );
  database
    .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    .run(
      "message-complete",
      "open-session",
      1_700_000_000_175,
      1_700_000_000_175,
      JSON.stringify({ role: "assistant", time: { completed: 1_700_000_000_176 } }),
    );
  database
    .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "part-complete",
      "message-complete",
      "open-session",
      1_700_000_000_176,
      1_700_000_000_176,
      JSON.stringify({ type: "text", text: "completed assistant receipt" }),
    );
  database
    .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    .run(
      "message-summary",
      "open-session",
      1_700_000_000_200,
      1_700_000_000_200,
      JSON.stringify({ role: "assistant", summary: true }),
    );
  database
    .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "part-summary",
      "message-summary",
      "open-session",
      1_700_000_000_201,
      1_700_000_000_201,
      JSON.stringify({ type: "text", text: "must not be exposed" }),
    );
  database.close();
  return { databasePath, root };
}

async function transcriptFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "session-reader-"));
  temporaryDirectories.push(root);
  const path = join(root, "2026-08-18T00-00-00-000Z_session-test.jsonl");
  const lines = [
    { type: "message", message: { role: "user", content: "before" } },
    {
      type: "message",
      message: { role: "assistant", content: "first targetLoad decision because source" },
    },
    { type: "message", message: { role: "assistant", content: "second targetLoad test passed" } },
    { type: "message", message: { role: "toolResult", content: "after /tmp/example.ts" } },
  ];
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

describe("session reader domain", () => {
  test("deduplicates overlapping inspect windows and caps output", async () => {
    const path = await transcriptFixture();
    const raw = await readFile(path, "utf8");
    const result = inspectTranscript(parseTranscript(path, raw), "targetLoad", 1, 2);
    const rendered = renderInspect(result, 700);

    assert.equal(result.matches.length, 2);
    assert.ok(rendered.length <= 700);
    assert.match(rendered, /L2 message/);
    assert.match(rendered, /L3 message/);
    assert.equal(JSON.stringify(inspectDetails(result)).includes("first targetLoad"), false);
  });

  test("schemas validate results and reject malformed operations", async () => {
    const path = await transcriptFixture();
    const raw = await readFile(path, "utf8");
    const result = inspectTranscript(parseTranscript(path, raw), "targetLoad", 1, 1);

    assert.equal(Result.isSuccess(Schema.decodeUnknownResult(InspectResultSchema)(result)), true);
    assert.equal(
      Result.isFailure(
        Schema.decodeUnknownResult(SessionOperationSchema)({
          _tag: "Inspect",
          sessionId: path,
          around: "targetLoad",
          before: "nope",
          after: 1,
        }),
      ),
      true,
    );
    assert.equal(
      JSON.stringify(redactUnknown({ token: "plain-secret-value" })).includes("plain-secret-value"),
      false,
    );
    assert.equal(
      redactSecrets('{"api_key":"plain-secret-value"}').text.includes("plain-secret-value"),
      false,
    );
  });

  test("extracts bounded structured evidence locally", async () => {
    const path = await transcriptFixture();
    const raw = await readFile(path, "utf8");
    const extraction = extractTranscript(parseTranscript(path, raw), "targetLoad");

    assert.equal(extraction.lineCount, 4);
    assert.ok(extraction.decisions.length > 0);
    assert.ok(extraction.verification.length > 0);
    assert.deepEqual(extraction.filesTouched, ["/tmp/example.ts"]);
  });

  test("reads OpenCode SQLite through a bounded read-only adapter", async () => {
    const fixture = await openCodeFixture();
    const adapter = createSessionAdapters({
      home: fixture.root,
      grokHome: join(fixture.root, ".grok"),
      openCodeDatabase: fixture.databasePath,
    }).find((candidate) => candidate.runtime === "opencode");
    assert.ok(adapter);

    const signal = new AbortController().signal;
    const discovered = [];
    for await (const locator of adapter.discover({ maxFiles: 5, signal })) {
      discovered.push(locator);
    }
    assert.equal(discovered.length, 1);
    assert.match(discovered[0].path, /opencode\.db#session=open-session$/u);

    const transcript = await adapter.read(discovered[0], signal);
    assert.equal(transcript.sessionId, "open-session");
    assert.equal(transcript.cwdKey, "/tmp/opencode-project");
    assert.equal(transcript.entries.length, 2);
    assert.match(transcript.entries[0].text, /targetLoad/u);
    assert.match(transcript.entries[1].text, /completed assistant receipt/u);
    assert.equal(JSON.stringify(transcript).includes("unfinished assistant text"), false);
    assert.equal(JSON.stringify(transcript).includes("must not be exposed"), false);

    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare("INSERT INTO session VALUES (?, ?, ?, ?)")
      .run("oversized-session", "/tmp/opencode-project", 1_700_000_002_000, 1_700_000_002_000);
    database
      .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
      .run(
        "oversized-message",
        "oversized-session",
        1_700_000_002_001,
        1_700_000_002_001,
        JSON.stringify({ role: "user" }),
      );
    database
      .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "oversized-part",
        "oversized-message",
        "oversized-session",
        1_700_000_002_002,
        1_700_000_002_002,
        JSON.stringify({ type: "text", text: "🧠".repeat(3_000) }),
      );
    database.close();
    const withOversized = [];
    for await (const locator of adapter.discover({ maxFiles: 5, signal })) {
      withOversized.push(locator);
    }
    const oversized = withOversized.find((locator) => locator.path.includes("oversized-session"));
    assert.ok(oversized);
    await assert.rejects(adapter.read(oversized, signal), /bounded reader limits/u);
    assert.equal((await adapter.health(signal)).status, "healthy");
  });

  test("does not mistake nested Codex date directories for Grok metadata", () => {
    const codex = sessionMetaFromPath(
      "/home/example/.codex/sessions/2026/08/18/rollout-2026-08-18T13-04-13-01a01679-7588-7981-9dd0-ee2b1faab24f.jsonl",
    );
    assert.equal(codex.sessionId, "01a01679-7588-7981-9dd0-ee2b1faab24f");
    assert.equal(codex.startedAt, "2026-08-18T13:04:13Z");

    const grok = sessionMetaFromPath(
      "/home/example/.grok/sessions/%2Fhome%2Fexample/01a01a5f-da6c-7fa2-8539-db2be9e6a08b/chat_history.jsonl",
    );
    assert.equal(grok.sessionId, "01a01a5f-da6c-7fa2-8539-db2be9e6a08b");
    assert.equal(grok.cwdKey, "/home/example");
  });
});

describe("flowing recall process boundary", () => {
  test("keeps recall text on stdin and validates the three-lane response", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowing-recall-runner-"));
    temporaryDirectories.push(root);
    const command = join(root, "fake-joelclaw");
    await writeFile(
      command,
      `#!/usr/bin/env node
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(raw);
  const available = (lane) => ({
    _tag: "RecallLaneAvailableV1",
    lane,
    source: "fixture",
    scoreScale: lane === "curated-pages" ? "bm25-negated" : "unit-interval",
    health: { _tag: "Healthy" },
    items: [],
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    command: "joelclaw recall",
    result: {
      adapter: "fixture",
      composed: {
        _tag: "ComposedRecallResultV1",
        schemaVersion: 1,
        lanes: {
          flowingReflections: available("flowing-reflections"),
          flowingObservations: available("flowing-observations"),
          curatedPages: available("curated-pages"),
        },
        request,
        resolvedAccess: request.access,
        resolvedScope: request.scope,
        unavailable: [],
      },
    },
  }));
});
`,
    );
    await chmod(command, 0o755);
    const result = await runFlowingRecall(
      {
        query: "private query over stdin",
        project: "joelclaw-memory",
        workstream: "session-recall-mcp",
        allowedPrivacy: ["public", "private"],
        includeSuperseded: false,
        limits: { curated: 5, observations: 5, reflections: 5 },
      },
      { command, cwd: root, signal: new AbortController().signal },
    );
    assert.equal(result.adapter, "fixture");
    assert.equal(result.composed.lanes.flowingReflections.lane, "flowing-reflections");
  });

  test("rejects invalid recall input before spawning", async () => {
    await assert.rejects(
      runFlowingRecall(
        {
          query: "",
          project: "joelclaw-memory",
          workstream: "session-recall-mcp",
          allowedPrivacy: ["private"],
          includeSuperseded: false,
          limits: { curated: 5, observations: 5, reflections: 5 },
        },
        { command: "/missing", cwd: process.cwd(), signal: new AbortController().signal },
      ),
      (error) => error instanceof FlowingRecallError && error.kind === "invalid-input",
    );
  });
});

describe("session reader actor", () => {
  test("runs a local inspect through Effect and XState", async () => {
    const path = await transcriptFixture();
    const states: string[] = [];
    const outcome = await runSessionActor(
      SessionOperation.Inspect({ sessionId: path, around: "targetLoad", before: 1, after: 1 }),
      new AbortController().signal,
      (snapshot) => states.push(String(snapshot.value)),
    );

    assert.equal(outcome.status, "succeeded");
    if (outcome.status !== "succeeded") return;
    assert.match(outcome.result.text, /Effect engine output/);
    assert.ok(outcome.result.text.length <= 24_000);
    assert.ok(states.includes("inspecting"));
    assert.ok(states.includes("succeeded"));
  });

  test("maps invalid regex input into a failed actor state", async () => {
    const path = await transcriptFixture();
    const outcome = await runSessionActor(
      SessionOperation.Inspect({ sessionId: path, around: "[", before: 1, after: 1 }),
      new AbortController().signal,
    );
    assert.equal(outcome.status, "failed");
  });

  test("expands with a bounded opaque continuation cursor", async () => {
    const path = await transcriptFixture();
    const first = await runSessionActor(
      SessionOperation.Expand({ sessionId: path, limit: 2, direction: "forward" }),
      new AbortController().signal,
    );
    assert.equal(first.status, "succeeded");
    if (first.status !== "succeeded") return;
    const cursor = first.result.details.nextCursor;
    assert.equal(typeof cursor, "string");
    assert.match(first.result.text, /Bounded continuation page/u);

    const second = await runSessionActor(
      SessionOperation.Expand({ sessionId: path, limit: 2, cursor: String(cursor) }),
      new AbortController().signal,
    );
    assert.equal(second.status, "succeeded");
    if (second.status !== "succeeded") return;
    assert.equal(second.result.details.hasMore, false);

    const otherPath = await transcriptFixture();
    const mismatch = await runSessionActor(
      SessionOperation.Expand({ sessionId: otherPath, limit: 2, cursor: String(cursor) }),
      new AbortController().signal,
    );
    assert.equal(mismatch.status, "failed");

    const encoded = String(cursor);
    const tampered = `${encoded.slice(0, -1)}${encoded.endsWith("a") ? "b" : "a"}`;
    const forged = await runSessionActor(
      SessionOperation.Expand({ sessionId: path, limit: 2, cursor: tampered }),
      new AbortController().signal,
    );
    assert.equal(forged.status, "failed");
  });

  test("fails closed before remote query text can enter argv", async () => {
    const outcome = await runSessionActor(
      SessionOperation.Search({
        query: "private search text",
        agent: "all",
        source: "both",
        machine: "test",
        limit: 5,
        maxFiles: 20,
        cwd: process.cwd(),
        extract: false,
      }),
      new AbortController().signal,
    );
    assert.equal(outcome.status, "succeeded");
    if (outcome.status !== "succeeded") return;
    assert.equal(outcome.result.isError, true);
    assert.equal(outcome.result.details.code, "remote-query-transport-unavailable");
    assert.equal(JSON.stringify(outcome.result.details).includes("private search text"), false);
  });

  test("cancels through the XState lifecycle", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runSessionActor(
      SessionOperation.Search({
        query: "never-run",
        agent: "all",
        source: "local",
        machine: "test",
        limit: 5,
        maxFiles: 200,
        cwd: process.cwd(),
        extract: false,
      }),
      controller.signal,
    );
    assert.equal(outcome.status, "cancelled");
  });
});

test("registers the compatibility tool surface", () => {
  const names: string[] = [];
  sessionReader({
    registerTool(tool: { readonly name: string }) {
      names.push(tool.name);
    },
  } as never);
  assert.deepEqual(names, [
    "flowing_recall",
    "session_search",
    "session_capture_status",
    "sessions",
    "session_context",
    "session_inspect",
    "session_expand",
    "session_chunks",
    "session_tasks",
  ]);
});

test("capture status renderer keeps current flowing delivery unproven", () => {
  const files: CaptureFileStatus[] = capturePathSpecs("/tmp/home", "test-machine").map((spec) => ({
    ...spec,
    present: spec.namespace === "legacy" && spec.runtime === "codex",
    pendingCount: spec.kind === "outbox" ? 0 : undefined,
  }));
  const health = assessCaptureHealth({
    machineId: "test-machine",
    files,
    central: { status: "stale", reason: "retired" },
  });
  const rendered = renderCaptureHealth(health);
  assert.match(rendered, /Current flowing capture: unproven/);
  assert.match(rendered, /Legacy Central diagnostics: degraded/);
  assert.match(rendered, /codex: legacy-only/);
  assert.match(rendered, /Legacy Central configuration: stale/);
});
