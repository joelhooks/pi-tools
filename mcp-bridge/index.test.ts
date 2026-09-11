import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import mcpBridge from "./index.ts";

test("mcp_status exposes an object parameter schema", () => {
  const tools: Array<{ name: string; parameters: unknown }> = [];
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(tool: { name: string; parameters: unknown }) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  mcpBridge(pi);

  const status = tools.find((tool) => tool.name === "mcp_status");
  assert.ok(status);
  const schema = status.parameters as { type?: unknown; properties?: unknown };
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.properties, {});
});
