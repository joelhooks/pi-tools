import Langfuse from "langfuse";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type UsageLike = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

type AggregatedUsage = UsageLike & {
  messageCount: number;
};

type SessionType = "gateway" | "interactive" | "codex";

const CHANNEL = process.env.GATEWAY_ROLE || process.env.JOELCLAW_CHANNEL || "interactive";
const SESSION_TYPE = getSessionType(CHANNEL);
const TRACE_TAGS = ["joelclaw", "pi-session"];
const FLUSH_INTERVAL_MS = 30_000;
let sessionId: string | null = null;

function getSessionType(channel: string): SessionType {
  const normalized = channel.toLowerCase();
  if (normalized === "gateway" || normalized === "codex" || normalized === "interactive") {
    return normalized;
  }
  return "interactive";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asUsage(candidate: unknown): UsageLike | null {
  if (!candidate || typeof candidate !== "object") return null;

  const usage = candidate as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    totalTokens?: unknown;
  };

  if (!isNumber(usage.input) || !isNumber(usage.output) || !isNumber(usage.totalTokens)) {
    return null;
  }

  return {
    input: usage.input,
    output: usage.output,
    cacheRead: isNumber(usage.cacheRead) ? usage.cacheRead : 0,
    cacheWrite: isNumber(usage.cacheWrite) ? usage.cacheWrite : 0,
    totalTokens: usage.totalTokens,
  };
}

function createAggregate(): AggregatedUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    messageCount: 0,
  };
}

function getTraceTags(model?: { provider?: unknown; id?: unknown }): string[] {
  const tags: Array<string | undefined> = [
    ...TRACE_TAGS,
    `channel:${CHANNEL}`,
    `session:${SESSION_TYPE}`,
    typeof model?.provider === "string" ? `provider:${model.provider}` : undefined,
    typeof model?.id === "string" ? `model:${model.id}` : undefined,
  ];

  return tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
}

function extractText(content: unknown, maxLen = 2000): string | undefined {
  if (!content) return undefined;
  if (typeof content === "string") return content.slice(0, maxLen);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((b: any) => b?.type === "text" && typeof b?.text === "string")
    .map((b: any) => b.text)
    .join("\n");
  return text ? text.slice(0, maxLen) : undefined;
}

function extractToolNames(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const tools = content
    .filter((b: any) => b?.type === "tool_use" && typeof b?.name === "string")
    .map((b: any) => b.name);
  return tools.length > 0 ? `[tools: ${tools.join(", ")}]` : undefined;
}

function extractToolResultSummary(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const results = content.filter(
    (b: any) => b?.type === "tool_result" && typeof b?.tool_use_id === "string",
  ).length;
  return results > 0 ? `[${results} tool result(s)]` : undefined;
}

function addUsage(aggregate: AggregatedUsage, usage: UsageLike): void {
  aggregate.input += usage.input;
  aggregate.output += usage.output;
  aggregate.cacheRead += usage.cacheRead;
  aggregate.cacheWrite += usage.cacheWrite;
  aggregate.totalTokens += usage.totalTokens;
  aggregate.messageCount += 1;
}

function getTurnAggregate(
  turnUsages: Map<number, AggregatedUsage>,
  turnIndex: number,
): AggregatedUsage {
  let aggregate = turnUsages.get(turnIndex);
  if (!aggregate) {
    aggregate = createAggregate();
    turnUsages.set(turnIndex, aggregate);
  }
  return aggregate;
}

