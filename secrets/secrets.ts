/**
 * agent-secrets — Pi tool for leasing secrets from the agent-secrets daemon.
 * 
 * Wraps the `secrets` CLI with proper HATEOAS responses.
 * Agents can lease credentials with TTLs, check status, revoke.
 * 
 * Requires: https://github.com/joelhooks/agent-secrets
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";

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
      next: `secrets_lease ${JSON.stringify({ ...params, client_id: "pi-agent" })}`,
    },
    ttl: {
      what: "invalid TTL",
      why: "ttl must match ^\\d+[smh]$ (for example, 15m or 1h).",
      next: `secrets_lease ${JSON.stringify({ ...params, ttl: "1h" })}`,
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

export default function (pi: ExtensionAPI) {

  pi.registerTool({
    name: "secrets_lease",
    label: "Secrets: Lease",
    description: "Lease a secret from agent-secrets with a TTL. Returns only the secret value. Use for API keys, tokens, credentials needed for a task.",
    parameters: Type.Object({
      name: Type.String({ description: "Secret name (e.g., slack_bot_token, kv_rest_api_url)" }),
      ttl: Type.Optional(Type.String({ description: "Time-to-live (default: 1h). Examples: 15m, 1h, 4h" })),
      client_id: Type.Optional(Type.String({ description: "Client identifier for audit trail" })),
    }),
    async execute(_id, params) {
      const ttl = params.ttl ?? "1h";
      const client = params.client_id ?? "pi-agent";
      const request = { name: params.name, ttl, client_id: client };
      if (params.name.match(/^[A-Za-z0-9._:-]{1,128}$/)?.[0] !== params.name) return text(leaseFailure("name", request));
      if (ttl.match(/^\d+[smh]$/)?.[0] !== ttl) return text(leaseFailure("ttl", request));
      if (client.match(/^[A-Za-z0-9._:-]{1,64}$/)?.[0] !== client) return text(leaseFailure("client", request));
      try {
        const value = execFileSync(
          "secrets", ["lease", params.name, "--ttl", ttl, "--client-id", client],
          { encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }
        ).trim();
        return text(value ? value : leaseFailure("unknown", request));
      } catch (error: unknown) {
        // Never read error.message: Node may embed the command and child output.
        let kind: LeaseFailure = "unknown";
        if (error && typeof error === "object") {
          if ("code" in error && error.code === "ETIMEDOUT") kind = "timeout";
          else {
            if ("stderr" in error) kind = classifyLeaseDiagnostic(error.stderr, true);
            if (kind === "unknown" && "stdout" in error) kind = classifyLeaseDiagnostic(error.stdout, false);
          }
        }
        return text(leaseFailure(kind, request));
      }
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
