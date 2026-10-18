import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSecrets, { executeSecrets, normalizeSecretsOutput, toolText } from "./secrets.ts";
import { redactingPipe, secretPatterns } from "./redaction.ts";

const canary = 'fake error+/?"\\\n🔐-canary';
const variants = [canary, encodeURIComponent(canary), JSON.stringify(canary).slice(1, -1),
  Buffer.from(canary).toString("base64"), Buffer.from(canary).toString("base64url")];
const getText = (result: Awaited<ReturnType<typeof executeSecrets>>) => result.content[0].text;

async function fake(body: string, run: (dir: string, argv: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-tools-secrets-"));
  const argv = join(dir, "leases.jsonl");
  const oldPath = process.env.PATH;
  writeFileSync(join(dir, "secrets"), `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n${body}`, { mode: 0o700 });
  try { process.env.PATH = `${dir}:${oldPath ?? ""}`; await run(dir, argv); }
  finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
}
const leaseBody = `process.stdout.write(${JSON.stringify(canary)});`;
const request = (script: string) => ({ env: { API_KEY: "app:key" }, command: [process.execPath, "-e", script] });
function threeLines(output: string, first: RegExp, next: string) {
  const lines = output.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], first); assert.match(lines[1], /^Why: /); assert.equal(lines[2], `Next: ${next}`);
}
function noCanary(output: string) {
  for (const value of variants) {
    assert.ok(!output.includes(value), "tool result disclosed a canary representation");
    assert.ok(!output.includes(JSON.stringify(value).slice(1, -1)), "serialized output disclosed a canary representation");
  }
}

test("canary: child raw, URL, JSON, base64 and base64url echoes across chunks and both pipes", async () => {
  await fake(leaseBody, async () => {
    const output = getText(await executeSecrets(request(`
      const v = process.env.API_KEY;
      const forms = [v, encodeURIComponent(v), JSON.stringify(v).slice(1,-1), Buffer.from(v).toString('base64'), Buffer.from(v).toString('base64url')];
      (async () => { for (const form of forms) {
        for (const byte of Buffer.from(form)) {
          process.stdout.write(Buffer.from([byte])); process.stderr.write(Buffer.from([byte]));
          await new Promise(r => setTimeout(r, 1));
        }
        process.stdout.write('|'); process.stderr.write('|');
      } })();
    `)));
    noCanary(output);
    const result = JSON.parse(output);
    assert.equal(result.exit_code, 0); assert.equal(result.signal, null);
    assert.deepEqual(result.injected_vars, ["API_KEY"]);
    assert.ok(result.duration_ms >= 0);
    assert.ok(result.stdout.includes("*****")); assert.ok(result.stderr.includes("*****"));
  });
});

test("redactor catches every byte boundary, overlaps, adjacent values, form encoding and Unicode", () => {
  const values = [canary, "abc", "bcd", "a b!"];
  const payload = Buffer.from(variants.join("|") + "|abcd|abcabc|a+b%21");
  for (let split = 0; split <= payload.length; split++) {
    let output = "";
    const pipe = redactingPipe(secretPatterns(values), (s) => { output += s; });
    pipe.write(payload.subarray(0, split)); pipe.write(payload.subarray(split)); pipe.end();
    noCanary(output); assert.ok(!output.includes("abc")); assert.ok(!output.includes("bcd"));
    assert.ok(output.endsWith("|****|******|******"));
  }
});

test("retired lease never spawns and returns the exact three-line migration instruction", async () => {
  await fake(leaseBody, async (_dir, argv) => {
    let lease: ((params: { name: string }) => Promise<string>) | undefined;
    // SAFETY: this fake supplies the sole ExtensionAPI method registration uses.
    registerSecrets({ registerTool(tool: { name: string; execute: (id: string, params: { name: string }) => Promise<ReturnType<typeof toolResult>> }) {
      if (tool.name === "secrets_lease") lease = async (params) => getText(await tool.execute("test", params));
    } } as unknown as ExtensionAPI);
    assert.ok(lease);
    assert.equal(await lease({ name: "app:key-name" }), `secrets_lease no longer returns values: they land in transcripts.\nWhy: secrets now run through secrets_exec, which injects them into one command's environment.\nNext: secrets_exec {"env":{"APP_KEY_NAME":"app:key-name"},"command":["<cmd>","..."]}`);
    assert.equal(existsSync(argv), false);
  });
});
function toolResult() { return { content: [{ type: "text" as const, text: "" }], details: {} }; }

