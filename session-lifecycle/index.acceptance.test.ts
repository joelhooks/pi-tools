import { beforeEach, describe, expect, it, mock } from "bun:test";

type SpawnCall = {
  command: string;
  args: string[];
  options: Record<string, unknown>;
};

const spawnCalls: SpawnCall[] = [];
const callOrder: string[] = [];
const appendCalls: Array<{ path: string; text: string; encoding?: string }> = [];

const unrefMock = mock(() => {
  callOrder.push("unref");
});

const spawnMock = mock((command: string, args: string[], options: Record<string, unknown>) => {
  callOrder.push("spawn");
  spawnCalls.push({ command, args, options });
  return { unref: unrefMock };
});

mock.module("node:child_process", () => ({
  exec: mock(() => undefined),
  spawn: spawnMock,
}));

mock.module("node:fs", () => ({
  readFileSync: mock(() => {
    throw new Error("not found");
  }),
  readdirSync: mock(() => []),
  mkdirSync: mock(() => undefined),
  appendFileSync: mock((filePath: string, text: string, encoding?: string) => {
    appendCalls.push({ path: filePath, text, encoding });
  }),
}));

const moduleUnderTest = await import("./index.ts");
const emitEventWithExpectedType: (name: string, data: Record<string, unknown>) => void =
  moduleUnderTest.emitEvent;

describe("MEM-WIRE-1 emitEvent acceptance", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    callOrder.length = 0;
    spawnMock.mockClear();
    unrefMock.mockClear();
  });

  it("exports emitEvent with the expected callable contract", () => {
    expect(moduleUnderTest).toMatchObject({
      emitEvent: expect.any(Function),
    });

    const emitEventResult = emitEventWithExpectedType("memory/session.ended", {
      sessionId: "session-123",
    });

    expect({ emitEventResult }).toMatchObject({ emitEventResult: undefined });
  });

  it("spawns `igs send` in detached fire-and-forget mode with JSON data", () => {
    const eventName = "memory/session.compaction.pending";
    const payload = {
      sessionId: "session-abc",
      schemaVersion: 1,
      nested: { ok: true },
    };

    moduleUnderTest.emitEvent(eventName, payload);

    expect({ spawnCallCount: spawnCalls.length }).toMatchObject({ spawnCallCount: 1 });
    expect(spawnCalls[0]).toMatchObject({
      command: "igs",
      args: ["send", eventName, "--data", JSON.stringify(payload)],
      options: {
        detached: true,
        stdio: "ignore",
      },
    });
  });

  it("unrefs the spawned child after spawning", () => {
    moduleUnderTest.emitEvent("memory/session.ended", { sessionId: "session-xyz" });

    expect({ unrefCallCount: unrefMock.mock.calls.length }).toMatchObject({ unrefCallCount: 1 });
    expect(callOrder).toMatchObject(["spawn", "unref"]);
  });
});

describe("MEM-WIRE-2 session_before_compact acceptance", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    callOrder.length = 0;
    appendCalls.length = 0;
    spawnMock.mockClear();
    unrefMock.mockClear();
  });

  it("emits memory/session.compaction.pending with required payload fields and literal values", async () => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const extensionApi = {
      on: mock((eventName: string, handler: (...args: unknown[]) => unknown) => {
        handlers[eventName] = handler;
      }),
      getSessionId: mock(() => "session-acceptance-123"),
      getSessionName: mock(() => "Acceptance Session"),
      setSessionName: mock(() => undefined),
    };

    moduleUnderTest.default(extensionApi as any);

    expect(handlers.session_before_compact).toEqual(expect.any(Function));

    const preparation = {
      messagesToSummarize: [
        { role: "user", content: "Please summarize this.", ignored: "x" },
        { role: "assistant", content: "Sure, working on it.", tool: "test" },
      ],
      tokensBefore: 4096,
      fileOps: {
        read: new Set(["docs/guide.md", "src/a.ts"]),
        edited: new Set(["src/b.ts"]),
      },
      previousSummary: "Earlier context",
    };

    await handlers.session_before_compact({ preparation });

    const sendCalls = spawnCalls.filter(
      (call) => call.command === "igs" && call.args[0] === "send"
    );
    expect({ sendCallCount: sendCalls.length }).toMatchObject({ sendCallCount: 1 });

    const compactionEventCall = sendCalls[0];
    expect(compactionEventCall.args[0]).toEqual("send");
    expect(compactionEventCall.args[1]).toEqual("memory/session.compaction.pending");
    expect(compactionEventCall.args[2]).toEqual("--data");
    expect(typeof compactionEventCall.args[3]).toEqual("string");

    const payload = JSON.parse(String(compactionEventCall.args[3])) as Record<string, unknown>;

    // Check types
    expect(typeof payload.sessionId).toEqual("string");
    expect(typeof payload.dedupeKey).toEqual("string");
    expect(typeof payload.messages).toEqual("string");
    expect(typeof payload.capturedAt).toEqual("string");

    // Check exact values
    expect(payload.trigger).toEqual("compaction");
    expect(payload.messageCount).toEqual(2);
    expect(payload.tokensBefore).toEqual(4096);
    expect(payload.filesRead).toEqual(["docs/guide.md", "src/a.ts"]);
    expect(payload.filesModified).toEqual(["src/b.ts"]);
    expect(payload.schemaVersion).toEqual(1);
    expect(payload.sessionId).toEqual("session-acceptance-123");

    const parsedMessages = JSON.parse(String(payload.messages)) as Array<Record<string, unknown>>;
    expect(parsedMessages).toEqual([
      { role: "user", content: "Please summarize this." },
      { role: "assistant", content: "Sure, working on it." },
    ]);
  });
});
