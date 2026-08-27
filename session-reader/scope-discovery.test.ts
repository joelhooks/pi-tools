import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  AGENT_SECRETS_EXECUTABLE,
  buildScopeDiscoveryRequest,
  createScopeDiscoveryRunner,
  leaseScopeDiscoveryCredential,
  minimalScopeDiscoveryEnv,
  runBoundedProcess,
  SCOPE_DISCOVERY_ARGS,
  SCOPE_DISCOVERY_CREDENTIAL_ENV_NAME,
  SCOPE_DISCOVERY_MAX_STDERR_BYTES,
  SCOPE_DISCOVERY_MAX_STDOUT_BYTES,
  SCOPE_DISCOVERY_SECRET_NAME,
  type BoundedProcessRequest,
  type BoundedProcessResult,
  type ScopeDiscoveryCandidate,
} from "./scope-discovery.ts";
import {
  PINNED_SCOPE_DISCOVERY_ARTIFACT_SHA256,
  PINNED_SCOPE_DISCOVERY_ARTIFACT_SIZE,
  PINNED_SCOPE_DISCOVERY_MANIFEST_SHA256,
  PINNED_SCOPE_DISCOVERY_MANIFEST_SIZE,
  PINNED_SCOPE_DISCOVERY_MEMORY_COMMIT,
  PINNED_SCOPE_DISCOVERY_RELEASE_NAME,
  PRODUCTION_SCOPE_DISCOVERY_RELEASE,
  SCOPE_DISCOVERY_MAX_MANIFEST_BYTES,
  SCOPE_DISCOVERY_RELEASE_MANIFEST_FILENAME,
  SCOPE_DISCOVERY_TRUSTED_HIERARCHY_ANCHOR,
  SCOPE_DISCOVERY_TRUSTED_RELEASE_ROOT,
  type ScopeDiscoveryReleaseTarget,
} from "./scope-discovery-release.ts";

interface TestRelease {
  readonly root: string;
  readonly hierarchyAnchor: string;
  readonly flowingMemoryDir: string;
  readonly releasesRoot: string;
  readonly releaseDir: string;
  readonly artifactPath: string;
  readonly manifestPath: string;
  readonly manifestBody: string;
  readonly body: string;
  readonly digest: string;
  readonly cleanupPaths: string[];
  readonly target: ScopeDiscoveryReleaseTarget;
}

interface TestReleaseOptions {
  readonly artifactMode?: number;
  readonly manifestMode?: number;
  readonly releaseDirMode?: number;
  readonly releaseRootMode?: number;
  readonly flowingMemoryMode?: number;
  readonly hierarchyAnchorMode?: number;
  readonly memoryCommit?: string;
  readonly manifestArtifactDigest?: string;
  readonly expectedManifestDigest?: string;
  readonly expectedManifestSizeDelta?: number;
  readonly expectedArtifactSizeDelta?: number;
  readonly expectedOwnerUid?: number;
}

