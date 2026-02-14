/**
 * auto-update — Automatically updates pi when a new version is available.
 *
 * On session start, checks the npm registry for a newer version.
 * If found, runs the install command in the background and notifies when done.
 * Detects install method (npm, pnpm, yarn, bun) to use the right command.
 *
 * Set PI_SKIP_AUTO_UPDATE=1 to disable.
 * Command: /update — manually trigger an update check + install
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";

const PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

function detectInstallMethod(): string {
	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase();
	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/") || resolvedPath.includes("\\pnpm\\")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/") || resolvedPath.includes("\\yarn\\")) {
		return "yarn";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/") || resolvedPath.includes("\\npm\\")) {
		return "npm";
	}
	return "npm";
}

function getInstallCommand(): string {
	const method = detectInstallMethod();
	switch (method) {
		case "pnpm":
			return `pnpm install -g ${PACKAGE_NAME}`;
		case "yarn":
			return `yarn global add ${PACKAGE_NAME}`;
		default:
			return `npm install -g ${PACKAGE_NAME}`;
	}
}

function getCurrentVersion(): string | undefined {
	try {
		const pkgPath = require.resolve(`${PACKAGE_NAME}/package.json`);
		return require(pkgPath).version;
	} catch {
		// Fallback: try reading from the dist config
		try {
			const result = execSync("pi --version 2>/dev/null || echo unknown", { encoding: "utf-8" }).trim();
			return result === "unknown" ? undefined : result;
		} catch {
			return undefined;
		}
	}
}

async function fetchLatestVersion(): Promise<string | undefined> {
	try {
		const response = await fetch(REGISTRY_URL);
		if (!response.ok) return undefined;
		const data = (await response.json()) as { version?: string };
		return data.version;
	} catch {
		return undefined;
	}
}

function isNewer(latest: string, current: string): boolean {
	const l = latest.split(".").map(Number);
	const c = current.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
		if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	async function checkAndUpdate(ctx: { ui: any }, silent = false): Promise<void> {
		if (process.env.PI_SKIP_AUTO_UPDATE) {
			if (!silent) ctx.ui.notify("Auto-update is disabled (PI_SKIP_AUTO_UPDATE)", "info");
			return;
		}

		const current = getCurrentVersion();
		if (!current) {
			if (!silent) ctx.ui.notify("Could not determine current pi version", "warning");
			return;
		}

		const latest = await fetchLatestVersion();
		if (!latest) {
			if (!silent) ctx.ui.notify("Could not check for updates", "warning");
			return;
		}

		if (!isNewer(latest, current)) {
			if (!silent) {
				const theme = ctx.ui.theme;
				ctx.ui.setWidget("auto-update", [theme.fg("success", "●") + " " + theme.fg("dim", `pi ${current} is up to date`)]);
				setTimeout(() => ctx.ui.setWidget("auto-update", undefined), 5000);
			}
			return;
		}

		const theme = ctx.ui.theme;
		const cmd = getInstallCommand();

		ctx.ui.setWidget("auto-update", [theme.fg("warning", "●") + " " + theme.fg("dim", `updating pi ${current} → ${latest}...`)]);

		try {
			execSync(cmd, { encoding: "utf-8", timeout: 120_000, stdio: "pipe" });
			ctx.ui.setWidget("auto-update", [theme.fg("success", "●") + " " + theme.fg("dim", `pi updated to ${latest} — restart to apply`)]);
			setTimeout(() => ctx.ui.setWidget("auto-update", undefined), 15000);
		} catch (err: any) {
			const msg = err.stderr?.trim()?.split("\n").pop() || err.message || "unknown error";
			ctx.ui.setWidget("auto-update", [theme.fg("error", "●") + " " + theme.fg("dim", `update failed: ${msg}`)]);
			setTimeout(() => ctx.ui.setWidget("auto-update", undefined), 10000);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		// Small delay so it doesn't race with startup UI
		setTimeout(() => checkAndUpdate(ctx, true), 3000);
	});

	pi.registerCommand("update", {
		description: "Check for pi updates and install if available",
		handler: async (_args, ctx) => {
			await checkAndUpdate(ctx, false);
		},
	});
}
