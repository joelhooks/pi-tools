import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { runSessionActor } from "./machine.ts";
import { inspectDetails, renderCaptureHealth, renderInspect } from "./presenter.ts";
import {
  assessCaptureHealth,
  type CaptureFileStatus,
  capturePathSpecs,
} from "./capture-paths.ts";
import sessionReader from "./session-reader.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const path = temporaryDirectories.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

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
    "session_search",
    "session_capture_status",
    "sessions",
    "session_context",
    "session_inspect",
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
