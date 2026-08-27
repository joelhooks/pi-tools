#!/usr/bin/env node
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { SessionOperation, type SessionOperation as Operation } from "./engine.ts";
import { runSessionActor, type MachineOutcome } from "./machine.ts";
import type { ToolPayload } from "./presenter.ts";

const MAX_EVIDENCE_FILES = 200;
const MAX_HITS = 50;
const MAX_INSPECT_BEFORE = 50;
const MAX_INSPECT_AFTER = 200;
const MAX_EXPAND = 40;
const MAX_CHUNK_CONTEXT = 10;

const RuntimeSchema = z.enum(["all", "pi", "claude", "codex", "cursor", "grok", "opencode"]);
const PrivacySchema = z.enum(["public", "private", "sensitive"]);
const EvidenceReceiptPayloadSchema = z.object({
  version: z.literal(1),
  project: z.string().min(1).max(240),
  workstream: z.string().min(1).max(240),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  nonce: z.string().min(16).max(32),
});
const EVIDENCE_RECEIPT_TTL_MS = 10 * 60 * 1_000;
const evidenceReceiptKey = randomBytes(32);

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

function issueEvidenceReceipt(project: string, workstream: string): string {
  const issuedAt = Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      project,
      workstream,
      issuedAt,
      expiresAt: issuedAt + EVIDENCE_RECEIPT_TTL_MS,
      nonce: randomBytes(12).toString("base64url"),
    }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", evidenceReceiptKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function validEvidenceReceipt(receipt: string): boolean {
  try {
    const [payload, signature, extra] = receipt.split(".");
    if (!payload || !signature || extra !== undefined) return false;
    const supplied = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", evidenceReceiptKey).update(payload).digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    const decoded = EvidenceReceiptPayloadSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return decoded.issuedAt <= Date.now() && decoded.expiresAt >= Date.now();
  } catch {
    return false;
  }
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

async function executeRecall(
  runner: SessionRecallOperationRunner,
  operation: Operation,
  signal: AbortSignal,
  project: string,
  workstream: string,
) {
  const outcome = await runner(operation, signal);
  if (outcome.status !== "succeeded") return failureResult(outcome);
  return payloadResult({
    ...outcome.result,
    details: {
      ...outcome.result.details,
      evidenceDrilldownReceipt: issueEvidenceReceipt(project, workstream),
      evidenceDrilldownReceiptTtlSeconds: EVIDENCE_RECEIPT_TTL_MS / 1_000,
    },
  });
}

function evidenceGateFailureResult() {
  const text =
    "Raw session search requires a fresh recall receipt. Call recall first, then pass its evidenceDrilldownReceipt.";
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: {
      text,
      details: {
        ok: false,
        code: "recall-required-before-raw-evidence",
      },
      isError: true,
    },
    isError: true,
  };
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
        "Use recall for every memory request. It searches distilled reflections, observations, and curated pages.",
        "Recall scope is exact: project is usually owner.repo and workstream is usually main, default, or the current branch.",
        "Prefer one or two concrete query terms. Exact two-term matches rank first; three or more terms require every term.",
        "If recall reports No projection head, correct the scope instead of searching transcripts.",
        "Keep the three lanes in canonical order and never compare scores across them.",
        "Raw transcripts are evidence, never a recall lane.",
        "Only drill_down_session_evidence and drill_down_session_chunks scan native transcripts.",
        "Those tools require the signed receipt from a successful recall and reject direct broad search.",
        "Use inspect_session or expand_session after selecting one exact session.",
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
        query: z
          .string()
          .min(1)
          .max(1_000)
          .describe("Prefer one or two concrete terms. Exact two-term matches rank first; three or more terms require every term."),
        project: z
          .string()
          .min(1)
          .max(240)
          .describe("Exact persisted repository identity, commonly owner.repo."),
        workstream: z
          .string()
          .min(1)
          .max(240)
          .describe("Exact persisted branch or bookmark, commonly main or default."),
        limit: z.number().int().min(1).max(MAX_HITS).optional(),
        includeSuperseded: z.boolean().optional(),
        allowedPrivacy: z.array(PrivacySchema).min(1).optional(),
      },
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input, extra) => {
      const limit = bounded(input.limit, 10, 1, MAX_HITS);
      return executeRecall(
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
        input.project,
        input.workstream,
      );
    },
  );

  server.registerTool(
    "drill_down_session_evidence",
    {
      title: "Drill Down Into Session Evidence",
      description:
        "After recall, search a small bounded set of native sessions for exact supporting evidence. Never use for initial memory recall.",
      inputSchema: {
        query: z.string().min(1).max(1_000),
        evidenceDrilldownReceipt: z.string().min(1),
        runtime: RuntimeSchema.optional(),
        limit: z.number().int().min(1).max(20).optional(),
        maxFiles: z.number().int().min(1).max(MAX_EVIDENCE_FILES).optional(),
      },
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input, extra) => {
      if (!validEvidenceReceipt(input.evidenceDrilldownReceipt)) {
        return evidenceGateFailureResult();
      }
      return execute(
        runner,
        SessionOperation.Search({
          query: input.query,
          agent: input.runtime ?? "all",
          source: "local",
          machine,
          limit: bounded(input.limit, 5, 1, 20),
          maxFiles: bounded(input.maxFiles, 50, 1, MAX_EVIDENCE_FILES),
          cwd,
          extract: true,
        }),
        extra.signal,
      );
    },
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
    "drill_down_session_chunks",
    {
      title: "Drill Down Into Session Chunks",
      description:
        "After recall, return bounded transcript windows from exact supporting sessions. Never use for initial memory recall.",
      inputSchema: {
        query: z.string().min(1).max(1_000),
        evidenceDrilldownReceipt: z.string().min(1),
        limit: z.number().int().min(1).max(20).optional(),
        contextBefore: z.number().int().min(0).max(MAX_CHUNK_CONTEXT).optional(),
        contextAfter: z.number().int().min(0).max(MAX_CHUNK_CONTEXT).optional(),
        excludeCurrent: z.boolean().optional(),
        currentSessionId: z.string().min(1).optional(),
        currentSessionFile: z.string().min(1).optional(),
      },
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input, extra) => {
      if (!validEvidenceReceipt(input.evidenceDrilldownReceipt)) {
        return evidenceGateFailureResult();
      }
      return execute(
        runner,
        SessionOperation.Chunks({
          query: input.query,
          source: "local",
          machine,
          limit: bounded(input.limit, 5, 1, 20),
          contextBefore: bounded(input.contextBefore, 0, 0, MAX_CHUNK_CONTEXT),
          contextAfter: bounded(input.contextAfter, 0, 0, MAX_CHUNK_CONTEXT),
          maxFiles: MAX_EVIDENCE_FILES,
          cwd,
          excludeCurrent:
            input.excludeCurrent === true &&
            (input.currentSessionId !== undefined || input.currentSessionFile !== undefined),
          currentSessionId: input.currentSessionId,
          currentSessionFile: input.currentSessionFile,
          warnings: [],
        }),
        extra.signal,
      );
    },
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
