#!/usr/bin/env node
/**
 * slog — structured system log for agent activity.
 *
 * Each entry is an Obsidian note with YAML frontmatter properties,
 * viewable via Obsidian Bases as a filterable/sortable database.
 * Also maintains a JSONL backing store for fast machine reads.
 *
 * Usage:
 *   slog write --action <action> --tool <tool> --detail "<what>" [--reason "<why>"] [--tags "a,b"]
 *   slog tail [--count N]
 *   slog today
 *   slog search <query>
 *
 * Storage:
 *   Notes:  <VAULT>/02 Areas/System Log/entries/YYYY-MM-DD-HHMMSS-<action>.md
 *   Base:   <VAULT>/02 Areas/System Log/System Log.base
 *   JSONL:  <VAULT>/02 Areas/System Log/system-log.jsonl  (machine-readable)
 *
 * Env:
 *   SLOG_VAULT  — Obsidian vault path (default: /Users/joel/Code/vercel/manage/brain)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Config ──────────────────────────────────────────────────────────

const VAULT = process.env.SLOG_VAULT || "/Users/joel/Code/vercel/manage/brain";
const LOG_DIR = path.join(VAULT, "02 Areas", "System Log");
const ENTRIES_DIR = path.join(LOG_DIR, "entries");
const JSONL_PATH = path.join(LOG_DIR, "system-log.jsonl");
const BASE_PATH = path.join(LOG_DIR, "System Log.base");

// ── Types ───────────────────────────────────────────────────────────

interface SlogEntry {
	timestamp: string;
	action: string;
	tool: string;
	detail: string;
	reason?: string;
	tags?: string[];
	hostname?: string;
}

const VALID_ACTIONS = new Set([
	"install",
	"remove",
	"update",
	"configure",
	"fix",
	"implement",
	"todo",
	"milestone",
	"adr-create",
	"adr-accept",
	"adr-supersede",
	"migrate",
	"security",
	"progress",
]);

// ── Helpers ─────────────────────────────────────────────────────────

function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

function actionEmoji(action: string): string {
	const map: Record<string, string> = {
		install: "📦",
		remove: "🗑️",
		update: "⬆️",
		configure: "⚙️",
		fix: "🔧",
		implement: "🏗️",
		todo: "📝",
		milestone: "🎯",
		"adr-create": "📐",
		"adr-accept": "✅",
		"adr-supersede": "🔄",
		migrate: "🚚",
		security: "🔐",
		progress: "📊",
	};
	return map[action] || "•";
}

function ensureDirs(): void {
	fs.mkdirSync(ENTRIES_DIR, { recursive: true });
}

// ── Write ───────────────────────────────────────────────────────────

function writeEntry(entry: SlogEntry): string {
	ensureDirs();
	ensureBase();

	// Generate filename: YYYY-MM-DD-HHMMSS-action.md
	const dt = new Date(entry.timestamp);
	const pad = (n: number) => String(n).padStart(2, "0");
	const slug = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}-${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}-${entry.action}`;
	const filename = `${slug}.md`;
	const filepath = path.join(ENTRIES_DIR, filename);

	// Build YAML frontmatter
	const emoji = actionEmoji(entry.action);
	const frontmatter: Record<string, unknown> = {
		action: entry.action,
		tool: entry.tool,
		detail: entry.detail,
		timestamp: entry.timestamp,
	};
	if (entry.reason) frontmatter.reason = entry.reason;
	if (entry.tags && entry.tags.length > 0) frontmatter.tags = entry.tags;
	if (entry.hostname) frontmatter.hostname = entry.hostname;

	// Render YAML manually (avoid dependency)
	const yamlLines: string[] = [];
	for (const [key, value] of Object.entries(frontmatter)) {
		if (Array.isArray(value)) {
			yamlLines.push(`${key}:`);
			for (const item of value) {
				yamlLines.push(`  - "${String(item).replace(/"/g, '\\"')}"`);
			}
		} else {
			const strVal = String(value);
			// Quote strings that contain special YAML chars
			if (strVal.includes(":") || strVal.includes('"') || strVal.includes("'") || strVal.includes("\n") || strVal.includes("#")) {
				yamlLines.push(`${key}: "${strVal.replace(/"/g, '\\"')}"`);
			} else {
				yamlLines.push(`${key}: ${strVal}`);
			}
		}
	}

	const timeDisplay = entry.timestamp.slice(11, 16);
	const body = `# ${emoji} ${entry.action}: ${entry.tool}

${entry.detail}${entry.reason ? `\n\n> **Why:** ${entry.reason}` : ""}
`;

	const content = `---\n${yamlLines.join("\n")}\n---\n\n${body}`;
	fs.writeFileSync(filepath, content);

	// Append to JSONL (machine-readable backing store)
	fs.appendFileSync(JSONL_PATH, JSON.stringify(entry) + "\n");

	return filepath;
}

// ── Base file ───────────────────────────────────────────────────────

function ensureBase(): void {
	if (fs.existsSync(BASE_PATH)) return;

	const baseYaml = `filters:
  and:
    - file.inFolder("02 Areas/System Log/entries")
    - file.ext == "md"
properties:
  action:
    displayName: Action
  tool:
    displayName: Tool
  detail:
    displayName: Detail
  reason:
    displayName: Reason
  timestamp:
    displayName: Time
  tags:
    displayName: Tags
formulas:
  emoji: 'if(action == "implement", "🏗️", if(action == "fix", "🔧", if(action == "configure", "⚙️", if(action == "install", "📦", if(action == "milestone", "🎯", if(action == "todo", "📝", if(action == "security", "🔐", if(action == "migrate", "🚚", if(action == "progress", "📊", if(action == "update", "⬆️", if(action == "remove", "🗑️", if(action == "adr-create", "📐", if(action == "adr-accept", "✅", if(action == "adr-supersede", "🔄", "•"))))))))))))))'
views:
  - type: table
    name: All Entries
    order:
      - formula.emoji
      - timestamp
      - action
      - tool
      - detail
      - reason
    sort:
      - property: timestamp
        direction: DESC
    columnSize:
      formula.emoji: 50
      note.timestamp: 175
      note.action: 120
      note.tool: 200
      note.detail: 400
      note.reason: 300
  - type: table
    name: Today
    filters:
      and:
        - file.ctime >= today()
    order:
      - formula.emoji
      - timestamp
      - action
      - tool
      - detail
      - reason
    sort:
      - property: timestamp
        direction: DESC
    columnSize:
      formula.emoji: 50
      note.timestamp: 175
      note.action: 120
      note.tool: 200
      note.detail: 400
      note.reason: 300
  - type: table
    name: This Week
    filters:
      and:
        - file.ctime >= today() - "7 days"
    order:
      - formula.emoji
      - timestamp
      - action
      - tool
      - detail
    sort:
      - property: timestamp
        direction: DESC
  - type: table
    name: Fixes
    filters:
      and:
        - action == "fix"
    order:
      - timestamp
      - tool
      - detail
      - reason
    sort:
      - property: timestamp
        direction: DESC
  - type: table
    name: Milestones
    filters:
      or:
        - action == "milestone"
        - action == "implement"
    order:
      - timestamp
      - action
      - tool
      - detail
    sort:
      - property: timestamp
        direction: DESC
`;

	fs.writeFileSync(BASE_PATH, baseYaml);
}

// ── Read ────────────────────────────────────────────────────────────

function readEntries(): SlogEntry[] {
	try {
		const content = fs.readFileSync(JSONL_PATH, "utf-8");
		return content
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function formatEntry(e: SlogEntry): string {
	const emoji = actionEmoji(e.action);
	const ts = e.timestamp.slice(0, 16).replace("T", " ");
	let line = `${emoji} ${ts}  ${e.action.padEnd(12)} ${e.tool}: ${e.detail}`;
	if (e.reason) line += `\n   └─ ${e.reason}`;
	return line;
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
	const command = argv[0] || "help";
	const flags: Record<string, string> = {};
	let i = 1;
	while (i < argv.length) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const val = argv[i + 1];
			if (val && !val.startsWith("--")) {
				flags[key] = val;
				i += 2;
			} else {
				flags[key] = "true";
				i++;
			}
		} else {
			flags._rest = (flags._rest ? flags._rest + " " : "") + arg;
			i++;
		}
	}
	return { command, flags };
}

function main(): void {
	const args = process.argv.slice(2);
	const { command, flags } = parseArgs(args);

	switch (command) {
		case "write": {
			const action = flags.action;
			const tool = flags.tool;
			const detail = flags.detail;
			const reason = flags.reason;
			const tags = flags.tags?.split(",").map((t) => t.trim()) || undefined;

			if (!action || !tool || !detail) {
				console.error("Usage: slog write --action <action> --tool <tool> --detail \"<what>\" [--reason \"<why>\"]");
				console.error(`\nValid actions: ${[...VALID_ACTIONS].join(", ")}`);
				process.exit(1);
			}

			if (!VALID_ACTIONS.has(action)) {
				console.error(`Unknown action: ${action}`);
				console.error(`Valid actions: ${[...VALID_ACTIONS].join(", ")}`);
				process.exit(1);
			}

			const entry: SlogEntry = {
				timestamp: new Date().toISOString(),
				action,
				tool,
				detail,
				reason: reason || undefined,
				tags: tags || undefined,
				hostname: os.hostname(),
			};

			const filepath = writeEntry(entry);
			console.log(formatEntry(entry));
			break;
		}

		case "tail": {
			const count = parseInt(flags.count || flags._rest || "10", 10);
			const entries = readEntries().slice(-count);
			if (entries.length === 0) {
				console.log("No slog entries yet.");
			} else {
				entries.forEach((e) => console.log(formatEntry(e)));
			}
			break;
		}

		case "today": {
			const today = todayStr();
			const entries = readEntries().filter((e) => e.timestamp.startsWith(today));
			if (entries.length === 0) {
				console.log(`No entries for ${today}.`);
			} else {
				console.log(`# ${today} — ${entries.length} entries\n`);
				entries.forEach((e) => console.log(formatEntry(e)));
			}
			break;
		}

		case "search": {
			const query = (flags._rest || "").toLowerCase();
			if (!query) {
				console.error("Usage: slog search <query>");
				process.exit(1);
			}
			const matches = readEntries().filter(
				(e) =>
					e.detail.toLowerCase().includes(query) ||
					e.tool.toLowerCase().includes(query) ||
					e.action.toLowerCase().includes(query) ||
					(e.reason || "").toLowerCase().includes(query),
			);
			if (matches.length === 0) {
				console.log(`No entries matching "${query}".`);
			} else {
				console.log(`${matches.length} matches:\n`);
				matches.forEach((e) => console.log(formatEntry(e)));
			}
			break;
		}

		case "path": {
			console.log(`JSONL:    ${JSONL_PATH}`);
			console.log(`Entries:  ${ENTRIES_DIR}`);
			console.log(`Base:     ${BASE_PATH}`);
			break;
		}

		case "help":
		default:
			console.log(`slog — structured system log for agent activity

Commands:
  slog write --action <action> --tool <tool> --detail "<what>" [--reason "<why>"] [--tags "a,b"]
  slog tail [--count N]           Show last N entries (default: 10)
  slog today                      Show today's entries
  slog search <query>             Search entries by text
  slog path                       Print storage paths

Actions:
  install, remove, update         — tools, services, dependencies
  configure                       — env vars, plists, service settings
  fix                             — bug fixes, debugging breakthroughs
  implement                       — features, functions, major code changes
  todo                            — deferred work, known issues
  milestone                       — significant accomplishments
  adr-create, adr-accept, adr-supersede — architecture decisions
  migrate                         — breaking changes, data migrations
  security                        — key rotations, permission updates
  progress                        — project status updates

Storage (Obsidian Bases):
  Notes:  ${ENTRIES_DIR}/YYYY-MM-DD-HHMMSS-<action>.md
  Base:   ${BASE_PATH}
  JSONL:  ${JSONL_PATH}

Env:
  SLOG_VAULT  — Obsidian vault path (default: ${VAULT})`);
			break;
	}
}

main();