function makeRelease(options: TestReleaseOptions = {}): TestRelease {
  const root = mkdtempSync(join(tmpdir(), "scope-discovery-release-"));
  const hierarchyAnchor = join(root, "JoelClaw");
  const flowingMemoryDir = join(hierarchyAnchor, "flowing-memory");
  const releasesRoot = join(flowingMemoryDir, "releases");
  const releaseDir = join(releasesRoot, "20260827-test-scope-v1");
  mkdirSync(releaseDir, { recursive: true });
  const artifactPath = join(releaseDir, "joelclaw-memory");
  const body = "#!/bin/sh\nexit 0\n";
  const digest = createHash("sha256").update(body).digest("hex");
  writeFileSync(artifactPath, body);
  chmodSync(artifactPath, options.artifactMode ?? 0o555);
  const manifestPath = join(
    releaseDir,
    SCOPE_DISCOVERY_RELEASE_MANIFEST_FILENAME,
  );
  const manifestBody = JSON.stringify({
    _tag: "FlowingMemoryReleaseManifestV2",
    schemaVersion: 2,
    memoryCommit: options.memoryCommit ?? PINNED_SCOPE_DISCOVERY_MEMORY_COMMIT,
    releasedAt: "2026-08-27T00:00:00.000Z",
    artifacts: [
      {
        kind: "standalone",
        path: "joelclaw-memory",
        sha256: options.manifestArtifactDigest ?? digest,
      },
    ],
  });
  writeFileSync(manifestPath, manifestBody);
  chmodSync(manifestPath, options.manifestMode ?? 0o444);
  chmodSync(releaseDir, options.releaseDirMode ?? 0o555);
  chmodSync(releasesRoot, options.releaseRootMode ?? 0o555);
  chmodSync(flowingMemoryDir, options.flowingMemoryMode ?? 0o555);
  chmodSync(hierarchyAnchor, options.hierarchyAnchorMode ?? 0o555);
  return {
    root,
    hierarchyAnchor,
    flowingMemoryDir,
    releasesRoot,
    releaseDir,
    artifactPath,
    manifestPath,
    manifestBody,
    body,
    digest,
    cleanupPaths: [releaseDir, releasesRoot, flowingMemoryDir, hierarchyAnchor],
    target: {
      hierarchyAnchor,
      trustedRoot: releasesRoot,
      artifactPath,
      expectedOwnerUid: options.expectedOwnerUid ?? process.getuid?.() ?? 0,
      expectedMemoryCommit: PINNED_SCOPE_DISCOVERY_MEMORY_COMMIT,
      expectedManifestSha256:
        options.expectedManifestDigest ??
        createHash("sha256").update(manifestBody).digest("hex"),
      expectedManifestSize:
        Buffer.byteLength(manifestBody) +
        (options.expectedManifestSizeDelta ?? 0),
      expectedArtifactSha256: digest,
      expectedArtifactSize:
        Buffer.byteLength(body) + (options.expectedArtifactSizeDelta ?? 0),
    },
  };
}

function processResult(
  overrides: Partial<BoundedProcessResult> = {},
): BoundedProcessResult {
  const stdout = overrides.stdout ?? "";
  const stderr = overrides.stderr ?? "";
  return {
    exitCode: 0,
    stdout,
    stderr,
    stdoutBytes: overrides.stdoutBytes ?? Buffer.byteLength(stdout),
    stderrBytes: overrides.stderrBytes ?? Buffer.byteLength(stderr),
    timedOut: false,
    cancelled: false,
    outputLimited: false,
    missingExecutable: false,
    ...overrides,
  };
}

const exactCandidates: ScopeDiscoveryCandidate[] = [
  {
    project: "mega-dot-dev.mega-dev",
    workstream: "main",
    headStatus: "healthy",
    lastActivityAt: "2026-08-27T05:00:00.000Z",
    revision: 12,
    streamCount: 4,
  },
  {
    project: "joelhooks.joelclaw",
    workstream: "opencode-accepted-producer",
    headStatus: "stale",
    lastActivityAt: "2026-08-26T05:00:00.000Z",
    streamCount: 2,
  },
];

function successEnvelope(
  scopes: readonly ScopeDiscoveryCandidate[] = exactCandidates,
): string {
  return JSON.stringify({
    _tag: "ScopeDiscoveryReadSuccessV1",
    result: {
      _tag: "ScopeDiscoveryResultV1",
      schemaVersion: 1,
      scopes,
    },
    schemaVersion: 1,
  });
}

function unavailableEnvelope(): string {
  return JSON.stringify({
    _tag: "ScopeDiscoveryReadUnavailableV1",
    code: "store-unavailable",
    message: "Flowing memory store is unavailable.",
    schemaVersion: 1,
  });
}

const input = {
  projectHint: "mega",
  workstreamHint: "producer",
  limit: 10,
  allowedPrivacy: ["public", "private"] as const,
};

function cleanup(release: TestRelease): void {
  for (const path of release.cleanupPaths) {
    try {
      chmodSync(path, 0o755);
    } catch {
      // An ancestry replacement test may already have moved this path.
    }
  }
  rmSync(release.root, { force: true, recursive: true });
}

