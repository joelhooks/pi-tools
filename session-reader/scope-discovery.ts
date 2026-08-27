import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import type { ToolPayload } from "./presenter.ts";
import {
  PRODUCTION_SCOPE_DISCOVERY_RELEASE,
  type ScopeDiscoveryReleaseBinding,
  type ScopeDiscoveryReleaseTarget,
  reverifyScopeDiscoveryRelease,
  verifyScopeDiscoveryRelease,
} from "./scope-discovery-release.ts";

export const SCOPE_DISCOVERY_SCHEMA_VERSION = 1 as const;
export const SCOPE_DISCOVERY_DEFAULT_LIMIT = 10;
export const SCOPE_DISCOVERY_MAX_LIMIT = 50;
export const SCOPE_DISCOVERY_DEFAULT_TIMEOUT_MS = 8_000;
export const SCOPE_DISCOVERY_MAX_STDOUT_BYTES = 256 * 1024;
export const SCOPE_DISCOVERY_MAX_STDERR_BYTES = 16 * 1024;
export const SCOPE_DISCOVERY_CREDENTIAL_ENV_NAME =
  "JOELCLAW_MEMORY_RUNTIME_DATABASE_URL";
export const SCOPE_DISCOVERY_SECRET_NAME =
  "flowing_memory_runtime_database_url";
export const SCOPE_DISCOVERY_ARGS = [
  "discover-scopes",
  "--request-file",
  "-",
] as const;
export const AGENT_SECRETS_EXECUTABLE = join(
  homedir(),
  ".local",
  "bin",
  "secrets",
);

const PrivacySchema = z.enum(["public", "private", "sensitive"]);
const PrivacySetSchema = z
  .array(PrivacySchema)
  .min(1)
  .max(3)
  .refine((tiers) => new Set(tiers).size === tiers.length);
const HintSchema = z.string().min(1).max(240);
const ScopeKeySchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9._/-]{0,238}[a-z0-9])?$/u);
const UtcDateTimeSchema = z
  .string()
  .max(64)
  .refine((value) => value.endsWith("Z") && Number.isFinite(Date.parse(value)));
const ScopeDiscoveryInputSchema = z.strictObject({
  projectHint: HintSchema.optional(),
  workstreamHint: HintSchema.optional(),
  limit: z.number().int().min(1).max(SCOPE_DISCOVERY_MAX_LIMIT),
  allowedPrivacy: PrivacySetSchema,
});
const ScopeDiscoveryCandidateSchema = z.strictObject({
  headStatus: z.enum(["healthy", "unprojected", "stale", "failed"]),
  lastActivityAt: UtcDateTimeSchema,
  project: ScopeKeySchema,
  revision: z.number().int().nonnegative().optional(),
  streamCount: z.number().int().min(1),
  workstream: ScopeKeySchema,
});
const ScopeDiscoveryResultSchema = z.strictObject({
  _tag: z.literal("ScopeDiscoveryResultV1"),
  schemaVersion: z.literal(SCOPE_DISCOVERY_SCHEMA_VERSION),
  scopes: z.array(ScopeDiscoveryCandidateSchema).max(SCOPE_DISCOVERY_MAX_LIMIT),
});
const ScopeDiscoveryReadEnvelopeSchema = z.discriminatedUnion("_tag", [
  z.strictObject({
    _tag: z.literal("ScopeDiscoveryReadSuccessV1"),
    result: ScopeDiscoveryResultSchema,
    schemaVersion: z.literal(SCOPE_DISCOVERY_SCHEMA_VERSION),
  }),
  z.strictObject({
    _tag: z.literal("ScopeDiscoveryReadUnavailableV1"),
    code: z.enum(["invalid-input", "store-unavailable", "contract-violation"]),
    message: z.string().min(1).max(500),
    schemaVersion: z.literal(SCOPE_DISCOVERY_SCHEMA_VERSION),
  }),
]);

export type ScopeDiscoveryPrivacy = z.infer<typeof PrivacySchema>;
export type ScopeDiscoveryCandidate = z.infer<
  typeof ScopeDiscoveryCandidateSchema
>;
export type ScopeDiscoveryResult = z.infer<typeof ScopeDiscoveryResultSchema>;

export interface ScopeDiscoveryInput {
  readonly projectHint?: string;
  readonly workstreamHint?: string;
  readonly limit: number;
  readonly allowedPrivacy: readonly ScopeDiscoveryPrivacy[];
}

export type ScopeDiscoveryFailureKind =
  | "cancelled"
  | "credential-unavailable"
  | "invalid-input"
  | "malformed-response"
  | "output-limit"
  | "process-failed"
  | "release-unavailable"
  | "source-unavailable"
  | "timeout";

