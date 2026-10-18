/**
 * agent-secrets — inject leased values into a child's environment, not context.
 * Wraps the `secrets` CLI; keeps status, revoke and audit compatibility.
 * 
 * Requires: https://github.com/joelhooks/agent-secrets
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFileSync, spawn } from "node:child_process";
import type { Static } from "@sinclair/typebox";
import { redactingPipe, secretPatterns } from "./redaction.ts";

type SecretsResult = { success: boolean; data: unknown };

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

export function normalizeSecretsOutput(output: string, commandSucceeded: boolean): SecretsResult {
  const trimmed = output.trim();

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const envelope = parsed as Record<string, unknown>;
      const success = typeof envelope.success === "boolean"
        ? envelope.success
        : typeof envelope.ok === "boolean"
          ? envelope.ok
          : commandSucceeded;
      const data = hasOwn(envelope, "result")
        ? envelope.result
        : hasOwn(envelope, "data")
          ? envelope.data
          : parsed;
      return { success, data };
    }

    return { success: commandSucceeded, data: parsed };
  } catch {
    return { success: commandSucceeded, data: trimmed };
  }
}

function secrets(args: string[]): SecretsResult {
  try {
    const out = execFileSync("secrets", args, { encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
    return normalizeSecretsOutput(out, true);
  } catch (e: any) {
    const out = String(e.stdout || e.stderr || e.message || "");
    return normalizeSecretsOutput(out, false);
  }
}

export function toolText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "No data returned.";
  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: toolText(value) }], details: {} };
}

type LeaseFailure = "name" | "client" | "ttl" | "missing" | "daemon" | "timeout" | "unknown";
type LeaseParams = { name: string; ttl?: string; client_id?: string };

// One fixed, three-line failure surface. No child output is ever interpolated.
function leaseFailure(kind: LeaseFailure, params: LeaseParams): string {
  const fragment = params.name.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 32) || "secret";
  const guidance: Record<LeaseFailure, { what: string; why: string; next: string }> = {
    name: {
      what: "invalid secret name",
      why: "name must match ^[A-Za-z0-9._:-]{1,128}$.",
      next: `secrets_status {}; bash: secrets list | grep -i -- '${fragment}'`,
    },
    client: {
      what: "invalid client_id",
      why: "client_id must match ^[A-Za-z0-9._:-]{1,64}$.",
      next: 'secrets_exec {"env":{"API_KEY":"<name>"},"command":["<cmd>"],"ttl":"1h"}',
    },
    ttl: {
      what: "invalid TTL",
      why: "ttl must match ^\\d+[smh]$ (for example, 15m or 1h).",
      next: 'secrets_exec {"env":{"API_KEY":"<name>"},"command":["<cmd>"],"ttl":"1h"}',
    },
    missing: {
      what: "unknown secret",
      why: "agent-secrets could not find that name. Check names before retrying.",
      next: "secrets_status {}; bash: secrets list",
    },
    daemon: {
      what: "daemon unavailable",
      why: "agent-secrets could not connect to its daemon.",
      next: "bash: secrets serve &",
    },
    timeout: {
      what: "lease timed out",
      why: "The lease exceeded its deadline; any partial output was withheld.",
      next: "secrets_status {}",
    },
    unknown: {
      what: "lease unavailable",
      why: "The CLI failed or returned empty stdout; untrusted diagnostics were withheld.",
      next: 'secrets_audit {"tail": 5}; secrets_status {}',
    },
  };
  const { what, why, next } = guidance[kind];
  return `secrets_lease failed: ${what}\nWhy: ${why}\nNext: ${next}`;
}

// Classify bounded, recognised messages, but disclose only fixed guidance. Even a
// recognised error line or JSON error/fix field may itself contain a credential.
function classifyLeaseMessage(message: string): LeaseFailure {
  if (/^(?:failed to acquire lease: RPC error -32000: secret "[A-Za-z0-9._:-]{1,128}": )?secret not found$/i.test(message)) return "missing";
  if (/^(?:Failed to connect to daemon|daemon not running|daemon unavailable)$/i.test(message)) return "daemon";
  if (/^(?:failed to acquire lease: RPC error -32603: )?invalid ttl duration:/.test(message)) return "ttl";
  if (/^(?:lease timed out|context deadline exceeded|i\/o timeout)$/i.test(message)) return "timeout";
  return "unknown";
}

function classifyLeaseDiagnostic(output: unknown, allowPlainText: boolean): LeaseFailure {
  if (typeof output !== "string" || output.length > 8192) return "unknown";
  try {
    const envelope: unknown = JSON.parse(output);
    if (!envelope || typeof envelope !== "object" || !("error" in envelope)
      || !(("ok" in envelope && envelope.ok === false) || ("success" in envelope && envelope.success === false))) return "unknown";
    const error: unknown = envelope.error;
    const message = typeof error === "string" ? error
      : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "";
    return classifyLeaseMessage(message);
  } catch {
    if (!allowPlainText) return "unknown";
    for (const line of output.split(/\r?\n/)) {
      const kind = classifyLeaseMessage(line.replace(/^Error: /, "").trim());
      if (kind !== "unknown") return kind;
    }
    return "unknown";
  }
}

const execParameters = Type.Object({
  env: Type.Record(Type.String({ pattern: "^[A-Z_][A-Z0-9_]{0,63}$" }), Type.String()),
  command: Type.Array(Type.String(), { minItems: 1, description: "Literal argv, not a shell string" }),
  cwd: Type.Optional(Type.String()),
  timeout_seconds: Type.Optional(Type.Number({ minimum: 0, exclusiveMinimum: 0, maximum: 1800, default: 120 })),
  ttl: Type.Optional(Type.String({ default: "1h" })),
});
type ExecParams = Static<typeof execParameters>;

function failure(what: string, why: string, next: string) {
  return text(`secrets_exec failed: ${what}\nWhy: ${why}\nNext: ${next}`);
}
const example = 'secrets_exec {"env":{"API_KEY":"<name>"},"command":["<cmd>"],"ttl":"1h"}';
function exactMatch(pattern: RegExp, value: string): boolean { return pattern.exec(value)?.[0] === value; }

export async function executeSecrets(input: unknown) {
  // Validate every input before ANY lease or command spawn, including callers
  // that bypass Pi's schema validation. Do not repeat untrusted input in errors.
  if (!input || typeof input !== "object" || !("env" in input) || !input.env
    || typeof input.env !== "object" || Array.isArray(input.env)) {
    return failure("invalid env", "env must map environment variable names to secret names.", example);
  }
  const entries = Object.entries(input.env);
  for (const [variable, name] of entries) {
    if (!exactMatch(/^[A-Z_][A-Z0-9_]{0,63}$/, variable)) return failure("invalid environment variable", "Use ^[A-Z_][A-Z0-9_]{0,63}$ for every env key.", example);
    if (typeof name !== "string" || !exactMatch(/^[A-Za-z0-9._:-]{1,128}$/, name)) return failure("invalid secret name", `Invalid name for ${variable}; use ^[A-Za-z0-9._:-]{1,128}$.`, "secrets_status {}; bash: secrets list");
  }
  if (!("command" in input) || !Array.isArray(input.command) || !input.command.length
    || input.command.some((arg: unknown) => typeof arg !== "string" || arg.includes("\0")) || !input.command[0]) {
    return failure("invalid command", "command must be a non-empty argv array of NUL-free strings, starting with an executable.", example);
  }
  if ("cwd" in input && (typeof input.cwd !== "string" || !input.cwd || input.cwd.includes("\0"))) return failure("invalid cwd", "cwd must be a non-empty NUL-free directory path.", example);
  if ("ttl" in input && (typeof input.ttl !== "string" || !exactMatch(/^\d+[smh]$/, input.ttl))) return failure("invalid TTL", "ttl must match ^\\d+[smh]$ (for example, 15m or 1h).", example);
  if ("timeout_seconds" in input && (typeof input.timeout_seconds !== "number" || !Number.isFinite(input.timeout_seconds) || input.timeout_seconds <= 0 || input.timeout_seconds > 1800)) return failure("invalid timeout", "timeout_seconds must be greater than 0 and at most 1800; default 120.", example);
  // SAFETY: all ExecParams fields have been validated above, not only by TypeBox.
  const params = input as ExecParams;
  const started = performance.now();
  const values: string[] = [];
  const environment = { ...process.env };
  for (const [variable, name] of Object.entries(params.env)) {
    const request = { name, ttl: params.ttl ?? "1h", client_id: "pi-agent" };
    let kind: LeaseFailure = "unknown";
    try {
      const value = execFileSync("secrets", ["lease", name, "--ttl", request.ttl, "--client-id", request.client_id],
        { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
      if (value && !value.includes("\0")) { values.push(value); environment[variable] = value; continue; }
    } catch (error: unknown) {
      // Never interpolate an exception: it may contain credentials and output.
      if (error && typeof error === "object") {
        if ("code" in error && error.code === "ETIMEDOUT") kind = "timeout";
        else {
          if ("stderr" in error) kind = classifyLeaseDiagnostic(error.stderr, true);
          if (kind === "unknown" && "stdout" in error) kind = classifyLeaseDiagnostic(error.stdout, false);
        }
      }
    }
    const guidance = leaseFailure(kind, request).replace("secrets_lease failed:", `secrets_exec failed: lease for ${variable} (${name}):`);
    return redactedText(guidance, values);
  }
  const patterns = secretPatterns(values);
  return await new Promise<ReturnType<typeof text>>((resolve) => {
    let remaining = 50 * 1024;
    let truncated = false;
    let stdout = "";
    let stderr = "";
    const capture = (stream: "stdout" | "stderr", output: string) => {
      const bytes = Buffer.from(output);
      let kept = bytes.subarray(0, remaining).toString("utf8");
      // Drop a replacement introduced by cutting a UTF-8 codepoint at the cap.
      if (Buffer.byteLength(kept) > remaining) kept = kept.slice(0, -1);
      const size = Buffer.byteLength(kept);
      remaining -= size;
      if (bytes.length > size) truncated = true;
      if (stream === "stdout") stdout += kept; else stderr += kept;
    };
    const out = redactingPipe(patterns, (s) => capture("stdout", s));
    const err = redactingPipe(patterns, (s) => capture("stderr", s));
    let timedOut = false;
    let spawnCode: string | undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(params.command[0], params.command.slice(1), {
        cwd: params.cwd, env: environment, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(failure("command could not start", "No child diagnostics were disclosed.", example));
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the owned process group, including explicit-shell descendants that
      // may otherwise keep stdout open forever. No process-name matching.
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* The child already exited. Its close event still settles. */ }
    }, (params.timeout_seconds ?? 120) * 1000);
    child.stdout?.on("data", (chunk: Buffer) => out.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.write(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => { spawnCode = error.code ?? "UNKNOWN"; });
    child.on("close", (exit_code, signal) => {
      clearTimeout(timer);
      out.end(); err.end();
      const result = { exit_code, signal, duration_ms: Math.round(performance.now() - started),
        injected_vars: Object.keys(params.env), stdout, stderr, truncated,
        ...(truncated ? { note: "Output truncated at 50 KB (combined stdout and stderr)." } : {}) };
      const details = JSON.stringify(result);
      let output = details;
      if (timedOut) output = `secrets_exec failed: command timed out\nWhy: Deadline exceeded; process group killed. Partial redacted result: ${details}\nNext: Inspect the redacted output, then retry secrets_exec with timeout_seconds up to 1800.`;
      else if (spawnCode) {
        // Shell quoting prevents the repair hint from becoming an injection.
        const quoted = /^[A-Za-z0-9_./-]+$/.test(params.command[0]) ? params.command[0] : "'" + params.command[0].replace(/'/g, "'\\''").replace(/[\r\n]/g, "") + "'";
        output = `secrets_exec failed: command could not start\nWhy: ${spawnCode === "ENOENT" ? "Executable or cwd not found" : "Spawn refused; check executable permissions and cwd"}. Redacted result: ${details}\nNext: bash: which ${quoted}`;
      } else if (exit_code !== 0) output = `secrets_exec exited: ${exit_code ?? signal}\nWhy: Command did not exit successfully. Redacted result: ${details}\nNext: Inspect the redacted output and fix the command before retrying secrets_exec.`;
      resolve(redactedText(output, values));
    });
  });
}