describe("scope discovery typed boundary", () => {
  test("constructs caller access internally with the exact privacy grant", () => {
    assert.deepEqual(
      buildScopeDiscoveryRequest(input, new Date("2026-08-27T06:00:00.000Z")),
      {
        _tag: "ScopeDiscoveryQueryV1",
        access: {
          _tag: "ScopeDiscoveryAccessV1",
          allowedPrivacy: ["public", "private"],
          decidedAt: "2026-08-27T06:00:00.000Z",
          principalRef: "operator:joel",
          purpose: "explicit-agent-scope-discovery",
          schemaVersion: 1,
        },
        limit: 10,
        projectHint: "mega",
        schemaVersion: 1,
        workstreamHint: "producer",
      },
    );
    assert.throws(() =>
      buildScopeDiscoveryRequest(
        { ...input, allowedPrivacy: ["private", "private"] },
        new Date(),
      ),
    );
    assert.throws(() =>
      buildScopeDiscoveryRequest({ ...input, limit: 51 }, new Date()),
    );
  });

  test("returns only producer-supplied exact candidates and keeps hints and secrets off argv", async () => {
    const release = makeRelease();
    const seen: BoundedProcessRequest[] = [];
    let leaseCount = 0;
    try {
      const runner = createScopeDiscoveryRunner({
        testOnlyReleaseTarget: release.target,
        now: () => new Date("2026-08-27T06:00:00.000Z"),
        parentEnv: {
          PATH: "/usr/bin",
          HOME: "/Users/test",
          GITHUB_TOKEN: "unrelated-parent-secret",
        },
        leaseCredential: async () => {
          leaseCount += 1;
          return {
            ok: true,
            value: "postgres://reader:runtime-secret@example.invalid/memory",
          };
        },
        runProcess: async (request) => {
          seen.push(request);
          return processResult({ stdout: successEnvelope() });
        },
      });

      const outcome = await runner(input, new AbortController().signal);
      assert.equal(outcome.status, "succeeded");
      if (outcome.status !== "succeeded") return;
      assert.deepEqual(outcome.result.scopes, exactCandidates);
      assert.equal(
        outcome.result.scopes.some(
          (scope) =>
            scope.project === "mega" && scope.workstream === "producer",
        ),
        false,
      );
      assert.equal(leaseCount, 1);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0]?.command, [
        release.artifactPath,
        ...SCOPE_DISCOVERY_ARGS,
      ]);
      const argv = JSON.stringify(seen[0]?.command);
      assert.doesNotMatch(argv, /mega|producer|runtime-secret|postgres:\/\//u);
      assert.deepEqual(JSON.parse(seen[0]?.stdin ?? ""), {
        _tag: "ScopeDiscoveryQueryV1",
        access: {
          _tag: "ScopeDiscoveryAccessV1",
          allowedPrivacy: ["public", "private"],
          decidedAt: "2026-08-27T06:00:00.000Z",
          principalRef: "operator:joel",
          purpose: "explicit-agent-scope-discovery",
          schemaVersion: 1,
        },
        limit: 10,
        projectHint: "mega",
        schemaVersion: 1,
        workstreamHint: "producer",
      });
      assert.deepEqual(seen[0]?.env, {
        TERM: "dumb",
        PATH: "/usr/bin",
        HOME: "/Users/test",
        [SCOPE_DISCOVERY_CREDENTIAL_ENV_NAME]:
          "postgres://reader:runtime-secret@example.invalid/memory",
      });
    } finally {
      cleanup(release);
    }
  });
});

