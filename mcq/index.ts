/**
 * MCQ (Multiple Choice Questions) — adaptive multi-channel intent tool
 *
 * Press 1-4 to answer. Option 4 is always "Other (type your response)".
 * Adapts rendering to terminal width:
 *   - Full (≥60 cols): bars, progress, recommendations, wrapping
 *   - Compact (<50 cols): stripped chrome, short prefixes, no hints
 *   - Minimal (<35 cols): flat numbered list, zero decoration
 *
 * Wire protocol: NDJSON over Redis gateway for Telegram/web/native/voice.
 * See protocol.ts for the shared schema.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getTUILayout, type TUILayout, type MCQQuestionDef, getOptionLabel } from "./protocol.js";

// ── Types ────────────────────────────────────────────────────────────

interface MCQQuestion {
	id: string;
	question: string;
	options: string[];
	context?: string;
	recommended?: number;
	recommendedReason?: string;
}

interface MCQAnswer {
	id: string;
	question: string;
	selected: number;
	answer: string;
	isCustom: boolean;
}

interface MCQResult {
	title: string;
	answers: MCQAnswer[];
	cancelled: boolean;
}

// ── Schema ───────────────────────────────────────────────────────────

const MCQQuestionSchema = Type.Object({
	id: Type.String({ description: "Short label, e.g. 'scope', 'priority'" }),
	question: Type.String({ description: "The question to ask" }),
	options: Type.Array(Type.String(), {
		description: 'Up to 3 options. A final "Other" option is always appended automatically.',
		maxItems: 3,
	}),
	context: Type.Optional(Type.String({ description: "Optional hint shown below the question" })),
	recommended: Type.Optional(
		Type.Number({ description: "1-indexed option number to recommend. Omit if no strong recommendation." }),
	),
	recommendedReason: Type.Optional(
		Type.String({ description: "Brief reasoning for the recommendation (1-2 sentences)." }),
	),
});

const MCQParams = Type.Object({
	title: Type.Optional(Type.String({ description: 'Flow title, e.g. "Feature Design"' })),
	questions: Type.Array(MCQQuestionSchema, {
		description: "Questions to present. Each gets up to 3 options plus auto-appended Other.",
	}),
});

// ── Helpers ──────────────────────────────────────────────────────────

function progressBar(current: number, total: number, width: number, fg: (c: any, s: string) => string): string {
	const filled = Math.round((current / total) * width);
	return fg("accent", "█".repeat(filled)) + fg("dim", "░".repeat(width - filled));
}

// ── Extension ────────────────────────────────────────────────────────

export default function mcq(pi: ExtensionAPI) {
	// ── System prompt nudge ──────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n## Clarification via MCQ\n" +
				"When a user request is ambiguous, under-specified, or has multiple valid approaches, " +
				"use the `mcq` tool to quickly gather intent before proceeding. " +
				"This is faster than asking open-ended questions — the user just presses 1-4. " +
				"Good triggers: vague feature requests, architectural choices with tradeoffs, " +
				"config with many options, or any time you'd otherwise guess and risk going the wrong direction. " +
				"Recommend an option when you have a informed opinion. " +
				"Don't use mcq for simple yes/no — just ask directly.\n\n" +
				"**Adaptive flow**: Call mcq with 1-2 questions at a time, read the answers, then call mcq again " +
				"with follow-up questions that adapt to what the user chose. This feels like a conversation, not a form. " +
				"Only batch questions together when they're truly independent of each other.",
		};
	});

	pi.registerTool({
		name: "mcq",
		label: "MCQ",
		description:
			"Present multiple-choice questions for rapid intent gathering. " +
			"Each question has up to 3 options; a 4th 'Other' option is always appended so the user can type a free response " +
			"(including @file and $symbol references). " +
			"User presses 1–4 to answer instantly. " +
			"Use for requirements, design decisions, config choices, or any structured clarification. " +
			"You can recommend an option with reasoning to guide the user's decision. " +
			"ADAPTIVE FLOW: Prefer calling mcq with 1-2 questions at a time, then reading the answers " +
			"to tailor your next mcq call. This makes the conversation feel responsive — later questions " +
			"adapt to earlier answers instead of being predetermined. Only batch questions when they're truly independent.",
		parameters: MCQParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "MCQ requires interactive mode" }],
					details: { title: "", answers: [], cancelled: true } as MCQResult,
				};
			}
			if (params.questions.length === 0) {
				return {
					content: [{ type: "text", text: "No questions provided" }],
					details: { title: "", answers: [], cancelled: true } as MCQResult,
				};
			}

			const title = params.title || "Questions";
			const questions: MCQQuestion[] = params.questions.map((q) => ({
				...q,
				options: q.options.slice(0, 3),
			}));

			// Hide the working spinner while custom UI is showing
			ctx.ui.setWorkingMessage(" ");

			const result = await ctx.ui.custom<MCQResult>((tui, theme, _kb, done) => {
				// ── State ──
				let currentQ = 0;
				let inputMode = false;
				let showSummary = false;
				let flashIndex: number | null = null;
				let lastEscTime = 0;
				let cachedLines: string[] | undefined;
				let highlightIndex = 0;
				const answers = new Map<number, MCQAnswer>();

				// ── Editor for "Other" ──
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
				};
				const editor = new Editor(tui, editorTheme);

				editor.onSubmit = (value) => {
					const trimmed = value.trim();
					if (!trimmed) return;
					const q = questions[currentQ];
					answers.set(currentQ, {
						id: q.id,
						question: q.question,
						selected: q.options.length + 1,
						answer: trimmed,
						isCustom: true,
					});
					inputMode = false;
					editor.setText("");
					advance();
				};

				// ── Helpers ──
				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function advance() {
					if (currentQ < questions.length - 1) {
						currentQ++;
						const nextQ = questions[currentQ];
						highlightIndex = nextQ.recommended ? nextQ.recommended - 1 : 0;
					} else {
						showSummary = true;
					}
					refresh();
				}

				function selectOption(index: number) {
					const q = questions[currentQ];
					const otherIndex = q.options.length + 1;

					if (index === otherIndex) {
						inputMode = true;
						editor.setText("");
						refresh();
						return;
					}

					if (index >= 1 && index <= q.options.length) {
						answers.set(currentQ, {
							id: q.id,
							question: q.question,
							selected: index,
							answer: q.options[index - 1],
							isCustom: false,
						});
						flashIndex = index;
						refresh();
						setTimeout(() => {
							flashIndex = null;
							advance();
						}, 120);
					}
				}

				function submit(cancelled: boolean) {
					const ordered: MCQAnswer[] = [];
					for (let i = 0; i < questions.length; i++) {
						const a = answers.get(i);
						if (a) ordered.push(a);
					}
					done({ title, answers: ordered, cancelled });
				}

				// ── Input handling ──
				function handleInput(data: string) {
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (showSummary) {
						if (matchesKey(data, Key.enter)) { submit(false); return; }
						if (matchesKey(data, Key.escape)) { submit(true); return; }
						if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
							showSummary = false;
							currentQ = questions.length - 1;
							highlightIndex = 0;
							refresh();
							return;
						}
						const n = parseInt(data);
						if (n >= 1 && n <= questions.length) {
							showSummary = false;
							currentQ = n - 1;
							highlightIndex = 0;
							refresh();
							return;
						}
						return;
					}

					// Esc: double-tap cancels, single goes back
					if (matchesKey(data, Key.escape)) {
						const now = Date.now();
						if (now - lastEscTime < 400) { submit(true); return; }
						lastEscTime = now;
						if (currentQ > 0) { currentQ--; highlightIndex = 0; refresh(); }
						return;
					}

					// Arrow navigation
					if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
						const q = questions[currentQ];
						const maxIdx = q.options.length;
						highlightIndex = (highlightIndex - 1 + maxIdx + 1) % (maxIdx + 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
						const q = questions[currentQ];
						const maxIdx = q.options.length;
						highlightIndex = (highlightIndex + 1) % (maxIdx + 1);
						refresh();
						return;
					}

					if (matchesKey(data, Key.enter)) { selectOption(highlightIndex + 1); return; }

					// Number keys
					if (flashIndex !== null) return;
					const n = parseInt(data);
					const q = questions[currentQ];
					const maxOpt = q.options.length + 1;
					if (n >= 1 && n <= maxOpt) {
						highlightIndex = n - 1;
						selectOption(n);
					}
				}

				// ── Render ──
				function render(width: number): string[] {
					if (cachedLines) return cachedLines;
					const layout = getTUILayout(width);

					if (layout === "minimal") {
						cachedLines = renderMinimal(width);
					} else if (layout === "compact") {
						cachedLines = renderCompact(width);
					} else {
						cachedLines = renderFull(width);
					}
					return cachedLines;
				}

				// ── Minimal renderer (<35 cols) ──────────────────
				function renderMinimal(width: number): string[] {
					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					if (showSummary) {
						add(theme.fg("accent", theme.bold(`✓ ${title}`)));
						for (let i = 0; i < questions.length; i++) {
							const a = answers.get(i);
							if (a) {
								const val = a.isCustom ? a.answer : `${a.selected}. ${a.answer}`;
								add(`${theme.fg("success", "✓")} ${a.id}: ${val}`);
							}
						}
						add(theme.fg("dim", "Enter=ok Esc=cancel"));
						return lines;
					}

					const q = questions[currentQ];
					const step = `${currentQ + 1}/${questions.length}`;
					add(theme.fg("accent", `${step} ${title}`));
					// Wrap question text
					const qWrapped = wrapTextWithAnsi(q.question, width);
					for (const l of qWrapped) add(l);

					for (let i = 0; i < q.options.length; i++) {
						const num = i + 1;
						const isHl = highlightIndex === i;
						const isFlash = flashIndex === num;
						const isRec = q.recommended === num;
						const mark = isFlash ? theme.fg("success", "✓") : isHl ? theme.fg("accent", "▸") : isRec ? theme.fg("warning", "★") : " ";
						const optWrapped = wrapTextWithAnsi(q.options[i], width - 4);
						for (let j = 0; j < optWrapped.length; j++) {
							add(j === 0 ? `${mark}${num} ${optWrapped[j]}` : `   ${optWrapped[j]}`);
						}
					}
					const otherNum = q.options.length + 1;
					const isOtherHl = highlightIndex === q.options.length;
					add(`${isOtherHl ? theme.fg("accent", "▸") : " "}${otherNum} Other`);

					if (inputMode) {
						for (const line of editor.render(width - 1)) add(` ${line}`);
					}

					return lines;
				}

				// ── Compact renderer (35-49 cols) ────────────────
				function renderCompact(width: number): string[] {
					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));
					const addWrapped = (prefix: string, text: string, suffix?: string) => {
						const prefixW = visibleWidth(prefix);
						const full = prefix + text + (suffix || "");
						if (visibleWidth(full) <= width) { lines.push(full); return; }
						const indent = " ".repeat(prefixW);
						const wrapped = wrapTextWithAnsi(text + (suffix || ""), width - prefixW);
						for (let j = 0; j < wrapped.length; j++) {
							lines.push((j === 0 ? prefix : indent) + wrapped[j]);
						}
					};

					if (showSummary) {
						add(theme.fg("accent", theme.bold(`✓ ${title}`)));
						for (let i = 0; i < questions.length; i++) {
							const a = answers.get(i);
							if (a) {
								const val = a.isCustom ? `✎ ${a.answer}` : a.answer;
								addWrapped(`${theme.fg("success", "✓")} ${theme.fg("accent", a.id)}: `, val);
							} else {
								add(`${theme.fg("warning", "○")} ${theme.fg("accent", questions[i].id)}: ${theme.fg("dim", "–")}`);
							}
						}
						add(theme.fg("dim", "Enter=ok Esc=cancel ←=back"));
						return lines;
					}

					const q = questions[currentQ];
					const step = `${currentQ + 1}/${questions.length}`;

					// Header: step + title, one line
					add(`${theme.fg("accent", theme.bold(step))} ${theme.fg("muted", title)}`);

					// Question
					addWrapped(" ", theme.fg("text", q.question));
					if (q.context) {
						addWrapped(" ", theme.fg("dim", q.context));
					}

					if (inputMode) {
						for (let i = 0; i < q.options.length; i++) {
							addWrapped(theme.fg("dim", ` ${i + 1} `), theme.fg("dim", q.options[i]));
						}
						add(theme.fg("accent", ` ${q.options.length + 1} Other ✎`));
						for (const line of editor.render(width - 1)) add(` ${line}`);
						add(theme.fg("dim", "Enter=ok Esc=back"));
					} else {
						for (let i = 0; i < q.options.length; i++) {
							const num = i + 1;
							const existing = answers.get(currentQ);
							const isPrev = existing && !existing.isCustom && existing.selected === num;
							const isFlash = flashIndex === num;
							const isHl = highlightIndex === i;
							const isRec = q.recommended === num;

							let mark: string;
							let color: string;
							if (isFlash) { mark = theme.fg("success", theme.bold("✓")); color = "success"; }
							else if (isPrev) { mark = theme.fg("success", "✓"); color = "text"; }
							else if (isHl) { mark = theme.fg("accent", theme.bold("▸")); color = "accent"; }
							else if (isRec) { mark = theme.fg("warning", "★"); color = "text"; }
							else { mark = " "; color = "text"; }

							const recTag = isRec && !isFlash && !isPrev ? theme.fg("warning", " ←rec") : "";
							addWrapped(`${mark}${num} `, theme.fg(color, q.options[i]), recTag);
						}

						// Other
						const otherNum = q.options.length + 1;
						const existing = answers.get(currentQ);
						const isOtherPrev = existing?.isCustom;
						const isOtherHl = highlightIndex === q.options.length;
						if (isOtherPrev) {
							addWrapped(`${theme.fg("success", "✓")}${otherNum} `, `Other → ${existing!.answer}`);
						} else if (isOtherHl) {
							add(`${theme.fg("accent", theme.bold("▸"))}${otherNum} ${theme.fg("accent", "Other")}`);
						} else {
							add(`${theme.fg("dim", ` ${otherNum}`)} Other`);
						}

						// Recommendation reason — compact: one line max
						if (q.recommended && q.recommendedReason && !isFlash) {
							const reason = q.recommendedReason.length > width - 4
								? q.recommendedReason.slice(0, width - 7) + "..."
								: q.recommendedReason;
							add(theme.fg("dim", ` 💡 ${reason}`));
						}
					}

					return lines;
				}

				// ── Full renderer (≥60 cols) ─────────────────────
				function renderFull(width: number): string[] {
					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));
					const addWrapped = (prefix: string, text: string, suffix?: string) => {
						const prefixW = visibleWidth(prefix);
						const full = prefix + text + (suffix || "");
						if (visibleWidth(full) <= width) { lines.push(full); return; }
						const indent = " ".repeat(prefixW);
						const wrapped = wrapTextWithAnsi(text + (suffix || ""), width - prefixW);
						for (let j = 0; j < wrapped.length; j++) {
							lines.push((j === 0 ? prefix : indent) + wrapped[j]);
						}
					};
					const barLen = Math.min(width, 60);
					const bar = theme.fg("accent", "━".repeat(barLen));

					// ─── Summary ─────────────────────────────────
					if (showSummary) {
						add(bar);
						add(theme.fg("accent", theme.bold(` ✓ ${title}`)));
						add("");

						for (let i = 0; i < questions.length; i++) {
							const q = questions[i];
							const a = answers.get(i);
							if (a) {
								const val = a.isCustom
									? theme.fg("muted", "(wrote) ") + a.answer
									: theme.fg("dim", `${a.selected}. `) + a.answer;
								addWrapped(` ${theme.fg("success", "✓")} ${theme.fg("accent", q.id)}: `, val);
							} else {
								add(` ${theme.fg("warning", "○")} ${theme.fg("accent", q.id)}: ${theme.fg("dim", "(unanswered)")}`);
							}
						}

						add("");
						add(theme.fg("dim", " Enter submit • Esc cancel • ←/↑ go back • 1-9 edit"));
						add(bar);
						return lines;
					}

					// ─── Question ────────────────────────────────
					const q = questions[currentQ];
					const step = `${currentQ + 1}/${questions.length}`;
					const barWidth = Math.min(20, width - 4);

					add(bar);
					add(
						` ${theme.fg("accent", theme.bold(title))} ${theme.fg("muted", step)}  ${progressBar(currentQ + 1, questions.length, barWidth, theme.fg.bind(theme))}`,
					);
					add("");
					addWrapped(" ", theme.fg("text", q.question));
					if (q.context) {
						addWrapped("   ", theme.fg("dim", q.context));
					}
					add("");

					if (inputMode) {
						for (let i = 0; i < q.options.length; i++) {
							addWrapped(theme.fg("dim", `   ${i + 1}  `), theme.fg("dim", q.options[i]));
						}
						add(theme.fg("accent", `   ${q.options.length + 1}  Other ✎`));
						add("");
						add(theme.fg("muted", " Your response (use @path for file refs):"));
						for (const line of editor.render(width - 2)) {
							add(` ${line}`);
						}
						add("");
						add(theme.fg("dim", " Enter submit • Esc back"));
					} else {
						const isRec = (num: number) => q.recommended === num;

						for (let i = 0; i < q.options.length; i++) {
							const num = i + 1;
							const existing = answers.get(currentQ);
							const isPrevSelected = existing && !existing.isCustom && existing.selected === num;
							const isFlash = flashIndex === num;
							const isHighlighted = highlightIndex === i;
							const rec = isRec(num);

							let prefix: string;
							let optColor: string;
							if (isFlash) {
								prefix = theme.fg("success", theme.bold(` ✓ ${num} `));
								optColor = "success";
							} else if (isPrevSelected) {
								prefix = theme.fg("success", ` ✓ ${num} `);
								optColor = "text";
							} else if (isHighlighted) {
								prefix = theme.fg("accent", theme.bold(` ▸ ${num} `));
								optColor = "accent";
							} else if (rec) {
								prefix = theme.fg("warning", ` ★ ${num} `);
								optColor = "text";
							} else {
								prefix = theme.fg("dim", `   ${num} `);
								optColor = "text";
							}
							const recTag = rec && !isFlash && !isPrevSelected ? theme.fg("warning", " ← recommended") : "";
							addWrapped(`${prefix} `, theme.fg(optColor, q.options[i]), recTag);
						}

						// "Other" option
						const otherNum = q.options.length + 1;
						const existing = answers.get(currentQ);
						const isOtherPrev = existing?.isCustom;
						const isOtherHighlighted = highlightIndex === q.options.length;
						if (isOtherPrev) {
							addWrapped(
								`${theme.fg("success", ` ✓ ${otherNum} `)} `,
								`${theme.fg("text", "Other")} ${theme.fg("dim", `→ ${existing!.answer}`)}`,
							);
						} else if (isOtherHighlighted) {
							add(
								`${theme.fg("accent", theme.bold(` ▸ ${otherNum} `))} ${theme.fg("accent", "Other (type your response)")}`,
							);
						} else {
							add(
								`${theme.fg("dim", `   ${otherNum} `)} ${theme.fg("text", "Other (type your response)")}`,
							);
						}

						// Recommendation reasoning
						if (q.recommended && q.recommendedReason) {
							add("");
							const reasonPrefix = theme.fg("warning", "💡 ");
							const reasonText = theme.fg("dim", q.recommendedReason);
							const wrapped = wrapTextWithAnsi(`${reasonPrefix}${reasonText}`, width - 4);
							for (const line of wrapped) {
								add(`   ${line}`);
							}
						}

						add("");
						const escHint = currentQ > 0 ? "Esc back" : "Esc×2 cancel";
						add(theme.fg("dim", ` ↑↓ navigate • Enter select • 1-${otherNum} quick pick • ${escHint}`));
					}

					add(bar);
					return lines;
				}

				return {
					render,
					invalidate: () => { cachedLines = undefined; },
					handleInput,
				};
			});

			// Restore default working message
			ctx.ui.setWorkingMessage();

			// ── Format result for LLM ──
			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled." }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				if (a.isCustom) return `${a.id}: (user wrote) ${a.answer}`;
				return `${a.id}: ${a.selected}. ${a.answer}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		// ── Rendering ────────────────────────────────────────────────

		renderCall(args, theme) {
			const t = args.title || "Questions";
			const qs = (args.questions as any[]) || [];
			let text = theme.fg("toolTitle", theme.bold("mcq "));
			text += theme.fg("accent", t);
			text += theme.fg("muted", ` (${qs.length}q)`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as MCQResult | undefined;
			if (!details || details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				const val = a.isCustom
					? theme.fg("muted", "(wrote) ") + a.answer
					: theme.fg("dim", `${a.selected}. `) + a.answer;
				return `${theme.fg("success", "✓")} ${theme.fg("accent", a.id)}: ${val}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────────────────────────

	const MCQ_COMMON =
		`Use the mcq tool adaptively: ask 1-2 questions at a time, read my answers, then tailor your next questions based on what I chose. ` +
		`Each question should have exactly 3 clear, distinct options (the 4th "Other" is added automatically). ` +
		`Use short, descriptive IDs like "scope", "approach", "testing". ` +
		`Recommend the option you think is best based on the project context and explain why briefly. ` +
		`Only batch questions together when they don't depend on each other.`;

	pi.registerCommand("design", {
		description: "Gather requirements before building — /design <what you want to build>",
		handler: async (args, ctx) => {
			const topic = args?.trim();
			if (!topic) {
				ctx.ui.notify("Usage: /design <what you want to build or change>", "warning");
				return;
			}
			pi.sendUserMessage(
				`I want to design: ${topic}\n\n` +
					`Ask me 3-5 focused design questions to understand my intent before writing any code. ${MCQ_COMMON} ` +
					`After I answer, synthesize my choices into a concrete implementation plan, then ask if I'd like to proceed.`,
			);
		},
	});

	pi.registerCommand("wizard", {
		description: "Interactive config/setup wizard — /wizard <what to configure>",
		handler: async (args, ctx) => {
			const topic = args?.trim();
			if (!topic) {
				ctx.ui.notify("Usage: /wizard <what to set up or configure>", "warning");
				return;
			}
			pi.sendUserMessage(
				`I need to set up: ${topic}\n\n` +
					`Walk me through the configuration choices as a step-by-step wizard. ${MCQ_COMMON} ` +
					`After I answer, apply the configuration and show me what was set up.`,
			);
		},
	});

	pi.registerCommand("decide", {
		description: "Record an architectural decision — /decide <decision to make>",
		handler: async (args, ctx) => {
			const topic = args?.trim();
			if (!topic) {
				ctx.ui.notify("Usage: /decide <architectural decision to make>", "warning");
				return;
			}
			pi.sendUserMessage(
				`I need to make a decision: ${topic}\n\n` +
					`Present the key tradeoffs as focused questions with clear options. ${MCQ_COMMON} ` +
					`After I answer, write a concise ADR (Architecture Decision Record) summarizing the decision, ` +
					`context, options considered, and rationale for the chosen approach.`,
			);
		},
	});
}
