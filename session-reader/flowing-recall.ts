import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

const MAX_RECALL_QUERY_LENGTH = 1_000;
const MAX_RECALL_HITS_PER_LANE = 50;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const SCOPE_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._/-]{0,238}[a-z0-9])?$/u;

const ScopeKeySchema = Schema.String;
const QuerySchema = Schema.String;
const LimitSchema = Schema.Number;
const PrivacySchema = Schema.Union([
  Schema.Literal("public"),
  Schema.Literal("private"),
  Schema.Literal("sensitive"),
]);
const LaneNameSchema = Schema.Union([
  Schema.Literal("flowing-reflections"),
  Schema.Literal("flowing-observations"),
  Schema.Literal("curated-pages"),
]);
const LaneAvailableSchema = Schema.Struct({
  _tag: Schema.Literal("RecallLaneAvailableV1"),
  lane: LaneNameSchema,
  source: Schema.String,
  scoreScale: Schema.String,
  health: Schema.Unknown,
  items: Schema.Array(Schema.Unknown),
});
const LaneUnavailableSchema = Schema.Struct({
  _tag: Schema.Literal("RecallLaneUnavailableV1"),
  lane: LaneNameSchema,
  source: Schema.String,
  code: Schema.String,
  message: Schema.String,
});
const LaneSchema = Schema.Union([LaneAvailableSchema, LaneUnavailableSchema]);

export const FlowingRecallInputSchema = Schema.Struct({
  query: QuerySchema,
  project: ScopeKeySchema,
  workstream: ScopeKeySchema,
  allowedPrivacy: Schema.Array(PrivacySchema),
  includeSuperseded: Schema.Boolean,
  limits: Schema.Struct({
    curated: LimitSchema,
    observations: LimitSchema,
    reflections: LimitSchema,
  }),
});
export type FlowingRecallInput = typeof FlowingRecallInputSchema.Type;

export const ComposedRecallResultBoundarySchema = Schema.Struct({
  _tag: Schema.Literal("ComposedRecallResultV1"),
  schemaVersion: Schema.Literal(1),
  lanes: Schema.Struct({
    flowingReflections: LaneSchema,
    flowingObservations: LaneSchema,
    curatedPages: LaneSchema,
  }),
  request: Schema.Unknown,
  resolvedAccess: Schema.Unknown,
  resolvedScope: Schema.Unknown,
  unavailable: Schema.Array(Schema.Unknown),
});
export type ComposedRecallResultBoundary = typeof ComposedRecallResultBoundarySchema.Type;

const RecallCliEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.String,
  result: Schema.Struct({
    adapter: Schema.String,
    composed: ComposedRecallResultBoundarySchema,
    curatedBackend: Schema.optional(Schema.String),
    timings: Schema.optional(Schema.Unknown),
  }),
  next_actions: Schema.optional(Schema.Array(Schema.Unknown)),
});

export type FlowingRecallErrorKind =
  | "cancelled"
  | "invalid-input"
  | "malformed-response"
  | "output-limit"
  | "process-failed"
  | "timeout";

export class FlowingRecallError extends Error {
  readonly _tag = "FlowingRecallError";
  readonly kind: FlowingRecallErrorKind;

  constructor(kind: FlowingRecallErrorKind) {
    super(`Flowing recall failed: ${kind}`);
    this.kind = kind;
    this.name = this._tag;
  }
}

export interface FlowingRecallResult {
  readonly adapter: string;
  readonly composed: ComposedRecallResultBoundary;
  readonly curatedBackend?: string;
  readonly timings?: unknown;
}

export interface FlowingRecallRunOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

export function buildComposedRecallRequest(input: FlowingRecallInput): unknown {
  const validated = Schema.decodeUnknownSync(FlowingRecallInputSchema)(input);
  const limits = Object.values(validated.limits);
  if (
    !validated.query.trim() ||
    validated.query.length > MAX_RECALL_QUERY_LENGTH ||
    !SCOPE_KEY_PATTERN.test(validated.project) ||
    !SCOPE_KEY_PATTERN.test(validated.workstream) ||
    validated.allowedPrivacy.length === 0 ||
    new Set(validated.allowedPrivacy).size !== validated.allowedPrivacy.length ||
    limits.some(
      (limit) => !Number.isInteger(limit) || limit < 1 || limit > MAX_RECALL_HITS_PER_LANE,
    )
  ) {
    throw new FlowingRecallError("invalid-input");
  }
  return {
    _tag: "ComposedRecallRequestV1",
    schemaVersion: 1,
    text: validated.query,
    scope: {
      _tag: "ProjectWorkstream",
      project: validated.project,
      workstream: validated.workstream,
    },
    access: {
      _tag: "RecallAccessV1",
      allowedPrivacy: validated.allowedPrivacy,
      decidedAt: new Date().toISOString(),
      principalRef: "operator:joel",
      purpose: "explicit-agent-recall",
    },
    includeSuperseded: validated.includeSuperseded,
    limits: validated.limits,
  };
}

export async function runFlowingRecall(
  input: FlowingRecallInput,
  options: FlowingRecallRunOptions,
): Promise<FlowingRecallResult> {
  let request: unknown;
  try {
    request = buildComposedRecallRequest(input);
  } catch {
    throw new FlowingRecallError("invalid-input");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = options.command ?? join(homedir(), ".local/bin/joelclaw");
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    const child = spawn(command, ["recall", "--request-file", "-"], {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const finish = (error?: Error, result?: FlowingRecallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new FlowingRecallError("process-failed"));
    };
    const cancel = () => {
      child.kill("SIGTERM");
      finish(new FlowingRecallError("cancelled"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new FlowingRecallError("timeout"));
    }, timeoutMs);

    options.signal.addEventListener("abort", cancel, { once: true });
    child.on("error", () => finish(new FlowingRecallError("process-failed")));
    child.stdin.on("error", () => finish(new FlowingRecallError("process-failed")));
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > MAX_STDOUT_BYTES) {
        child.kill("SIGTERM");
        finish(new FlowingRecallError("output-limit"));
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new FlowingRecallError("process-failed"));
        return;
      }
      try {
        const envelope = Schema.decodeUnknownSync(RecallCliEnvelopeSchema)(
          JSON.parse(stdout.toString("utf8")),
        );
        const lanes = envelope.result.composed.lanes;
        if (
          lanes.flowingReflections.lane !== "flowing-reflections" ||
          lanes.flowingObservations.lane !== "flowing-observations" ||
          lanes.curatedPages.lane !== "curated-pages"
        ) {
          throw new FlowingRecallError("malformed-response");
        }
        finish(undefined, {
          adapter: envelope.result.adapter,
          composed: envelope.result.composed,
          ...(envelope.result.curatedBackend === undefined
            ? {}
            : { curatedBackend: envelope.result.curatedBackend }),
          ...(envelope.result.timings === undefined ? {} : { timings: envelope.result.timings }),
        });
      } catch {
        finish(new FlowingRecallError("malformed-response"));
      }
    });

    child.stdin.end(`${JSON.stringify(request)}\n`);
    if (options.signal.aborted) cancel();
  });
}