describe("sealed release binding", () => {
  test("pins the root-owned release, reviewed source, manifest, and artifact", () => {
    assert.equal(
      SCOPE_DISCOVERY_TRUSTED_HIERARCHY_ANCHOR,
      "/Library/Application Support/JoelClaw",
    );
    assert.equal(
      SCOPE_DISCOVERY_TRUSTED_RELEASE_ROOT,
      "/Library/Application Support/JoelClaw/flowing-memory/releases",
    );
    assert.equal(PRODUCTION_SCOPE_DISCOVERY_RELEASE.expectedOwnerUid, 0);
    assert.equal(
      PINNED_SCOPE_DISCOVERY_MEMORY_COMMIT,
      "05d92eadb5091113c5fc648e95ced36eb5fb8f39",
    );
    assert.equal(
      PINNED_SCOPE_DISCOVERY_MANIFEST_SHA256,
      "a5d2a737c7dd558ff3e3566646b85d43c2ce5514dee17c4bb09405b79ffcb998",
    );
    assert.equal(PINNED_SCOPE_DISCOVERY_MANIFEST_SIZE, 349);
    assert.equal(
      PINNED_SCOPE_DISCOVERY_ARTIFACT_SHA256,
      "62922264b9f27df3ad9c18c095dabf3dd55477859522739ee396b7de78b3b6cf",
    );
    assert.equal(PINNED_SCOPE_DISCOVERY_ARTIFACT_SIZE, 74_988_002);
    assert.equal(
      PINNED_SCOPE_DISCOVERY_RELEASE_NAME,
      "20260827-05d92ead-scope-v1",
    );
  });

  for (const [name, options] of [
    ["manifest digest mismatch", { expectedManifestDigest: "a".repeat(64) }],
    ["manifest exact size mismatch", { expectedManifestSizeDelta: 1 }],
    ["artifact digest mismatch", { manifestArtifactDigest: "a".repeat(64) }],
    ["artifact exact size mismatch", { expectedArtifactSizeDelta: 1 }],
    ["artifact writable mode", { artifactMode: 0o755 }],
    ["artifact noncanonical mode", { artifactMode: 0o500 }],
    ["manifest writable mode", { manifestMode: 0o644 }],
    ["manifest noncanonical mode", { manifestMode: 0o400 }],
    ["release directory writable mode", { releaseDirMode: 0o755 }],
    ["wrong semantic source commit", { memoryCommit: "0".repeat(40) }],
  ] as const) {
    test(`refuses ${name} before leasing a credential`, async () => {
      const release = makeRelease(options);
      let leaseCount = 0;
      try {
        const runner = createScopeDiscoveryRunner({
          testOnlyReleaseTarget: release.target,
          leaseCredential: async () => {
            leaseCount += 1;
            return { ok: true, value: "must-not-exist" };
          },
        });
        const outcome = await runner(input, new AbortController().signal);
        assert.deepEqual(outcome, {
          status: "unavailable",
          kind: "release-unavailable",
        });
        assert.equal(leaseCount, 0);
      } finally {
        cleanup(release);
      }
    });
  }

  test("refuses a user-owned hierarchy before leasing a credential", async () => {
    const currentUid = process.getuid?.() ?? 0;
    const release = makeRelease({
      expectedOwnerUid: currentUid === 0 ? 1 : 0,
    });
    let leaseCount = 0;
    try {
      const runner = createScopeDiscoveryRunner({
        testOnlyReleaseTarget: release.target,
        leaseCredential: async () => {
          leaseCount += 1;
          return { ok: true, value: "must-not-exist" };
        },
      });

      assert.deepEqual(await runner(input, new AbortController().signal), {
        status: "unavailable",
        kind: "release-unavailable",
      });
      assert.equal(leaseCount, 0);
    } finally {
      cleanup(release);
    }
  });

  test("refuses a writable managed ancestor before leasing a credential", async () => {
    const release = makeRelease({ hierarchyAnchorMode: 0o755 });
    let leaseCount = 0;
    try {
      const runner = createScopeDiscoveryRunner({
        testOnlyReleaseTarget: release.target,
        leaseCredential: async () => {
          leaseCount += 1;
          return { ok: true, value: "must-not-exist" };
        },
      });

      assert.deepEqual(await runner(input, new AbortController().signal), {
        status: "unavailable",
        kind: "release-unavailable",
      });
      assert.equal(leaseCount, 0);
    } finally {
      cleanup(release);
    }
  });

  test("refuses a symlinked managed ancestor before leasing a credential", async () => {
    const release = makeRelease();
    const realReleasesRoot = `${release.releasesRoot}.real`;
    let leaseCount = 0;
    try {
      chmodSync(release.hierarchyAnchor, 0o755);
      chmodSync(release.flowingMemoryDir, 0o755);
      chmodSync(release.releasesRoot, 0o755);
      renameSync(release.releasesRoot, realReleasesRoot);
      chmodSync(realReleasesRoot, 0o555);
      symlinkSync(realReleasesRoot, release.releasesRoot);
      chmodSync(release.flowingMemoryDir, 0o555);
      chmodSync(release.hierarchyAnchor, 0o555);
      release.cleanupPaths.push(realReleasesRoot);

      const runner = createScopeDiscoveryRunner({
        testOnlyReleaseTarget: release.target,
        leaseCredential: async () => {
          leaseCount += 1;
          return { ok: true, value: "must-not-exist" };
        },
      });

      assert.deepEqual(await runner(input, new AbortController().signal), {
        status: "unavailable",
        kind: "release-unavailable",
      });
      assert.equal(leaseCount, 0);
    } finally {
      cleanup(release);
    }
  });

  test("refuses renamed and byte-identically recreated ancestry before lease", async () => {
    const release = makeRelease();
    const renamedRoot = `${release.releasesRoot}.renamed`;
    let leaseCount = 0;
    try {
      const runner = createScopeDiscoveryRunner({
        testOnlyReleaseTarget: release.target,
        leaseCredential: async () => {
          leaseCount += 1;
          return { ok: true, value: "must-not-exist" };
        },
      });

      chmodSync(release.hierarchyAnchor, 0o755);
      chmodSync(release.flowingMemoryDir, 0o755);
      chmodSync(release.releasesRoot, 0o755);
      renameSync(release.releasesRoot, renamedRoot);
      chmodSync(renamedRoot, 0o555);
      mkdirSync(release.releaseDir, { recursive: true });
      writeFileSync(release.artifactPath, release.body);
      chmodSync(release.artifactPath, 0o555);
      writeFileSync(release.manifestPath, release.manifestBody);
      chmodSync(release.manifestPath, 0o444);
      chmodSync(release.releaseDir, 0o555);
      chmodSync(release.releasesRoot, 0o555);
      chmodSync(release.flowingMemoryDir, 0o555);
      chmodSync(release.hierarchyAnchor, 0o555);
      release.cleanupPaths.push(
        join(renamedRoot, "20260827-test-scope-v1"),
        renamedRoot,
      );

      assert.deepEqual(await runner(input, new AbortController().signal), {
        status: "unavailable",
        kind: "release-unavailable",
      });
      assert.equal(leaseCount, 0);
    } finally {
      cleanup(release);
    }
  });

  test("refuses a manifest size above the synchronous read cap before lease", async () => {
    const release = makeRelease();
    let leaseCount = 0;
    try {
      const oversizedManifest = "x".repeat(
        SCOPE_DISCOVERY_MAX_MANIFEST_BYTES + 1,
      );
      chmodSync(release.releaseDir, 0o755);
      chmodSync(release.manifestPath, 0o644);
      writeFileSync(release.manifestPath, oversizedManifest);
      chmodSync(release.manifestPath, 0o444);
      chmodSync(release.releaseDir, 0o555);
      const target = {
        ...release.target,
        expectedManifestSha256: createHash("sha256")
          .update(oversizedManifest)
          .digest("hex"),
        expectedManifestSize: Buffer.byteLength(oversizedManifest),
      };
      const runner = createScopeDiscoveryRunner({
        testOnlyReleaseTarget: target,
        leaseCredential: async () => {
          leaseCount += 1;
          return { ok: true, value: "must-not-exist" };
        },
      });

      assert.deepEqual(await runner(input, new AbortController().signal), {
        status: "unavailable",
        kind: "release-unavailable",
      });
      assert.equal(leaseCount, 0);
    } finally {
      cleanup(release);
    }
  });

  test("refuses a byte-identical artifact identity replacement before lease", async () => {
    const release = makeRelease();
    let leaseCount = 0;
    try {
      const runner = createScopeDiscoveryRunner({
        testOnlyReleaseTarget: release.target,
        leaseCredential: async () => {
          leaseCount += 1;
          return { ok: true, value: "must-not-exist" };
        },
      });
      chmodSync(release.releaseDir, 0o755);
      rmSync(release.artifactPath);
      writeFileSync(release.artifactPath, release.body);
      chmodSync(release.artifactPath, 0o555);
      chmodSync(release.releaseDir, 0o555);

      const outcome = await runner(input, new AbortController().signal);
      assert.deepEqual(outcome, {
        status: "unavailable",
        kind: "release-unavailable",
      });
      assert.equal(leaseCount, 0);
    } finally {
      cleanup(release);
    }
  });

  test("rechecks stable identity immediately before spawn", async () => {
    const release = makeRelease();
    let spawned = false;
    try {
      const runner = createScopeDiscoveryRunner({
        testOnlyReleaseTarget: release.target,
        leaseCredential: async () => {
          chmodSync(release.releaseDir, 0o755);
          rmSync(release.artifactPath);
          writeFileSync(release.artifactPath, release.body);
          chmodSync(release.artifactPath, 0o555);
          chmodSync(release.releaseDir, 0o555);
          return { ok: true, value: "runtime-secret" };
        },
        runProcess: async () => {
          spawned = true;
          return processResult({ stdout: successEnvelope() });
        },
      });

      const outcome = await runner(input, new AbortController().signal);
      assert.deepEqual(outcome, {
        status: "unavailable",
        kind: "release-unavailable",
      });
      assert.equal(spawned, false);
    } finally {
      cleanup(release);
    }
  });
});

