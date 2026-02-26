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

const CHANNEL = process.env.JOELCLAW_CHANNEL || "interactive";
const TRACE_TAGS = ["joelclaw", "pi-session"];
const FLUSH_INTERVAL_MS = 30_000;

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

  pi.on("message_end", (event, ctx) => {
    if (!langfuse) return;

    try {
      const message = event.message;
      if (!message || typeof message !== "object") return;

      if ((message as { role?: unknown }).role !== "assistant") return;

      const usage = asUsage((message as { usage?: unknown }).usage);
      if (!usage) return;

      const stopReason = (message as { stopReason?: unknown }).stopReason;

      const turnIndex =
        typeof (event as { turnIndex?: unknown }).turnIndex === "number"
          ? Number((event as { turnIndex?: number }).turnIndex)
          : activeTurnIndex;

      const aggregate = getTurnAggregate(turnUsages, turnIndex);
      addUsage(aggregate, usage);

      const trace = langfuse.trace({
        name: "pi.llm_call",
        tags: TRACE_TAGS,
        metadata: {
          channel: CHANNEL,
          component: "pi-session",
          turnIndex,
        },
      });

      trace.generation({
        name: "assistant_response",
        model: ctx.model?.id,
        usage: {
          input: usage.input,
          output: usage.output,
          total: usage.totalTokens,
          unit: "TOKENS",
        },
        metadata: {
          provider: ctx.model?.provider,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          stopReason,
        },
      });
    } catch (error) {
      console.error("langfuse-cost: Failed to process message_end", error);
    }
  });

  pi.on("turn_end", (event, ctx) => {
    if (!langfuse) return;

    try {
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

      const trace = langfuse.trace({
        name: "pi.llm_turn",
        tags: TRACE_TAGS,
        metadata: {
          channel: CHANNEL,
          component: "pi-session",
          turnIndex,
          toolResultsCount,
        },
      });

      trace.generation({
        name: "assistant_turn_aggregate",
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
