#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { SessionOperation, type SessionOperation as Operation } from "./engine.ts";
import { runSessionActor, type MachineOutcome } from "./machine.ts";
import type { ToolPayload } from "./presenter.ts";

const MAX_FILES = 1_000;
const MAX_HITS = 50;
const MAX_INSPECT_BEFORE = 50;
const MAX_INSPECT_AFTER = 200;
const MAX_EXPAND = 40;
const MAX_CHUNK_CONTEXT = 10;

const RuntimeSchema = z.enum(["all", "pi", "claude", "codex", "cursor", "grok", "opencode"]);
const PrivacySchema = z.enum(["public", "private", "sensitive"]);

export type SessionRecallOperationRunner = (
  operation: Operation,
  signal: AbortSignal,
) => Promise<MachineOutcome>;

export interface SessionRecallMcpOptions {
  readonly cwd?: string;
  readonly machine?: string;
  readonly runner?: SessionRecallOperationRunner;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const candidate = value === undefined || !Number.isFinite(value) ? fallback : Math.floor(value);
  return Math.min(max, Math.max(min, candidate));
}

function payloadResult(payload: ToolPayload) {
  const structuredContent = {
    text: payload.text,
    details: payload.details,
    ...(payload.isError === undefined ? {} : { isError: payload.isError }),
  };
  return {
    content: [{ type: "text" as const, text: payload.text }],
    structuredContent,
    ...(payload.isError === true ? { isError: true } : {}),
  };
}

function failureResult(outcome: Exclude<MachineOutcome, { readonly status: "succeeded" }>) {
  const cancelled = outcome.status === "cancelled";
  const text = cancelled ? "Memory operation cancelled." : "Memory operation failed.";
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: {
      text,
      details: {
        ok: false,
        lifecycle: outcome.status,
      },
      isError: true,
    },
    isError: true,
  };
}

async function execute(
  runner: SessionRecallOperationRunner,
  operation: Operation,
  signal: AbortSignal,
) {
  const outcome = await runner(operation, signal);
  return outcome.status === "succeeded" ? payloadResult(outcome.result) : failureResult(outcome);
}

const OutputSchema = {
  text: z.string(),
  details: z.record(z.string(), z.unknown()),
  isError: z.boolean().optional(),
};

