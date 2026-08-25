/**
 * Canonical JoelClaw capture path discovery and health classification.
 *
 * Namespaced layout:
 * `~/.joelclaw/capture/<machine_id>/<runtime>/{state.json,capture.log,outbox/}`
 *
 * Legacy flat files are historical evidence only. Generic flat files have no
 * trusted runtime owner and must not be treated as healthy namespaced capture.
 *
 * Keep this module aligned with `joelclaw-session-capture/lib/capture-layout.js`.
 */

export const CAPTURE_RUNTIMES = ["pi", "codex", "claude-code"] as const;
export type CaptureRuntime = (typeof CAPTURE_RUNTIMES)[number];
export type CaptureKind = "state" | "log" | "outbox";
export type CaptureNamespace = "canonical" | "legacy";
export type CentralUrlStatus = "missing" | "stale" | "configured";
export type RuntimeCaptureStatus =
  | "legacy-clear"
  | "missing-canonical"
  | "legacy-only"
  | "queued"
  | "degraded";

/** One capture artifact the doctor or session_capture_status must inspect. */
export interface CapturePathSpec {
  readonly runtime?: CaptureRuntime;
  readonly kind: CaptureKind;
  readonly namespace: CaptureNamespace;
  readonly label: string;
  readonly path: string;
}

/** Observed health for one capture artifact. */
export interface CaptureFileStatus {
  readonly label: string;
  readonly path: string;
  readonly runtime?: CaptureRuntime;
  readonly kind: CaptureKind;
  readonly namespace: CaptureNamespace;
  readonly present: boolean;
  readonly modified?: string;
  readonly tail?: string;
  readonly pendingCount?: number;
}

/** Classified Central capture URL. Never invent a replacement host. */
export interface CentralUrlClassification {
  readonly status: CentralUrlStatus;
  readonly source?: string;
  readonly reason?: string;
}

/** Per-runtime capture health derived from canonical vs legacy files. */
export interface RuntimeCaptureHealth {
  readonly runtime: CaptureRuntime;
  readonly status: RuntimeCaptureStatus;
  readonly canonicalState: boolean;
  readonly canonicalLog: boolean;
  readonly pendingCount: number;
  readonly legacyPresent: boolean;
}

/** Aggregate capture health. Missing canonical namespaces are never healthy. */
export interface CaptureHealth {
  readonly ok: false;
  readonly currentCapture: "unproven";
  readonly legacyCentralOk: boolean;
  readonly machineId: string;
  readonly runtimes: readonly RuntimeCaptureHealth[];
  readonly central: CentralUrlClassification;
}

const RETIRED_CENTRAL_URL = /^https?:\/\/[^/]+:3000(?:\/|$)/iu;

/**
 * Sanitize a JoelClaw machine id for use as a capture directory name.
 *
 * @param machineId - Raw machine id from auth or env
 * @returns Directory-safe machine id, or `unknown-machine` when empty
 */
