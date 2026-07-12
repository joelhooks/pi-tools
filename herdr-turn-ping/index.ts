import { execFileSync } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TAIL_LIMIT = 500;

type CachedAssistant = {
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
};

type CurrentPaneResponse = {
	result?: { pane?: { pane_id?: unknown } };
};

function resolvePaneId(): string | undefined {
	const fromEnvironment = process.env.HERDR_PANE_ID?.trim();
	if (fromEnvironment) return fromEnvironment;

	try {
		const output = execFileSync("herdr", ["pane", "current"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		});
		const paneId = (JSON.parse(output) as CurrentPaneResponse).result?.pane?.pane_id;
		return typeof paneId === "string" && paneId.trim() ? paneId.trim() : undefined;
	} catch {
		return undefined;
	}
}

function assistantText(message: CachedAssistant | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";

	return message.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("");
}

function tail(value: string): string | undefined {
	if (!value) return undefined;
	return value.slice(-TAIL_LIMIT);
}

function safeFilename(paneId: string): string {
	return `${paneId.replaceAll(":", "-")}.jsonl`;
}

export default function herdrTurnPing(pi: ExtensionAPI) {
	const paneId = resolvePaneId();
	if (!paneId) return;

	const spoolDirectory = join(homedir(), ".local", "state", "herdr-pings");
	const spoolPath = join(spoolDirectory, safeFilename(paneId));
	let latestAssistant: CachedAssistant | undefined;
	let latestTurnIndex: number | undefined;
	let session: string | undefined;
	let writeQueue = Promise.resolve();
	let notifiedOfWriteFailure = false;

	pi.on("agent_start", () => {
		latestAssistant = undefined;
		latestTurnIndex = undefined;
	});

	pi.on("agent_end", (event, ctx) => {
		session = ctx.sessionManager.getSessionId() || ctx.sessionManager.getSessionFile();
		latestAssistant = [...event.messages]
			.reverse()
			.find((message) => message.role === "assistant") as CachedAssistant | undefined;
	});

	pi.on("turn_end", (event) => {
		latestTurnIndex = event.turnIndex;
	});

	pi.on("agent_settled", (_event, ctx) => {
		const message = latestAssistant;
		const lastMessageTail = tail(assistantText(message));
		const record: Record<string, unknown> = {
			event: message?.stopReason === "error" ? "turn_error" : "turn_ended",
			pane_id: paneId,
			timestamp: new Date().toISOString(),
		};

		if (session) record.session = session;
		if (latestTurnIndex !== undefined) record.turn_index = latestTurnIndex;
		if (lastMessageTail !== undefined) record.last_message_tail = lastMessageTail;
		if (message?.stopReason === "error" && message.errorMessage) {
			record.error = message.errorMessage;
		}

		const line = `${JSON.stringify(record)}\n`;
		writeQueue = writeQueue
			.then(async () => {
				await mkdir(spoolDirectory, { recursive: true });
				await appendFile(spoolPath, line, "utf8");
			})
			.catch((error: unknown) => {
				if (notifiedOfWriteFailure) return;
				notifiedOfWriteFailure = true;
				ctx.ui.notify(
					`herdr-turn-ping could not append ${spoolPath}: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});

		return writeQueue;
	});
}