describe("process and envelope fail-closed behavior", () => {
  test("leases only the fixed secret through the canonical executable", async () => {
    const seen: BoundedProcessRequest[] = [];
    const lease = await leaseScopeDiscoveryCredential({
      signal: new AbortController().signal,
      timeoutMs: 500,
      parentEnv: { PATH: "/usr/bin", GITHUB_TOKEN: "parent-secret" },
      runProcess: async (request) => {
        seen.push(request);
        return processResult({ stdout: "postgres://runtime-secret" });
      },
    });

    assert.deepEqual(lease, { ok: true, value: "postgres://runtime-secret" });
    assert.deepEqual(seen[0]?.command, [
      AGENT_SECRETS_EXECUTABLE,
      "lease",
      SCOPE_DISCOVERY_SECRET_NAME,
      "--ttl",
      "5m",
      "--client-id",
      "pi-tools-scope-discovery",
    ]);
    assert.equal(seen[0]?.stdin, "");
    assert.deepEqual(seen[0]?.env, { TERM: "dumb", PATH: "/usr/bin" });
  });

  test("refuses a successful credential lease that writes stderr bytes", async () => {
    const lease = await leaseScopeDiscoveryCredential({
      signal: new AbortController().signal,
      timeoutMs: 500,
      runProcess: async () =>
        processResult({
          stdout: "postgres://runtime-secret",
          stderr: " \n",
        }),
    });

    assert.deepEqual(lease, { ok: false, kind: "unavailable" });
  });

  test("rejects scope producer stderr bytes before decoding a valid envelope", async () => {
    const release = makeRelease();
    try {
      const runner = createScopeDiscoveryRunner({
        testOnlyReleaseTarget: release.target,
        leaseCredential: async () => ({ ok: true, value: "runtime-secret" }),
        runProcess: async () =>
          processResult({ stdout: successEnvelope(), stderr: "\t" }),
      });

      assert.deepEqual(await runner(input, new AbortController().signal), {
        status: "unavailable",
        kind: "malformed-response",
      });
    } finally {
      cleanup(release);
    }
  });

  for (const [name, exitCode, stdout] of [
    ["success envelope with unavailable exit", 3, successEnvelope()],
    ["unavailable envelope with success exit", 0, unavailableEnvelope()],
    ["extra JSON output", 0, `${successEnvelope()}\n{}`],
    [
      "an extra envelope field",
      0,
      JSON.stringify({
        ...JSON.parse(successEnvelope()),
        forged: true,
      }),
    ],
    [
      "contract drift",
      0,
      JSON.stringify({
        ...JSON.parse(successEnvelope()),
        schemaVersion: 2,
      }),
    ],
  ] as const) {
    test(`rejects ${name}`, async () => {
      const release = makeRelease();
      try {
        const runner = createScopeDiscoveryRunner({
          testOnlyReleaseTarget: release.target,
          leaseCredential: async () => ({ ok: true, value: "runtime-secret" }),
          runProcess: async () => processResult({ exitCode, stdout }),
        });
        const outcome = await runner(input, new AbortController().signal);
        assert.deepEqual(outcome, {
          status: "unavailable",
          kind: "malformed-response",
        });
      } finally {
        cleanup(release);
      }
    });
  }

  test("rejects result counts beyond the requested bound and duplicate pairs", async () => {
    const release = makeRelease();
    let invocation = 0;
    try {
      const runner = createScopeDiscoveryRunner({
        testOnlyReleaseTarget: release.target,
        leaseCredential: async () => ({ ok: true, value: "runtime-secret" }),
        runProcess: async () => {
          invocation += 1;
          return processResult({
            stdout:
              invocation === 1
                ? successEnvelope(exactCandidates)
                : successEnvelope([exactCandidates[0]!, exactCandidates[0]!]),
          });
        },
      });
      assert.deepEqual(
        await runner({ ...input, limit: 1 }, new AbortController().signal),
        { status: "unavailable", kind: "malformed-response" },
      );
      assert.deepEqual(await runner(input, new AbortController().signal), {
        status: "unavailable",
        kind: "malformed-response",
      });
    } finally {
      cleanup(release);
    }
  });

  for (const [name, process, kind] of [
    ["stdout bound", { outputLimited: true }, "output-limit"],
    ["deadline", { timedOut: true }, "timeout"],
    ["cancellation", { cancelled: true }, "cancelled"],
  ] as const) {
    test(`maps ${name} to a bounded unavailable outcome`, async () => {
      const release = makeRelease();
      try {
        const runner = createScopeDiscoveryRunner({
          testOnlyReleaseTarget: release.target,
          leaseCredential: async () => ({ ok: true, value: "runtime-secret" }),
          runProcess: async () => processResult(process),
        });
        assert.deepEqual(await runner(input, new AbortController().signal), {
          status: "unavailable",
          kind,
        });
      } finally {
        cleanup(release);
      }
    });
  }
});

function exactPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe("real bounded process runner", () => {
  test("reports raw stdout and stderr bytes even when text trims to empty", async () => {
    const result = await runBoundedProcess({
      command: [
        process.execPath,
        "-e",
        "process.stdout.write(' \\n'); process.stderr.write('\\t')",
      ],
      stdin: "",
      env: minimalScopeDiscoveryEnv(process.env),
      timeoutMs: 5_000,
      maxStdoutBytes: SCOPE_DISCOVERY_MAX_STDOUT_BYTES,
      maxStderrBytes: SCOPE_DISCOVERY_MAX_STDERR_BYTES,
      signal: new AbortController().signal,
    });

    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(result.stdoutBytes, 2);
    assert.equal(result.stderrBytes, 1);
  });

  test("enforces stdout bytes without retaining unbounded output", async () => {
    const result = await runBoundedProcess({
      command: [
        process.execPath,
        "-e",
        "process.stdout.write('x'.repeat(100000))",
      ],
      stdin: "",
      env: minimalScopeDiscoveryEnv(process.env),
      timeoutMs: 5_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: SCOPE_DISCOVERY_MAX_STDERR_BYTES,
      signal: new AbortController().signal,
    });
    assert.equal(result.outputLimited, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 1_024);
  });

  test("enforces a hard timeout", async () => {
    const startedAt = Date.now();
    const result = await runBoundedProcess({
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      stdin: "",
      env: minimalScopeDiscoveryEnv(process.env),
      timeoutMs: 100,
      maxStdoutBytes: SCOPE_DISCOVERY_MAX_STDOUT_BYTES,
      maxStderrBytes: SCOPE_DISCOVERY_MAX_STDERR_BYTES,
      signal: new AbortController().signal,
    });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - startedAt < 3_000);
  });

  test("cancels and reaps a running child", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runBoundedProcess({
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      stdin: "private-hint",
      env: minimalScopeDiscoveryEnv(process.env),
      timeoutMs: 5_000,
      maxStdoutBytes: SCOPE_DISCOVERY_MAX_STDOUT_BYTES,
      maxStderrBytes: SCOPE_DISCOVERY_MAX_STDERR_BYTES,
      signal: controller.signal,
    });
    assert.equal(result.cancelled, true);
  });

  test("kills the process group when the leader exits on SIGTERM", async () => {
    const descendantSource = [
      "process.on('SIGTERM', () => {});",
      "process.send?.('ready');",
      "setInterval(() => {}, 1000);",
    ].join("");
    const leaderSource = [
      "const { spawn } = require('node:child_process');",
      `const descendant = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
      "descendant.once('message', () => process.stdout.write(String(descendant.pid) + '\\n'));",
      "setInterval(() => {}, 1000);",
    ].join("");

    const result = await runBoundedProcess({
      command: [process.execPath, "-e", leaderSource],
      stdin: "",
      env: minimalScopeDiscoveryEnv(process.env),
      timeoutMs: 500,
      maxStdoutBytes: SCOPE_DISCOVERY_MAX_STDOUT_BYTES,
      maxStderrBytes: SCOPE_DISCOVERY_MAX_STDERR_BYTES,
      signal: new AbortController().signal,
    });
    const descendantPid = Number.parseInt(result.stdout, 10);
    assert.equal(result.timedOut, true);
    assert.equal(Number.isInteger(descendantPid), true);

    try {
      assert.equal(exactPidIsAlive(descendantPid), false);
    } finally {
      if (Number.isInteger(descendantPid) && exactPidIsAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });
});
