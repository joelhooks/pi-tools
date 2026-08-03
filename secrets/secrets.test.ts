import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSecretsOutput, toolText } from "./secrets.ts";

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
