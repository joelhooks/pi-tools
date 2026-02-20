/**
 * MCQ Protocol — NDJSON wire format for multi-channel question/answer flow.
 *
 * One JSON object per line per event. Flows through Redis gateway bridge:
 *   joelclaw:events:<target>  (list)
 *   joelclaw:notify:<target>  (pub/sub)
 *
 * Any client that can parse a line of JSON can render MCQ questions
 * and push answers back — TUI, Telegram, web, native, voice.
 */

// ── Question (agent → client) ────────────────────────────────────

export interface MCQQuestionEvent {
	type: "mcq.question";
	/** Flow title, e.g. "Feature Design" */
	title?: string;
	/** Questions in this batch */
	questions: MCQQuestionDef[];
	/** Session that should receive answers */
	session: string;
	/** ISO timestamp */
	ts: string;
}

export interface MCQQuestionDef {
	/** Short label, e.g. 'scope', 'priority' */
	id: string;
	/** The question text */
	question: string;
	/** Up to 3 options. "Other" is always implied as last option. */
	options: MCQOption[];
	/** Hint shown below question */
	context?: string;
	/** 1-indexed option to recommend */
	recommended?: number;
	/** Brief reasoning for recommendation */
	recommendedReason?: string;
	/** Recommendation strength — "strong" pre-selects, "slight" just badges */
	conviction?: "strong" | "slight";
	/** Visual weight — "critical" = prominent, "minor" = compact */
	weight?: "critical" | "minor";
}

export type MCQOption = string | MCQRichOption;

export interface MCQRichOption {
	label: string;
	code?: {
		code: string;
		lang?: string;
		file?: string;
	};
}

export function getOptionLabel(opt: MCQOption): string {
	return typeof opt === "string" ? opt : opt.label;
}

// ── Answer (client → agent) ──────────────────────────────────────

export interface MCQAnswerEvent {
	type: "mcq.answer";
	/** Question ID this answers */
	id: string;
	/** 1-indexed selection (options.length + 1 = "Other") */
	selected: number;
	/** The text of the selected option or custom input */
	answer: string;
	/** True if user typed a custom response */
	isCustom: boolean;
	/** Which channel answered */
	channel: "tui" | "telegram" | "web" | "native" | "voice" | "rpc";
	/** Session ID */
	session: string;
	/** ISO timestamp */
	ts: string;
}

// ── Cancel (either direction) ────────────────────────────────────

export interface MCQCancelEvent {
	type: "mcq.cancel";
	/** Reason for cancellation */
	reason: "user" | "timeout" | "abort";
	/** Session ID */
	session: string;
	/** ISO timestamp */
	ts: string;
}

// ── Complete (client → agent, all questions answered) ────────────

export interface MCQCompleteEvent {
	type: "mcq.complete";
	title: string;
	answers: MCQAnswerEvent[];
	session: string;
	ts: string;
}

// ── Union type ───────────────────────────────────────────────────

export type MCQEvent =
	| MCQQuestionEvent
	| MCQAnswerEvent
	| MCQCancelEvent
	| MCQCompleteEvent;

// ── Serialize / parse ────────────────────────────────────────────

export function serialize(event: MCQEvent): string {
	return JSON.stringify(event);
}

export function parse(line: string): MCQEvent | null {
	try {
		const obj = JSON.parse(line);
		if (obj?.type?.startsWith("mcq.")) return obj as MCQEvent;
		return null;
	} catch {
		return null;
	}
}

// ── Rendering context ────────────────────────────────────────────

export type MCQChannel = "tui" | "telegram" | "web" | "native" | "voice" | "rpc";

export interface MCQRenderContext {
	channel: MCQChannel;
	/** Terminal width (TUI only) */
	width?: number;
	/** Can display inline images */
	supportsImages?: boolean;
	/** Can display interactive buttons (Telegram, web, native) */
	supportsButtons?: boolean;
	/** Can render code blocks with syntax */
	supportsCode?: boolean;
}

/** Determine TUI layout mode from terminal width */
export type TUILayout = "full" | "compact" | "minimal";

export function getTUILayout(width: number): TUILayout {
	if (width < 35) return "minimal";
	if (width < 50) return "compact";
	return "full";
}
