/**
 * MCQ (Multiple Choice Questions) — rapid intent design tool
 *
 * Press 1-4 to answer. Option 4 is always "Other (type your response)".
 * Designed for fast requirements gathering before implementation.
 *
 * Tool: mcq — LLM presents questions, user taps number keys
 * Command: /design <topic> — kicks off an MCQ-driven design flow
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

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
	pi.registerTool({
		name: "mcq",
		label: "MCQ",
		description:
			"Present multiple-choice questions for rapid intent gathering. " +
			"Each question has up to 3 options; a 4th 'Other' option is always appended so the user can type a free response " +
			"(including @file and $symbol references). " +
			"User presses 1–4 to answer instantly. " +
			"Use for requirements, design decisions, config choices, or any structured clarification. " +
			"You can recommend an option with reasoning to guide the user's decision.",
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
					// Editor mode
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

					// Summary view
					if (showSummary) {
						if (matchesKey(data, Key.enter)) {
							submit(false);
							return;
						}
						if (matchesKey(data, Key.escape)) {
							submit(true);
							return;
						}
						if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
							showSummary = false;
							currentQ = questions.length - 1;
							refresh();
							return;
						}
						const n = parseInt(data);
						if (n >= 1 && n <= questions.length) {
							showSummary = false;
							currentQ = n - 1;
							refresh();
							return;
						}
						return;
					}

					// Question view — Esc: double-tap cancels, single goes back
					if (matchesKey(data, Key.escape)) {
						const now = Date.now();
						if (now - lastEscTime < 400) {
							// Double-Esc → cancel entire flow
							submit(true);
							return;
						}
						lastEscTime = now;

						if (currentQ > 0) {
							currentQ--;
							refresh();
						}
						// On Q1, single Esc does nothing (need double to cancel)
						return;
					}

					// Number keys for instant selection
					if (flashIndex !== null) return;
					const n = parseInt(data);
					const q = questions[currentQ];
					const maxOpt = q.options.length + 1;
					if (n >= 1 && n <= maxOpt) {
						selectOption(n);
					}
				}

				// ── Render ──
				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));
					const barLen = Math.min(width, 60);
					const bar = theme.fg("accent", "━".repeat(barLen));

					// ─── Summary ─────────────────────────────────────
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
								add(` ${theme.fg("success", "✓")} ${theme.fg("accent", q.id)}: ${val}`);
							} else {
								add(` ${theme.fg("warning", "○")} ${theme.fg("accent", q.id)}: ${theme.fg("dim", "(unanswered)")}`);
							}
						}

						add("");
						add(theme.fg("dim", " Enter submit • Esc cancel • ←/↑ go back • 1-9 edit"));
						add(bar);
						cachedLines = lines;
						return lines;
					}

					// ─── Question ────────────────────────────────────
					const q = questions[currentQ];
					const step = `${currentQ + 1}/${questions.length}`;
					const barWidth = Math.min(20, width - 4);

					add(bar);
					add(
						` ${theme.fg("accent", theme.bold(title))} ${theme.fg("muted", step)}  ${progressBar(currentQ + 1, questions.length, barWidth, theme.fg.bind(theme))}`,
					);
					add("");
					add(theme.fg("text", ` ${q.question}`));
					if (q.context) {
						add(theme.fg("dim", `   ${q.context}`));
					}
					add("");

					if (inputMode) {
						for (let i = 0; i < q.options.length; i++) {
							add(theme.fg("dim", `   ${i + 1}  ${q.options[i]}`));
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
							const rec = isRec(num);

							let prefix: string;
							let optColor: string;
							if (isFlash) {
								prefix = theme.fg("success", theme.bold(` ✓ ${num} `));
								optColor = "success";
							} else if (isPrevSelected) {
								prefix = theme.fg("success", ` ✓ ${num} `);
								optColor = "text";
							} else if (rec) {
								prefix = theme.fg("warning", ` ★ ${num} `);
								optColor = "text";
							} else {
								prefix = theme.fg("accent", theme.bold(`   ${num} `));
								optColor = "text";
							}
							const recTag = rec && !isFlash && !isPrevSelected ? theme.fg("warning", " ← recommended") : "";
							add(`${prefix} ${theme.fg(optColor, q.options[i])}${recTag}`);
						}

						// "Other" option
						const otherNum = q.options.length + 1;
						const existing = answers.get(currentQ);
						const isOtherPrev = existing?.isCustom;
						if (isOtherPrev) {
							add(
								`${theme.fg("success", ` ✓ ${otherNum} `)} ${theme.fg("text", "Other")} ${theme.fg("dim", `→ ${existing!.answer}`)}`,
							);
						} else {
							add(
								`${theme.fg("accent", theme.bold(`   ${otherNum} `))} ${theme.fg("text", "Other (type your response)")}`,
							);
						}

						// Recommendation reasoning
						if (q.recommended && q.recommendedReason) {
							add("");
							const reasonPrefix = theme.fg("warning", " 💡 ");
							const reasonText = theme.fg("dim", q.recommendedReason);
							const wrapped = wrapTextWithAnsi(`${reasonPrefix}${reasonText}`, width - 2);
							for (const line of wrapped.split("\n")) {
								add(` ${line}`);
							}
						}

						add("");
						const escHint = currentQ > 0 ? "Esc back" : "Esc×2 cancel";
						add(theme.fg("dim", ` Press 1-${otherNum} • ${escHint}`));
					}

					add(bar);
					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
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

	// ── /design command ──────────────────────────────────────────────

	pi.registerCommand("design", {
		description: "Start an MCQ intent-design flow — /design <what you want to build>",
		handler: async (args, ctx) => {
			const topic = args?.trim();
			if (!topic) {
				ctx.ui.notify("Usage: /design <what you want to build or change>", "warning");
				return;
			}
			pi.sendUserMessage(
				`I want to design: ${topic}\n\n` +
					`Use the mcq tool to ask me 3-5 focused design questions to understand my intent before writing any code. ` +
					`Each question should have exactly 3 clear, distinct options (the 4th "Other" is added automatically). ` +
					`Use short, descriptive IDs like "scope", "approach", "testing". ` +
					`For each question, recommend the option you think is best based on the project context and explain why briefly. ` +
					`After I answer, synthesize my choices into a concrete implementation plan, then ask if I'd like to proceed.`,
			);
		},
	});
}
