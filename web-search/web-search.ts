/**
 * web-search — Brave Search API tool for pi.
 *
 * Two-tier search:
 *   1. web_search — Uses Brave LLM Context API (/v1/llm/context) which returns
 *      pre-extracted page content (text, tables, code) optimized for LLM grounding.
 *      This is the primary tool the agent should use.
 *
 *   2. web_search_links — Falls back to standard web search (/v1/web/search) for
 *      when you just need URLs, news headlines, or discussion links.
 *
 * Requires: brave_api_key in agent-secrets (or BRAVE_API_KEY env var)
 *
 * Command: /search <query> — search from the prompt
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";

const LLM_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context";
const WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

// ── API key management ──────────────────────────────────────────────

let cachedKey: string | undefined;
let keyExpiry = 0;

function getApiKey(): string | undefined {
	if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;

	if (cachedKey && Date.now() < keyExpiry) return cachedKey;

	try {
		const result = execSync("secrets lease brave_api_key --ttl 1h --json 2>/dev/null", {
			encoding: "utf-8",
			timeout: 5000,
		});
		const parsed = JSON.parse(result);
		cachedKey = parsed.secret_value || parsed.value;
		keyExpiry = Date.now() + 50 * 60 * 1000;
		return cachedKey;
	} catch {
		return undefined;
	}
}

// ── HTML / entity stripping ─────────────────────────────────────────

function stripHtml(s: string): string {
	return s
		.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&nbsp;/g, " ");
}

// ── LLM Context API (primary) ───────────────────────────────────────

interface LLMContextParams {
	query: string;
	count?: number;
	freshness?: string;
	max_tokens?: number;
	max_urls?: number;
	threshold?: string;
}

interface LLMContextResult {
	url: string;
	title: string;
	snippets: string[];
}

interface LLMContextResponse {
	grounding?: {
		generic?: LLMContextResult[];
		poi?: LLMContextResult | null;
		map?: LLMContextResult[];
	};
	sources?: Record<string, { title?: string; hostname?: string; age?: string[] | null }>;
}

async function searchLLMContext(params: LLMContextParams): Promise<string> {
	const apiKey = getApiKey();
	if (!apiKey) throw new Error("No Brave API key. Run: secrets add brave_api_key");

	const body: Record<string, any> = {
		q: params.query,
		count: params.count ?? 20,
		maximum_number_of_tokens: params.max_tokens ?? 8192,
		maximum_number_of_urls: params.max_urls ?? 20,
	};
	if (params.threshold) body.context_threshold_mode = params.threshold;
	if (params.freshness) body.freshness = params.freshness;

	const response = await fetch(LLM_CONTEXT_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Subscription-Token": apiKey,
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Brave LLM Context API ${response.status}: ${text.slice(0, 200)}`);
	}

	const data = (await response.json()) as LLMContextResponse;
	return formatLLMContext(data);
}

function formatLLMContext(data: LLMContextResponse): string {
	const sections: string[] = [];
	const sources = data.sources || {};

	// Main grounding content
	const generic = data.grounding?.generic || [];
	if (generic.length > 0) {
		for (const result of generic) {
			const sourceInfo = sources[result.url];
			const age = sourceInfo?.age?.[2] || sourceInfo?.age?.[0] || "";
			const lines: string[] = [];

			lines.push(`## ${stripHtml(result.title)}`);
			lines.push(`Source: ${result.url}${age ? ` (${age})` : ""}`);
			lines.push("");

			for (const snippet of result.snippets) {
				const clean = snippet.trim();
				if (!clean) continue;

				// Detect JSON-serialized structured data (tables, schemas)
				if (clean.startsWith("{") || clean.startsWith("[")) {
					try {
						const parsed = JSON.parse(clean);
						// Format tables
						if (parsed.table && Array.isArray(parsed.table)) {
							if (parsed.caption) lines.push(`**${parsed.caption}**`);
							const headers = Object.keys(parsed.table[0] || {});
							lines.push(`| ${headers.join(" | ")} |`);
							lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
							for (const row of parsed.table) {
								lines.push(`| ${headers.map((h) => row[h] ?? "").join(" | ")} |`);
							}
							lines.push("");
							continue;
						}
						// Other structured data — include as-is, LLMs handle JSON well
						lines.push(clean);
						lines.push("");
						continue;
					} catch {
						// Not valid JSON, treat as text
					}
				}

				lines.push(stripHtml(clean));
				lines.push("");
			}

			sections.push(lines.join("\n"));
		}
	}

	// POI (point of interest)
	const poi = data.grounding?.poi;
	if (poi) {
		const lines = [`## 📍 ${stripHtml(poi.title)}`, `Source: ${poi.url}`, ""];
		for (const s of poi.snippets) lines.push(stripHtml(s.trim()), "");
		sections.push(lines.join("\n"));
	}

	// Map results
	const map = data.grounding?.map || [];
	if (map.length > 0) {
		const lines = ["### Map Results"];
		for (const m of map) {
			lines.push(`• ${stripHtml(m.title)} — ${m.url}`);
			for (const s of m.snippets.slice(0, 2)) lines.push(`  ${stripHtml(s.trim())}`);
		}
		sections.push(lines.join("\n"));
	}

	// Source list
	if (Object.keys(sources).length > 0) {
		const sourceLines = ["### Sources"];
		for (const [url, info] of Object.entries(sources)) {
			const age = info.age?.[2] || info.age?.[0] || "";
			sourceLines.push(`• ${info.hostname || url}${age ? ` (${age})` : ""}: ${url}`);
		}
		sections.push(sourceLines.join("\n"));
	}

	if (sections.length === 0) return "No results found.";
	return sections.join("\n\n---\n\n");
}

// ── Web Search API (links/news/discussions) ─────────────────────────

async function searchWeb(
	query: string,
	options: { count?: number; freshness?: string; offset?: number } = {},
): Promise<string> {
	const apiKey = getApiKey();
	if (!apiKey) throw new Error("No Brave API key. Run: secrets add brave_api_key");

	const params = new URLSearchParams({
		q: query,
		count: String(options.count ?? 10),
		text_decorations: "false",
		extra_snippets: "true",
	});
	if (options.freshness) params.set("freshness", options.freshness);
	if (options.offset) params.set("offset", String(options.offset));

	const response = await fetch(`${WEB_SEARCH_URL}?${params}`, {
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": apiKey,
		},
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Brave Web Search ${response.status}: ${body.slice(0, 200)}`);
	}

	const data = (await response.json()) as any;
	return formatWebSearch(data);
}

function formatWebSearch(data: any): string {
	const sections: string[] = [];

	// Infobox
	if (data.infobox?.results?.length) {
		const box = data.infobox.results[0];
		const lines = [`## ${stripHtml(box.title)}`];
		if (box.long_desc) lines.push(stripHtml(box.long_desc));
		else if (box.description) lines.push(stripHtml(box.description));
		if (box.url) lines.push(`Source: ${box.url}`);
		if (box.attributes?.length) {
			const attrs = box.attributes
				.filter(([_k, v]: [string, string | null]) => v !== null)
				.map(([k, v]: [string, string]) => `  ${stripHtml(k)}: ${stripHtml(v)}`)
				.slice(0, 10);
			if (attrs.length) lines.push("", ...attrs);
		}
		sections.push(lines.join("\n"));
	}

	// FAQ
	if (data.faq?.results?.length) {
		const faqLines = data.faq.results.slice(0, 5).map((f: any) =>
			`Q: ${stripHtml(f.question)}\nA: ${stripHtml(f.answer)}`,
		);
		sections.push("### FAQ\n" + faqLines.join("\n\n"));
	}

	// Web results
	if (data.web?.results?.length) {
		const webLines = data.web.results.map((r: any, i: number) => {
			const parts = [`${i + 1}. ${stripHtml(r.title)}`];
			parts.push(`   ${r.url}`);
			if (r.description) parts.push(`   ${stripHtml(r.description)}`);
			if (r.age) parts.push(`   ${r.age}`);
			if (r.article?.date) {
				const author = r.article.author?.[0]?.name;
				parts.push(`   Published: ${r.article.date}${author ? ` by ${author}` : ""}`);
			}
			if (r.extra_snippets?.length) {
				for (const s of r.extra_snippets.slice(0, 2)) {
					const clean = stripHtml(s).trim();
					if (clean.length > 40) parts.push(`   > ${clean.slice(0, 500)}`);
				}
			}
			return parts.join("\n");
		});
		sections.push("### Web Results\n" + webLines.join("\n\n"));
	}

	// News
	if (data.news?.results?.length) {
		const newsLines = data.news.results.slice(0, 5).map((r: any) => {
			const age = r.age ? ` (${r.age})` : "";
			return `• ${stripHtml(r.title)}${age}\n  ${r.url}\n  ${stripHtml(r.description || "")}`;
		});
		sections.push("### News\n" + newsLines.join("\n\n"));
	}

	// Discussions
	if (data.discussions?.results?.length) {
		const discLines = data.discussions.results.slice(0, 5).map((r: any) => {
			const forum = r.data?.forum_name ? ` [${r.data.forum_name}]` : "";
			const answers = r.data?.num_answers ? ` — ${r.data.num_answers} replies` : "";
			const parts = [`• ${stripHtml(r.title)}${forum}${answers}`];
			parts.push(`  ${r.url}`);
			if (r.data?.top_comment) parts.push(`  Top: ${stripHtml(r.data.top_comment).slice(0, 300)}`);
			return parts.join("\n");
		});
		sections.push("### Discussions\n" + discLines.join("\n\n"));
	}

	if (sections.length === 0) return "No results found.";
	return sections.join("\n\n");
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Primary tool: LLM Context (pre-extracted content)
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web and get pre-extracted page content optimized for LLM reasoning. " +
			"Returns actual text, tables, and code from pages — not just links and snippets. " +
			"Use for current events, documentation, API references, debugging errors, fact-checking, " +
			"or any question needing fresh web data. " +
			"Supports freshness filtering and token budget control.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query (max 400 chars)" }),
			count: Type.Optional(
				Type.Number({ description: "Max search results to consider (default: 20, max: 50)", minimum: 1, maximum: 50 }),
			),
			freshness: Type.Optional(
				Type.Union(
					[Type.Literal("pd"), Type.Literal("pw"), Type.Literal("pm"), Type.Literal("py"), Type.String()],
					{ description: "Freshness: pd (day), pw (week), pm (month), py (year), or YYYY-MM-DDtoYYYY-MM-DD" },
				),
			),
			max_tokens: Type.Optional(
				Type.Number({
					description: "Max tokens of context to return (default: 8192, max: 32768). Use 2048 for simple facts, 16384+ for research.",
					minimum: 1024,
					maximum: 32768,
				}),
			),
			max_urls: Type.Optional(
				Type.Number({ description: "Max URLs in response (default: 20, max: 50)", minimum: 1, maximum: 50 }),
			),
			threshold: Type.Optional(
				Type.Union(
					[Type.Literal("strict"), Type.Literal("balanced"), Type.Literal("lenient"), Type.Literal("disabled")],
					{ description: "Relevance filtering: strict (precise), balanced (default), lenient (more results), disabled (all)" },
				),
			),
		}),

		async execute(_id, params) {
			try {
				const results = await searchLLMContext({
					query: params.query,
					count: params.count,
					freshness: params.freshness,
					max_tokens: params.max_tokens,
					max_urls: params.max_urls,
					threshold: params.threshold,
				});
				return { content: [{ type: "text", text: results }], details: {} };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Search failed: ${err.message}` }], details: {} };
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("search "));
			text += theme.fg("accent", args.query || "");
			const meta: string[] = [];
			if (args.freshness) meta.push(args.freshness as string);
			if (args.max_tokens) meta.push(`${args.max_tokens}tok`);
			if (args.threshold && args.threshold !== "balanced") meta.push(args.threshold as string);
			if (meta.length) text += theme.fg("dim", ` (${meta.join(", ")})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content?.[0]?.type === "text" ? (result.content[0] as any).text : "";
			const lines = text.split("\n").slice(0, 10);
			const preview = lines.map((l: string) => theme.fg("dim", l)).join("\n");
			const total = text.split("\n").length;
			const remaining = total - 10;
			const suffix = remaining > 0 ? theme.fg("muted", `\n... ${remaining} more lines`) : "";
			return new Text(preview + suffix, 0, 0);
		},
	});

	// Secondary tool: standard web search (links, news, discussions)
	pi.registerTool({
		name: "web_search_links",
		label: "Web Search (Links)",
		description:
			"Standard web search returning links, snippets, news, and discussions. " +
			"Use when you need URLs to share, news headlines, Reddit/forum discussions, " +
			"or paginated results. For deep content extraction, prefer web_search instead.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			count: Type.Optional(Type.Number({ description: "Results (default: 10, max: 20)", minimum: 1, maximum: 20 })),
			freshness: Type.Optional(
				Type.Union(
					[Type.Literal("pd"), Type.Literal("pw"), Type.Literal("pm"), Type.Literal("py"), Type.String()],
					{ description: "Freshness: pd (day), pw (week), pm (month), py (year)" },
				),
			),
			offset: Type.Optional(Type.Number({ description: "Pagination offset (default: 0)" })),
		}),

		async execute(_id, params) {
			try {
				const results = await searchWeb(params.query, {
					count: params.count,
					freshness: params.freshness,
					offset: params.offset,
				});
				return { content: [{ type: "text", text: results }], details: {} };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Search failed: ${err.message}` }], details: {} };
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("search-links "));
			text += theme.fg("accent", args.query || "");
			if (args.freshness) text += theme.fg("dim", ` (${args.freshness})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content?.[0]?.type === "text" ? (result.content[0] as any).text : "";
			const lines = text.split("\n").slice(0, 8);
			const preview = lines.map((l: string) => theme.fg("dim", l)).join("\n");
			const remaining = text.split("\n").length - 8;
			const suffix = remaining > 0 ? theme.fg("muted", `\n... ${remaining} more lines`) : "";
			return new Text(preview + suffix, 0, 0);
		},
	});

	// System prompt
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n## Web Search\n" +
				"You have `web_search` for searching the web. It returns pre-extracted page content " +
				"(text, tables, code) optimized for reasoning — not just links. Use it for current info, " +
				"docs, API references, errors, or anything needing fresh web data.\n" +
				"- `freshness`: pd (day), pw (week), pm (month) for time-sensitive queries\n" +
				"- `max_tokens`: 2048 for simple facts, 8192 (default) for standard, 16384+ for deep research\n" +
				"- `threshold`: strict for precision, lenient for broader coverage\n" +
				"Use `web_search_links` only when you specifically need URLs, news headlines, or forum discussions.",
		};
	});

	pi.registerCommand("search", {
		description: "Search the web — /search <query>",
		handler: async (args, ctx) => {
			const query = args?.trim();
			if (!query) {
				ctx.ui.notify("Usage: /search <query>", "warning");
				return;
			}
			pi.sendUserMessage(
				`Search the web for: ${query}\n\nUse the web_search tool, then summarize the key findings concisely.`,
			);
		},
	});
}
