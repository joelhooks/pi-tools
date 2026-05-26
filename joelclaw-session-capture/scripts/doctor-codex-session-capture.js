#!/usr/bin/env node
/**
 * Doctor for JoelClaw Codex session capture.
 * Read-only except for running joelclaw search. Does not print auth tokens.
 */
const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { homedir, hostname } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const CENTRAL_URL = process.env.JOELCLAW_CENTRAL_URL || "http://panda.tail7af24.ts.net:3000";
const HOME = homedir();
const HOOKS = join(HOME, ".codex/hooks.json");
const SESSIONS = join(HOME, ".codex/sessions");
const STATE = join(HOME, ".joelclaw/codex-session-state.json");
const LOG = join(HOME, ".joelclaw/codex-capture.log");
const OUTBOX = join(HOME, ".joelclaw/outbox");

function newestJsonl(root, limit = 2000) {
  const files = [];
  function walk(dir) {
    if (files.length >= limit || !existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) walk(path);
      else if (ent.isFile() && ent.name.endsWith(".jsonl")) files.push(path);
    }
  }
  walk(root);
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function age(path) {
  if (!existsSync(path)) return null;
  const s = statSync(path);
  return { path, mtime: s.mtime.toISOString(), ageMinutes: Math.round((Date.now() - s.mtimeMs) / 60000) };
}

function check(name, ok, detail) {
  return { name, ok, detail };
}

async function main() {
  const results = [];
  const hooksText = existsSync(HOOKS) ? readFileSync(HOOKS, "utf8") : "";
  results.push(check("codex hooks.json exists", existsSync(HOOKS), HOOKS));
  results.push(check("Stop hook has JoelClaw capture", /joelclaw-capture-codex-session|capture-codex-session\.js/.test(hooksText), "expected a Stop command pointing at the capture script"));
  results.push(check("cmux hooks preserved", /cmux hooks/.test(hooksText), "expected existing cmux hook commands to remain"));
  results.push(check("stable panda URL configured", /panda\.tail7af24\.ts\.net:3000/.test(hooksText), "current hook should prefer Tailscale DNS over bare panda"));

  const latestSession = newestJsonl(SESSIONS);
  results.push(check("latest Codex transcript exists", Boolean(latestSession), latestSession || SESSIONS));
  results.push(check("Codex state file", existsSync(STATE), age(STATE) || STATE));
  results.push(check("Codex capture log", existsSync(LOG), age(LOG) || LOG));
  const outboxCount = existsSync(OUTBOX) ? readdirSync(OUTBOX).filter((f) => f.endsWith(".json")).length : 0;
  results.push(check("outbox count", outboxCount === 0, `${outboxCount} queued JSON payload(s)`));

  try {
    const res = await fetch(`${CENTRAL_URL}/api/runs`, { method: "OPTIONS" });
    results.push(check("Central reachable", res.status < 500, `${CENTRAL_URL}/api/runs status=${res.status}`));
  } catch (err) {
    results.push(check("Central reachable", false, `${CENTRAL_URL}: ${err.message}`));
  }

  let unique = process.argv.slice(2).join(" ").trim();
  if (!unique && latestSession) {
    const base = latestSession.split("/").pop().replace(/\.jsonl$/, "");
    unique = base.match(/[0-9a-f]{8}-[0-9a-f-]{20,}/)?.[0] || base;
  }
  if (unique) {
    const search = spawnSync("joelclaw", ["session", "search", unique, "--source", "local", "--machine", hostname().replace(/\..*$/, ""), "--limit", "5", "--extract"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    let paths = [];
    try {
      const parsed = JSON.parse(search.stdout || "{}");
      paths = Array.isArray(parsed?.result?.hits)
        ? parsed.result.hits.map((hit) => String(hit.path || ""))
        : [];
    } catch {
      paths = [];
    }
    const hasCodexPath = paths.some((path) => path.includes("/.codex/sessions/"));
    results.push(check(
      "local joelclaw search returns Codex path",
      hasCodexPath,
      `query=${JSON.stringify(unique)} exit=${search.status} paths=${paths.slice(0, 5).join(", ") || "none"}`,
    ));
  }

  const ok = results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, centralUrl: CENTRAL_URL, results }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
