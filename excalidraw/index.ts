/**
 * excalidraw — Pi extension that bridges @cmd8/excalidraw-mcp via stdio.
 *
 * Spawns the excalidraw MCP server as a child process, connects via
 * stdio transport, and registers its tools into pi natively.
 *
 * Usage:
 *   /excalidraw-open <path>    — Open/create a diagram and register tools
 *   /excalidraw-close          — Close the current diagram
 *   /excalidraw-status         — Show connection status
 *
 * The diagram path defaults to ./diagram.excalidraw in the cwd.
 * Tools are prefixed with `excalidraw_`.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";

interface ExcalidrawState {
  client: Client | null;
  transport: StdioClientTransport | null;
  connected: boolean;
  diagramPath: string | null;
  tools: string[];
}

const state: ExcalidrawState = {
  client: null,
  transport: null,
  connected: false,
  diagramPath: null,
  tools: [],
};

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }], details: {} };
}

function ensureDiagramExists(path: string) {
  if (!existsSync(path)) {
    // Create a minimal empty excalidraw file
    const empty = {
      type: "excalidraw",
      version: 2,
      source: "pi-excalidraw-extension",
      elements: [],
      appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
      files: {},
    };
    writeFileSync(path, JSON.stringify(empty, null, 2));
  }
}

async function connectToDiagram(pi: ExtensionAPI, diagramPath: string, ctx?: ExtensionContext): Promise<boolean> {
  // Disconnect existing
  await disconnect();

  ensureDiagramExists(diagramPath);

  try {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "@cmd8/excalidraw-mcp", "--diagram", diagramPath],
    });

    const client = new Client({
      name: "pi-excalidraw",
      version: "1.0.0",
    });

    await client.connect(transport);

    const { tools } = await client.listTools();
    const registeredTools: string[] = [];

    for (const tool of tools) {
      const toolName = `excalidraw_${tool.name}`;

      pi.registerTool({
        name: toolName,
        label: `Excalidraw: ${tool.name}`,
        description: tool.description || `Excalidraw tool: ${tool.name}`,
        parameters: (tool.inputSchema || {}) as any,
        async execute(_id, params) {
          if (!state.client || !state.connected) {
            return text("❌ Not connected. Run /excalidraw-open <path>");
          }

          try {
            const result = await state.client.callTool({
              name: tool.name,
              arguments: params,
            });

            const parts: string[] = [];
            if (result.content && Array.isArray(result.content)) {
              for (const item of result.content) {
                if (item.type === "text") {
                  parts.push((item as any).text);
                } else {
                  parts.push(JSON.stringify(item, null, 2));
                }
              }
            }

            return text(parts.join("\n\n") || "✓ Done");
          } catch (err: any) {
            return text(`❌ Excalidraw error: ${err.message}`);
          }
        },
      });

      registeredTools.push(toolName);
    }

    state.client = client;
    state.transport = transport;
    state.connected = true;
    state.diagramPath = diagramPath;
    state.tools = registeredTools;

    ctx?.ui.notify(`Excalidraw: ${diagramPath} — ${tools.length} tools registered`, "success");
    return true;
  } catch (err: any) {
    state.connected = false;
    ctx?.ui.notify(`Excalidraw failed: ${err.message}`, "error");
    return false;
  }
}

async function disconnect() {
  if (state.transport) {
    try {
      await state.transport.close();
    } catch {}
  }
  state.client = null;
  state.transport = null;
  state.connected = false;
  state.diagramPath = null;
  state.tools = [];
}

export default function excalidraw(pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    await disconnect();
  });

  pi.registerCommand("excalidraw-open", {
    description: "Open an excalidraw diagram: /excalidraw-open [path]",
    handler: async (args, ctx) => {
      const path = (args || "").trim() || join(process.cwd(), "diagram.excalidraw");
      await connectToDiagram(pi, path, ctx);
    },
  });

  pi.registerCommand("excalidraw-close", {
    description: "Close the current excalidraw diagram",
    handler: async (_args, ctx) => {
      await disconnect();
      ctx.ui.notify("Excalidraw disconnected.", "info");
    },
  });

  pi.registerCommand("excalidraw-status", {
    description: "Show excalidraw connection status",
    handler: async (_args, ctx) => {
      if (!state.connected) {
        ctx.ui.notify("Excalidraw: not connected. Use /excalidraw-open <path>", "info");
        return;
      }
      const lines = [
        `Excalidraw: connected`,
        `Diagram: ${state.diagramPath}`,
        `Tools: ${state.tools.join(", ")}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