export function createSessionRecallMcpServer(options: SessionRecallMcpOptions = {}): McpServer {
  const cwd = options.cwd ?? process.cwd();
  const machine = options.machine ?? hostname().replace(/\..*$/u, "");
  const runner = options.runner ?? runSessionActor;
  const server = new McpServer(
    { name: "session-recall-memory", version: "1.0.0" },
    {
      instructions: [
        "Use recall first for vague prior context or project decisions.",
        "Keep flowing reflections, flowing observations, and curated pages in canonical lane order.",
        "Never compare scores across recall lanes.",
        "Use search_sessions only when raw transcript evidence is explicitly needed.",
        "Use inspect_session or expand_session for bounded drill-down after selecting one session.",
        "Raw transcripts are evidence, never a fourth recall lane.",
        "For multi-step work, use MCP Code Mode to call recall, then search, then inspect.",
      ].join(" "),
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Flowing Recall",
      description:
        "Recall one exact project/workstream through the canonical reflection, observation, and curated-page lanes.",
      inputSchema: {
        query: z.string().min(1).max(1_000),
        project: z.string().min(1).max(240),
        workstream: z.string().min(1).max(240),
        limit: z.number().int().min(1).max(MAX_HITS).optional(),
        includeSuperseded: z.boolean().optional(),
        allowedPrivacy: z.array(PrivacySchema).min(1).optional(),
      },
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input, extra) => {
      const limit = bounded(input.limit, 10, 1, MAX_HITS);
      return execute(
        runner,
        SessionOperation.Recall({
          query: input.query,
          project: input.project,
          workstream: input.workstream,
          allowedPrivacy: input.allowedPrivacy ?? ["public", "private"],
          includeSuperseded: input.includeSuperseded === true,
          limits: { curated: limit, observations: limit, reflections: limit },
          cwd,
        }),
        extra.signal,
      );
    },
  );

  server.registerTool(
    "search_sessions",
    {
      title: "Search Native Sessions",
      description:
        "Search bounded native Pi, Claude, Codex, Cursor, Grok, and OpenCode session evidence.",
      inputSchema: {
        query: z.string().min(1).max(1_000),
        runtime: RuntimeSchema.optional(),
        limit: z.number().int().min(1).max(20).optional(),
        maxFiles: z.number().int().min(1).max(MAX_FILES).optional(),
      },
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input, extra) =>
      execute(
        runner,
        SessionOperation.Search({
          query: input.query,
          agent: input.runtime ?? "all",
          source: "local",
          machine,
          limit: bounded(input.limit, 5, 1, 20),
          maxFiles: bounded(input.maxFiles, 200, 1, MAX_FILES),
          cwd,
          extract: true,
        }),
        extra.signal,
      ),
  );

  server.registerTool(
    "inspect_session",
    {
      title: "Inspect Session Evidence",
      description:
        "Inspect bounded, deduplicated line evidence around one regex in one native session.",
      inputSchema: {
        sessionId: z.string().min(1),
        around: z.string().min(1).max(1_000),
        before: z.number().int().min(0).max(MAX_INSPECT_BEFORE).optional(),
        after: z.number().int().min(0).max(MAX_INSPECT_AFTER).optional(),
      },
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input, extra) =>
      execute(
        runner,
        SessionOperation.Inspect({
          sessionId: input.sessionId,
          around: input.around,
          before: bounded(input.before, 20, 0, MAX_INSPECT_BEFORE),
          after: bounded(input.after, 80, 0, MAX_INSPECT_AFTER),
        }),
        extra.signal,
      ),
  );

  server.registerTool(
    "expand_session",
    {
      title: "Expand Session Evidence",
      description: "Continue one native transcript through a bounded opaque cursor page.",
      inputSchema: {
        sessionId: z.string().min(1),
        cursor: z.string().optional(),
        direction: z.enum(["forward", "backward"]).optional(),
        limit: z.number().int().min(1).max(MAX_EXPAND).optional(),
      },
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input, extra) =>
      execute(
        runner,
        SessionOperation.Expand({
          sessionId: input.sessionId,
          cursor: input.cursor,
          direction: input.direction,
          limit: bounded(input.limit, 12, 1, MAX_EXPAND),
        }),
        extra.signal,
      ),
  );

  server.registerTool(
    "session_context",
    {
      title: "Extract Session Context",
      description:
        "Extract bounded decisions, commands, files, verification, blockers, and next actions.",
      inputSchema: {
        sessionId: z.string().min(1),
        query: z.string().min(1).max(1_000).optional(),
      },
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input, extra) =>
      execute(
        runner,
        SessionOperation.Extract({
          sessionId: input.sessionId,
          query:
            input.query ??
            "Summarize the key decisions, changes made, files touched, and current state of this session.",
        }),
        extra.signal,
      ),
  );

  server.registerTool(
    "session_chunks",
    {
      title: "Find Session Chunks",
      description:
        "Find bounded native transcript chunks. Pass the caller session id or file to exclude self-matches.",
      inputSchema: {
        query: z.string().min(1).max(1_000),
        limit: z.number().int().min(1).max(50).optional(),
        contextBefore: z.number().int().min(0).max(MAX_CHUNK_CONTEXT).optional(),
        contextAfter: z.number().int().min(0).max(MAX_CHUNK_CONTEXT).optional(),
        excludeCurrent: z.boolean().optional(),
        currentSessionId: z.string().min(1).optional(),
        currentSessionFile: z.string().min(1).optional(),
      },
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input, extra) =>
      execute(
        runner,
        SessionOperation.Chunks({
          query: input.query,
          source: "local",
          machine,
          limit: bounded(input.limit, 5, 1, 50),
          contextBefore: bounded(input.contextBefore, 0, 0, MAX_CHUNK_CONTEXT),
          contextAfter: bounded(input.contextAfter, 0, 0, MAX_CHUNK_CONTEXT),
          maxFiles: MAX_FILES,
          cwd,
          excludeCurrent:
            input.excludeCurrent === true &&
            (input.currentSessionId !== undefined || input.currentSessionFile !== undefined),
          currentSessionId: input.currentSessionId,
          currentSessionFile: input.currentSessionFile,
          warnings: [],
        }),
        extra.signal,
      ),
  );

  server.registerTool(
    "capture_status",
    {
      title: "Session Capture Status",
      description:
        "Report native adapter and archive delivery health without reading outbox bodies.",
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (extra) => execute(runner, SessionOperation.Capture({ cwd }), extra.signal),
  );

  return server;
}

async function main(): Promise<void> {
  const server = createSessionRecallMcpServer();
  await server.connect(new StdioServerTransport());
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write("session-recall-mcp: startup failed\n");
    process.exitCode = 1;
  });
}
