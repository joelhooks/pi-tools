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

  pi.on("message_end", (event, ctx) => {
    if (!langfuse) return;

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
      const output = extractText((message as { content?: unknown }).content);

      const turnIndex =
        typeof (event as { turnIndex?: unknown }).turnIndex === "number"
          ? Number((event as { turnIndex?: number }).turnIndex)
          : activeTurnIndex;

      const aggregate = getTurnAggregate(turnUsages, turnIndex);
      addUsage(aggregate, usage);

      const trace = langfuse.trace({
        name: "joelclaw.session.call",
        sessionId: sessionId ?? undefined,
        input: output,
        output,
        tags: TRACE_TAGS,
        metadata: {
          channel: CHANNEL,
          sessionType: SESSION_TYPE,
          component: "pi-session",
          turnIndex,
          model: ctx.model?.id,
          provider: ctx.model?.provider,
          stopReason,
          tokenCount: {
            input: usage.input,
            output: usage.output,
            total: usage.totalTokens,
          },
        },
      });

      trace.generation({
        name: "session.call",
        model: ctx.model?.id,
        input: undefined,
        output,
        usage: {
          input: usage.input,
          output: usage.output,
          total: usage.totalTokens,
          unit: "TOKENS",
        },
        metadata: {
          model: ctx.model?.id,
          provider: ctx.model?.provider,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          stopReason,
          tokenCount: {
            input: usage.input,
            output: usage.output,
            total: usage.totalTokens,
          },
        },
      });
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
        return;
      }

      const toolResultsCount =
        Array.isArray((event as { toolResults?: unknown }).toolResults)
          ? (event as { toolResults: unknown[] }).toolResults.length
          : 0;

      const messagesOutput = (event as { messages?: unknown }).messages;
      const turnOutput = messagesOutput
        ? extractText(messagesOutput)
        : extractText((event as { summary?: unknown }).summary);
      const stopReason =
        typeof (event as { stopReason?: unknown }).stopReason === "string"
          ? (event as { stopReason?: string }).stopReason
          : undefined;

      const trace = langfuse.trace({
        name: "joelclaw.session.turn",
        sessionId: sessionId ?? undefined,
        output: turnOutput,
        tags: TRACE_TAGS,
        metadata: {
          channel: CHANNEL,
          sessionType: SESSION_TYPE,
          component: "pi-session",
          turnIndex,
          model: ctx.model?.id,
          provider: ctx.model?.provider,
          stopReason,
          tokenCount: {
            input: turnAggregate.input,
            output: turnAggregate.output,
            total: turnAggregate.totalTokens,
          },
          toolResultsCount,
          messageCount: turnAggregate.messageCount,
        },
      });

      trace.generation({
        name: "session.turn",
        model: ctx.model?.id,
        usage: {
          input: turnAggregate.input,
          output: turnAggregate.output,
          total: turnAggregate.totalTokens,
          unit: "TOKENS",
        },
        metadata: {
          provider: ctx.model?.provider,
          cacheRead: turnAggregate.cacheRead,
          cacheWrite: turnAggregate.cacheWrite,
          messageCount: turnAggregate.messageCount,
          toolResultsCount,
          tokenCount: {
            input: turnAggregate.input,
            output: turnAggregate.output,
            total: turnAggregate.totalTokens,
          },
        },
      });

      turnUsages.delete(turnIndex);
      if (turnIndex >= 0) {
        activeTurnIndex = turnIndex + 1;
      }
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
