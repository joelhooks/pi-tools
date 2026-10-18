import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerSecrets, { normalizeSecretsOutput, toolText } from "./secrets.ts";

type LeaseParams = { name: string; ttl?: string; client_id?: string };

async function withFakeSecrets(
  body: string,
  run: (lease: (params: LeaseParams) => Promise<string>, argvPath: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "pi-tools-secrets-"));
  const argvPath = join(dir, "argv.json");
  const oldPath = process.env.PATH;
  writeFileSync(join(dir, "secrets"), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));\n${body}\n`, { mode: 0o700 });
  let execute: ((params: LeaseParams) => Promise<string>) | undefined;
  // SAFETY: registration is the only ExtensionAPI surface used by this extension.
  registerSecrets({ registerTool(tool: {
    name: string;
    execute: (id: string, params: LeaseParams) => Promise<{ content: { type: string; text?: string }[] }>;
  }) {
    if (tool.name === "secrets_lease") {
      execute = async (params) => {
        const result = await tool.execute("test", params);
        return result.content.map((part) => part.type === "text" ? part.text : "").join("");
      };
    }
  } } as unknown as ExtensionAPI);
  try {
    process.env.PATH = `${dir}:${oldPath ?? ""}`;
    assert.ok(execute);
    await run(execute, argvPath);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

const canary = "fake-secret-containing-error-DO-NOT-ECHO";

test("a value containing error is a success, never a failure echo", async () => {
  await withFakeSecrets(`process.stdout.write(${JSON.stringify(canary)});`, async (lease) => {
    const output = await lease({ name: "missing" });
    if (output !== canary) assert.ok(!output.includes(canary), "failure echoed the fake secret");
    assert.equal(output, canary);
  });
});

test("lease failure never echoes stdout or child-process exception text", async () => {
  await withFakeSecrets(`process.stdout.write(${JSON.stringify(canary)}); process.exit(1);`, async (lease) => {
    const output = await lease({ name: "missing" });
    assert.ok(!output.includes(canary), "failure echoed the fake secret");
    assert.match(output, /^secrets_lease failed:/);
  });
});

function assertFailure(output: string, what: string, next: string) {
  const lines = output.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `secrets_lease failed: ${what}`);
  assert.match(lines[1], /^Why: .+/);
  assert.equal(lines[2], `Next: ${next}`);
  assert.ok(!output.includes(canary));
}

test("lease uses literal argv and preserves supported names and defaults", async () => {
  await withFakeSecrets(`process.stdout.write('  fake-value  \\n');`, async (lease, path) => {
    assert.equal(await lease({ name: "app::key-name.v1_2" }), "fake-value");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), ["lease", "app::key-name.v1_2", "--ttl", "1h", "--client-id", "pi-agent"]);
    await lease({ name: "app:key", ttl: "15m", client_id: "client::test-2" });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), ["lease", "app:key", "--ttl", "15m", "--client-id", "client::test-2"]);
  });
});

test("invalid inputs fail before spawn with exact repair calls", async () => {
  await withFakeSecrets("process.exit(99)", async (lease, path) => {
    assertFailure(await lease({ name: "x; touch injected" }), "invalid secret name", "secrets_status {}; bash: secrets list | grep -i -- 'xtouchinjected'");
    for (const name of ["", "a".repeat(129), "x\n", "$(id)", "x' | cat"]) {
      assert.match(await lease({ name }), /^secrets_lease failed: invalid secret name\n/);
    }
    for (const ttl of ["", "bad", "1h; id", "1h\n"]) {
      assertFailure(await lease({ name: "missing", ttl }), "invalid TTL", 'secrets_lease {"name":"missing","ttl":"1h","client_id":"pi-agent"}');
    }
    for (const client_id of ["", "x; id", "a".repeat(65), "x\n"]) {
      assertFailure(await lease({ name: "missing", client_id }), "invalid client_id", 'secrets_lease {"name":"missing","ttl":"1h","client_id":"pi-agent"}');
    }
    assert.equal(existsSync(path), false, "invalid inputs spawned the binary");
  });
});

test("every CLI failure returns only fixed three-line guidance", async () => {
  const cases = [
    { message: 'failed to acquire lease: RPC error -32000: secret "missing": secret not found', what: "unknown secret", next: "secrets_status {}; bash: secrets list" },
    { message: "Failed to connect to daemon", what: "daemon unavailable", next: "bash: secrets serve &" },
    { message: 'failed to acquire lease: RPC error -32603: invalid ttl duration: time: invalid duration "bad"', what: "invalid TTL", next: 'secrets_lease {"name":"missing","ttl":"1h","client_id":"pi-agent"}' },
    { message: "context deadline exceeded", what: "lease timed out", next: "secrets_status {}" },
    { message: canary, what: "lease unavailable", next: 'secrets_audit {"tail": 5}; secrets_status {}' },
  ];
  for (const { message, what, next } of cases) {
    for (const stream of ["stdout", "stderr"]) {
      const envelope = JSON.stringify({ ok: false, error: { message, code: "generic_error" }, fix: canary, result: canary });
      const body = `process.stdout.write(${JSON.stringify(canary)}); process.${stream}.write(${JSON.stringify(envelope)}); process.exit(1);`;
      // stdout must be a standalone JSON envelope to be eligible for parsing.
      const script = stream === "stdout" ? `process.stdout.write(${JSON.stringify(envelope)}); process.exit(1);` : body;
      await withFakeSecrets(script, async (lease) => assertFailure(await lease({ name: "missing" }), what, next));
    }
  }
  await withFakeSecrets(`process.stdout.write(${JSON.stringify(canary)}); process.stderr.write('Error: daemon not running\\n' + ${JSON.stringify(canary)}); process.exit(1);`, async (lease) => {
    assertFailure(await lease({ name: "missing" }), "daemon unavailable", "bash: secrets serve &");
  });
  for (const body of ["", `process.stdout.write(${JSON.stringify(canary)}); process.exit(1);`, `process.stderr.write('Error: ' + ${JSON.stringify(canary)}); process.exit(1);`, `process.stderr.write('x'.repeat(9000)); process.exit(1);`]) {
    await withFakeSecrets(body, async (lease) => assertFailure(await lease({ name: "missing" }), "lease unavailable", 'secrets_audit {"tail": 5}; secrets_status {}'));
  }
});

test("a killed lease deadline does not echo partial stdout", async () => {
  await withFakeSecrets(`process.stdout.write(${JSON.stringify(canary)}); setTimeout(() => {}, 20000);`, async (lease) => {
    assertFailure(await lease({ name: "missing" }), "lease timed out", "secrets_status {}");
  });
});

test("unwraps the current agent-secrets result envelope", () => {
  const result = normalizeSecretsOutput(JSON.stringify({
    ok: true,
    success: true,
    result: { entries: [], total_shown: 0 },
  }), true);

  assert.deepEqual(result, {
    success: true,
    data: { entries: [], total_shown: 0 },
  });
});

test("keeps compatibility with the old data envelope", () => {
  const result = normalizeSecretsOutput(JSON.stringify({
    success: true,
    data: "legacy output",
  }), true);

  assert.deepEqual(result, { success: true, data: "legacy output" });
});

test("preserves failure envelopes when result is absent", () => {
  const result = normalizeSecretsOutput(JSON.stringify({
    ok: false,
    success: false,
    error: "daemon unavailable",
    fix: "start it",
  }), true);

  assert.equal(result.success, false);
  assert.deepEqual(result.data, {
    ok: false,
    success: false,
    error: "daemon unavailable",
    fix: "start it",
  });
});

test("tool text is always a string", () => {
  assert.equal(toolText(undefined), "No data returned.");
  assert.equal(toolText({ entries: [] }), "{\n  \"entries\": []\n}");
  assert.equal(toolText("ready"), "ready");
});