test("literal child and lease argv, multiple env entries, cwd, ttl and inherited env", async () => {
  await fake(leaseBody, async (dir, argv) => {
    const literal = ['; touch injected', '$(id)', 'a b', '"quoted"', ""];
    const result = JSON.parse(getText(await executeSecrets({ env: { API_KEY: "app::key-name.v1_2", OTHER: "second" },
      ttl: "15m", cwd: dir, command: [process.execPath, "-e", "process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),path:!!process.env.PATH,both:process.env.API_KEY===process.env.OTHER}));", "--", ...literal] })));
    assert.deepEqual(JSON.parse(result.stdout), { argv: literal, cwd: realpathSync(dir), path: true, both: true });
    assert.deepEqual(readFileSync(argv, "utf8").trim().split("\n").map((s) => JSON.parse(s)), [
      ["lease", "app::key-name.v1_2", "--ttl", "15m", "--client-id", "pi-agent"],
      ["lease", "second", "--ttl", "15m", "--client-id", "pi-agent"],
    ]);
    assert.equal(existsSync(join(dir, "injected")), false);
  });
});

test("invalid inputs never spawn a lease or a child", async () => {
  await fake("process.exit(99)", async (dir, argv) => {
    const base = { env: { API_KEY: "valid" }, command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(join(dir, "child"))}, 'ran')`] };
    const inputs: unknown[] = [null, {}, { ...base, env: [] }, { ...base, env: null }];
    for (const key of ["bad", "A-B", "1KEY", "A\n", "A".repeat(65)]) inputs.push({ ...base, env: { [key]: "valid" } });
    for (const name of ["", "x\n", "x; id", "x".repeat(129), 123]) inputs.push({ ...base, env: { API_KEY: name } });
    for (const command of [[], "echo hi", [""], [1], ["x\0"]]) inputs.push({ ...base, command });
    for (const ttl of ["", "1h\n", "1h; id", 1]) inputs.push({ ...base, ttl });
    for (const timeout_seconds of [0, -1, 1801, NaN, Infinity, "1"]) inputs.push({ ...base, timeout_seconds });
    for (const cwd of ["", 1, "x\0"]) inputs.push({ ...base, cwd });
    for (const input of inputs) {
      const output = getText(await executeSecrets(input));
      assert.match(output, /^secrets_exec failed:/); assert.equal(output.split("\n").length, 3); assert.match(output, /\nNext: /);
    }
    assert.equal(existsSync(argv), false); assert.equal(existsSync(join(dir, "child")), false);
  });
});

test("lease errors reuse bounded fixed guidance, name the var and secret, never echo diagnostics", async () => {
  const cases = [
    ["secret not found", "unknown secret", "secrets_status {}; bash: secrets list"],
    ["Failed to connect to daemon", "daemon unavailable", "bash: secrets serve &"],
    ["context deadline exceeded", "lease timed out", "secrets_status {}"],
    [canary, "lease unavailable", 'secrets_audit {"tail": 5}; secrets_status {}'],
  ];
  for (const [message, what, next] of cases) {
    for (const stream of ["stdout", "stderr"]) {
      const diagnostic = JSON.stringify({ ok: false, error: { message }, fix: canary });
      await fake(`process.${stream}.write(${JSON.stringify(diagnostic)}); process.exit(1)`, async () => {
        const output = getText(await executeSecrets(request("throw Error('child must not run')")));
        threeLines(output, new RegExp(`^secrets_exec failed: lease for API_KEY \\(app:key\\): ${what}$`), next);
        noCanary(output);
      });
    }
  }
  await fake("", async () => assert.match(getText(await executeSecrets(request(""))), /lease unavailable/));
});

test("a failed second lease redacts earlier values from all guidance", async () => {
  await fake(`if(process.argv[3] === 'first') process.stdout.write('second'); else { process.stderr.write('secret not found'); process.exit(1); }`, async () => {
    const output = getText(await executeSecrets({ env: { FIRST: "first", SECOND: "second" }, command: ["unused"] }));
    assert.ok(!output.includes("second")); assert.equal(output.split("\n").length, 3);
  });
});

test("timeout returns partial redacted output, signal, deadline and exact repair guidance", async () => {
  await fake(leaseBody, async () => {
    const output = getText(await executeSecrets({ ...request("process.stdout.write(process.env.API_KEY); setInterval(()=>{},1000)"), timeout_seconds: 0.2 }));
    noCanary(output);
    threeLines(output, /^secrets_exec failed: command timed out$/, "Inspect the redacted output, then retry secrets_exec with timeout_seconds up to 1800.");
    assert.match(output, /\*{5}/); assert.match(output, /SIGKILL/);
  });
});

test("nonzero and signal exits are results with three-line repair guidance", async () => {
  await fake(leaseBody, async () => {
    for (const ending of ["process.exit(7)", "process.kill(process.pid,'SIGTERM')"]) {
      const output = getText(await executeSecrets(request(`process.stderr.write(process.env.API_KEY); ${ending}`)));
      threeLines(output, /^secrets_exec exited:/, "Inspect the redacted output and fix the command before retrying secrets_exec.");
      noCanary(output); assert.match(output, /\*{5}/);
    }
  });
});

test("ENOENT returns the exact which command hint, never raw exception text", async () => {
  await fake(leaseBody, async () => {
    threeLines(getText(await executeSecrets({ env: { API_KEY: "app:key" }, command: ["no-such-pi-tools-test-binary"] })), /^secrets_exec failed: command could not start$/, "bash: which no-such-pi-tools-test-binary");
  });
});

test("output cap is combined, explicit, bounded, and redacted before truncation", async () => {
  await fake(leaseBody, async () => {
    const result = JSON.parse(getText(await executeSecrets(request("process.stdout.write('x'.repeat(51190)+process.env.API_KEY+'y'.repeat(100000)); process.stderr.write(process.env.API_KEY+'z'.repeat(100000))"))));
    assert.equal(result.truncated, true); assert.match(result.note, /truncated at 50 KB/);
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 50 * 1024);
    assert.ok(!result.stdout.includes("fake error")); noCanary(JSON.stringify(result));
  });
});

test("lease deadline withholds partial stdout and has exact recovery instructions", async () => {
  await fake(`process.stdout.write(${JSON.stringify(canary)}); setTimeout(()=>{}, 20000)`, async () => {
    const output = getText(await executeSecrets(request("")));
    noCanary(output);
    threeLines(output, /^secrets_exec failed: lease for API_KEY \(app:key\): lease timed out$/, "secrets_status {}");
  });
});

test("UTF-8 output cap never expands a cut codepoint beyond 50 KB", async () => {
  await fake(leaseBody, async () => {
    for (const padding of [51198, 51199]) {
      const output = getText(await executeSecrets(request(`process.stdout.write('x'.repeat(${padding})+'🔐'.repeat(10000))`)));
      const result = JSON.parse(output);
      assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.stdout) <= 51200);
      assert.ok(!result.stdout.includes('\ufffd'));
    }
  });
});

test("normalization and tool text remain compatible", () => {
  assert.deepEqual(normalizeSecretsOutput(JSON.stringify({ ok: true, result: { entries: [] } }), true), { success: true, data: { entries: [] } });
  assert.deepEqual(normalizeSecretsOutput(JSON.stringify({ success: true, data: "legacy" }), true), { success: true, data: "legacy" });
  assert.equal(normalizeSecretsOutput('{"ok":false,"error":"unavailable"}', true).success, false);
  assert.equal(toolText(undefined), "No data returned."); assert.equal(toolText("ready"), "ready");
});