export default function (pi: ExtensionAPI) {
  let langfuse: Langfuse | null = null;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  const turnUsages = new Map<number, AggregatedUsage>();
  let activeTurnIndex = 0;
  let lastUserInput: string | undefined;
  let lastAssistantStartTime: number | undefined;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey) {
    console.warn(
      "langfuse-cost: LANGFUSE_PUBLIC_KEY and/or LANGFUSE_SECRET_KEY missing; telemetry disabled.",
    );
  } else {
    try {
      langfuse = new Langfuse({
        publicKey,
        secretKey,
        baseUrl,
        environment: "production",
      });

      flushTimer = setInterval(() => {
        try {
          langfuse?.flush();
        } catch (error) {
          console.error("langfuse-cost: Langfuse flush failed", error);
        }
      }, FLUSH_INTERVAL_MS);
    } catch (error) {
      console.error("langfuse-cost: Failed to initialize Langfuse; telemetry disabled.", error);
      langfuse = null;
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = undefined;
      }
    }
  }

  pi.on("session_start", (_event, ctx) => {
    try {
      sessionId = ctx.sessionManager.getSessionId() ?? null;
    } catch {
      // ignore
    }
  });

  pi.on("message_start", (event, _ctx) => {
    try {
      const message = event.message;
      if (!message || typeof message !== "object") {
        console.error(`[langfuse-cost] message_start: no message object`);
        return;
      }
      const role = (message as { role?: unknown }).role;
      console.error(`[langfuse-cost] message_start role=${role}`);
      if (role === "assistant") {
        lastAssistantStartTime = Date.now();
        return;
      }
      if (role !== "user") return;

      const content = (message as { content?: unknown }).content;
      const extracted = extractText(content);
      if (extracted !== undefined) {
        // Debug: log what we're capturing as user input
        console.error(`[langfuse-cost] message_start user text (${extracted.length} chars): ${extracted.slice(0, 80)}...`);
        lastUserInput = extracted;
      } else {
        const toolSummary = extractToolResultSummary(content);
        if (toolSummary !== undefined) {
          lastUserInput = toolSummary;
        }
      }
    } catch {
      // ignore
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (!langfuse) {
      console.error(`[langfuse-cost] message_end: langfuse is null!`);
      return;
    }

    try {
      if (!sessionId) {
        try {
          sessionId = ctx.sessionManager.getSessionId() ?? null;
        } catch {
          // ignore
        }
      }

      const message = event.message;
      if (!message || typeof message !== "object") return;

      if ((message as { role?: unknown }).role !== "assistant") return;

      const usage = asUsage((message as { usage?: unknown }).usage);
      if (!usage) return;

      const stopReason = (message as { stopReason?: unknown }).stopReason;
      const content = (message as { content?: unknown }).content;
      const output = extractText(content) || extractToolNames(content);
      const input = lastUserInput ?? (stopReason === "toolUse" ? "[tool continuation]" : undefined);
      console.error(`[langfuse-cost] message_end: input=${input?.slice(0,40)}... output=${output?.slice(0,40)}... stop=${stopReason}`);
      // Clear after use to prevent stale input bleeding into next call
      lastUserInput = undefined;
      const completionStartTime = lastAssistantStartTime
        ? new Date(lastAssistantStartTime)
        : undefined;

      const turnIndex =
        typeof (event as { turnIndex?: unknown }).turnIndex === "number"
          ? Number((event as { turnIndex?: number }).turnIndex)
          : activeTurnIndex;

      const aggregate = getTurnAggregate(turnUsages, turnIndex);
      addUsage(aggregate, usage);

      const trace = langfuse.trace({
        name: "joelclaw.session.call",
        sessionId: sessionId ?? undefined,
        input,
        output,
        tags: getTraceTags(ctx.model),
        metadata: {
          channel: CHANNEL,
          sessionType: SESSION_TYPE,
          component: "pi-session",
          turnIndex,
          model: ctx.model?.id,
          provider: ctx.model?.provider,
          stopReason,
          inputTokens: usage.input,
          outputTokens: usage.output,
          totalTokens: usage.totalTokens,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
        },
      });

      trace.generation({
        name: "session.call",
        model: ctx.model?.id,
        input,
        output,
        completionStartTime,
        endTime: new Date(),
        usage: {
          input: usage.input,
          output: usage.output,
          total: usage.totalTokens,
          unit: "TOKENS",
        },
        metadata: {
          model: ctx.model?.id,
          provider: ctx.model?.provider,
          stopReason,
          inputTokens: usage.input,
          outputTokens: usage.output,
          totalTokens: usage.totalTokens,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
        },
      });

      lastAssistantStartTime = undefined;
    } catch (error) {
      console.error("langfuse-cost: Failed to process message_end", error);
    }
  });

  pi.on("turn_end", (event, ctx) => {
    if (!langfuse) return;

    try {
      if (!sessionId) {
        try {
          sessionId = ctx.sessionManager.getSessionId() ?? null;
        } catch {
          // ignore
        }
      }

      const turnIndex =
        typeof (event as { turnIndex?: unknown }).turnIndex === "number"
          ? Number((event as { turnIndex?: number }).turnIndex)
          : activeTurnIndex;

      const turnAggregate = getTurnAggregate(turnUsages, turnIndex);

      const messageUsage = asUsage((event as { message?: unknown }).message as { usage?: unknown });
      if (messageUsage && turnAggregate.messageCount === 0) {
        addUsage(turnAggregate, messageUsage);
      }

      if (turnAggregate.messageCount === 0) {
        turnUsages.delete(turnIndex);
        activeTurnIndex = turnIndex + 1;
        lastUserInput = undefined;
        return;
      }

      const toolResultsCount =
        Array.isArray((event as { toolResults?: unknown }).toolResults)
          ? (event as { toolResults: unknown[] }).toolResults.length
          : 0;

      const messagesOutput = (event as { messages?: unknown }).messages;
      let turnOutput = messagesOutput
        ? extractText(messagesOutput)
        : extractText((event as { summary?: unknown }).summary);
      if (turnOutput === undefined) {
        const toolSummary = messagesOutput ? extractToolNames(messagesOutput) : undefined;
        if (toolSummary !== undefined) {
          turnOutput = toolSummary;
        } else if (toolResultsCount > 0) {
          turnOutput = `[${toolResultsCount} tool result(s)]`;
        }
      }
      const stopReason =
        typeof (event as { stopReason?: unknown }).stopReason === "string"
          ? (event as { stopReason?: string }).stopReason
          : undefined;
      const input = lastUserInput;

      const trace = langfuse.trace({
        name: "joelclaw.session.turn",
        sessionId: sessionId ?? undefined,
        input,
        output: turnOutput,
        tags: getTraceTags(ctx.model),
        metadata: {
          channel: CHANNEL,
          sessionType: SESSION_TYPE,
          component: "pi-session",
          turnIndex,
          model: ctx.model?.id,
          provider: ctx.model?.provider,
          stopReason,
          inputTokens: turnAggregate.input,
          outputTokens: turnAggregate.output,
          totalTokens: turnAggregate.totalTokens,
          cacheReadTokens: turnAggregate.cacheRead,
          cacheWriteTokens: turnAggregate.cacheWrite,
          toolResultsCount,
          messageCount: turnAggregate.messageCount,
        },
      });

      trace.generation({
        name: "session.turn",
        model: ctx.model?.id,
        input,
        output: turnOutput,
        usage: {
          input: turnAggregate.input,
          output: turnAggregate.output,
          total: turnAggregate.totalTokens,
          unit: "TOKENS",
        },
        metadata: {
          provider: ctx.model?.provider,
          inputTokens: turnAggregate.input,
          outputTokens: turnAggregate.output,
          totalTokens: turnAggregate.totalTokens,
          cacheReadTokens: turnAggregate.cacheRead,
          cacheWriteTokens: turnAggregate.cacheWrite,
          model: ctx.model?.id,
          messageCount: turnAggregate.messageCount,
          toolResultsCount,
        },
      });

      turnUsages.delete(turnIndex);
      if (turnIndex >= 0) {
        activeTurnIndex = turnIndex + 1;
      }
      lastUserInput = undefined;
    } catch (error) {
      console.error("langfuse-cost: Failed to process turn_end", error);
    }
  });

  pi.on("session_shutdown", async () => {
    if (!langfuse) return;

    try {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = undefined;
      }
      await langfuse.shutdownAsync();
    } catch (error) {
      console.error("langfuse-cost: Failed to shutdown Langfuse", error);
    }
  });
}
