import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSessionRecallMcpHttpApp } from "./mcp-http-server.ts";

const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

describe("session recall MCP HTTP transport", () => {
  test("binds a bearer-protected read-only MCP surface", async () => {
    const app = createSessionRecallMcpHttpApp({
      token,
      cwd: "/tmp/session-recall-mcp-http",
      machine: "test-machine",
      runner: async (operation) => ({
        status: "succeeded",
        result: {
          text: `${operation._tag} complete`,
          details: { ok: true, operation: operation._tag },
        },
      }),
    });
    const server = createServer(app);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const health = await fetch(`${base}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "ok" });

      const unauthorized = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      assert.equal(unauthorized.status, 401);
      assert.doesNotMatch(await unauthorized.text(), /SyntaxError|node_modules|mcp-http-server/u);

      const malformed = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "{",
      });
      assert.equal(malformed.status, 400);
      assert.deepEqual(await malformed.json(), {
        jsonrpc: "2.0",
        error: { code: -32_700, message: "Parse error" },
        id: null,
      });

      const client = new Client({ name: "executor-memory-test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      try {
        const listed = await client.listTools();
        assert.deepEqual(
          listed.tools.map((tool) => tool.name),
          [
            "recall",
            "drill_down_session_evidence",
            "inspect_session",
            "expand_session",
            "session_context",
            "drill_down_session_chunks",
            "capture_status",
          ],
        );
        assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true));
      } finally {
        await client.close();
      }
    } finally {
      await closeServer(server);
    }
  });

  test("rejects missing or short bearer tokens at startup", () => {
    assert.throws(
      () => createSessionRecallMcpHttpApp({ token: "short" }),
      /must contain at least 32 bytes/u,
    );
  });
});
