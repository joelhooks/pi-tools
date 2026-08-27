#!/usr/bin/env node
import { createServer, type Server as HttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  createSessionRecallMcpServer,
  type SessionRecallMcpOptions,
} from "./mcp-server.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4792;
const MIN_TOKEN_BYTES = 32;

export interface SessionRecallHttpOptions extends SessionRecallMcpOptions {
  readonly token: string;
}

export interface SessionRecallHttpRuntimeOptions extends SessionRecallHttpOptions {
  readonly host?: string;
  readonly port?: number;
}

function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function assertToken(token: string): void {
  if (Buffer.byteLength(token, "utf8") < MIN_TOKEN_BYTES) {
    throw new Error(`SESSION_RECALL_MCP_TOKEN must contain at least ${MIN_TOKEN_BYTES} bytes`);
  }
}

function localHost(header: string | undefined): boolean {
  if (header === undefined) return false;
  const hostname = header.replace(/:\d+$/u, "").toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost";
}

export function createSessionRecallMcpHttpApp(options: SessionRecallHttpOptions) {
  assertToken(options.token);
  const app = express();

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!localHost(request.header("host"))) {
      response.status(421).json({ status: "invalid-host" });
      return;
    }
    next();
  });

  app.get("/healthz", (_request: Request, response: Response) => {
    response.status(200).json({ status: "ok" });
  });

  app.use("/mcp", (request: Request, response: Response, next: NextFunction) => {
    if (!authorized(request.header("authorization"), options.token)) {
      response.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32_000, message: "Unauthorized" },
        id: null,
      });
      return;
    }
    next();
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (error instanceof SyntaxError) {
        response.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32_700, message: "Parse error" },
          id: null,
        });
        return;
      }
      next(error);
    },
  );

  app.post("/mcp", async (request: Request, response: Response) => {
    const server = createSessionRecallMcpServer(options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32_603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_request: Request, response: Response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32_000, message: "Method not allowed" },
      id: null,
    });
  });

  app.delete("/mcp", (_request: Request, response: Response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32_000, message: "Method not allowed" },
      id: null,
    });
  });

  return app;
}

export async function startSessionRecallMcpHttpServer(
  options: SessionRecallHttpRuntimeOptions,
): Promise<HttpServer> {
  const host = options.host ?? DEFAULT_HOST;
  if (host !== DEFAULT_HOST) throw new Error("session recall MCP must bind to 127.0.0.1");
  const port = options.port ?? DEFAULT_PORT;
  const app = createSessionRecallMcpHttpApp(options);
  const server = createServer(app);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  return server;
}

async function main(): Promise<void> {
  const token = process.env.SESSION_RECALL_MCP_TOKEN ?? "";
  const portValue = process.env.SESSION_RECALL_MCP_PORT;
  const port = portValue === undefined ? DEFAULT_PORT : Number.parseInt(portValue, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SESSION_RECALL_MCP_PORT must be a valid TCP port");
  }
  const server = await startSessionRecallMcpHttpServer({ token, port });
  process.stderr.write(`session-recall-mcp: listening on ${DEFAULT_HOST}:${port}\n`);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write("session-recall-mcp: HTTP startup failed\n");
    process.exitCode = 1;
  });
}
