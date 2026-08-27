import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSessionRecallMcpServer } from "./mcp-server.ts";
import type { SessionOperation } from "./engine.ts";

const expectedTools = [
  "recall",
  "drill_down_session_evidence",
  "inspect_session",
  "expand_session",
  "session_context",
  "drill_down_session_chunks",
  "capture_status",
];

async function withClient(
  run: (client: Client, operations: SessionOperation[]) => Promise<void>,
): Promise<void> {
  const operations: SessionOperation[] = [];
  const server = createSessionRecallMcpServer({
    cwd: "/tmp/session-recall-mcp",
    machine: "test-machine",
    runner: async (operation) => {
      operations.push(operation);
      return {
        status: "succeeded",
        result: {
          text: `${operation._tag} complete`,
          details: { ok: true, operation: operation._tag },
        },
      };
    },
  });
  const client = new Client({ name: "session-recall-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client, operations);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("session recall MCP", () => {
  test("advertises the bounded read-only memory surface", async () => {
    await withClient(async (client) => {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        expectedTools,
      );
      assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true));
    });
  });

  test("routes recall and raw drill-down as separate operations", async () => {
    await withClient(async (client, operations) => {
      const recalled = await client.callTool({
        name: "recall",
        arguments: {
          query: "prior decision",
          project: "joelclaw-memory",
          workstream: "session-recall-mcp",
          limit: 4,
        },
      });
      assert.equal(recalled.isError, undefined);
      const evidenceDrilldownReceipt = (
        recalled.structuredContent as { details?: { evidenceDrilldownReceipt?: unknown } }
      )?.details?.evidenceDrilldownReceipt;
      assert.equal(typeof evidenceDrilldownReceipt, "string");
      assert.equal(operations[0]._tag, "Recall");
      if (operations[0]._tag !== "Recall" || typeof evidenceDrilldownReceipt !== "string") return;
      assert.deepEqual(operations[0].limits, {
        curated: 4,
        observations: 4,
        reflections: 4,
      });

      await client.callTool({
        name: "drill_down_session_evidence",
        arguments: {
          query: "exact receipt",
          evidenceDrilldownReceipt,
          runtime: "opencode",
          limit: 2,
        },
      });
      assert.equal(operations[1]._tag, "Search");
      if (operations[1]._tag !== "Search") return;
      assert.equal(operations[1].agent, "opencode");
      assert.equal(operations[1].source, "local");

      await client.callTool({
        name: "inspect_session",
        arguments: {
          sessionId: "session-1",
          around: "receipt",
          before: 2,
          after: 3,
        },
      });
      assert.equal(operations[2]._tag, "Inspect");

      await client.callTool({
        name: "drill_down_session_chunks",
        arguments: {
          query: "receipt",
          evidenceDrilldownReceipt,
          excludeCurrent: true,
          currentSessionId: "caller-session",
        },
      });
      assert.equal(operations[3]._tag, "Chunks");
      if (operations[3]._tag !== "Chunks") return;
      assert.equal(operations[3].excludeCurrent, true);
      assert.equal(operations[3].currentSessionId, "caller-session");
    });
  });

  test("rejects broad native search without a fresh recall receipt", async () => {
    await withClient(async (client, operations) => {
      const result = await client.callTool({
        name: "drill_down_session_evidence",
        arguments: {
          query: "broad memory query",
          evidenceDrilldownReceipt: "not-a-valid-receipt",
        },
      });

      assert.equal(result.isError, true);
      assert.equal(operations.length, 0);
      assert.equal(
        (result.structuredContent as { details?: { code?: unknown } })?.details?.code,
        "recall-required-before-raw-evidence",
      );
    });
  });
});