export function sanitizeMachineId(machineId: string | undefined): string {
  const trimmed = machineId?.trim() ?? "";
  if (!trimmed) return "unknown-machine";
  return trimmed.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

/**
 * Read `machine_id` from a JoelClaw auth document without throwing.
 *
 * @param value - Parsed `auth.json` object
 * @returns Machine id or `unknown-machine`
 */
export function machineIdFromAuth(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown-machine";
  const machineId = (value as { machine_id?: unknown }).machine_id;
  return typeof machineId === "string" ? sanitizeMachineId(machineId) : "unknown-machine";
}

/**
 * Namespaced capture root for one runtime.
 *
 * @param home - User home directory
 * @param machineId - JoelClaw machine id
 * @param runtime - Capture runtime directory name
 */
export function canonicalRuntimeRoot(
  home: string,
  machineId: string,
  runtime: CaptureRuntime,
): string {
  return `${home}/.joelclaw/capture/${sanitizeMachineId(machineId)}/${runtime}`;
}

/**
 * Build the canonical plus legacy capture targets for one machine.
 *
 * Canonical paths are listed first. Legacy Codex/Claude files are tagged to
 * their runtime so split reporting cannot be mistaken for one healthy namespace.
 *
 * @param home - User home directory
 * @param machineId - JoelClaw machine id
 */
export function capturePathSpecs(home: string, machineId: string): readonly CapturePathSpec[] {
  const safeId = sanitizeMachineId(machineId);
  const canonical = CAPTURE_RUNTIMES.flatMap((runtime) => {
    const root = canonicalRuntimeRoot(home, safeId, runtime);
    return [
      {
        runtime,
        kind: "state",
        namespace: "canonical",
        label: `${runtime} capture state (${safeId})`,
        path: `${root}/state.json`,
      },
      {
        runtime,
        kind: "log",
        namespace: "canonical",
        label: `${runtime} capture log (${safeId})`,
        path: `${root}/capture.log`,
      },
      {
        runtime,
        kind: "outbox",
        namespace: "canonical",
        label: `${runtime} capture outbox (${safeId})`,
        path: `${root}/outbox`,
      },
    ] satisfies CapturePathSpec[];
  });

  const legacy: CapturePathSpec[] = [
    {
      kind: "state",
      namespace: "legacy",
      label: "legacy runtime-ambiguous capture state",
      path: `${home}/.joelclaw/session-state.json`,
    },
    {
      kind: "log",
      namespace: "legacy",
      label: "legacy runtime-ambiguous capture log",
      path: `${home}/.joelclaw/capture.log`,
    },
    {
      kind: "outbox",
      namespace: "legacy",
      label: "legacy ambiguous capture outbox",
      path: `${home}/.joelclaw/outbox`,
    },
    {
      runtime: "codex",
      kind: "state",
      namespace: "legacy",
      label: "legacy codex capture state",
      path: `${home}/.joelclaw/codex-session-state.json`,
    },
    {
      runtime: "codex",
      kind: "log",
      namespace: "legacy",
      label: "legacy codex capture log",
      path: `${home}/.joelclaw/codex-capture.log`,
    },
    {
      runtime: "claude-code",
      kind: "state",
      namespace: "legacy",
      label: "legacy claude capture state",
      path: `${home}/.joelclaw/claude-session-state.json`,
    },
    {
      runtime: "claude-code",
      kind: "log",
      namespace: "legacy",
      label: "legacy claude capture log",
      path: `${home}/.joelclaw/claude-capture.log`,
    },
  ];

  return [...canonical, ...legacy];
}

/**
 * Classify a configured Central URL. Does not invent a replacement.
 *
 * Port 3000 was used by the retired Central capture route.
 *
 * @param url - Candidate URL from env, system-bus, or a hook command
 */
export function classifyCentralUrl(url: string | undefined): CentralUrlClassification {
  const trimmed = url?.trim() ?? "";
  if (!trimmed) return { status: "missing", reason: "JOELCLAW_CENTRAL_URL is not set" };
  if (RETIRED_CENTRAL_URL.test(trimmed)) {
    return {
      status: "stale",
      reason: "configured value is a retired Central URL; do not guess a replacement",
    };
  }
  // Reachability belongs to the owning health probe, not URL classification.
  return { status: "configured" };
}

/**
 * Pull `JOELCLAW_CENTRAL_URL` from a shell env file body.
 *
 * @param text - Raw `.env` / `system-bus.env` contents
 */
export function parseEnvAssignment(text: string | undefined, name: string): string | undefined {
  if (!text) return undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const prefix = trimmed.startsWith("export ") ? `export ${name}=` : `${name}=`;
    if (!trimmed.startsWith(prefix)) continue;
    return trimmed.slice(prefix.length).trim().replace(/^["']|["']$/gu, "") || undefined;
  }
  return undefined;
}

/**
 * Read a Central URL baked into a Codex Stop-hook command.
 *
 * @param command - Hook command string
 */
export function extractUrlFromHookCommand(command: string | undefined): string | undefined {
  const match = command?.match(/JOELCLAW_CENTRAL_URL=(\S+)/u);
  return match?.[1];
}

/**
 * Resolve Central URL from known local sources without inventing a host.
 *
 * Priority: process env, then `system-bus.env`, then a hook command.
 * A stale value in an earlier source wins and is reported as stale.
 *
 * @param input - Local configuration fragments
 */
export function resolveCentralUrl(input: {
  readonly envUrl?: string;
  readonly systemBusText?: string;
  readonly hookCommand?: string;
}): CentralUrlClassification {
  const candidates: ReadonlyArray<{ source: string; url: string | undefined }> = [
    { source: "env", url: input.envUrl },
    { source: "system-bus.env", url: parseEnvAssignment(input.systemBusText, "JOELCLAW_CENTRAL_URL") },
    { source: "hook", url: extractUrlFromHookCommand(input.hookCommand) },
  ];
  for (const candidate of candidates) {
    const classified = classifyCentralUrl(candidate.url);
    if (classified.status === "missing") continue;
    return { ...classified, source: candidate.source };
  }
  return { status: "missing", reason: "JOELCLAW_CENTRAL_URL is not set in env, system-bus.env, or hook" };
}

function fileOf(
  files: readonly CaptureFileStatus[],
  runtime: CaptureRuntime | undefined,
  kind: CaptureKind,
  namespace: CaptureNamespace,
): CaptureFileStatus | undefined {
  return files.find(
    (file) => file.runtime === runtime && file.kind === kind && file.namespace === namespace,
  );
}

/**
 * Derive capture health. Legacy files never make a missing namespace healthy.
 *
 * @param input - Observed files plus optional Central classification
 */
export function assessCaptureHealth(input: {
  readonly machineId: string;
  readonly files: readonly CaptureFileStatus[];
  readonly central?: CentralUrlClassification;
}): CaptureHealth {
  const central = input.central ?? { status: "missing" as const };
  const runtimes = CAPTURE_RUNTIMES.map((runtime) => {
    const canonicalState = fileOf(input.files, runtime, "state", "canonical")?.present === true;
    const canonicalLog = fileOf(input.files, runtime, "log", "canonical")?.present === true;
    const pendingCount = fileOf(input.files, runtime, "outbox", "canonical")?.pendingCount ?? 0;
    const legacyPresent =
      fileOf(input.files, runtime, "state", "legacy")?.present === true ||
      fileOf(input.files, runtime, "log", "legacy")?.present === true;
    let status: RuntimeCaptureStatus;
    if (canonicalState && canonicalLog) {
      status = pendingCount > 0 ? "queued" : "legacy-clear";
    } else if (legacyPresent) {
      status = "legacy-only";
    } else if (canonicalLog || pendingCount > 0) {
      status = "degraded";
    } else {
      status = "missing-canonical";
    }
    return {
      runtime,
      status,
      canonicalState,
      canonicalLog,
      pendingCount,
      legacyPresent,
    } satisfies RuntimeCaptureHealth;
  });

  const legacyCentralOk =
    central.status === "configured" &&
    runtimes.every((runtime) => runtime.status === "legacy-clear");
  return {
    ok: false,
    currentCapture: "unproven",
    legacyCentralOk,
    machineId: sanitizeMachineId(input.machineId),
    runtimes,
    central,
  };
}
