/**
 * mcp-bridge — Generic MCP client bridge for pi.
 *
 * Connects to any remote MCP server via Streamable HTTP with OAuth support.
 * Dynamically registers all server tools into pi, prefixed by server name.
 *
 * State is stored in ~/.pi/mcp-bridge/:
 *   servers.json               — Registry of configured servers
 *   client-<name>.json         — OAuth client registration per server
 *   tokens-<name>.json         — OAuth tokens per server
 *   verifier-<name>.json       — PKCE verifier per server
 *
 * Commands:
 *   /mcp-add <name> <url>      — Register a new MCP server
 *   /mcp-remove <name>         — Remove server config and tokens
 *   /mcp-login <name>          — Run OAuth flow (opens browser)
 *   /mcp-logout <name>         — Clear tokens for a server
 *   /mcp-list                  — Show all servers and status
 *   /mcp-reconnect [name]      — Reconnect one or all servers
 *
 * On session start, auto-connects to all servers with saved tokens.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientProvider,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer, type Server } from "node:http";
import { execSync } from "node:child_process";

// ── Config ──────────────────────────────────────────────────────────
const BRIDGE_DIR = join(homedir(), ".pi", "mcp-bridge");
const SERVERS_FILE = join(BRIDGE_DIR, "servers.json");
const BASE_PORT = 19543; // Linear bridge uses 19542

interface ServerConfig {
  name: string;
  url: string;
  port: number; // Callback port for OAuth
}

interface ServerState {
  client: Client | null;
  transport: StreamableHTTPClientTransport | null;
  connected: boolean;
  tools: string[]; // Registered tool names
}

// ── File helpers ────────────────────────────────────────────────────
function ensureDir() {
  if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function writeJson(path: string, data: unknown) {
  ensureDir();
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function removeFile(path: string) {
  try {
    unlinkSync(path);
  } catch {}
}

function clientFile(name: string) {
  return join(BRIDGE_DIR, `client-${name}.json`);
}
function tokensFile(name: string) {
  return join(BRIDGE_DIR, `tokens-${name}.json`);
}
function verifierFile(name: string) {
  return join(BRIDGE_DIR, `verifier-${name}.json`);
}

function loadServers(): ServerConfig[] {
  return readJson<ServerConfig[]>(SERVERS_FILE) ?? [];
}

function saveServers(servers: ServerConfig[]) {
  writeJson(SERVERS_FILE, servers);
}

function getServer(name: string): ServerConfig | undefined {
  return loadServers().find((s) => s.name === name);
}

function nextPort(): number {
  const servers = loadServers();
  if (servers.length === 0) return BASE_PORT;
  return Math.max(...servers.map((s) => s.port)) + 1;
}

// ── OAuth Provider (per-server) ─────────────────────────────────────

class McpOAuthProvider implements OAuthClientProvider {
  private _codeVerifier: string | undefined;
  private _callbackServer: Server | undefined;
  private _serverName: string;
  private _port: number;

  constructor(serverName: string, port: number) {
    this._serverName = serverName;
    this._port = port;
  }

  get redirectUrl() {
    return `http://127.0.0.1:${this._port}/oauth/callback`;
  }

  get clientMetadata() {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none" as const,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: `pi-mcp-bridge (${this._serverName})`,
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return readJson<OAuthClientInformationMixed>(clientFile(this._serverName));
  }

  saveClientInformation(info: OAuthClientInformationMixed) {
    writeJson(clientFile(this._serverName), info);
  }

  tokens(): OAuthTokens | undefined {
    return readJson<OAuthTokens>(tokensFile(this._serverName));
  }

  saveTokens(tokens: OAuthTokens) {
    writeJson(tokensFile(this._serverName), tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    try {
      execSync(`open "${authorizationUrl.toString()}"`, { stdio: "ignore" });
    } catch {
      console.log(`Authorize at: ${authorizationUrl.toString()}`);
    }
  }

  saveCodeVerifier(codeVerifier: string) {
    this._codeVerifier = codeVerifier;
    writeJson(verifierFile(this._serverName), { codeVerifier });
  }

  codeVerifier(): string {
    if (this._codeVerifier) return this._codeVerifier;
    const saved = readJson<{ codeVerifier: string }>(verifierFile(this._serverName));
    if (saved?.codeVerifier) return saved.codeVerifier;
    throw new Error("No code verifier found");
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier") {
    if (scope === "all" || scope === "tokens") removeFile(tokensFile(this._serverName));
    if (scope === "all" || scope === "client") removeFile(clientFile(this._serverName));
    if (scope === "all" || scope === "verifier") removeFile(verifierFile(this._serverName));
  }

  /** Start local HTTP server to capture OAuth callback. Resolves with auth code. */
  waitForCallback(): Promise<string> {
    return new Promise((resolve, reject) => {
      this._callbackServer = createServer((req, res) => {
        const url = new URL(req.url || "/", `http://127.0.0.1:${this._port}`);
        if (url.pathname !== "/oauth/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h2>Authorization failed</h2><p>${error}</p><p>You can close this tab.</p></body></html>`
          );
          this._callbackServer?.close();
          this._callbackServer = undefined;
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h2>Missing authorization code</h2><p>You can close this tab.</p></body></html>`
          );
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>✅ ${this._serverName} connected!</h2><p>You can close this tab and return to pi.</p></body></html>`
        );
        this._callbackServer?.close();
        this._callbackServer = undefined;
        resolve(code);
      });

      this._callbackServer.listen(this._port, "127.0.0.1");

      setTimeout(() => {
        this._callbackServer?.close();
        this._callbackServer = undefined;
        reject(new Error("OAuth callback timeout (2 minutes)"));
      }, 120_000);
    });
  }

  stopCallbackServer() {
    this._callbackServer?.close();
    this._callbackServer = undefined;
  }
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const states = new Map<string, ServerState>();
  let _footerTui: { requestRender: () => void } | undefined;

  function text(s: string) {
    return { content: [{ type: "text" as const, text: s }], details: {} };
  }

  function truncate(s: string, max = 50000): string {
    return s.length > max ? s.slice(0, max) + "\n\n... (truncated)" : s;
  }

  /** Trigger a footer re-render (e.g. when mcp connection state changes). */
  function refreshFooter() {
    _footerTui?.requestRender();
  }

  /** Build the mcp label for the footer, e.g. "mcp 1/2". Empty string if no servers. */
  function getMcpLabel(): string {
    const servers = loadServers();
    if (servers.length === 0) return "";
    const connected = servers.filter(
      (s) => states.get(s.name)?.connected
    ).length;
    return `mcp ${connected}/${servers.length}`;
  }

  /**
   * Register a single MCP tool as a pi tool.
   */
  function registerMcpTool(
    serverName: string,
    tool: { name: string; description?: string; inputSchema?: any },
    getClient: () => Client | null,
    isConnected: () => boolean
  ): string {
    const toolName = `${serverName}_${tool.name}`;

    pi.registerTool({
      name: toolName,
      label: `${serverName}: ${tool.name}`,
      description: tool.description || `MCP tool from ${serverName}: ${tool.name}`,
      parameters: (tool.inputSchema || {}) as any,
      async execute(_id, params) {
        const client = getClient();
        if (!client || !isConnected()) {
          return text(`❌ Not connected to ${serverName}. Run /mcp-login ${serverName}`);
        }

        try {
          const result = await client.callTool({
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

          return text(truncate(parts.join("\n\n") || "✓ Done"));
        } catch (err: any) {
          if (
            err.message?.includes("Unauthorized") ||
            err.message?.includes("401")
          ) {
            const state = states.get(serverName);
            if (state) state.connected = false;
            return text(
              `❌ ${serverName} session expired. Run /mcp-login ${serverName}`
            );
          }
          return text(`❌ ${serverName} error: ${err.message}`);
        }
      },
    });

    return toolName;
  }

  /**
   * Connect to a server and register its tools.
   * Returns true on success.
   */
  async function connectServer(
    config: ServerConfig,
    ctx?: ExtensionContext
  ): Promise<boolean> {
    const existing = states.get(config.name);
    if (existing?.connected) return true;

    const authProvider = new McpOAuthProvider(config.name, config.port);
    const tokens = authProvider.tokens();
    if (!tokens) return false;

    try {
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider,
      });
      const client = new Client({
        name: `pi-mcp-bridge-${config.name}`,
        version: "1.0.0",
      });

      await client.connect(transport);

      const { tools } = await client.listTools();
      const toolNames: string[] = [];

      for (const tool of tools) {
        const name = registerMcpTool(
          config.name,
          tool,
          () => states.get(config.name)?.client ?? null,
          () => states.get(config.name)?.connected ?? false
        );
        toolNames.push(name);
      }

      states.set(config.name, {
        client,
        transport,
        connected: true,
        tools: toolNames,
      });

      refreshFooter();
      return true;
    } catch (err: any) {
      states.set(config.name, {
        client: null,
        transport: null,
        connected: false,
        tools: [],
      });

      if (
        err.constructor?.name === "UnauthorizedError" ||
        err.message?.includes("Unauthorized")
      ) {
        refreshFooter();
        return false;
      }

      ctx?.ui.notify(`MCP ${config.name}: ${err.message}`, "error");
      refreshFooter();
      return false;
    }
  }

  /**
   * Disconnect a server.
   */
  async function disconnectServer(name: string) {
    const state = states.get(name);
    if (!state) return;
    try {
      if (state.transport) await (state.transport as any).close();
    } catch {}
    states.set(name, {
      client: null,
      transport: null,
      connected: false,
      tools: [],
    });
  }

  /**
   * Full OAuth login flow for a server.
   */
  async function loginServer(
    config: ServerConfig,
    ctx: ExtensionContext
  ): Promise<boolean> {
    await disconnectServer(config.name);

    const authProvider = new McpOAuthProvider(config.name, config.port);
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      authProvider,
    });
    const client = new Client({
      name: `pi-mcp-bridge-${config.name}`,
      version: "1.0.0",
    });

    ctx.ui.notify(`Opening browser for ${config.name} authorization...`, "info");

    const callbackPromise = authProvider.waitForCallback();

    try {
      await client.connect(transport);
      // If we get here, tokens were already valid
    } catch (err: any) {
      if (
        err.constructor?.name === "UnauthorizedError" ||
        err.message?.includes("Unauthorized")
      ) {
        ctx.ui.notify(
          `Waiting for ${config.name} authorization in browser...`,
          "info"
        );

        try {
          const code = await callbackPromise;
          await transport.finishAuth(code);

          // Reconnect with fresh tokens
          const freshTransport = new StreamableHTTPClientTransport(
            new URL(config.url),
            { authProvider }
          );
          const freshClient = new Client({
            name: `pi-mcp-bridge-${config.name}`,
            version: "1.0.0",
          });
          await freshClient.connect(freshTransport);

          // List and register tools
          const { tools } = await freshClient.listTools();
          const toolNames: string[] = [];

          for (const tool of tools) {
            const toolName = registerMcpTool(
              config.name,
              tool,
              () => states.get(config.name)?.client ?? null,
              () => states.get(config.name)?.connected ?? false
            );
            toolNames.push(toolName);
          }

          states.set(config.name, {
            client: freshClient,
            transport: freshTransport,
            connected: true,
            tools: toolNames,
          });

          refreshFooter();
          ctx.ui.notify(
            `${config.name} connected — ${tools.length} tools`,
            "success"
          );
          return true;
        } catch (authErr: any) {
          authProvider.stopCallbackServer();
          ctx.ui.notify(
            `${config.name} auth failed: ${authErr.message}`,
            "error"
          );
          return false;
        }
      } else {
        authProvider.stopCallbackServer();
        ctx.ui.notify(
          `${config.name} connection failed: ${err.message}`,
          "error"
        );
        return false;
      }
    }

    // Tokens were already valid — register tools
    try {
      const { tools } = await client.listTools();
      const toolNames: string[] = [];

      for (const tool of tools) {
        const toolName = registerMcpTool(
          config.name,
          tool,
          () => states.get(config.name)?.client ?? null,
          () => states.get(config.name)?.connected ?? false
        );
        toolNames.push(toolName);
      }

      states.set(config.name, {
        client,
        transport,
        connected: true,
        tools: toolNames,
      });

      refreshFooter();
      ctx.ui.notify(
        `${config.name} connected — ${tools.length} tools`,
        "success"
      );
      return true;
    } catch (err: any) {
      ctx.ui.notify(
        `${config.name} connected but tool list failed: ${err.message}`,
        "error"
      );
      return false;
    }
  }

  // ── Custom footer with mcp status ───────────────────────────────
  function installFooter(ctx: ExtensionContext) {
    ctx.ui.setFooter((tui, theme, footerData) => {
      _footerTui = tui;
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          // ── Line 1: [mcp N/M]  ~/path (branch) [• session] ──
          let pwd = process.cwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) pwd = `${pwd} • ${sessionName}`;

          const mcpLabel = getMcpLabel();
          let line1: string;
          if (mcpLabel) {
            const pwdWidth = visibleWidth(pwd);
            const labelWidth = visibleWidth(mcpLabel);
            const gap = width - pwdWidth - labelWidth;
            if (gap >= 2) {
              line1 = pwd + " ".repeat(gap) + mcpLabel;
            } else {
              // Not enough room — truncate pwd to make space
              const maxPwd = width - labelWidth - 2;
              line1 = maxPwd > 3
                ? truncateToWidth(pwd, maxPwd) + "  " + mcpLabel
                : truncateToWidth(pwd, width);
            }
          } else {
            line1 = truncateToWidth(pwd, width);
          }

          // ── Line 2: token stats + context + model ──
          let totalInput = 0, totalOutput = 0;
          let totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
          let thinkingLevel = "off";
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && (entry as any).message?.role === "assistant") {
              const m = (entry as any).message as AssistantMessage;
              totalInput += m.usage.input;
              totalOutput += m.usage.output;
              totalCacheRead += m.usage.cacheRead;
              totalCacheWrite += m.usage.cacheWrite;
              totalCost += m.usage.cost.total;
            } else if ((entry as any).type === "thinking_level_change") {
              thinkingLevel = (entry as any).thinkingLevel;
            }
          }

          const fmt = (n: number) => {
            if (n < 1000) return n.toString();
            if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
            if (n < 1000000) return `${Math.round(n / 1000)}k`;
            if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
            return `${Math.round(n / 1000000)}M`;
          };

          const statsParts: string[] = [];
          if (totalInput) statsParts.push(`↑${fmt(totalInput)}`);
          if (totalOutput) statsParts.push(`↓${fmt(totalOutput)}`);
          if (totalCacheRead) statsParts.push(`R${fmt(totalCacheRead)}`);
          if (totalCacheWrite) statsParts.push(`W${fmt(totalCacheWrite)}`);

          const usingSubscription = ctx.model
            ? ctx.modelRegistry.isUsingOAuth(ctx.model)
            : false;
          if (totalCost || usingSubscription) {
            const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
            statsParts.push(costStr);
          }

          // Context usage
          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercentDisplay = contextUsage?.percent !== null
            ? `${contextPercentValue.toFixed(1)}%/${fmt(contextWindow)} (auto)`
            : `?/${fmt(contextWindow)} (auto)`;
          let contextPercentStr: string;
          if (contextPercentValue > 90) {
            contextPercentStr = theme.fg("error", contextPercentDisplay);
          } else if (contextPercentValue > 70) {
            contextPercentStr = theme.fg("warning", contextPercentDisplay);
          } else {
            contextPercentStr = contextPercentDisplay;
          }
          statsParts.push(contextPercentStr);

          let statsLeft = statsParts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width);
            statsLeftWidth = visibleWidth(statsLeft);
          }

          // Right side: model + thinking level
          const modelName = ctx.model?.id || "no-model";
          let rightSideBase = modelName;
          if (ctx.model?.reasoning) {
            rightSideBase = thinkingLevel === "off"
              ? `${modelName} • thinking off`
              : `${modelName} • ${thinkingLevel}`;
          }

          // Add provider prefix if multiple providers
          let rightSide = rightSideBase;
          if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
            const withProvider = `(${ctx.model.provider}) ${rightSideBase}`;
            if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) {
              rightSide = withProvider;
            }
          }

          const rightSideWidth = visibleWidth(rightSide);
          const minPadding = 2;
          let statsLine: string;
          if (statsLeftWidth + minPadding + rightSideWidth <= width) {
            const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
            statsLine = statsLeft + padding + rightSide;
          } else {
            const avail = width - statsLeftWidth - minPadding;
            if (avail > 3) {
              const truncRight = truncateToWidth(rightSide, avail);
              const padding = " ".repeat(width - statsLeftWidth - visibleWidth(truncRight));
              statsLine = statsLeft + padding + truncRight;
            } else {
              statsLine = statsLeft;
            }
          }

          const dimStatsLeft = theme.fg("dim", statsLeft);
          const remainder = statsLine.slice(statsLeft.length);
          const dimRemainder = theme.fg("dim", remainder);

          return [theme.fg("dim", line1), dimStatsLeft + dimRemainder];
        },
      };
    });
  }

  // ── Auto-connect on session start ─────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    installFooter(ctx);

    const servers = loadServers();
    if (servers.length === 0) return;

    const failed: string[] = [];
    for (const config of servers) {
      const ok = await connectServer(config, ctx);
      if (!ok) failed.push(config.name);
    }

    refreshFooter();

    if (failed.length > 0) {
      ctx.ui.notify(
        `mcp: ${failed.join(", ")} need /mcp-login`,
        "info"
      );
    }
  });

  // ── Cleanup on shutdown ───────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    for (const [name] of states) {
      await disconnectServer(name);
    }
  });

  // ── Commands ──────────────────────────────────────────────────────

  pi.registerCommand("mcp-add", {
    description: "Add an MCP server: /mcp-add <name> <url>",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /mcp-add <name> <url>", "error");
        return;
      }

      const [name, url] = parts;
      const servers = loadServers();

      if (servers.find((s) => s.name === name)) {
        ctx.ui.notify(`Server "${name}" already exists. Remove it first with /mcp-remove ${name}`, "error");
        return;
      }

      const config: ServerConfig = { name, url, port: nextPort() };
      servers.push(config);
      saveServers(servers);

      ctx.ui.notify(
        `Added ${name} → ${url} (port ${config.port}). Run /mcp-login ${name} to authenticate.`,
        "info"
      );
    },
  });

  pi.registerCommand("mcp-remove", {
    description: "Remove an MCP server: /mcp-remove <name>",
    handler: async (args, ctx) => {
      const name = (args || "").trim();
      if (!name) {
        ctx.ui.notify("Usage: /mcp-remove <name>", "error");
        return;
      }

      await disconnectServer(name);

      const servers = loadServers().filter((s) => s.name !== name);
      saveServers(servers);

      removeFile(tokensFile(name));
      removeFile(clientFile(name));
      removeFile(verifierFile(name));

      states.delete(name);
      refreshFooter();

      ctx.ui.notify(`Removed ${name} and cleared all credentials.`, "info");
    },
  });

  pi.registerCommand("mcp-login", {
    description: "Authenticate with an MCP server: /mcp-login <name>",
    handler: async (args, ctx) => {
      const name = (args || "").trim();
      if (!name) {
        ctx.ui.notify("Usage: /mcp-login <name>", "error");
        return;
      }

      const config = getServer(name);
      if (!config) {
        ctx.ui.notify(
          `Server "${name}" not found. Add it first with /mcp-add ${name} <url>`,
          "error"
        );
        return;
      }

      await loginServer(config, ctx);
    },
  });

  pi.registerCommand("mcp-logout", {
    description: "Clear tokens for an MCP server: /mcp-logout <name>",
    handler: async (args, ctx) => {
      const name = (args || "").trim();
      if (!name) {
        ctx.ui.notify("Usage: /mcp-logout <name>", "error");
        return;
      }

      await disconnectServer(name);
      removeFile(tokensFile(name));
      removeFile(verifierFile(name));

      refreshFooter();
      ctx.ui.notify(`${name}: tokens cleared, disconnected.`, "info");
    },
  });

  pi.registerCommand("mcp-reconnect", {
    description: "Reconnect MCP servers: /mcp-reconnect [name]",
    handler: async (args, ctx) => {
      const name = (args || "").trim();

      if (name) {
        const config = getServer(name);
        if (!config) {
          ctx.ui.notify(`Server "${name}" not found.`, "error");
          return;
        }
        await disconnectServer(name);
        const ok = await connectServer(config, ctx);
        refreshFooter();
        ctx.ui.notify(
          ok
            ? `${name} reconnected`
            : `${name} failed — try /mcp-login ${name}`,
          ok ? "info" : "error"
        );
      } else {
        const servers = loadServers();
        for (const config of servers) {
          await disconnectServer(config.name);
          await connectServer(config, ctx);
        }
        refreshFooter();
      }
    },
  });

  pi.registerCommand("mcp-list", {
    description: "List all configured MCP servers",
    handler: async (_args, ctx) => {
      const servers = loadServers();
      if (servers.length === 0) {
        ctx.ui.notify(
          "No MCP servers configured. Use /mcp-add <name> <url>",
          "info"
        );
        return;
      }

      const lines = ["MCP Servers\n"];
      for (const config of servers) {
        const state = states.get(config.name);
        const status = state?.connected ? "connected" : "disconnected";
        const toolCount = state?.tools.length ?? 0;
        lines.push(`  ${config.name} — ${status}, ${toolCount} tools`);
        lines.push(`    ${config.url}`);
        if (state?.tools.length) {
          for (const t of state.tools) lines.push(`    - ${t}`);
        }
        lines.push("");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── LLM tool for checking status ──────────────────────────────────
  pi.registerTool({
    name: "mcp_status",
    label: "MCP: Status",
    description:
      "List configured MCP servers, their connection status, and registered tools.",
    parameters: {} as any,
    async execute() {
      const servers = loadServers();
      if (servers.length === 0) {
        return text("No MCP servers configured.");
      }

      const lines: string[] = [];
      for (const config of servers) {
        const state = states.get(config.name);
        const status = state?.connected ? "connected" : "disconnected";
        lines.push(
          `${config.name}: ${status} (${state?.tools.length ?? 0} tools) — ${config.url}`
        );
        if (state?.tools.length) {
          for (const t of state.tools) lines.push(`  • ${t}`);
        }
      }
      return text(lines.join("\n"));
    },
  });
}
