import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const installer = join(
  dirname(fileURLToPath(import.meta.url)),
  "install-executor-memory-service.sh",
);

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "srm-wrapper-"));
  const calls = join(dir, "secrets-calls");
  const secrets = join(dir, "secrets");
  writeFileSync(
    secrets,
    `#!/bin/sh\necho "$@" >> '${calls}'\nprintf 0123456789abcdef0123456789abcdef\n`,
  );
  chmodSync(secrets, 0o755);
  const node = join(dir, "node");
  writeFileSync(node, `#!/bin/sh\necho "node $1"\n`);
  chmodSync(node, 0o755);
  const root = join(dir, "release");
  mkdirSync(join(root, "session-reader"), { recursive: true });
  return { dir, calls, secrets, node, root };
}

function renderWrapper(s: ReturnType<typeof scratch>): string {
  const rendered = spawnSync("sh", [installer, "render-wrapper", s.root], {
    env: { ...process.env, NODE_BIN: s.node, SECRETS_BIN: s.secrets },
    encoding: "utf8",
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  const wrapper = join(s.dir, "wrapper");
  writeFileSync(wrapper, rendered.stdout);
  chmodSync(wrapper, 0o700);
  return wrapper;
}

describe("generated session recall wrapper", () => {
  test("exits 78 without leasing when the server is missing", () => {
    const s = scratch();
    const run = spawnSync(renderWrapper(s), { encoding: "utf8" });
    assert.equal(run.status, 78);
    assert.match(run.stderr, /missing server or node/);
    assert.equal(existsSync(s.calls), false);
  });

  test("leases once, then execs node on the server", () => {
    const s = scratch();
    const server = join(s.root, "session-reader", "mcp-http-server.ts");
    writeFileSync(server, "");
    const run = spawnSync(renderWrapper(s), { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), `node ${server}`);
    assert.deepEqual(readFileSync(s.calls, "utf8").trim().split("\n"), [
      "lease session_recall_mcp_bearer_token --ttl 24h",
    ]);
  });

  test("the installed plist throttles restarts to 60 seconds", () => {
    assert.match(
      readFileSync(installer, "utf8"),
      /<key>ThrottleInterval<\/key><integer>60<\/integer>/,
    );
  });
});