export type ScopeDiscoveryOutcome =
  | { readonly status: "succeeded"; readonly result: ScopeDiscoveryResult }
  | {
      readonly status: "unavailable";
      readonly kind: ScopeDiscoveryFailureKind;
    };

export interface BoundedProcessRequest {
  /** Executable and adapter-owned flags only. Never hints or credentials. */
  readonly command: readonly string[];
  /** The entire private request. */
  readonly stdin: string;
  /** Complete child environment; the parent environment is never inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly signal: AbortSignal;
}

export interface BoundedProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Raw bytes observed before UTF-8 decoding or trimming. */
  readonly stdoutBytes: number;
  /** Raw bytes observed before UTF-8 decoding or trimming. */
  readonly stderrBytes: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly outputLimited: boolean;
  readonly missingExecutable: boolean;
}

export type BoundedProcessRunner = (
  request: BoundedProcessRequest,
) => Promise<BoundedProcessResult>;

const KILL_GRACE_MS = 250;
const REAP_BACKSTOP_MS = 2_000;
const PROCESS_GROUP_POLL_MS = 25;

type TerminationReason = "cancelled" | "output-limit" | "timeout";

function signalProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The exact detached process group already exited.
  }
}

function processGroupIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

/** Spawn with a hard deadline, cancellation, process-group cleanup, and byte caps. */
export const runBoundedProcess: BoundedProcessRunner = (request) =>
  new Promise((resolveRun) => {
    const emptyResult = (
      overrides: Partial<BoundedProcessResult>,
    ): BoundedProcessResult => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      timedOut: false,
      cancelled: false,
      outputLimited: false,
      missingExecutable: false,
      ...overrides,
    });

    if (request.signal.aborted) {
      resolveRun(emptyResult({ cancelled: true }));
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.command[0] ?? "", request.command.slice(1), {
        detached: true,
        env: { ...request.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolveRun(emptyResult({ missingExecutable: true }));
      return;
    }

    const processGroupId = child.pid;
    let settled = false;
    let terminationReason: TerminationReason | undefined;
    let leaderExitCode: number | null = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    let groupPollTimer: ReturnType<typeof setTimeout> | undefined;

    const result = (exitCode: number | null): BoundedProcessResult => ({
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
      stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
      stdoutBytes,
      stderrBytes,
      timedOut: terminationReason === "timeout",
      cancelled: terminationReason === "cancelled",
      outputLimited: terminationReason === "output-limit",
      missingExecutable: false,
    });

    const cancel = () => terminate("cancelled");

    const cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (reapTimer) clearTimeout(reapTimer);
      if (groupPollTimer) clearTimeout(groupPollTimer);
      request.signal.removeEventListener("abort", cancel);
    };

    const finish = (value: BoundedProcessResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveRun(value);
    };

    const waitForKilledGroup = () => {
      if (!processGroupIsAlive(processGroupId)) {
        finish(result(leaderExitCode));
        return;
      }
      groupPollTimer = setTimeout(waitForKilledGroup, PROCESS_GROUP_POLL_MS);
    };

    function terminate(reason: TerminationReason): void {
      if (terminationReason !== undefined) return;
      terminationReason = reason;
      signalProcessGroup(processGroupId, "SIGTERM");

      // Leader close must not cancel escalation: descendants may ignore TERM
      // and close inherited stdio before the leader exits.
      escalationTimer = setTimeout(() => {
        signalProcessGroup(processGroupId, "SIGKILL");
        waitForKilledGroup();
      }, KILL_GRACE_MS);
      reapTimer = setTimeout(
        () => finish(result(leaderExitCode)),
        KILL_GRACE_MS + REAP_BACKSTOP_MS,
      );
    }

    deadlineTimer = setTimeout(() => terminate("timeout"), request.timeoutMs);
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (terminationReason !== undefined) return;
      finish(emptyResult({ missingExecutable: error.code === "ENOENT" }));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (settled || terminationReason !== undefined) return;
      if (stdoutBytes > request.maxStdoutBytes) {
        terminate("output-limit");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (settled || terminationReason !== undefined) return;
      if (stderrBytes > request.maxStderrBytes) {
        terminate("output-limit");
        return;
      }
      stderrChunks.push(chunk);
    });
    child.once("close", (code) => {
      leaderExitCode = code;
      if (terminationReason === undefined) finish(result(code));
    });
    child.stdin?.on("error", () => {
      // EPIPE is represented by the child's exit and never surfaced verbatim.
    });
    child.stdin?.end(request.stdin);
  });

