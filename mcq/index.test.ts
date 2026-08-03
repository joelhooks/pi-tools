import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import mcq, { fitRenderedLines } from "./index";

describe("fitRenderedLines", () => {
	test("never exceeds a 19-column terminal", () => {
		const lines = fitRenderedLines(
			[
				"✓ Flagg Commit Scope",
				"\u001b[1m✓ scope: 1. Fleet merge only\u001b[22m",
			],
			19,
		);

		expect(lines.every((line) => visibleWidth(line) <= 19)).toBe(true);
		expect(visibleWidth(lines[0])).toBe(19);
	});

	test("handles narrower widths defensively", () => {
		const [line] = fitRenderedLines(["abcd"], 1);

		expect(visibleWidth(line)).toBeLessThanOrEqual(1);
	});
});

describe("MCQ renderer", () => {
	test("fits the completed summary into the reported 19-column width", async () => {
		let tool: any;
		let rendered: string[] = [];
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const tui = { requestRender: () => {} };
		const pi = {
			on: () => {},
			registerCommand: () => {},
			registerTool: (definition: any) => { tool = definition; },
		};

		mcq(pi as any);
		await tool.execute(
			"test-call",
			{
				title: "Flagg Commit Scope",
				questions: [{ id: "scope", question: "Commit which Flagg work?", options: ["Fleet merge only"] }],
				timeout: 0,
			},
			new AbortController().signal,
			() => {},
			{
				hasUI: true,
				ui: {
					setWorkingMessage: () => {},
					custom: async (factory: any) => {
						const component = factory(tui, theme, {}, () => {});
						component.handleInput("1");
						await Bun.sleep(150);
						rendered = component.render(19);
						return { title: "Flagg Commit Scope", answers: [], cancelled: true };
					},
				},
			},
		);

		expect(rendered.length).toBeGreaterThan(0);
		expect(rendered.every((line) => visibleWidth(line) <= 19)).toBe(true);
		expect(rendered[0]).toContain("Flagg Commit");
	});
});
