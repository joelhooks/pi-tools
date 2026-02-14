/**
 * ts-check — TypeScript diagnostics + intelligence via tsgo LSP (TypeScript 7 native).
 *
 * Spawns tsgo --lsp --stdio per project root. Feeds it file changes after write/edit.
 * Reports diagnostics at end of agent turn. Exposes an on-demand tool for
 * definitions, references, hover, and diagnostics.
 *
 * Requires: npm install -g @typescript/native-preview
 *
 * Light-touch: one tsgo process per project, auto-shutdown after idle.
 * No vscode-languageserver-protocol dependency — raw JSON-RPC.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

// ── JSON-RPC over stdio ─────────────────────────────────────────────

interface LSPServer {
  proc: ChildProcess;
  root: string;
  nextId: number;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>;
  buffer: string;
  initialized: boolean;
  lastActivity: number;
  openFiles: Set<string>;
  version: Map<string, number>;
  diagnostics: Map<string, any[]>;
}

function send(server: LSPServer, method: string, params: any, isNotification = false): Promise<any> {
  const msg: any = { jsonrpc: "2.0", method, params };
  if (!isNotification) {
    msg.id = server.nextId++;
  }
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  try {
    server.proc.stdin!.write(header + body);
  } catch { }
  server.lastActivity = Date.now();

  if (isNotification) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error("LSP timeout")); server.pending.delete(msg.id); }, 15000);
    server.pending.set(msg.id, {
      resolve: (v: any) => { clearTimeout(timer); resolve(v); },
      reject: (e: any) => { clearTimeout(timer); reject(e); },
    });
  });
}

function handleData(server: LSPServer, chunk: string) {
  server.buffer += chunk;
  while (true) {
    const headerEnd = server.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = server.buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length: (\d+)/);
    if (!match) { server.buffer = server.buffer.slice(headerEnd + 4); continue; }
    const length = parseInt(match[1]);
    const bodyStart = headerEnd + 4;
    if (server.buffer.length < bodyStart + length) break;
    const body = server.buffer.slice(bodyStart, bodyStart + length);
    server.buffer = server.buffer.slice(bodyStart + length);
    try {
      const msg = JSON.parse(body);
      if (msg.id !== undefined && server.pending.has(msg.id)) {
        const p = server.pending.get(msg.id)!;
        server.pending.delete(msg.id);
        if (msg.error) p.reject(msg.error);
        else p.resolve(msg.result);
      }
      // Capture push diagnostics
      if (msg.method === "textDocument/publishDiagnostics" && msg.params) {
        server.diagnostics.set(msg.params.uri, msg.params.diagnostics || []);
      }
    } catch { }
  }
}

// ── Server lifecycle ────────────────────────────────────────────────

const servers = new Map<string, LSPServer>();
const IDLE_MS = 120_000;

function findProjectRoot(filePath: string): string | null {
  let dir = dirname(resolve(filePath));
  for (let i = 0; i < 15; i++) {
    if (existsSync(join(dir, "tsconfig.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function getServer(root: string): Promise<LSPServer | null> {
  if (servers.has(root)) return servers.get(root)!;

  try {
    const proc = spawn("tsgo", ["--lsp", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    const server: LSPServer = {
      proc, root, nextId: 1, pending: new Map(), buffer: "",
      initialized: false, lastActivity: Date.now(),
      openFiles: new Set(), version: new Map(), diagnostics: new Map(),
    };

    proc.stdout!.on("data", (d: Buffer) => handleData(server, d.toString()));
    proc.stderr!.on("data", () => { }); // swallow
    proc.on("exit", () => { servers.delete(root); });

    servers.set(root, server);

    // Initialize
    await send(server, "initialize", {
      processId: process.pid,
      rootUri: `file://${root}`,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: {},
          references: {},
          completion: { completionItem: { snippetSupport: false } },
          diagnostic: {},
        },
      },
    });

    send(server, "initialized", {}, true);
    server.initialized = true;
    return server;
  } catch {
    return null;
  }
}

function fileUri(path: string): string {
  return `file://${resolve(path)}`;
}

function langId(path: string): string {
  if (path.endsWith(".tsx")) return "typescriptreact";
  if (path.endsWith(".jsx")) return "javascriptreact";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "javascript";
  return "typescript";
}

async function openFile(server: LSPServer, filePath: string) {
  const uri = fileUri(filePath);
  if (server.openFiles.has(uri)) return;
  const content = readFileSync(filePath, "utf-8");
  server.version.set(uri, 1);
  server.openFiles.add(uri);
  send(server, "textDocument/didOpen", {
    textDocument: { uri, languageId: langId(filePath), version: 1, text: content },
  }, true);
}

async function updateFile(server: LSPServer, filePath: string) {
  const uri = fileUri(filePath);
  const content = readFileSync(filePath, "utf-8");
  const v = (server.version.get(uri) || 1) + 1;
  server.version.set(uri, v);
  if (!server.openFiles.has(uri)) {
    await openFile(server, filePath);
    return;
  }
  send(server, "textDocument/didChange", {
    textDocument: { uri, version: v },
    contentChanges: [{ text: content }],
  }, true);
}

function shutdownServer(server: LSPServer) {
  try {
    send(server, "shutdown", null).catch(() => { });
    setTimeout(() => { try { server.proc.kill(); } catch { } }, 1000);
  } catch { }
  servers.delete(server.root);
}

// Idle cleanup
setInterval(() => {
  const now = Date.now();
  for (const [root, server] of servers) {
    if (now - server.lastActivity > IDLE_MS) shutdownServer(server);
  }
}, 30_000);

// ── Formatting helpers ──────────────────────────────────────────────

function formatDiagnostics(server: LSPServer, root: string): string {
  const lines: string[] = [];
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const [uri, diags] of server.diagnostics) {
    if (diags.length === 0) continue;
    const filePath = uri.replace("file://", "");
    const relPath = relative(root, filePath);
    for (const d of diags) {
      const sev = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
      if (d.severity === 1) totalErrors++;
      if (d.severity === 2) totalWarnings++;
      const line = (d.range?.start?.line ?? 0) + 1;
      const col = (d.range?.start?.character ?? 0) + 1;
      const code = d.code ? ` TS${d.code}` : "";
      lines.push(`${relPath}:${line}:${col} ${sev}${code}: ${d.message}`);
    }
  }

  if (lines.length === 0) return "";
  return `${totalErrors} error(s), ${totalWarnings} warning(s):\n${lines.slice(0, 20).join("\n")}${lines.length > 20 ? `\n... and ${lines.length - 20} more` : ""}`;
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let enabled = true;
  const touchedFiles = new Set<string>();

  // Track TS file writes/edits
  pi.on("tool_result", async (event) => {
    if (!enabled) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const filePath = event.input?.path;
    if (!filePath) return;
    const resolved = resolve(filePath);
    if (!resolved.match(/\.[jt]sx?$/)) return;
    touchedFiles.add(resolved);

    // Feed to LSP immediately so it can process in background
    const root = findProjectRoot(resolved);
    if (!root) return;
    const server = await getServer(root);
    if (server) await updateFile(server, resolved);
  });

  // Report diagnostics at end of turn
  pi.on("agent_end", async (_event, ctx) => {
    if (!enabled || touchedFiles.size === 0) return;
    const files = [...touchedFiles];
    touchedFiles.clear();

    const root = findProjectRoot(files[0]!);
    if (!root) return;
    const server = await getServer(root);
    if (!server) return;

    // Give LSP a moment to finish processing
    await new Promise(r => setTimeout(r, 1500));

    // Pull diagnostics
    try {
      for (const f of files) {
        await send(server, "textDocument/diagnostic", {
          textDocument: { uri: fileUri(f) },
        }).catch(() => { });
      }
      await new Promise(r => setTimeout(r, 500));
    } catch { }

    const report = formatDiagnostics(server, root);
    const theme = ctx.ui.theme;
    if (report) {
      const errorCount = (report.match(/error/g) || []).length;
      ctx.ui.setWidget("ts-check", [theme.fg("error", "●") + " " + theme.fg("dim", `tsgo: ${errorCount} issue${errorCount > 1 ? "s" : ""}`)]);
      ctx.ui.notify(`TypeScript issues:\n${report.split("\n").slice(0, 8).join("\n")}`, "warning");
    } else {
      ctx.ui.setWidget("ts-check", [theme.fg("success", "●") + " " + theme.fg("dim", "tsgo: clean")]);
      setTimeout(() => ctx.ui.setWidget("ts-check", undefined), 5000);
    }
  });

  // On-demand LSP tool
  pi.registerTool({
    name: "ts_lsp",
    label: "TypeScript LSP",
    description: "Query tsgo LSP — hover, definitions, references, diagnostics for TypeScript/JavaScript files. Powered by TypeScript 7 native compiler.",
    parameters: Type.Object({
      file: Type.String({ description: "File path" }),
      action: Type.Union([
        Type.Literal("hover"),
        Type.Literal("definition"),
        Type.Literal("references"),
        Type.Literal("diagnostics"),
        Type.Literal("symbols"),
      ], { description: "LSP action" }),
      line: Type.Optional(Type.Number({ description: "1-indexed line number (for hover/definition/references)" })),
      column: Type.Optional(Type.Number({ description: "1-indexed column (for hover/definition/references)" })),
    }),
    async execute(_id, params) {
      const filePath = resolve(params.file);
      if (!existsSync(filePath)) return { content: [{ type: "text", text: `File not found: ${params.file}` }], details: {} };

      const root = findProjectRoot(filePath);
      if (!root) return { content: [{ type: "text", text: "No tsconfig.json found" }], details: {} };

      const server = await getServer(root);
      if (!server) return { content: [{ type: "text", text: "Failed to start tsgo LSP" }], details: {} };

      await openFile(server, filePath);
      const uri = fileUri(filePath);
      const pos = { line: (params.line || 1) - 1, character: (params.column || 1) - 1 };

      try {
        switch (params.action) {
          case "hover": {
            const r = await send(server, "textDocument/hover", { textDocument: { uri }, position: pos });
            if (!r || !r.contents) return { content: [{ type: "text", text: "No hover info" }], details: {} };
            const text = typeof r.contents === "string" ? r.contents
              : r.contents.value || JSON.stringify(r.contents);
            return { content: [{ type: "text", text }], details: {} };
          }
          case "definition": {
            const r = await send(server, "textDocument/definition", { textDocument: { uri }, position: pos });
            if (!r || (Array.isArray(r) && r.length === 0)) return { content: [{ type: "text", text: "No definition found" }], details: {} };
            const defs = Array.isArray(r) ? r : [r];
            const text = defs.map((d: any) => {
              const u = (d.targetUri || d.uri || "").replace("file://", "");
              const l = (d.targetRange || d.range)?.start;
              return `${relative(root, u)}:${(l?.line ?? 0) + 1}:${(l?.character ?? 0) + 1}`;
            }).join("\n");
            return { content: [{ type: "text", text }], details: {} };
          }
          case "references": {
            const r = await send(server, "textDocument/references", {
              textDocument: { uri }, position: pos, context: { includeDeclaration: true },
            });
            if (!r || r.length === 0) return { content: [{ type: "text", text: "No references found" }], details: {} };
            const text = r.slice(0, 20).map((ref: any) => {
              const u = (ref.uri || "").replace("file://", "");
              return `${relative(root, u)}:${(ref.range?.start?.line ?? 0) + 1}`;
            }).join("\n");
            return { content: [{ type: "text", text: `${r.length} references:\n${text}` }], details: {} };
          }
          case "diagnostics": {
            await updateFile(server, filePath);
            await new Promise(r => setTimeout(r, 1000));
            try {
              await send(server, "textDocument/diagnostic", { textDocument: { uri } });
              await new Promise(r => setTimeout(r, 500));
            } catch { }
            const report = formatDiagnostics(server, root);
            return { content: [{ type: "text", text: report || "No diagnostics" }], details: {} };
          }
          case "symbols": {
            const r = await send(server, "textDocument/documentSymbol", { textDocument: { uri } });
            if (!r || r.length === 0) return { content: [{ type: "text", text: "No symbols" }], details: {} };
            const fmt = (s: any, indent = 0): string => {
              const prefix = "  ".repeat(indent);
              const kind = ["", "File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field", "Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String", "Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct", "Event", "Operator", "TypeParameter"][s.kind] || `kind:${s.kind}`;
              const line = (s.range || s.selectionRange)?.start?.line ?? 0;
              let text = `${prefix}${kind} ${s.name} (L${line + 1})`;
              if (s.children) text += "\n" + s.children.map((c: any) => fmt(c, indent + 1)).join("\n");
              return text;
            };
            return { content: [{ type: "text", text: r.map((s: any) => fmt(s)).join("\n") }], details: {} };
          }
        }
      } catch (e: any) {
        return { content: [{ type: "text", text: `LSP error: ${e.message || e}` }], details: {} };
      }
      return { content: [{ type: "text", text: "Unknown action" }], details: {} };
    },
  });

  // Toggle command
  pi.registerCommand("ts-check", {
    description: "Toggle tsgo diagnostics after edits",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.notify(`tsgo checking: ${enabled ? "enabled" : "disabled"}`, "info");
      if (!enabled) ctx.ui.setWidget("ts-check", undefined);
    },
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", () => {
    for (const server of servers.values()) shutdownServer(server);
  });
}
