// Grind Mode — autonomous coding loop with auto-compact.
//
// `/grind` toggles grind mode on/off.
// When on: after each agent turn, sends a follow-up message to keep building.
// Auto-compacts at 50% context usage to prevent overflow.
// Auto-stops after 3 consecutive no-op turns (no tool calls, <10 chars text).
// The `grind_stop` tool lets the agent self-terminate when all work is done.
//
// ALL behavior is gated on `active` — normal sessions are never affected.
//
// Env vars:
//   GRIND_COMPACT_THRESHOLD  — context % to trigger compaction (default: 50)
//   GRIND_MAX_NOOPS          — consecutive empty turns before auto-stop (default: 3)
//   GRIND_COMPACT_INSTRUCTIONS — custom compaction instructions
//   GRIND_CONTINUE_PROMPT    — custom continuation prompt

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const COMPACT_THRESHOLD = parseInt(process.env.GRIND_COMPACT_THRESHOLD || "50", 10);
const MAX_NOOPS = parseInt(process.env.GRIND_MAX_NOOPS || "3", 10);
const COMPACT_INSTRUCTIONS =
  process.env.GRIND_COMPACT_INSTRUCTIONS ||
  "Preserve: current task, what was just built, decisions made, gotchas hit. " +
    "Discard: tool call details, file contents already committed.";
const CONTINUE_PROMPT =
  process.env.GRIND_CONTINUE_PROMPT ||
  "🔥 Grind mode: keep going. What's the next step? Build it, test it, commit it. If all work is complete, call the grind_stop tool.";

export default function grindMode(pi: ExtensionAPI) {
  let active = false;
  let noOpCount = 0;

  // ── /grind command ──────────────────────────────────────────
  pi.registerCommand("grind", {
    description: "Toggle grind mode — auto-compact and keep building after every turn",
    handler: async (_args, ctx) => {
      active = !active;
      noOpCount = 0;

      if (active) {
        ctx.ui.notify("🔥 Grind mode ON", "info");
        ctx.ui.setStatus("grind", "🔥");
      } else {
        ctx.ui.notify("⏸️ Grind mode OFF", "info");
        ctx.ui.setStatus("grind", undefined);
      }
    },
  });

  // ── grind_stop tool ─────────────────────────────────────────
  pi.registerTool({
    name: "grind_stop",
    label: "Grind: Stop",
    description:
      "Stop grind mode. Call this when all work is complete and there is nothing left to build, test, or commit.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      active = false;
      noOpCount = 0;
      ctx.ui.setStatus("grind", undefined);
      ctx.ui.notify("⏸️ Grind mode stopped by agent", "info");
      return "Grind mode stopped.";
    },
  });

  // ── agent_end: auto-compact + auto-continue (ONLY when grind is active) ──
  pi.on("agent_end", async (_event, ctx) => {
    if (!active) return;

    try {
      // Auto-compact at threshold
      let usage: ReturnType<typeof ctx.getContextUsage> | undefined;
      try { usage = ctx.getContextUsage(); } catch {}
      if (usage && usage.percent !== null && usage.percent > COMPACT_THRESHOLD) {
        const pct = Math.round(usage.percent);
        ctx.compact({
          customInstructions: COMPACT_INSTRUCTIONS,
          onComplete: () => {
            pi.sendMessage(
              {
                customType: "grind-compacted",
                content: `🔄 Auto-compacted at ${pct}% context. Continuing where we left off.`,
                display: false,
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          },
        });
        return; // compact triggers its own continuation
      }

      // No-op detection: count consecutive turns with no tool calls and short text
      const msgs = (_event as any)?.messages;
      const lastMsg = Array.isArray(msgs)
        ? msgs.filter((m: any) => m.role === "assistant").at(-1)
        : undefined;

      const contentArr = Array.isArray(lastMsg?.content) ? lastMsg.content : [];

      const lastText = contentArr
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text ?? "")
        .join("")
        .trim();

      const hasToolCalls = contentArr.some((p: any) => p.type === "tool-call");

      if (!hasToolCalls && lastText.length < 10) {
        noOpCount++;
        if (noOpCount >= MAX_NOOPS) {
          active = false;
          noOpCount = 0;
          ctx.ui.setStatus("grind", undefined);
          ctx.ui.notify(
            `⏸️ Grind auto-stopped: no work for ${MAX_NOOPS} turns`,
            "warning",
          );
          return;
        }
      } else {
        noOpCount = 0;
      }

      pi.sendMessage(
        {
          customType: "grind-continue",
          content: CONTINUE_PROMPT,
          display: false,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      // Swallow — don't crash pi on malformed event data
    }
  });
}
