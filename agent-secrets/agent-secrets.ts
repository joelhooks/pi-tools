/**
 * agent-secrets — Pi tool for leasing secrets from the agent-secrets daemon.
 * 
 * Wraps the `secrets` CLI with proper HATEOAS responses.
 * Agents can lease credentials with TTLs, check status, revoke.
 * 
 * Requires: https://github.com/joelhooks/agent-secrets
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";

function secrets(cmd: string): { success: boolean; data: any } {
  try {
    const out = execSync(`secrets ${cmd}`, { encoding: "utf-8", timeout: 10000 }).trim();
    try { return JSON.parse(out); } catch { return { success: true, data: out }; }
  } catch (e: any) {
    const out = (e.stdout || e.stderr || e.message || "").trim();
    try { return JSON.parse(out); } catch { return { success: false, data: out }; }
  }
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }], details: {} };
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
      const ttl = params.ttl || "1h";
      const client = params.client_id || "pi-agent";
      try {
        const value = execSync(
          `secrets lease ${params.name} --ttl ${ttl} --client-id ${client}`,
          { encoding: "utf-8", timeout: 10000 }
        ).trim();
        if (!value || value.includes("error")) {
          return text(`Failed to lease '${params.name}': ${value}`);
        }
        return text(value);
      } catch (e: any) {
        return text(`Failed to lease '${params.name}': ${e.stderr || e.message}`);
      }
    },
  });

  pi.registerTool({
    name: "secrets_status",
    label: "Secrets: Status",
    description: "Check agent-secrets daemon status — running state, secret count, active leases.",
    parameters: Type.Object({}),
    async execute() {
      const result = secrets("status");
      if (!result.success) return text(`Daemon not running: ${JSON.stringify(result.data)}`);
      const d = result.data;
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
        const result = secrets("revoke --all");
        return text(result.success ? "🚨 All leases revoked." : `Revoke failed: ${JSON.stringify(result.data)}`);
      }
      if (params.lease_id) {
        const result = secrets(`revoke ${params.lease_id}`);
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
      const result = secrets(`audit --tail ${n}`);
      return text(typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2));
    },
  });

  pi.registerTool({
    name: "secrets_env",
    label: "Secrets: Env",
    description: "Generate a .env file from .secrets.json in the working directory. Leases all listed secrets and writes KEY=value pairs.",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Overwrite existing .env" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const flag = params.force ? " --force" : "";
        const out = execSync(`secrets env${flag}`, {
          encoding: "utf-8",
          timeout: 15000,
          cwd: ctx.cwd,
        }).trim();
        try {
          const result = JSON.parse(out);
          return text(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
        } catch {
          return text(out);
        }
      } catch (e: any) {
        return text(`Failed: ${e.stderr || e.message}`);
      }
    },
  });
}
