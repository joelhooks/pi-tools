import Langfuse from "langfuse";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type UsageLike = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

type SessionType = "gateway" | "interactive" | "codex";

const CHANNEL = process.env.GATEWAY_ROLE || process.env.JOELCLAW_CHANNEL || "interactive";
const SESSION_TYPE = getSessionType(CHANNEL);
const TRACE_TAGS = ["joelclaw", "pi-session"];
const FLUSH_INTERVAL_MS = 30_000;
let sessionId: string | null = null;

function getSessionType(channel: string): SessionType {
  const normalized = channel.toLowerCase();
  if (normalized === "gateway" || normalized === "central" || normalized === "codex" || normalized === "interactive") {
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

function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b?.type === "tool_use" && typeof b?.name === "string")
    .map((b: any) => b.name as string);
}

function extractToolResultSummary(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const results = content.filter(
    (b: any) => b?.type === "tool_result" && typeof b?.tool_use_id === "string",
  ).length;
  return results > 0 ? `[${results} tool result(s)]` : undefined;
}

/** Strip ---\nChannel:...\n--- header from input, return clean text + parsed metadata */
function stripChannelHeader(text: string): { clean: string; headerMeta?: Record<string, string> } {
  const headerMatch = text.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!headerMatch) return { clean: text };

  const headerBlock = headerMatch[1];
  const meta: Record<string, string> = {};

  for (const line of headerBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase().replace(/\s+/g, "_");
      const value = line.slice(colonIdx + 1).trim();
      if (key && value) meta[key] = value;
    }
  }

  const clean = text.slice(headerMatch[0].length).trim();
  return { clean, headerMeta: Object.keys(meta).length > 0 ? meta : undefined };
}


export default function (pi: ExtensionAPI) {
  let langfuse: Langfuse | null = null;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let lastUserInput: string | undefined;
  let lastInputHeaderMeta: Record<string, string> | undefined;
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
        return;
      }
      const role = (message as { role?: unknown }).role;
      if (role === "assistant") {
        lastAssistantStartTime = Date.now();
        return;
      }
      if (role !== "user") return;

      const content = (message as { content?: unknown }).content;
      const extracted = extractText(content);
      if (extracted !== undefined) {
        const { clean, headerMeta } = stripChannelHeader(extracted);
        lastUserInput = clean || extracted;
        lastInputHeaderMeta = headerMeta;
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
      console.warn("langfuse-cost: langfuse is null, skipping tracing");
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
      const toolNames = extractToolNames(content);
      const outputText = extractText(content);
      const output =
        outputText ||
        (toolNames.length > 0 ? `[${toolNames.join(", ")}]` : undefined) ||
        (typeof stopReason === "string" ? `[${stopReason}]` : undefined);
      const input = lastUserInput ?? (stopReason === "toolUse" ? "[tool continuation]" : undefined);
      const turnIndex =
        typeof (event as { turnIndex?: unknown }).turnIndex === "number"
          ? Number((event as { turnIndex?: number }).turnIndex)
          : undefined;
      const completionStartTime = lastAssistantStartTime
        ? new Date(lastAssistantStartTime)
        : undefined;

      const trace = langfuse.trace({
        name: "joelclaw.session.call",
        userId: "joel",
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
          ...(lastInputHeaderMeta ? { sourceChannel: lastInputHeaderMeta } : {}),
          ...(toolNames.length > 0 ? { tools: toolNames } : {}),
        },
      });

      const generation = trace.generation({
        name: "session.call",
        model: ctx.model?.id,
        input,
        output,
        completionStartTime,
        endTime: new Date(),
        usageDetails: {
          input: usage.input,
          output: usage.output,
          total: usage.totalTokens,
          cache_read_input_tokens: usage.cacheRead,
          cache_write_input_tokens: usage.cacheWrite,
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
      generation.end();

      lastAssistantStartTime = undefined;
      lastInputHeaderMeta = undefined;
    } catch (error) {
      console.error("langfuse-cost: Failed to process message_end", error);
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
