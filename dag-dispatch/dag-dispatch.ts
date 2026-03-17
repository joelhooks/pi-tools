/**
 * Pi extension: DAG Dispatch
 * 
 * Provides tools for dispatching and monitoring Restate DAG workloads
 * from within a pi session. Subscribes to completion events via Redis
 * so results appear as session messages — no polling needed.
 * 
 * Tools:
 *   dispatch_dag  — Send a DAG pipeline to Restate, returns immediately
 *   dag_status    — Check status of a running DAG
 * 
 * Background:
 *   Subscribes to Redis pub/sub for DAG completion notifications.
 *   Injects completion results into the session as custom messages.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const RESTATE_INGRESS_URL = process.env.RESTATE_INGRESS_URL || "http://localhost:8080";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Track dispatched DAGs for this session
const activeDAGs = new Map<string, { pipeline: string; dispatchedAt: number; status: string }>();

export default function dagDispatch(pi: ExtensionAPI) {
  let redisSubscriber: any = null;

  // --- Tool: dispatch_dag ---
  pi.registerTool({
    name: "dispatch_dag",
    label: "Dispatch DAG",
    description: "Send a DAG pipeline to Restate for async execution. Returns immediately with workflowId. You'll be notified when it completes.",
    parameters: Type.Object({
      pipeline: Type.String({ description: "Pipeline name (used for logging)" }),
      nodes: Type.Array(
        Type.Object({
          id: Type.String({ description: "Node ID" }),
          task: Type.String({ description: "Task description" }),
          handler: Type.Union([
            Type.Literal("shell"),
            Type.Literal("infer"),
            Type.Literal("microvm"),
            Type.Literal("noop"),
          ], { description: "Handler type" }),
          dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Dependency node IDs" })),
          config: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Handler config" })),
        }),
        { description: "DAG nodes" }
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const workflowId = `dag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

      try {
        const response = await fetch(
          `${RESTATE_INGRESS_URL}/dagOrchestrator/${workflowId}/run/send`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requestId: workflowId,
              pipeline: params.pipeline,
              nodes: params.nodes,
            }),
            signal: AbortSignal.timeout(10_000),
          }
        );

        if (!response.ok) {
          const text = await response.text();
          return {
            content: [{ type: "text" as const, text: `DAG dispatch failed (${response.status}): ${text}` }],
            details: { error: text, status: response.status },
          };
        }

        activeDAGs.set(workflowId, {
          pipeline: params.pipeline,
          dispatchedAt: Date.now(),
          status: "running",
        });

        return {
          content: [{
            type: "text" as const,
            text: `DAG dispatched: ${workflowId}\nPipeline: ${params.pipeline}\nNodes: ${params.nodes.length}\nStatus: running\n\nYou'll be notified when it completes. Continue with other work.`,
          }],
          details: { workflowId, pipeline: params.pipeline, nodeCount: params.nodes.length },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `DAG dispatch error: ${msg}` }],
          details: { error: msg },
        };
      }
    },
  });

  // --- Tool: dag_status ---
  pi.registerTool({
    name: "dag_status",
    label: "DAG Status",
    description: "Check the status of dispatched DAG workloads in this session.",
    parameters: Type.Object({
      workflowId: Type.Optional(Type.String({ description: "Specific workflow ID (omit for all)" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      if (params.workflowId) {
        const dag = activeDAGs.get(params.workflowId);
        if (!dag) {
          return {
            content: [{ type: "text" as const, text: `No DAG found with ID: ${params.workflowId}` }],
            details: undefined,
          };
        }
        const ageMs = Date.now() - dag.dispatchedAt;
        return {
          content: [{
            type: "text" as const,
            text: `DAG ${params.workflowId}\n  Pipeline: ${dag.pipeline}\n  Status: ${dag.status}\n  Age: ${Math.round(ageMs / 1000)}s`,
          }],
          details: { ...dag, workflowId: params.workflowId, ageMs },
        };
      }

      // All DAGs
      if (activeDAGs.size === 0) {
        return {
          content: [{ type: "text" as const, text: "No DAGs dispatched in this session." }],
          details: undefined,
        };
      }

      const lines = ["Active DAGs:"];
      for (const [id, dag] of activeDAGs) {
        const ageMs = Date.now() - dag.dispatchedAt;
        lines.push(`  ${id} — ${dag.pipeline} — ${dag.status} (${Math.round(ageMs / 1000)}s)`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: Object.fromEntries(activeDAGs),
      };
    },
  });

  // --- Background: Redis subscription for DAG completion ---
  pi.on("session_start", async () => {
    try {
      const { default: Redis } = await import("ioredis");
      redisSubscriber = new Redis(REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      redisSubscriber.on("error", () => {}); // suppress

      await redisSubscriber.connect();
      await redisSubscriber.subscribe("joelclaw:dag:completed");

      redisSubscriber.on("message", (_channel: string, message: string) => {
        try {
          const event = JSON.parse(message);
          const workflowId = event.workflowId;
          const dag = workflowId ? activeDAGs.get(workflowId) : null;

          if (dag) {
            dag.status = event.success === false ? "failed" : "completed";
            
            // Inject a message into the session
            const lines = [
              `📬 DAG ${event.success === false ? "❌ FAILED" : "✅ COMPLETED"}: ${workflowId}`,
              `   Pipeline: ${dag.pipeline}`,
              `   Duration: ${event.durationMs ? Math.round(event.durationMs / 1000) + "s" : "unknown"}`,
            ];
            if (event.summary) lines.push(`   Summary: ${event.summary}`);
            if (event.error) lines.push(`   Error: ${event.error}`);

            // Use pi's message injection if available
            console.log(lines.join("\n"));
          }
        } catch {
          // ignore parse errors
        }
      });
    } catch {
      // Redis not available — tools still work, just no live notifications
    }
  });

  pi.on("session_shutdown", async () => {
    if (redisSubscriber) {
      try {
        await redisSubscriber.unsubscribe();
        redisSubscriber.disconnect();
      } catch {
        // cleanup best-effort
      }
      redisSubscriber = null;
    }
  });
}
