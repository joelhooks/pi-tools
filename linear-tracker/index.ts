/**
 * linear-tracker — project-local issue tracker resolver + Linear publisher.
 *
 * This is the lock Rat King needs: Linear is only allowed when project-local
 * policy says Linear AND we have a Linear association (team key/id) AND auth.
 * No more "global MCP exists, therefore yeet tickets into Linear" bullshit.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const MAX_POLICY_BYTES = 160_000;
const DEFAULT_LINEAR_SECRET_NAMES = ["wzrrd::linear_api_key", "rubicon:linear_api_key", "linear_api_key", "LINEAR_API_KEY", "linear_token", "LINEAR_TOKEN"];

type TrackerKind = "linear" | "github" | "other" | "unknown";
type PolicyDecision = "linear" | "non-linear" | "unknown";

type EvidenceKind = "policy" | "brain" | "settings" | "skill" | "mcp" | "auth";

interface Evidence {
	path: string;
	kind: EvidenceKind;
	decision: PolicyDecision;
	reason: string;
	snippet?: string;
}

interface LinearAssociation {
	workspace?: string;
	teamKey?: string;
	teamId?: string;
	projectId?: string;
	projectName?: string;
}

interface LinearCapabilities {
	directApiKey: boolean;
	directApiKeySource?: string;
	agentSecretsChecked: boolean;
	agentSecretsAvailable: boolean;
	mcpConfigured: boolean;
	mcpAuthenticated: boolean;
	mcpServerName?: string;
	mcpUrl?: string;
}

interface ResolveResult {
	cwd: string;
	projectRoot: string;
	tracker: TrackerKind;
	linearAllowed: boolean;
	canPublishLinearDirect: boolean;
	canPublishLinearViaMcp: boolean;
	publishMode: "linear_direct" | "linear_mcp" | "payload_only" | "not_linear" | "unknown";
	association: LinearAssociation;
	capabilities: LinearCapabilities;
	authSecretNames: string[];
	reasons: string[];
	evidence: Evidence[];
	nextActions: string[];
}

interface LinearIssuePayload {
	title: string;
	description?: string;
	teamKey?: string;
	teamId?: string;
	projectId?: string;
	stateId?: string;
	assigneeId?: string;
	parentId?: string;
	labelIds?: string[];
	priority?: number;
}

interface CreatedIssue {
	id: string;
	identifier: string;
	url: string;
	title: string;
}

function text(content: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: content }], details };
}

function redact(value: string): string {
	return value
		.replace(/(linear[_-]?(?:api[_-]?)?(?:key|token)\s*[:=]\s*)[^\s\n"'`]+/gi, "$1[REDACTED]")
		.replace(/(authorization\s*[:=]\s*)[^\s\n"'`]+/gi, "$1[REDACTED]")
		.replace(/([A-Za-z0-9_-]{32,})/g, (match) => {
			// Keep UUID-ish IDs visible; redact token-shaped blobs.
			if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(match)) return match;
			return "[REDACTED]";
		});
}

function safeRead(path: string): string | undefined {
	try {
		const text = readFileSync(path, "utf-8");
		return text.length > MAX_POLICY_BYTES ? text.slice(0, MAX_POLICY_BYTES) : text;
	} catch {
		return undefined;
	}
}

function findGitRoot(cwd: string): string {
	try {
		const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3_000,
		}).trim();
		if (out) return out;
	} catch {}
	return cwd;
}

function ancestorDirs(start: string, stopAt: string): string[] {
	const dirs: string[] = [];
	let current = resolve(start);
	const stop = resolve(stopAt);
	while (true) {
		dirs.push(current);
		if (current === stop || current === dirname(current)) break;
		current = dirname(current);
	}
	return dirs;
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function lineSnippet(text: string, matcher: RegExp): string | undefined {
	const lines = text.split(/\r?\n/);
	const index = lines.findIndex((line) => matcher.test(line));
	if (index < 0) return undefined;
	const start = Math.max(0, index - 1);
	const end = Math.min(lines.length, index + 2);
	return redact(lines.slice(start, end).join("\n").trim());
}

function scanDecision(text: string): { decision: PolicyDecision; reason: string; snippet?: string } {
	const nonLinearPatterns = [
		/\bissue\s*tracker\b[^\n]*(github|gh|not\s+linear|no\s+linear)/i,
		/\btracker\b[^\n]*(github|gh|not\s+linear|no\s+linear)/i,
		/\bgithub\s+issues\b/i,
		/\b(use|prefer)\s+github\b[^\n]*\bissues?\b/i,
		/\bdo\s+not\s+use\s+linear\b/i,
		/\blinear\b[^\n]*(disabled|false|not\s+used)/i,
	];
	for (const pattern of nonLinearPatterns) {
		if (pattern.test(text)) {
			return { decision: "non-linear", reason: "local policy points away from Linear", snippet: lineSnippet(text, pattern) };
		}
	}

	const linearPatterns = [
		/\bissue\s*tracker\b[^\n]*\blinear\b/i,
		/\btracker\b[^\n]*\blinear\b/i,
		/\b(use|uses|prefer|publish\s+to)\s+linear\b/i,
		/\blinear\s+(workspace|org|organization|team|team\s*key|team\s*id|project)\b/i,
		/\blinear\s*[:=]\s*(true|enabled|\{)/i,
	];
	for (const pattern of linearPatterns) {
		if (pattern.test(text)) {
			return { decision: "linear", reason: "local policy explicitly points to Linear", snippet: lineSnippet(text, pattern) };
		}
	}

	return { decision: "unknown", reason: "no tracker decision found" };
}

function assignAssociation(target: LinearAssociation, next: LinearAssociation) {
	for (const [key, value] of Object.entries(next) as Array<[keyof LinearAssociation, string | undefined]>) {
		if (value && !target[key]) target[key] = value;
	}
}

function linearRelevantChunks(text: string): string[] {
	const chunks = [text];
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		if (!/linear/i.test(lines[index])) continue;
		const start = Math.max(0, index - 2);
		let end = Math.min(lines.length, index + 18);
		for (let cursor = index + 1; cursor < lines.length; cursor++) {
			// Stop when the next peer Markdown section starts. This lets plain labels like
			// "Team key" work inside "## Linear issue tracking" without accidentally
			// stealing IDs from unrelated sections later in the policy file.
			if (/^#{1,3}\s+\S/.test(lines[cursor]) && cursor > index + 1) {
				end = cursor;
				break;
			}
		}
		chunks.push(lines.slice(start, end).join("\n"));
	}
	return chunks;
}

export function parseAssociationFromText(text: string): LinearAssociation {
	const out: LinearAssociation = {};
	const patterns: Array<[keyof LinearAssociation, RegExp]> = [
		["workspace", /\blinear[_\s.-]*workspace\b\s*[:=]\s*["'`]?([A-Za-z0-9][A-Za-z0-9_-]{1,80})/i],
		["workspace", /\blinear[_\s.-]*(?:org|organization|workspace)(?:[_\s.-]*(?:slug|name))?\b\s*[:=]\s*["'`]?([A-Za-z0-9][A-Za-z0-9_-]{1,80})/i],
		["teamKey", /\blinear[_\s.-]*team[_\s.-]*key\b\s*[:=]\s*["'`]?([A-Z][A-Z0-9]{1,12})\b/i],
		["teamKey", /\blinear[_\s.-]*team\b\s*[:=]\s*["'`]?([A-Z][A-Z0-9]{1,12})\b/i],
		["teamId", /\blinear[_\s.-]*team[_\s.-]*id\b\s*[:=]\s*["'`]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i],
		["projectId", /\blinear[_\s.-]*project[_\s.-]*id\b\s*[:=]\s*["'`]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i],
		["projectName", /\blinear[_\s.-]*project(?:[_\s.-]*name)?\b\s*[:=]\s*["'`]?([^\n"'`]+)/i],
	];
	const sectionPatterns: Array<[keyof LinearAssociation, RegExp]> = [
		["workspace", /^\s*[-*]?\s*(?:org|organization|workspace)(?:\s+(?:slug|name))?\s*:\s*[`"']?([A-Za-z0-9][A-Za-z0-9_-]{1,80})/im],
		["teamKey", /^\s*[-*]?\s*team\s+key\s*:\s*[`"']?([A-Z][A-Z0-9]{1,12})\b/im],
		["teamId", /^\s*[-*]?\s*team\s+id\s*:\s*[`"']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/im],
		["projectId", /^\s*[-*]?\s*project\s+id\s*:\s*[`"']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/im],
		["projectName", /^\s*[-*]?\s*project(?:\s+name)?\s*:\s*[`"']?([^\n"'`]+)/im],
	];
	for (const chunk of linearRelevantChunks(text)) {
		for (const [key, pattern] of [...patterns, ...sectionPatterns]) {
			if (out[key]) continue;
			const match = chunk.match(pattern);
			if (match?.[1]) out[key] = match[1].trim().replace(/[`"']$/, "");
		}
	}
	return out;
}

function parseLinearSecretNamesFromText(text: string): string[] {
	const names: string[] = [];
	const patterns = [
		/\bsecrets\s+lease\s+([A-Za-z0-9:_-]*linear[A-Za-z0-9:_-]*)\b/gi,
		/\bagent-secrets\b[^\n]{0,80}\bas\s+[`"']?([A-Za-z0-9:_-]*linear[A-Za-z0-9:_-]*)\b/gi,
		/\bsecret(?:\s+name)?\b\s*[:=]\s*[`"']?([A-Za-z0-9:_-]*linear[A-Za-z0-9:_-]*)\b/gi,
		/\blinear(?:[_\s.-]*api)?[_\s.-]*key\b\s*(?:secret|name)?\s*[:=]\s*[`"']?([A-Za-z0-9:_-]*linear[A-Za-z0-9:_-]*)\b/gi,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			const name = match[1]?.trim().replace(/[`,.;)\]}]+$/, "");
			if (name) names.push(name);
		}
	}
	return unique(names);
}

function walkJson(value: unknown, path: string[] = [], visitor: (path: string[], value: unknown) => void) {
	visitor(path, value);
	if (Array.isArray(value)) {
		value.forEach((item, index) => walkJson(item, [...path, String(index)], visitor));
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) walkJson(child, [...path, key], visitor);
	}
}

function findBrainPolicyFiles(projectRoot: string): string[] {
	const brainRoot = join(projectRoot, ".brain");
	if (!existsSync(brainRoot)) return [];
	const candidates = [join(brainRoot, "index.svx")];
	for (const section of ["areas", "projects", "decisions", "resources"] as const) {
		const dir = join(brainRoot, section);
		if (!existsSync(dir)) continue;
		try {
			const entries = execFileSync("find", [dir, "-maxdepth", "2", "-type", "f", "-name", "*.svx"], {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 3_000,
			})
				.split(/\r?\n/)
				.filter(Boolean)
				.slice(0, 80);
			candidates.push(...entries);
		} catch {}
	}
	return unique(candidates).filter((path) => existsSync(path));
}

function scanSettings(path: string, text: string): { evidence?: Evidence; association: LinearAssociation } {
	const association: LinearAssociation = {};
	try {
		const json = JSON.parse(text);
		let decision: PolicyDecision = "unknown";
		let reason = "no tracker decision found";
		walkJson(json, [], (keyPath, value) => {
			const joined = keyPath.join(".").toLowerCase();
			if (typeof value === "string") {
				const lower = value.toLowerCase();
				if ((joined.includes("issue") || joined.includes("tracker")) && lower.includes("github")) {
					decision = "non-linear";
					reason = `${keyPath.join(".")} is ${value}`;
				}
				if ((joined.includes("issue") || joined.includes("tracker")) && lower.includes("linear")) {
					decision = "linear";
					reason = `${keyPath.join(".")} is ${value}`;
				}
				if (joined.endsWith("linear.workspace") || joined.endsWith("linear.workspacename")) association.workspace ||= value;
				if (joined.endsWith("linear.teamkey") || joined.endsWith("linear.team") || joined.endsWith("linearteamkey")) association.teamKey ||= value;
				if (joined.endsWith("linear.teamid") || joined.endsWith("linearteamid")) association.teamId ||= value;
				if (joined.endsWith("linear.projectid") || joined.endsWith("linearprojectid")) association.projectId ||= value;
				if (joined.endsWith("linear.projectname") || joined.endsWith("linear.project") || joined.endsWith("linearprojectname")) association.projectName ||= value;
			}
			if (typeof value === "boolean" && joined.includes("linear")) {
				if (value === false) {
					decision = "non-linear";
					reason = `${keyPath.join(".")} is false`;
				} else if (joined.includes("issue") || joined.includes("tracker")) {
					decision = "linear";
					reason = `${keyPath.join(".")} is true`;
				}
			}
		});
		return { evidence: { path, kind: "settings", decision, reason, snippet: redact(JSON.stringify(json, null, 2).slice(0, 800)) }, association };
	} catch {
		const scanned = scanDecision(text);
		assignAssociation(association, parseAssociationFromText(text));
		return { evidence: { path, kind: "settings", ...scanned }, association };
	}
}

function collectPolicy(cwd: string): { projectRoot: string; evidence: Evidence[]; association: LinearAssociation; authSecretNames: string[] } {
	const projectRoot = findGitRoot(cwd);
	const home = homedir();
	const dirs = unique([...ancestorDirs(cwd, home), projectRoot]);
	const evidence: Evidence[] = [];
	const association: LinearAssociation = {};
	const authSecretNames: string[] = [];

	for (const dir of dirs) {
		const candidates = [
			{ path: join(dir, "AGENTS.md"), kind: "policy" as const },
			{ path: join(dir, "CLAUDE.md"), kind: "policy" as const },
			{ path: join(dir, ".pi", "APPEND_SYSTEM.md"), kind: "policy" as const },
			{ path: join(dir, ".pi", "settings.json"), kind: "settings" as const },
			// Legacy shim supported for older projects. Prefer .pi/APPEND_SYSTEM.md or .brain/*.svx.
			{ path: join(dir, "docs", "agents", "issue-tracker.md"), kind: "policy" as const },
		];
		for (const candidate of candidates) {
			if (!existsSync(candidate.path)) continue;
			const content = safeRead(candidate.path);
			if (!content) continue;
			authSecretNames.push(...parseLinearSecretNamesFromText(content));
			if (candidate.kind === "settings") {
				const scanned = scanSettings(candidate.path, content);
				if (scanned.evidence) evidence.push(scanned.evidence);
				assignAssociation(association, scanned.association);
			} else {
				const scanned = scanDecision(content);
				evidence.push({ path: candidate.path, kind: candidate.kind, ...scanned });
				assignAssociation(association, parseAssociationFromText(content));
			}
		}
	}

	for (const brainPath of findBrainPolicyFiles(projectRoot)) {
		const content = safeRead(brainPath);
		if (!content || !/linear|github issues?|issue tracker/i.test(content)) continue;
		authSecretNames.push(...parseLinearSecretNamesFromText(content));
		const scanned = scanDecision(content);
		if (scanned.decision === "unknown") continue;
		evidence.push({ path: brainPath, kind: "brain", ...scanned });
		assignAssociation(association, parseAssociationFromText(content));
	}

	// Project-local skills are supporting evidence only. They never override policy.
	const skillDirs = [join(projectRoot, ".pi", "skills"), join(projectRoot, ".pi", "agent", "skills"), join(projectRoot, ".agents", "skills"), join(projectRoot, "skills")];
	for (const root of skillDirs) {
		if (!existsSync(root)) continue;
		try {
			const entries = execFileSync("find", [root, "-maxdepth", "3", "-name", "SKILL.md", "-type", "f"], {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 3_000,
			})
				.split(/\r?\n/)
				.filter(Boolean)
				.slice(0, 50);
			for (const skillPath of entries) {
				if (/\/linear-tracker\/SKILL\.md$/i.test(skillPath)) continue;
				const content = safeRead(skillPath);
				if (!content || !/linear|github issues?|issue tracker/i.test(content)) continue;
				authSecretNames.push(...parseLinearSecretNamesFromText(content));
				const scanned = scanDecision(content);
				if (scanned.decision === "unknown") continue;
				evidence.push({ path: skillPath, kind: "skill", ...scanned });
			}
		} catch {}
	}

	return { projectRoot, evidence, association, authSecretNames: unique(authSecretNames) };
}

function loadJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function tokenExpired(tokens: any): boolean {
	if (!tokens) return true;
	if (typeof tokens.expiresAt === "number") return Date.now() >= tokens.expiresAt - 60_000;
	if (typeof tokens.expires_at === "number") return Date.now() >= tokens.expires_at - 60_000;
	return false;
}

function detectMcp(): Pick<LinearCapabilities, "mcpConfigured" | "mcpAuthenticated" | "mcpServerName" | "mcpUrl"> & { evidence?: Evidence } {
	const bridgeDir = join(homedir(), ".pi", "mcp-bridge");
	const servers = loadJson<Array<{ name: string; url: string }>>(join(bridgeDir, "servers.json")) ?? [];
	const server = servers.find((s) => /linear/i.test(s.name) || /linear/i.test(s.url));
	const fallbackName = existsSync(join(homedir(), ".pi", "agent", "mcp-oauth", "linear", "tokens.json")) ? "linear" : undefined;
	const name = server?.name ?? fallbackName;
	if (!name) return { mcpConfigured: false, mcpAuthenticated: false };

	const bridgeTokens = loadJson<any>(join(bridgeDir, `tokens-${name}.json`));
	const piTokens = loadJson<any>(join(homedir(), ".pi", "agent", "mcp-oauth", name, "tokens.json"));
	const tokens = piTokens?.access_token ? piTokens : bridgeTokens;
	const authenticated = Boolean(tokens?.access_token && !tokenExpired(tokens));
	return {
		mcpConfigured: true,
		mcpAuthenticated: authenticated,
		mcpServerName: name,
		mcpUrl: server?.url,
		evidence: {
			path: server ? join(bridgeDir, "servers.json") : join(homedir(), ".pi", "agent", "mcp-oauth", name, "tokens.json"),
			kind: "mcp",
			decision: "linear",
			reason: authenticated ? "Linear MCP server configured and authenticated" : "Linear MCP server configured but not authenticated",
		},
	};
}

function leaseLinearSecret(secretNames: string[] = []): { token?: string; source?: string; checked: boolean; available: boolean } {
	for (const name of unique([...secretNames, ...DEFAULT_LINEAR_SECRET_NAMES])) {
		try {
			const value = execFileSync("secrets", ["lease", name, "--ttl", "15m", "--client-id", "pi-linear-tracker"], {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 10_000,
			}).trim();
			if (value && !/^error/i.test(value)) return { token: value, source: `agent-secrets:${name}`, checked: true, available: true };
		} catch {}
	}
	return { checked: true, available: false };
}

function getLinearApiKey(options: { allowAgentSecrets: boolean; secretNames?: string[] }): { token?: string; source?: string; agentSecretsChecked: boolean; agentSecretsAvailable: boolean } {
	const envNames = ["LINEAR_API_KEY", "LINEAR_TOKEN", "LINEAR_PERSONAL_API_KEY"];
	for (const name of envNames) {
		const value = process.env[name];
		if (value) return { token: value, source: `env:${name}`, agentSecretsChecked: false, agentSecretsAvailable: false };
	}
	if (options.allowAgentSecrets) {
		const leased = leaseLinearSecret(options.secretNames);
		return { token: leased.token, source: leased.source, agentSecretsChecked: leased.checked, agentSecretsAvailable: leased.available };
	}
	return { agentSecretsChecked: false, agentSecretsAvailable: false };
}

export function resolveTracker(cwdRaw: string | undefined, options: { allowAgentSecrets: boolean; includeEvidence: boolean }): ResolveResult {
	const cwd = resolve(cwdRaw && isAbsolute(cwdRaw) ? cwdRaw : cwdRaw ? join(process.cwd(), cwdRaw) : process.cwd());
	const { projectRoot, evidence, association, authSecretNames } = collectPolicy(cwd);
	const decisive = evidence.find((item) => (item.kind === "policy" || item.kind === "brain" || item.kind === "settings") && (item.decision === "non-linear" || item.decision === "linear"));
	const mcp = detectMcp();
	if (mcp.evidence) evidence.push(mcp.evidence);

	let tracker: TrackerKind = "unknown";
	const reasons: string[] = [];
	if (decisive?.decision === "non-linear") {
		tracker = /github|gh/i.test(decisive.snippet ?? decisive.reason) ? "github" : "other";
		reasons.push(`Nearest decisive policy is non-Linear: ${decisive.path}`);
	} else if (decisive?.decision === "linear") {
		tracker = "linear";
		reasons.push(`Nearest decisive policy is Linear: ${decisive.path}`);
	} else {
		reasons.push("No project-local issue tracker policy found.");
	}

	const shouldCheckAuth = tracker === "linear";
	const auth: { token?: string; source?: string; agentSecretsChecked: boolean; agentSecretsAvailable: boolean } = shouldCheckAuth
		? getLinearApiKey({ allowAgentSecrets: options.allowAgentSecrets, secretNames: authSecretNames })
		: { agentSecretsChecked: false, agentSecretsAvailable: false };
	const capabilities: LinearCapabilities = {
		directApiKey: Boolean(auth.token),
		directApiKeySource: auth.source,
		agentSecretsChecked: auth.agentSecretsChecked,
		agentSecretsAvailable: auth.agentSecretsAvailable,
		mcpConfigured: mcp.mcpConfigured,
		mcpAuthenticated: mcp.mcpAuthenticated,
		mcpServerName: mcp.mcpServerName,
		mcpUrl: mcp.mcpUrl,
	};

	const hasAssociation = Boolean(association.teamKey || association.teamId);
	if (tracker === "linear" && !hasAssociation) reasons.push("Linear policy exists, but no local Linear teamKey/teamId association was found.");
	if (tracker === "linear" && hasAssociation && !capabilities.directApiKey && !capabilities.mcpAuthenticated) reasons.push("Linear association exists, but no Linear auth/API capability was found.");

	const linearAllowed = tracker === "linear";
	const canPublishLinearDirect = linearAllowed && hasAssociation && capabilities.directApiKey;
	const canPublishLinearViaMcp = linearAllowed && hasAssociation && capabilities.mcpAuthenticated;
	const publishMode: ResolveResult["publishMode"] = !linearAllowed
		? tracker === "unknown"
			? "unknown"
			: "not_linear"
		: canPublishLinearDirect
			? "linear_direct"
			: canPublishLinearViaMcp
				? "linear_mcp"
				: "payload_only";

	const nextActions: string[] = [];
	if (publishMode === "unknown") nextActions.push("Add project-local tracker policy before publishing. Suggested: .pi/APPEND_SYSTEM.md or .brain/areas/<project>.svx. Legacy docs/agents/issue-tracker.md is still supported but not preferred.");
	if (publishMode === "not_linear") nextActions.push("Use the configured non-Linear tracker. Do not publish Linear issues from global auth/tool presence.");
	if (publishMode === "payload_only") {
		if (!hasAssociation) nextActions.push("Add Linear teamKey or teamId to project-local tracker policy.");
		if (!capabilities.directApiKey && !capabilities.mcpAuthenticated) nextActions.push("Authenticate Linear via LINEAR_API_KEY, project-local agent-secrets name such as wzrrd::linear_api_key, rubicon:linear_api_key, linear_api_key, or /mcp-login linear.");
		nextActions.push("Until both association and auth exist, output ready-to-paste Linear payloads only.");
	}
	if (publishMode === "linear_mcp") nextActions.push("Linear MCP appears ready; use the Linear MCP create/read tools and verify readback.");
	if (publishMode === "linear_direct") nextActions.push("Direct Linear GraphQL publishing is allowed. Verify every created issue by readback.");

	return {
		cwd,
		projectRoot,
		tracker,
		linearAllowed,
		canPublishLinearDirect,
		canPublishLinearViaMcp,
		publishMode,
		association,
		capabilities,
		authSecretNames,
		reasons,
		evidence: options.includeEvidence ? evidence : [],
		nextActions,
	};
}

function formatResolve(result: ResolveResult): string {
	const lines = [
		`Issue tracker: ${result.tracker}`,
		`Publish mode: ${result.publishMode}`,
		`Project root: ${result.projectRoot}`,
		`Linear allowed: ${result.linearAllowed ? "yes" : "no"}`,
		`Linear association: ${result.association.teamKey || result.association.teamId ? [result.association.teamKey && `teamKey=${result.association.teamKey}`, result.association.teamId && `teamId=${result.association.teamId}`, result.association.projectId && `projectId=${result.association.projectId}`, result.association.projectName && `projectName=${result.association.projectName}`].filter(Boolean).join(", ") : "missing"}`,
		`Capabilities: directApiKey=${result.capabilities.directApiKey ? "yes" : "no"}${result.capabilities.directApiKeySource ? ` (${result.capabilities.directApiKeySource})` : ""}, mcp=${result.capabilities.mcpAuthenticated ? "authenticated" : result.capabilities.mcpConfigured ? "configured" : "missing"}`,
		"",
		"Reasons:",
		...result.reasons.map((reason) => `- ${reason}`),
		"",
		"Next:",
		...result.nextActions.map((action) => `- ${action}`),
	];
	if (result.evidence.length) {
		lines.push("", "Evidence:");
		for (const item of result.evidence.filter((e) => e.decision !== "unknown")) {
			lines.push(`- ${item.decision} via ${item.path}: ${item.reason}`);
			if (item.snippet) lines.push(`  ${item.snippet.replace(/\n/g, "\n  ")}`);
		}
	}
	return lines.join("\n");
}

async function linearGraphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
	const response = await fetch(LINEAR_GRAPHQL_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: token,
		},
		body: JSON.stringify({ query, variables }),
	});
	const data: any = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(`Linear API HTTP ${response.status}: ${JSON.stringify(data)}`);
	if (data.errors?.length) throw new Error(`Linear API error: ${data.errors.map((e: any) => e.message).join("; ")}`);
	return data.data as T;
}

async function getTeamId(token: string, input: { teamId?: string; teamKey?: string }): Promise<{ teamId: string; teamKey?: string; teamName?: string }> {
	if (input.teamId) return { teamId: input.teamId, teamKey: input.teamKey };
	if (!input.teamKey) throw new Error("Missing Linear teamKey/teamId association");
	const data = await linearGraphql<{ teams: { nodes: Array<{ id: string; key: string; name: string }> } }>(
		token,
		`query ResolveTeam($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name } } }`,
		{ key: input.teamKey },
	);
	const team = data.teams.nodes[0];
	if (!team) throw new Error(`Linear team not found for key ${input.teamKey}`);
	return { teamId: team.id, teamKey: team.key, teamName: team.name };
}

async function readIssue(token: string, id: string): Promise<CreatedIssue> {
	const data = await linearGraphql<{ issue: CreatedIssue | null }>(
		token,
		`query ReadIssue($id: String!) { issue(id: $id) { id identifier url title } }`,
		{ id },
	);
	if (!data.issue?.id || !data.issue.identifier || !data.issue.url) throw new Error(`Linear readback failed for issue ${id}`);
	return data.issue;
}

async function createLinearIssue(token: string, payload: LinearIssuePayload): Promise<CreatedIssue> {
	const team = await getTeamId(token, payload);
	const input: Record<string, unknown> = {
		teamId: team.teamId,
		title: payload.title,
		description: payload.description ?? "",
	};
	if (payload.projectId) input.projectId = payload.projectId;
	if (payload.stateId) input.stateId = payload.stateId;
	if (payload.assigneeId) input.assigneeId = payload.assigneeId;
	if (payload.parentId) input.parentId = payload.parentId;
	if (payload.labelIds?.length) input.labelIds = payload.labelIds;
	if (typeof payload.priority === "number") input.priority = payload.priority;

	const created = await linearGraphql<{ issueCreate: { success: boolean; issue: { id: string } | null } }>(
		token,
		`mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id } } }`,
		{ input },
	);
	const id = created.issueCreate.issue?.id;
	if (!created.issueCreate.success || !id) throw new Error("Linear issueCreate did not return a created issue id");
	return readIssue(token, id);
}

function issuePayloadFromParams(params: any, association: LinearAssociation): LinearIssuePayload {
	return {
		title: params.title,
		description: params.description,
		teamKey: params.team_key ?? association.teamKey,
		teamId: params.team_id ?? association.teamId,
		projectId: params.project_id ?? association.projectId,
		stateId: params.state_id,
		assigneeId: params.assignee_id,
		parentId: params.parent_id,
		labelIds: params.label_ids,
		priority: params.priority,
	};
}

function formatAcceptance(criteria: string[] | undefined): string {
	if (!criteria?.length) return "";
	return ["## Acceptance criteria", "", ...criteria.map((criterion) => `- [ ] ${criterion.replace(/^\s*- \[ \]\s*/, "")}`), ""].join("\n");
}

function formatBlockedBy(blockers: string[]): string {
	return ["## Blocked by", "", blockers.length ? blockers.map((blocker) => `- ${blocker}`).join("\n") : "None - can start immediately", ""].join("\n");
}

function renderPayload(payload: LinearIssuePayload): string {
	return JSON.stringify({
		title: payload.title,
		description: payload.description,
		teamKey: payload.teamKey,
		teamId: payload.teamId,
		projectId: payload.projectId,
		stateId: payload.stateId,
		assigneeId: payload.assigneeId,
		parentId: payload.parentId,
		labelIds: payload.labelIds,
		priority: payload.priority,
	}, null, 2);
}

export default function linearTracker(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => ({
		systemPrompt:
			event.systemPrompt +
			"\n\n## Linear Tracker Resolver\n" +
			"When publishing or planning issues, use `linear_tracker_resolve` before assuming Linear. " +
			"Linear requires project-local routing policy plus a Linear team association plus auth. " +
			"Global Linear MCP/auth is capability only, not routing. If the resolver returns payload_only/not_linear/unknown, obey it and do not claim Linear publishing happened. " +
			"Use `linear_tracker_create_issue` or `linear_tracker_create_issues` only when resolver allows direct Linear publishing; both tools verify created issues by readback before returning URLs.",
	}));

	pi.registerTool({
		name: "linear_tracker_resolve",
		label: "Linear: Resolve Tracker",
		description:
			"Resolve the current project's issue tracker policy before publishing issues. " +
			"Reads nearest project-local AGENTS.md/CLAUDE.md/.pi/APPEND_SYSTEM.md/.pi/settings.json/.brain/*.svx, plus legacy docs/agents/issue-tracker.md and supporting local skills. " +
			"Returns whether Linear is allowed, whether a team association exists, whether auth/MCP exists, and whether to publish or payload-only. " +
			"Use this before creating Linear issues. Never infer Linear from global auth alone.",
		parameters: Type.Object({
			cwd: Type.Optional(Type.String({ description: "Project directory to resolve from. Defaults to current tool cwd." })),
			include_evidence: Type.Optional(Type.Boolean({ description: "Include policy evidence snippets. Default true." })),
			allow_agent_secrets: Type.Optional(Type.Boolean({ description: "Lease project-local Linear agent-secrets names, plus rubicon:linear_api_key/linear_api_key aliases, for auth capability check when project policy says Linear. Default true." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = resolveTracker(params.cwd ?? ctx.cwd, {
				includeEvidence: params.include_evidence !== false,
				allowAgentSecrets: params.allow_agent_secrets !== false,
			});
			return text(formatResolve(result), result as unknown as Record<string, unknown>);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("linear resolve ")) + theme.fg("accent", args.cwd || "current project"), 0, 0);
		},
	});

	pi.registerTool({
		name: "linear_tracker_create_issue",
		label: "Linear: Create Issue",
		description:
			"Create one Linear issue only after project-local resolver policy allows Linear. " +
			"Requires Linear teamKey/teamId from project-local policy and direct API auth via LINEAR_API_KEY or agent-secrets. " +
			"Verifies the created issue by readback before returning identifier and URL. If policy/auth/association is missing, returns payload only and creates nothing.",
		parameters: Type.Object({
			cwd: Type.Optional(Type.String({ description: "Project directory to resolve policy from. Defaults to current tool cwd." })),
			dry_run: Type.Optional(Type.Boolean({ description: "Return payload without creating. Default false." })),
			title: Type.String({ description: "Linear issue title. Prefer conventional prefixes like feat:, fix:, docs:, chore:." }),
			description: Type.Optional(Type.String({ description: "Issue body in Markdown." })),
			team_key: Type.Optional(Type.String({ description: "Deprecated safety valve for payload shaping only. Direct publish uses project-local team association." })),
			team_id: Type.Optional(Type.String({ description: "Deprecated safety valve for payload shaping only. Direct publish uses project-local team association." })),
			project_id: Type.Optional(Type.String({ description: "Optional Linear project ID. Overrides project policy." })),
			state_id: Type.Optional(Type.String({ description: "Optional Linear workflow state ID." })),
			assignee_id: Type.Optional(Type.String({ description: "Optional Linear assignee ID." })),
			parent_id: Type.Optional(Type.String({ description: "Optional parent Linear issue ID." })),
			label_ids: Type.Optional(Type.Array(Type.String(), { description: "Optional Linear label IDs." })),
			priority: Type.Optional(Type.Number({ description: "Optional Linear priority number." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = resolveTracker(params.cwd ?? ctx.cwd, { includeEvidence: true, allowAgentSecrets: true });
			const payload = issuePayloadFromParams(params, result.association);
			const token = getLinearApiKey({ allowAgentSecrets: true, secretNames: result.authSecretNames });
			// Direct publish never guesses or overrides the project-local Linear team association.
			payload.teamKey = result.association.teamKey;
			payload.teamId = result.association.teamId;
			payload.projectId ||= result.association.projectId;

			if (params.dry_run || result.publishMode !== "linear_direct" || !token.token || !(payload.teamKey || payload.teamId)) {
				const reasons = params.dry_run ? ["dry_run=true"] : result.reasons;
				return text(["Linear issue not created. Payload only.", "", ...reasons.map((reason) => `- ${reason}`), "", "Payload:", renderPayload(payload)].join("\n"), { created: false, payload, resolver: result });
			}

			try {
				const issue = await createLinearIssue(token.token, payload);
				return text(`Created and verified ${issue.identifier}: ${issue.url}`, { created: true, issue, resolver: { ...result, capabilities: { ...result.capabilities, directApiKeySource: token.source } } });
			} catch (error: any) {
				return text(`Linear create failed; no verified issue URL claimed.\n\n${error.message}\n\nPayload:\n${renderPayload(payload)}`, { created: false, error: error.message, payload, resolver: result });
			}
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("linear create ")) + theme.fg("accent", args.title || "issue"), 0, 0);
		},
	});

	pi.registerTool({
		name: "linear_tracker_create_issues",
		label: "Linear: Create Issues",
		description:
			"Create a dependency-ordered batch of Linear issues after resolver policy allows Linear. " +
			"Each issue is independently grabbable and verified by readback. If Linear is not allowed/ready, returns ready-to-paste payloads and creates nothing.",
		parameters: Type.Object({
			cwd: Type.Optional(Type.String({ description: "Project directory to resolve policy from. Defaults to current tool cwd." })),
			dry_run: Type.Optional(Type.Boolean({ description: "Return payloads without creating. Default false." })),
			team_key: Type.Optional(Type.String({ description: "Deprecated safety valve for payload shaping only. Direct publish uses project-local team association." })),
			team_id: Type.Optional(Type.String({ description: "Deprecated safety valve for payload shaping only. Direct publish uses project-local team association." })),
			project_id: Type.Optional(Type.String({ description: "Optional Linear project ID. Overrides project policy." })),
			parent_id: Type.Optional(Type.String({ description: "Optional parent Linear issue ID for all issues." })),
			label_ids: Type.Optional(Type.Array(Type.String(), { description: "Optional Linear label IDs for all issues." })),
			issues: Type.Array(Type.Object({
				title: Type.String({ description: "Linear issue title." }),
				what_to_build: Type.Optional(Type.String({ description: "Concise vertical-slice behavior." })),
				description: Type.Optional(Type.String({ description: "Full issue body. If provided, used before generated sections." })),
				acceptance_criteria: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria." })),
				blocked_by: Type.Optional(Type.Array(Type.Number(), { description: "Zero-based indexes of prior issues that block this one." })),
				type: Type.Optional(Type.String({ description: "HITL or AFK marker, included in body." })),
				priority: Type.Optional(Type.Number({ description: "Optional Linear priority number." })),
			}), { description: "Issues in dependency order. blocked_by indexes must point to earlier issues." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = resolveTracker(params.cwd ?? ctx.cwd, { includeEvidence: true, allowAgentSecrets: true });
			const token = getLinearApiKey({ allowAgentSecrets: true, secretNames: result.authSecretNames });
			const base = {
				// Direct publish never guesses or overrides the project-local Linear team association.
				teamKey: result.association.teamKey,
				teamId: result.association.teamId,
				projectId: params.project_id ?? result.association.projectId,
				parentId: params.parent_id,
				labelIds: params.label_ids,
			};

			const created: CreatedIssue[] = [];
			const payloads: LinearIssuePayload[] = [];
			for (let index = 0; index < params.issues.length; index++) {
				const issue = params.issues[index];
				const blockers = (issue.blocked_by ?? []).map((blockerIndex: number) => created[blockerIndex] ? `${created[blockerIndex].identifier} ${created[blockerIndex].url}` : payloads[blockerIndex]?.title ? `Issue ${blockerIndex}: ${payloads[blockerIndex].title}` : `issue index ${blockerIndex}`);
				const generated = [
					issue.type ? `**Type**: ${issue.type}` : "",
					issue.what_to_build ? `## What to build\n\n${issue.what_to_build}\n` : "",
					formatAcceptance(issue.acceptance_criteria),
					formatBlockedBy(blockers),
				].filter(Boolean).join("\n");
				payloads.push({
					title: issue.title,
					description: [issue.description, generated].filter(Boolean).join("\n\n"),
					teamKey: base.teamKey,
					teamId: base.teamId,
					projectId: base.projectId,
					parentId: base.parentId,
					labelIds: base.labelIds,
					priority: issue.priority,
				});
			}

			if (params.dry_run || result.publishMode !== "linear_direct" || !token.token || !(base.teamKey || base.teamId)) {
				const reasons = params.dry_run ? ["dry_run=true"] : result.reasons;
				return text(["Linear issues not created. Payloads only.", "", ...reasons.map((reason) => `- ${reason}`), "", "Payloads:", JSON.stringify(payloads, null, 2)].join("\n"), { created: false, payloads, resolver: result });
			}

			try {
				for (const payload of payloads) {
					const issue = await createLinearIssue(token.token, payload);
					created.push(issue);
				}
				return text(["Created and verified Linear issues:", "", ...created.map((issue) => `- ${issue.identifier}: ${issue.url}`)].join("\n"), { created: true, issues: created, resolver: { ...result, capabilities: { ...result.capabilities, directApiKeySource: token.source } } });
			} catch (error: any) {
				return text(`Linear batch create failed; only verified issues are returned.\n\n${error.message}\n\nVerified before failure:\n${created.map((issue) => `- ${issue.identifier}: ${issue.url}`).join("\n") || "None"}\n\nRemaining payloads may need manual handling.`, { created: false, error: error.message, issues: created, payloads, resolver: result });
			}
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("linear batch ")) + theme.fg("accent", `${args.issues?.length ?? 0} issues`), 0, 0);
		},
	});

	pi.registerTool({
		name: "linear_tracker_get_issue",
		label: "Linear: Get Issue",
		description: "Fetch a Linear issue by id/identifier/url using direct Linear API auth. Use for readback verification before claiming publish succeeded.",
		parameters: Type.Object({
			id: Type.String({ description: "Linear issue id, identifier, or URL." }),
		}),
		async execute(_id, params) {
			const token = getLinearApiKey({ allowAgentSecrets: true });
			if (!token.token) return text("No Linear API auth found. Set LINEAR_API_KEY, project-local agent-secrets name, rubicon:linear_api_key, or linear_api_key.", { found: false });
			const id = String(params.id).split("/").filter(Boolean).pop() ?? params.id;
			try {
				const issue = await readIssue(token.token, id);
				return text(`${issue.identifier}: ${issue.title}\n${issue.url}`, { found: true, issue });
			} catch (error: any) {
				return text(`Linear issue fetch failed: ${error.message}`, { found: false, error: error.message });
			}
		},
	});

	pi.registerCommand("linear-tracker", {
		description: "Resolve this project's issue tracker policy — /linear-tracker",
		handler: async (_args, _ctx) => {
			pi.sendUserMessage("Resolve this project's issue tracker policy with linear_tracker_resolve and summarize whether Linear publishing is allowed.");
		},
	});
}
