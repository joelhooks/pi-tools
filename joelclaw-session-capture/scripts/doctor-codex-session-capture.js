#!/usr/bin/env node
/**
 * Read-only diagnostics for the retired Codex-to-Central capture path.
 * This never proves current flowing-memory capture health.
 */
const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const home = homedir();

function readMachineId() {
  try {
    const value = JSON.parse(readFileSync(join(home, ".joelclaw/auth.json"), "utf8"));
    return typeof value.machine_id === "string" && value.machine_id.trim()
      ? value.machine_id.trim().replace(/[^a-zA-Z0-9._-]/gu, "_")
      : "unknown-machine";
  } catch {
    return "unknown-machine";
  }
}

function metadata(path) {
  if (!existsSync(path)) return { present: false };
  const stats = statSync(path);
  return { present: true, bytes: stats.size, modified: stats.mtime.toISOString() };
}

function jsonCount(path) {
  if (!existsSync(path)) return 0;
  return readdirSync(path, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  ).length;
}

function main() {
  const machineId = readMachineId();
  const canonicalRoot = join(home, ".joelclaw/capture", machineId, "codex");
  const hooksPath = join(home, ".codex/hooks.json");
  const hooksText = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : "";
  const legacyHookDetected = /joelclaw-capture-codex-session|capture-codex-session\.js/u.test(
    hooksText,
  );
  const legacy = {
    state: metadata(join(home, ".joelclaw/codex-session-state.json")),
    log: metadata(join(home, ".joelclaw/codex-capture.log")),
    ambiguousOutboxCount: jsonCount(join(home, ".joelclaw/outbox")),
  };
  const canonical = {
    state: metadata(join(canonicalRoot, "state.json")),
    log: metadata(join(canonicalRoot, "capture.log")),
    outboxCount: jsonCount(join(canonicalRoot, "outbox")),
  };

  console.log(
    JSON.stringify(
      {
        ok: true,
        schemaVersion: 1,
        mode: "retired-central-capture-diagnostics",
        currentCaptureProven: false,
        machineId,
        legacyHookDetected,
        canonical,
        legacy,
        nextAction: legacyHookDetected
          ? "remove the retired hook through the approved installer migration before activating the single-owner flowing-memory host hook"
          : "report Codex capture unavailable until the single-owner flowing-memory host hook is installed and canaried",
      },
      null,
      2,
    ),
  );
}

main();
