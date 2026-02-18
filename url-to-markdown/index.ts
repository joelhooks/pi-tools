/**
 * url-to-markdown — Extract clean markdown from any URL via Defuddle.
 *
 * Fetches a web page, strips navigation/clutter/ads, returns clean markdown
 * with metadata header (title, author, date, domain, word count).
 *
 * Requires: defuddle-cli installed globally (npm i -g @anthropic/defuddle-cli or similar)
 *
 * Command: /fetch <url> — extract markdown from the prompt
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Defuddle integration ────────────────────────────────────────────

interface DefuddleResult {
	title?: string;
	description?: string;
	domain?: string;
	author?: string;
	published?: string;
	site?: string;
	wordCount?: number;
	content?: string;
}

async function fetchMarkdown(
	url: string,
	options: { includeMetadata?: boolean; timeout?: number } = {},
): Promise<{ markdown: string; meta: Omit<DefuddleResult, "content"> }> {
	const timeoutMs = (options.timeout ?? 30) * 1000;

	// Use --json to get metadata + content in one call
	const { stdout } = await execFileAsync("defuddle", ["parse", "--json", url], {
		encoding: "utf-8",
		timeout: timeoutMs,
		maxBuffer: 10 * 1024 * 1024, // 10MB for large pages
	});

	const data: DefuddleResult = JSON.parse(stdout);
	const content = data.content ?? "";

	// Build metadata header
	const meta: Omit<DefuddleResult, "content"> = {
		title: data.title,
		description: data.description,
		domain: data.domain,
		author: data.author,
		published: data.published,
		site: data.site,
		wordCount: data.wordCount,
	};

	if (options.includeMetadata === false) {
		return { markdown: content, meta };
	}

	const header: string[] = [];
	if (data.title) header.push(`# ${data.title}`);
	if (data.description) header.push(``, `> ${data.description}`);

	const metaLine: string[] = [];
	if (data.author) metaLine.push(`By ${data.author}`);
	if (data.published) metaLine.push(data.published);
	if (data.domain) metaLine.push(data.domain);
	if (data.wordCount) metaLine.push(`${data.wordCount} words`);
	if (metaLine.length) header.push(``, metaLine.join(" · "));

	header.push(`Source: ${url}`, ``, `---`, ``);

	return { markdown: header.join("\n") + content, meta };
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "url_to_markdown",
		label: "URL to Markdown",
		description:
			"Fetch a URL and extract its content as clean markdown, stripping navigation, " +
			"ads, and clutter. Returns the article/page content with a metadata header " +
			"(title, author, date, domain, word count). " +
			"Use instead of web_search when you already have a specific URL to read. " +
			"Good for: documentation pages, blog posts, articles, READMEs, any standard web page.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch and convert to markdown" }),
			include_metadata: Type.Optional(
				Type.Boolean({
					description: "Include title/author/date header (default: true)",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: "Timeout in seconds (default: 30)",
					minimum: 5,
					maximum: 120,
				}),
			),
		}),

		async execute(_id, params) {
			try {
				const { markdown, meta } = await fetchMarkdown(params.url, {
					includeMetadata: params.include_metadata,
					timeout: params.timeout,
				});
				return {
					content: [{ type: "text", text: markdown }],
					details: {
						title: meta.title,
						domain: meta.domain,
						wordCount: meta.wordCount,
					},
				};
			} catch (err: any) {
				const msg = err.message?.includes("ENOENT")
					? "defuddle CLI not found. Install: npm i -g @anthropic/defuddle-cli"
					: err.message?.includes("ETIMEDOUT") || err.message?.includes("timeout")
						? `Timed out fetching ${params.url}`
						: `Failed to fetch ${params.url}: ${err.message}`;
				return {
					content: [{ type: "text", text: msg }],
					details: { title: undefined, domain: undefined, wordCount: undefined },
				};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("fetch "));
			// Show just the domain + path, not the full URL
			try {
				const u = new URL(args.url);
				text += theme.fg("accent", u.hostname + u.pathname);
			} catch {
				text += theme.fg("accent", args.url || "");
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content?.[0]?.type === "text" ? (result.content[0] as any).text : "";
			const details = (result as any).details || {};
			const title = details.title ? theme.fg("accent", details.title) + "\n" : "";
			const stats: string[] = [];
			if (details.domain) stats.push(details.domain);
			if (details.wordCount) stats.push(`${details.wordCount} words`);
			const statsLine = stats.length ? theme.fg("dim", stats.join(" · ")) + "\n" : "";

			const lines = text.split("\n");
			const totalLines = lines.length;
			const preview = lines
				.slice(0, 8)
				.map((l: string) => theme.fg("dim", l))
				.join("\n");
			const remaining = totalLines - 8;
			const suffix = remaining > 0 ? theme.fg("muted", `\n... ${remaining} more lines`) : "";

			return new Text(title + statsLine + preview + suffix, 0, 0);
		},
	});

	// /fetch command
	pi.registerCommand("fetch", {
		description: "Fetch a URL as markdown — /fetch <url>",
		handler: async (args, ctx) => {
			const url = args?.trim();
			if (!url) {
				ctx.ui.notify("Usage: /fetch <url>", "warning");
				return;
			}
			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				ctx.ui.notify("URL must start with http:// or https://", "warning");
				return;
			}
			pi.sendUserMessage(
				`Fetch this URL and summarize the key content:\n\n${url}\n\nUse the url_to_markdown tool.`,
			);
		},
	});
}