/** Allow only inert locale/path values plus explicitly injected values. */
export function minimalScopeDiscoveryEnv(
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = { TERM: "dumb" };
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"] as const) {
    const value = parent[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return { ...env, ...extra };
}

export type CredentialLeaseOutcome =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly kind: "cancelled" | "unavailable" };

export type ScopeDiscoveryCredentialLeaser = (input: {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}) => Promise<CredentialLeaseOutcome>;

export interface ScopeDiscoveryCredentialLeaseOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly runProcess?: BoundedProcessRunner;
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
}

/** Lease the fixed runtime credential through the canonical secrets executable. */
export async function leaseScopeDiscoveryCredential(
  options: ScopeDiscoveryCredentialLeaseOptions,
): Promise<CredentialLeaseOutcome> {
  const runProcess = options.runProcess ?? runBoundedProcess;
  const processResult = await runProcess({
    command: [
      AGENT_SECRETS_EXECUTABLE,
      "lease",
      SCOPE_DISCOVERY_SECRET_NAME,
      "--ttl",
      "5m",
      "--client-id",
      "pi-tools-scope-discovery",
    ],
    stdin: "",
    env: minimalScopeDiscoveryEnv(options.parentEnv ?? process.env),
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: 16 * 1024,
    maxStderrBytes: SCOPE_DISCOVERY_MAX_STDERR_BYTES,
    signal: options.signal,
  });

  if (processResult.cancelled) return { ok: false, kind: "cancelled" };
  if (
    processResult.timedOut ||
    processResult.outputLimited ||
    processResult.missingExecutable ||
    processResult.stderrBytes !== 0 ||
    processResult.exitCode !== 0
  ) {
    return { ok: false, kind: "unavailable" };
  }
  const value = processResult.stdout.trim();
  return value.length > 0
    ? { ok: true, value }
    : { ok: false, kind: "unavailable" };
}

