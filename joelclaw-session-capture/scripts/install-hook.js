#!/usr/bin/env node
/** Install/update the Codex Stop hook while preserving existing hooks. */
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const hooksPath = process.env.CODEX_HOOKS_PATH || join(homedir(), ".codex/hooks.json");
const scriptPath = resolve(__dirname, "capture-codex-session.js");
const command = `JOELCLAW_CENTRAL_URL=${process.env.JOELCLAW_CENTRAL_URL || "http://panda.tail7af24.ts.net:3000"} /opt/homebrew/bin/node ${scriptPath}`;

const doc = existsSync(hooksPath) ? JSON.parse(readFileSync(hooksPath, "utf8")) : { hooks: {} };
doc.hooks ||= {};
doc.hooks.Stop ||= [];

let found = false;
for (const group of doc.hooks.Stop) {
  for (const hook of group.hooks || []) {
    if (typeof hook.command === "string" && /joelclaw-capture-codex-session|capture-codex-session\.js/.test(hook.command)) {
      hook.type = "command";
      hook.command = command;
      hook.timeout = hook.timeout || 5000;
      hook.statusMessage = hook.statusMessage || "Capturing Codex run";
      found = true;
    }
  }
}

if (!found) {
  doc.hooks.Stop.push({ hooks: [{ type: "command", command, timeout: 5000, statusMessage: "Capturing Codex run" }] });
}

mkdirSync(dirname(hooksPath), { recursive: true });
writeFileSync(hooksPath, `${JSON.stringify(doc, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, hooksPath, installed: command, updatedExisting: found }, null, 2));