function redactedText(output: string, values: string[]) {
  let safe = "";
  const pipe = redactingPipe(secretPatterns(values), (s) => { safe += s; });
  pipe.write(Buffer.from(output)); pipe.end();
  return text(safe);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "secrets_exec",
    label: "Secrets: Exec",
    description: "Run an argv command with secrets injected into its environment, never returned as values. Output is redacted and capped at 50 KB. Shells must be explicit; do not echo or transform credentials.",
    parameters: execParameters,
    async execute(_id, params) { return executeSecrets(params); },
  });

  pi.registerTool({
    name: "secrets_lease",
    label: "Secrets: Lease",
    description: "Retired: never returns values. Returns instructions for secrets_exec environment injection instead.",
    parameters: Type.Object({
      name: Type.String({ description: "Secret name (e.g., slack_bot_token, kv_rest_api_url)" }),
      ttl: Type.Optional(Type.String({ description: "Time-to-live (default: 1h). Examples: 15m, 1h, 4h" })),
      client_id: Type.Optional(Type.String({ description: "Client identifier for audit trail" })),
    }),
    async execute(_id, params) {
      const variable = (params.name.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&").slice(0, 64) || "SECRET");
      return text(`secrets_lease no longer returns values: they land in transcripts.\nWhy: secrets now run through secrets_exec, which injects them into one command's environment.\nNext: secrets_exec ${JSON.stringify({ env: { [variable]: params.name }, command: ["<cmd>", "..."] })}`);
    },
  });

  pi.registerTool({
    name: "secrets_status",
    label: "Secrets: Status",
    description: "Check agent-secrets daemon status — running state, secret count, active leases.",
    parameters: Type.Object({}),
    async execute() {
      const result = secrets(["status"]);
      if (!result.success) return text(`Daemon not running: ${JSON.stringify(result.data)}`);
      const d = asRecord(result.data);
      if (!d) return text("Invalid daemon status response.");
      const lines = [
        `🛡️ agent-secrets daemon`,
        `Running: ${d.running}`,
        `Secrets: ${d.secrets_count}`,
        `Active leases: ${d.active_leases}`,
        `Uptime: ${d.uptime || "unknown"}`,
      ];
      if (d.heartbeat?.enabled) {
        lines.push(`Heartbeat: ${d.heartbeat.url} (${d.heartbeat.interval})`);
      }
      return text(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "secrets_revoke",
    label: "Secrets: Revoke",
    description: "Revoke a specific lease or all active leases.",
    parameters: Type.Object({
      lease_id: Type.Optional(Type.String({ description: "Specific lease ID to revoke" })),
      all: Type.Optional(Type.Boolean({ description: "Revoke ALL active leases (killswitch)" })),
    }),
    async execute(_id, params) {
      if (params.all) {
        const result = secrets(["revoke", "--all"]);
        return text(result.success ? "🚨 All leases revoked." : `Revoke failed: ${JSON.stringify(result.data)}`);
      }
      if (params.lease_id) {
        const result = secrets(["revoke", params.lease_id]);
        return text(result.success ? `Revoked lease ${params.lease_id}` : `Failed: ${JSON.stringify(result.data)}`);
      }
      return text("Provide lease_id or set all=true");
    },
  });

  pi.registerTool({
    name: "secrets_audit",
    label: "Secrets: Audit",
    description: "View the append-only audit log of secret access.",
    parameters: Type.Object({
      tail: Type.Optional(Type.Number({ description: "Number of entries (default: 20)" })),
    }),
    async execute(_id, params) {
      const n = params.tail || 20;
      const result = secrets(["audit", "--tail", String(n)]);
      return text(result.data);
    },
  });
}
