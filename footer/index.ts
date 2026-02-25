/**
 * footer — Shared footer for pi.
 *
 * Owns setFooter. Renders two lines:
 *   Line 1: ~/path (branch) • session        [extension statuses]
 *   Line 2: ↑in ↓out Rcache Wcache $cost ctx%     (provider) model • thinking
 *
 * Composable: any extension adds to the footer via ctx.ui.setStatus(id, label).
 * The footer collects them from footerData.getExtensionStatuses() automatically.
 * No direct dependency required — if this extension isn't loaded, setStatus
 * still works with pi's default footer.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export default function footer(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    install(ctx);
  });

  function install(ctx: ExtensionContext) {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          // ── Line 1: path + extension statuses ──
          let pwd = process.cwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) pwd = `${pwd} • ${sessionName}`;

          // All extension statuses — grind 🔥, mcp 2/3, whatever else
          const statuses = [...footerData.getExtensionStatuses().values()]
            .filter(Boolean)
            .join("  ");

          let line1: string;
          if (statuses) {
            const pwdW = visibleWidth(pwd);
            const statusW = visibleWidth(statuses);
            const gap = width - pwdW - statusW;
            if (gap >= 2) {
              line1 = pwd + " ".repeat(gap) + statuses;
            } else {
              const maxPwd = width - statusW - 2;
              line1 = maxPwd > 3
                ? truncateToWidth(pwd, maxPwd) + "  " + statuses
                : truncateToWidth(pwd, width);
            }
          } else {
            line1 = truncateToWidth(pwd, width);
          }

          // ── Line 2: token stats + context + model ──
          let totalIn = 0, totalOut = 0, cacheR = 0, cacheW = 0, cost = 0;
          let thinking = "off";
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && (entry as any).message?.role === "assistant") {
              const m = (entry as any).message as AssistantMessage;
              totalIn += m.usage.input;
              totalOut += m.usage.output;
              cacheR += m.usage.cacheRead;
              cacheW += m.usage.cacheWrite;
              cost += m.usage.cost.total;
            } else if ((entry as any).type === "thinking_level_change") {
              thinking = (entry as any).thinkingLevel;
            }
          }

          const fmt = (n: number) => {
            if (n < 1000) return n.toString();
            if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
            if (n < 1000000) return `${Math.round(n / 1000)}k`;
            if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
            return `${Math.round(n / 1000000)}M`;
          };

          const left: string[] = [];
          if (totalIn) left.push(`↑${fmt(totalIn)}`);
          if (totalOut) left.push(`↓${fmt(totalOut)}`);
          if (cacheR) left.push(`R${fmt(cacheR)}`);
          if (cacheW) left.push(`W${fmt(cacheW)}`);

          const isSub = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
          if (cost || isSub) left.push(`$${cost.toFixed(3)}${isSub ? " (sub)" : ""}`);

          // Wrapped — estimateTokens can throw on malformed message.content
          let ctxUsage: ReturnType<typeof ctx.getContextUsage> | undefined;
          try { ctxUsage = ctx.getContextUsage(); } catch {}
          const ctxWindow = ctxUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const ctxPct = ctxUsage?.percent ?? 0;
          const ctxDisplay = ctxUsage?.percent !== null
            ? `${ctxPct.toFixed(1)}%/${fmt(ctxWindow)} (auto)`
            : `?/${fmt(ctxWindow)} (auto)`;
          left.push(
            ctxPct > 90 ? theme.fg("error", ctxDisplay)
            : ctxPct > 70 ? theme.fg("warning", ctxDisplay)
            : ctxDisplay
          );

          let leftStr = left.join(" ");
          let leftW = visibleWidth(leftStr);
          if (leftW > width) { leftStr = truncateToWidth(leftStr, width); leftW = visibleWidth(leftStr); }

          // Right: model + thinking
          const model = ctx.model?.id || "no-model";
          let right = ctx.model?.reasoning
            ? (thinking === "off" ? `${model} • thinking off` : `${model} • ${thinking}`)
            : model;

          if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
            const withProv = `(${ctx.model.provider}) ${right}`;
            if (leftW + 2 + visibleWidth(withProv) <= width) right = withProv;
          }

          const rightW = visibleWidth(right);
          let line2: string;
          if (leftW + 2 + rightW <= width) {
            line2 = leftStr + " ".repeat(width - leftW - rightW) + right;
          } else {
            const avail = width - leftW - 2;
            if (avail > 3) {
              const tr = truncateToWidth(right, avail);
              line2 = leftStr + " ".repeat(width - leftW - visibleWidth(tr)) + tr;
            } else {
              line2 = leftStr;
            }
          }

          return [
            theme.fg("dim", line1),
            theme.fg("dim", leftStr) + theme.fg("dim", line2.slice(leftStr.length)),
          ];
        },
      };
    });
  }
}
