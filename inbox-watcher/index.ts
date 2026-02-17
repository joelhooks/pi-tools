import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type InboxPayload = {
  status?: string;
  task?: string;
  result?: string;
  error?: string;
  tool?: string;
  requestId?: string;
};

type BackgroundAgentTarget = "codex" | "claude" | "pi";

type BackgroundAgentParams = {
  task?: string;
  tool?: string;
  cwd?: string;
  timeout?: number;
  model?: string;
};

type BackgroundDispatchResult = {
  requestId?: string;
  status: string;
  error?: string;
  details?: {
    requestId?: string;
    status: string;
    error?: string;
  };
  content?: Array<{ type: "text"; text: string }>;
};

const HOME = os.homedir();
const INBOX_DIR = path.join(HOME, ".joelclaw", "workspace", "inbox");
const ACK_DIR = path.join(INBOX_DIR, "ack");
const DEFAULT_INNGEST_URL = process.env.INNGEST_URL ?? "http://localhost:8288";
const DEFAULT_INNGEST_EVENT_KEY =
  process.env.INNGEST_EVENT_KEY ?? "37aa349b89692d657d276a40e0e47a15";
const BACKGROUND_TOOLS: BackgroundAgentTarget[] = ["codex", "claude", "pi"];

function ensureDirs(): void {
  try {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    fs.mkdirSync(ACK_DIR, { recursive: true });
  } catch {
    // Ignore filesystem setup errors to avoid crashing startup.
  }
}

function preview(text: unknown, max = 180): string {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return "(no result)";
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function formatSystemMessage(payload: InboxPayload): string {
  const status = payload.status || "unknown";
  const task = payload.task || "(no task)";
  const resultText = payload.error || payload.result || "";
  const resultPreview = preview(resultText);
  const toolText = payload.tool ? ` (${payload.tool})` : "";
  const requestIdText = payload.requestId ? ` [${payload.requestId}]` : "";

  return [
    `Background task ${status}${toolText}${requestIdText}`,
    `Task: ${task}`,
    `Result: ${resultPreview}`,
  ].join("\n");
}

function moveToAck(filename: string): void {
  const from = path.join(INBOX_DIR, filename);
  const to = path.join(ACK_DIR, filename);

  try {
    fs.renameSync(from, to);
  } catch {
    // Ignore move failures so watcher keeps running.
  }
}

// ExtensionAPI exposes addSystemMessage at runtime but it may not appear in the
// published type declarations depending on the installed version.
type PiWithSystemMessage = ExtensionAPI & { addSystemMessage: (msg: string) => void };

function processInboxFile(pi: ExtensionAPI, filename: string): void {
  if (!filename.endsWith(".json")) return;

  const filePath = path.join(INBOX_DIR, filename);
  let raw = "";

  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  let payload: InboxPayload;
  try {
    payload = JSON.parse(raw) as InboxPayload;
  } catch {
    console.warn(`[inbox-watcher] Skipping malformed JSON file: ${filename}`);
    return;
  }

  try {
    (pi as PiWithSystemMessage).addSystemMessage(formatSystemMessage(payload));
  } catch {
    // Ignore message injection failures so files still get acked.
  }

  moveToAck(filename);
}

function generateRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "").slice(0, 21)}`;
}

function inngestEventUrl(): string {
  const base = DEFAULT_INNGEST_URL.replace(/\/+$/, "");
  return `${base}/e/${DEFAULT_INNGEST_EVENT_KEY}`;
}

function extractSessionId(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;

  const sessionId = (ctx as { sessionId?: unknown }).sessionId;
  if (typeof sessionId === "string" && sessionId.trim()) {
    return sessionId.trim();
  }

  const sessionManager = (ctx as { sessionManager?: { getSessionName?: () => unknown } }).sessionManager;
  if (sessionManager && typeof sessionManager.getSessionName === "function") {
    try {
      const value = sessionManager.getSessionName();
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      // Ignore session manager lookup failures.
    }
  }

  return undefined;
}

function invalidRequest(error: string): BackgroundDispatchResult {
  return {
    status: "invalid_request",
    error,
    details: {
      status: "invalid_request",
      error,
    },
    content: [{ type: "text", text: `background_agent: ${error}` }],
  };
}

function dispatchRequestedEvent(url: string, payload: unknown): void {
  void fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Dispatch intentionally runs in background and should not fail the tool call.
  });
}

export default function (pi: ExtensionAPI) {
  let watcher: fs.FSWatcher | null = null;

  const registerTool = (pi as ExtensionAPI & { registerTool?: (tool: unknown) => void }).registerTool;
  if (typeof registerTool === "function") {
    registerTool({
      name: "background_agent",
      description:
        "Dispatch background work by sending system/agent.requested to Inngest and returning immediately.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task prompt for the background agent." },
          tool: { type: "string", enum: BACKGROUND_TOOLS, default: "codex" },
          cwd: { type: "string", description: "Optional working directory override." },
          timeout: {
            type: "number",
            description: "Timeout in seconds (default: 600).",
            default: 600,
          },
          model: { type: "string", description: "Optional model override for the target agent." },
        },
        required: ["task"],
      },
      execute(
        _toolCallId: string,
        params: BackgroundAgentParams,
        _signal: unknown,
        _onUpdate: unknown,
        ctx: unknown
      ): BackgroundDispatchResult {
        const task = typeof params.task === "string" ? params.task.trim() : "";
        if (!task) return invalidRequest("`task` is required.");

        const toolInput = typeof params.tool === "string" ? params.tool.trim().toLowerCase() : "codex";
        if (!BACKGROUND_TOOLS.includes(toolInput as BackgroundAgentTarget)) {
          return invalidRequest("`tool` must be one of: codex, claude, pi.");
        }

        const timeout = params.timeout == null ? 600 : Number(params.timeout);
        if (!Number.isFinite(timeout) || timeout <= 0) {
          return invalidRequest("`timeout` must be a positive number.");
        }

        const requestId = generateRequestId();
        const sessionId = extractSessionId(ctx);
        const cwdFromContext = (ctx as { cwd?: unknown } | null)?.cwd;
        const cwd =
          typeof params.cwd === "string" && params.cwd.trim()
            ? params.cwd.trim()
            : typeof cwdFromContext === "string" && cwdFromContext.trim()
            ? cwdFromContext.trim()
            : undefined;
        const model = typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined;

        const data: Record<string, unknown> = {
          requestId,
          task,
          tool: toolInput,
          timeout,
        };
        if (cwd) data.cwd = cwd;
        if (model) data.model = model;
        if (sessionId) data.sessionId = sessionId;

        dispatchRequestedEvent(inngestEventUrl(), {
          name: "system/agent.requested",
          data,
        });

        return {
          requestId,
          status: "dispatched",
          details: {
            requestId,
            status: "dispatched",
          },
          content: [{ type: "text", text: `Dispatched background request ${requestId}.` }],
        };
      },
    });
  }

  pi.on("session_start", async () => {
    ensureDirs();

    let files: string[] = [];
    try {
      files = fs.readdirSync(INBOX_DIR);
    } catch {
      files = [];
    }

    for (const filename of files) {
      processInboxFile(pi, filename);
    }

    if (watcher) return;

    try {
      watcher = fs.watch(INBOX_DIR, (eventType, filename) => {
        if (eventType !== "rename") return;
        const name = filename == null ? "" : filename.toString();
        if (!name || !name.endsWith(".json")) return;
        processInboxFile(pi, name);
      });
    } catch {
      // Ignore watcher init failures to avoid crashing session startup.
    }
  });
}