export interface ScopeDiscoveryRunnerOptions {
  /** Test-only owner/anchor seam. Production always uses the root-owned target. */
  readonly testOnlyReleaseTarget?: ScopeDiscoveryReleaseTarget;
  readonly runProcess?: BoundedProcessRunner;
  readonly leaseCredential?: ScopeDiscoveryCredentialLeaser;
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export type ScopeDiscoveryRunner = (
  input: ScopeDiscoveryInput,
  signal: AbortSignal,
) => Promise<ScopeDiscoveryOutcome>;

function unavailable(kind: ScopeDiscoveryFailureKind): ScopeDiscoveryOutcome {
  return { status: "unavailable", kind };
}

export function buildScopeDiscoveryRequest(
  input: ScopeDiscoveryInput,
  now: Date,
): Record<string, unknown> {
  const decoded = ScopeDiscoveryInputSchema.safeParse(input);
  if (!decoded.success || !Number.isFinite(now.getTime())) {
    throw new Error("invalid scope discovery input");
  }
  return {
    _tag: "ScopeDiscoveryQueryV1",
    access: {
      _tag: "ScopeDiscoveryAccessV1",
      allowedPrivacy: [...decoded.data.allowedPrivacy],
      decidedAt: now.toISOString(),
      principalRef: "operator:joel",
      purpose: "explicit-agent-scope-discovery",
      schemaVersion: SCOPE_DISCOVERY_SCHEMA_VERSION,
    },
    limit: decoded.data.limit,
    ...(decoded.data.projectHint === undefined
      ? {}
      : { projectHint: decoded.data.projectHint }),
    schemaVersion: SCOPE_DISCOVERY_SCHEMA_VERSION,
    ...(decoded.data.workstreamHint === undefined
      ? {}
      : { workstreamHint: decoded.data.workstreamHint }),
  };
}

function uniqueCandidates(scopes: readonly ScopeDiscoveryCandidate[]): boolean {
  const pairs = scopes.map(
    (scope) => `${scope.project}\u0000${scope.workstream}`,
  );
  return new Set(pairs).size === pairs.length;
}

async function runWithRelease(
  binding: ScopeDiscoveryReleaseBinding,
  input: ScopeDiscoveryInput,
  signal: AbortSignal,
  options: ScopeDiscoveryRunnerOptions,
): Promise<ScopeDiscoveryOutcome> {
  let request: Record<string, unknown>;
  try {
    request = buildScopeDiscoveryRequest(
      input,
      (options.now ?? (() => new Date()))(),
    );
  } catch {
    return unavailable("invalid-input");
  }

  // The release may have changed since runner construction. Refuse before a
  // credential exists, then re-prove again immediately before spawn.
  if (!reverifyScopeDiscoveryRelease(binding).ok) {
    return unavailable("release-unavailable");
  }

  const timeoutMs = Math.min(
    Math.max(
      1,
      Math.floor(options.timeoutMs ?? SCOPE_DISCOVERY_DEFAULT_TIMEOUT_MS),
    ),
    120_000,
  );
  const leaseCredential =
    options.leaseCredential ??
    ((leaseInput) =>
      leaseScopeDiscoveryCredential({
        ...leaseInput,
        runProcess: options.runProcess,
        parentEnv: options.parentEnv,
      }));
  let credential: CredentialLeaseOutcome;
  try {
    credential = await leaseCredential({
      signal,
      timeoutMs: Math.min(timeoutMs, 5_000),
    });
  } catch {
    return unavailable("credential-unavailable");
  }
  if (!credential.ok) {
    return unavailable(
      credential.kind === "cancelled" ? "cancelled" : "credential-unavailable",
    );
  }

  if (!reverifyScopeDiscoveryRelease(binding).ok) {
    return unavailable("release-unavailable");
  }

  const runProcess = options.runProcess ?? runBoundedProcess;
  let processResult: BoundedProcessResult;
  try {
    processResult = await runProcess({
      command: [binding.artifactPath, ...SCOPE_DISCOVERY_ARGS],
      stdin: `${JSON.stringify(request)}\n`,
      env: minimalScopeDiscoveryEnv(options.parentEnv ?? process.env, {
        [SCOPE_DISCOVERY_CREDENTIAL_ENV_NAME]: credential.value,
      }),
      timeoutMs,
      maxStdoutBytes: SCOPE_DISCOVERY_MAX_STDOUT_BYTES,
      maxStderrBytes: SCOPE_DISCOVERY_MAX_STDERR_BYTES,
      signal,
    });
  } catch {
    return unavailable("process-failed");
  }

  if (processResult.cancelled) return unavailable("cancelled");
  if (processResult.timedOut) return unavailable("timeout");
  if (processResult.outputLimited) return unavailable("output-limit");
  if (processResult.missingExecutable)
    return unavailable("release-unavailable");
  if (processResult.stderrBytes !== 0) return unavailable("malformed-response");
  if (processResult.exitCode !== 0 && processResult.exitCode !== 3) {
    return unavailable("process-failed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(processResult.stdout);
  } catch {
    return unavailable("malformed-response");
  }
  const decoded = ScopeDiscoveryReadEnvelopeSchema.safeParse(parsed);
  if (!decoded.success) return unavailable("malformed-response");

  if (decoded.data._tag === "ScopeDiscoveryReadUnavailableV1") {
    return processResult.exitCode === 3
      ? unavailable("source-unavailable")
      : unavailable("malformed-response");
  }
  if (processResult.exitCode !== 0) return unavailable("malformed-response");
  if (
    decoded.data.result.scopes.length > input.limit ||
    !uniqueCandidates(decoded.data.result.scopes)
  ) {
    return unavailable("malformed-response");
  }

  return { status: "succeeded", result: decoded.data.result };
}

/**
 * Resolve and bind the release once. Every invocation still checks the captured
 * identities and digest before lease and immediately before spawn.
 */
export function createScopeDiscoveryRunner(
  options: ScopeDiscoveryRunnerOptions = {},
): ScopeDiscoveryRunner {
  const release = verifyScopeDiscoveryRelease(
    options.testOnlyReleaseTarget ?? PRODUCTION_SCOPE_DISCOVERY_RELEASE,
  );
  if (!release.ok) {
    return async () => unavailable("release-unavailable");
  }
  return (input, signal) =>
    runWithRelease(release.binding, input, signal, options);
}

export function scopeDiscoveryPayload(
  outcome: ScopeDiscoveryOutcome,
): ToolPayload {
  if (outcome.status === "unavailable") {
    const text = "Scope discovery is unavailable.";
    return {
      text,
      details: {
        ok: false,
        code: "scope-discovery-unavailable",
        lifecycle: outcome.kind === "cancelled" ? "cancelled" : "failed",
      },
      isError: true,
    };
  }

  const lines = outcome.result.scopes.map(
    (scope) =>
      `${scope.project}/${scope.workstream} — ${scope.headStatus}, ${scope.streamCount} stream${scope.streamCount === 1 ? "" : "s"}, last active ${scope.lastActivityAt}`,
  );
  return {
    text:
      lines.length === 0
        ? "No persisted scopes matched the supplied hints and privacy grant."
        : `Persisted scope candidates:\n${lines.join("\n")}`,
    details: {
      ok: true,
      operation: "DiscoverScopes",
      scopes: outcome.result.scopes,
    },
  };
}
