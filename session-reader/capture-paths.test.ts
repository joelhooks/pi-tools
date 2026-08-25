import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assessCaptureHealth,
  capturePathSpecs,
  classifyCentralUrl,
  extractUrlFromHookCommand,
  machineIdFromAuth,
  resolveCentralUrl,
  sanitizeMachineId,
  type CaptureFileStatus,
} from "./capture-paths.ts";

describe("capture path discovery", () => {
  test("canonical paths are namespaced under capture/<machine_id>/<runtime>", () => {
    const specs = capturePathSpecs("/home/example", "test-machine");
    const canonical = specs.filter((spec) => spec.namespace === "canonical");
    assert.deepEqual(
      canonical.map((spec) => spec.path),
      [
        "/home/example/.joelclaw/capture/test-machine/pi/state.json",
        "/home/example/.joelclaw/capture/test-machine/pi/capture.log",
        "/home/example/.joelclaw/capture/test-machine/pi/outbox",
        "/home/example/.joelclaw/capture/test-machine/codex/state.json",
        "/home/example/.joelclaw/capture/test-machine/codex/capture.log",
        "/home/example/.joelclaw/capture/test-machine/codex/outbox",
        "/home/example/.joelclaw/capture/test-machine/claude-code/state.json",
        "/home/example/.joelclaw/capture/test-machine/claude-code/capture.log",
        "/home/example/.joelclaw/capture/test-machine/claude-code/outbox",
      ],
    );
  });

  test("legacy Codex files are tagged separately from runtime-ambiguous files", () => {
    const specs = capturePathSpecs("/home/example", "test-machine");
    const legacyCodex = specs.filter((spec) => spec.namespace === "legacy" && spec.runtime === "codex");
    assert.deepEqual(
      legacyCodex.map((spec) => spec.path),
      [
        "/home/example/.joelclaw/codex-session-state.json",
        "/home/example/.joelclaw/codex-capture.log",
      ],
    );
    const ambiguous = specs.find((spec) => spec.path.endsWith("/.joelclaw/session-state.json"));
    assert.equal(ambiguous?.runtime, undefined);
    assert.equal(ambiguous?.namespace, "legacy");
  });

  test("sanitizes machine ids and refuses empty auth", () => {
    assert.equal(sanitizeMachineId("test-machine/../x"), "test-machine_.._x");
    assert.equal(machineIdFromAuth({ machine_id: "test-machine" }), "test-machine");
    assert.equal(machineIdFromAuth({}), "unknown-machine");
    assert.equal(machineIdFromAuth(null), "unknown-machine");
  });
});

describe("namespace reconciliation", () => {
  test("legacy Codex state does not make a missing namespace healthy", () => {
    const files: CaptureFileStatus[] = capturePathSpecs("/tmp/home", "test-machine").map((spec) => ({
      ...spec,
      present:
        spec.namespace === "legacy" && spec.runtime === "codex"
          ? true
          : spec.runtime === "claude-code" && spec.namespace === "canonical" && spec.kind !== "outbox"
            ? true
            : false,
      pendingCount: spec.kind === "outbox" ? 0 : undefined,
    }));
    const health = assessCaptureHealth({
      machineId: "test-machine",
      files,
      central: { status: "configured" },
    });
    const codex = health.runtimes.find((runtime) => runtime.runtime === "codex");
    assert.equal(codex?.status, "legacy-only");
    assert.equal(codex?.legacyPresent, true);
    assert.equal(codex?.canonicalState, false);
    assert.equal(health.ok, false);
  });

  test("Pi namespaced log plus queued outbox is degraded, not healthy", () => {
    const files: CaptureFileStatus[] = capturePathSpecs("/tmp/home", "test-machine").map((spec) => ({
      ...spec,
      present:
        spec.runtime === "pi" && spec.namespace === "canonical" && spec.kind !== "state"
          ? true
          : spec.runtime === "claude-code" && spec.namespace === "canonical" && spec.kind !== "outbox"
            ? true
            : spec.runtime === "codex" && spec.namespace === "canonical" && spec.kind !== "outbox"
              ? true
              : false,
      pendingCount: spec.runtime === "pi" && spec.kind === "outbox" && spec.namespace === "canonical" ? 3 : 0,
    }));
    const health = assessCaptureHealth({
      machineId: "test-machine",
      files,
      central: { status: "configured" },
    });
    const pi = health.runtimes.find((runtime) => runtime.runtime === "pi");
    assert.equal(pi?.status, "degraded");
    assert.equal(pi?.canonicalState, false);
    assert.equal(pi?.canonicalLog, true);
    assert.equal(pi?.pendingCount, 3);
    assert.equal(health.ok, false);
  });

  test("legacy Central diagnostics can be clear without proving current capture", () => {
    const files: CaptureFileStatus[] = capturePathSpecs("/tmp/home", "test-machine").map((spec) => ({
      ...spec,
      present: spec.namespace === "canonical" && spec.kind !== "outbox",
      pendingCount: 0,
    }));
    const health = assessCaptureHealth({
      machineId: "test-machine",
      files,
      central: { status: "configured" },
    });
    assert.equal(health.ok, false);
    assert.equal(health.currentCapture, "unproven");
    assert.equal(health.legacyCentralOk, true);
    assert.ok(health.runtimes.every((runtime) => runtime.status === "legacy-clear"));
  });
});

describe("stale and missing Central URL", () => {
  test("classifies retired port-3000 URLs as stale without substituting a host", () => {
    assert.equal(classifyCentralUrl(undefined).status, "missing");
    assert.equal(classifyCentralUrl("http://retired.example:3000").status, "stale");
    assert.equal(classifyCentralUrl("http://retired.example:3000").status, "stale");
    assert.equal(classifyCentralUrl("http://central.example:3111").status, "configured");
    const configured = classifyCentralUrl("http://example.test:3111");
    assert.equal(configured.status, "configured");
    assert.equal("url" in configured, false);
  });

  test("resolveCentralUrl prefers env and reports stale env before falling through", () => {
    const staleEnv = resolveCentralUrl({
      envUrl: "http://retired.example:3000",
      systemBusText: "JOELCLAW_CENTRAL_URL=http://example.test:3111\n",
    });
    assert.equal(staleEnv.status, "stale");
    assert.equal(staleEnv.source, "env");

    const fromBus = resolveCentralUrl({
      systemBusText: "JOELCLAW_CENTRAL_URL=http://example.test:3111\n",
    });
    assert.equal(fromBus.status, "configured");
    assert.equal(fromBus.source, "system-bus.env");
    assert.equal("url" in fromBus, false);
  });

  test("extracts hook URLs and does not invent a missing value", () => {
    assert.equal(
      extractUrlFromHookCommand(
        "JOELCLAW_CENTRAL_URL=http://central.example:3111 /opt/homebrew/bin/node ./capture-codex-session.js",
      ),
      "http://central.example:3111",
    );
    const missing = resolveCentralUrl({});
    assert.equal(missing.status, "missing");
  });
});
