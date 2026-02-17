import { beforeEach, describe, expect, it, mock } from "bun:test";

type SpawnCall = {
  command: string;
  args: string[];
  options: Record<string, unknown>;
};

const spawnCalls: SpawnCall[] = [];
const callOrder: string[] = [];

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
