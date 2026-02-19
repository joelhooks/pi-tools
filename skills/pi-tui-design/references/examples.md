# TUI Design Examples

Complete, copy-paste component implementations. Each demonstrates specific design principles from the skill.

## Table of Contents

- [Selection Dialog](#selection-dialog) — SelectList with borders, theming, hints
- [Status Dashboard](#status-dashboard) — Multi-section layout, aligned columns, color hierarchy
- [Progress Tracker](#progress-tracker) — Animated braille progress, timer cleanup, state changes
- [Data Table](#data-table) — Column alignment, truncation, scroll, row highlighting
- [Persistent Widget](#persistent-widget) — Above-editor widget with live updates
- [Tool Renderer](#tool-renderer) — renderCall/renderResult for custom tools
- [Overlay Panel](#overlay-panel) — Side panel with responsive visibility

## Selection Dialog

Standard pattern. Uses `SelectList` + `DynamicBorder` + theme-aware styling. Compose from built-in components — don't rebuild selection logic.

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@mariozechner/pi-tui";

pi.registerCommand("pick-env", {
  description: "Select deployment environment",
  handler: async (_args, ctx) => {
    const items: SelectItem[] = [
      { value: "dev", label: "Development", description: "Local k8s cluster" },
      { value: "staging", label: "Staging", description: "Preview deploys" },
      { value: "prod", label: "Production", description: "joelclaw.com — careful" },
    ];

    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();

      // Top border — type the param to avoid jiti issues
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      // Title with breathing room
      container.addChild(new Text(theme.fg("accent", theme.bold("Deploy Target")), 1, 0));
      container.addChild(new Spacer(1));

      // Selection list
      const list = new SelectList(items, items.length, {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      container.addChild(list);

      // Keyboard hints
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));

      // Bottom border
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
      };
    });

    if (result) ctx.ui.notify(`Deploying to ${result}`, "info");
  },
});
```

**Design notes**: `Spacer(1)` between title and list gives breathing room. DynamicBorder adapts to terminal width. Hints use `dim` — visible but not competing with content.

## Status Dashboard

Multi-section layout with aligned columns and semantic color hierarchy. Demonstrates: box-drawing borders, right-aligned values, mixed color weights, responsive width.

```typescript
import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

interface ServiceStatus {
  name: string;
  status: "up" | "down" | "degraded";
  latency?: number;
  detail?: string;
}

class StatusDashboard {
  private services: ServiceStatus[];
  private theme: Theme;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(services: ServiceStatus[], theme: Theme, onClose: () => void) {
    this.services = services;
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const th = this.theme;
    const lines: string[] = [];
    const inner = Math.max(20, width - 4); // 2 padding each side

    // Header with rounded corners
    lines.push(th.fg("border", `  ╭${"─".repeat(inner)}╮`));
    const title = th.fg("accent", th.bold(" System Health "));
    const titlePad = inner - visibleWidth(title);
    lines.push(th.fg("border", "  │") + title + " ".repeat(Math.max(0, titlePad)) + th.fg("border", "│"));
    lines.push(th.fg("border", `  ├${"─".repeat(inner)}┤`));

    // Column headers
    const nameCol = 20;
    const statusCol = 10;
    const latencyCol = 10;
    const hdr = "  " + th.fg("border", "│") + " "
      + th.fg("dim", "SERVICE".padEnd(nameCol))
      + th.fg("dim", "STATUS".padEnd(statusCol))
      + th.fg("dim", "LATENCY".padStart(latencyCol))
      + " ".repeat(Math.max(0, inner - nameCol - statusCol - latencyCol - 2))
      + th.fg("border", "│");
    lines.push(truncateToWidth(hdr, width));

    lines.push(th.fg("border", `  ├${"─".repeat(inner)}┤`));

    // Service rows
    for (const svc of this.services) {
      const statusIcon = svc.status === "up" ? "●"
        : svc.status === "degraded" ? "◉" : "✗";
      const statusColor = svc.status === "up" ? "success"
        : svc.status === "degraded" ? "warning" : "error";
      const latency = svc.latency !== undefined ? `${svc.latency}ms` : "—";

      const row = "  " + th.fg("border", "│") + " "
        + th.fg("text", svc.name.padEnd(nameCol))
        + th.fg(statusColor, `${statusIcon} ${svc.status}`.padEnd(statusCol))
        + th.fg("muted", latency.padStart(latencyCol))
        + " ".repeat(Math.max(0, inner - nameCol - statusCol - latencyCol - 2))
        + th.fg("border", "│");
      lines.push(truncateToWidth(row, width));
    }

    // Footer
    lines.push(th.fg("border", `  ╰${"─".repeat(inner)}╯`));
    lines.push(th.fg("dim", "  press esc to close"));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

**Design notes**: Right-aligned latency column — numbers align better right-justified. `●/◉/✗` symbol weight conveys status before color registers. Rounded corners (`╭╰`) feel modern. `dim` for column headers — structure without visual noise. Inner padding calculated from width so borders always fit.

## Progress Tracker

Animated braille-resolution progress bar with timer. Demonstrates: `setInterval` lifecycle, `dispose()` cleanup, `tui.requestRender()`, block element gradients.

```typescript
class ProgressTracker {
  private percent = 0;
  private message = "Starting...";
  private tui: { requestRender: () => void };
  private theme: Theme;
  private interval: ReturnType<typeof setInterval> | null = null;
  private onDone: (cancelled: boolean) => void;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private version = 0;
  private cachedVersion = -1;

  constructor(
    tui: { requestRender: () => void },
    theme: Theme,
    onDone: (cancelled: boolean) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onDone = onDone;
  }

  /** Call from outside to update progress */
  update(percent: number, message: string): void {
    this.percent = Math.min(100, Math.max(0, percent));
    this.message = message;
    this.version++;
    this.tui.requestRender();
  }

  /** Start a simulated auto-progress (for demo) */
  startSimulation(): void {
    const steps = ["Downloading...", "Processing...", "Transcribing...", "Enriching...", "Finalizing..."];
    let step = 0;
    this.interval = setInterval(() => {
      this.percent += 2;
      if (this.percent >= (step + 1) * 20 && step < steps.length - 1) step++;
      this.message = steps[step];
      this.version++;
      this.tui.requestRender();

      if (this.percent >= 100) {
        this.dispose();
        this.onDone(false);
      }
    }, 100);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.dispose();
      this.onDone(true);
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width && this.cachedVersion === this.version) {
      return this.cachedLines;
    }

    const th = this.theme;
    const lines: string[] = [];
    const barWidth = Math.max(10, width - 16); // room for percentage + padding

    // Build bar with block elements for smooth gradient
    const filled = Math.floor((this.percent / 100) * barWidth);
    const partial = ((this.percent / 100) * barWidth) - filled;

    // Partial fill characters: ░▒▓█ (4 levels of density)
    const partialChar = partial > 0.75 ? "▓" : partial > 0.5 ? "▒" : partial > 0.25 ? "░" : "";
    const bar = "█".repeat(filled) + partialChar + " ".repeat(Math.max(0, barWidth - filled - (partialChar ? 1 : 0)));

    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("accent", bar)} ${th.fg("muted", `${this.percent}%`)}`, width));
    lines.push(truncateToWidth(`  ${th.fg("dim", this.message)}`, width));
    lines.push(truncateToWidth(`  ${th.fg("dim", "esc to cancel")}`, width));
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    this.cachedVersion = this.version;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  /** ALWAYS call on exit — leaked intervals cause post-dispose renders */
  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
```

**Design notes**: Block element gradient `█▓▒░` gives sub-character resolution. `dispose()` is explicit and called on BOTH cancel and completion paths. Version tracking avoids re-rendering on every `requestRender()` when nothing changed.

## Data Table

Scrollable table with column alignment, row highlighting, and truncation. Demonstrates: keyboard navigation, scroll window, `visibleWidth` for ANSI-safe column math.

```typescript
interface Column {
  header: string;
  width: number;        // fixed character width
  align: "left" | "right";
  color?: string;       // theme color token
}

interface Row {
  cells: string[];
  highlight?: boolean;
}

class DataTable {
  private columns: Column[];
  private rows: Row[];
  private selectedRow = 0;
  private scrollOffset = 0;
  private maxVisible: number;
  private theme: Theme;
  private onSelect?: (row: Row) => void;
  private onCancel?: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(columns: Column[], rows: Row[], maxVisible: number, theme: Theme) {
    this.columns = columns;
    this.rows = rows;
    this.maxVisible = maxVisible;
    this.theme = theme;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) && this.selectedRow > 0) {
      this.selectedRow--;
      if (this.selectedRow < this.scrollOffset) this.scrollOffset = this.selectedRow;
      this.invalidate();
    } else if (matchesKey(data, Key.down) && this.selectedRow < this.rows.length - 1) {
      this.selectedRow++;
      if (this.selectedRow >= this.scrollOffset + this.maxVisible) {
        this.scrollOffset = this.selectedRow - this.maxVisible + 1;
      }
      this.invalidate();
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.rows[this.selectedRow]);
    } else if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const th = this.theme;
    const lines: string[] = [];
    const sep = th.fg("border", " │ ");

    // Header row
    const headerCells = this.columns.map(col => {
      const text = col.align === "right"
        ? col.header.padStart(col.width)
        : col.header.padEnd(col.width);
      return th.fg("dim", text);
    });
    lines.push(truncateToWidth("  " + headerCells.join(sep), width));

    // Header separator using box-drawing
    const sepLine = this.columns.map(col => "─".repeat(col.width)).join("─┼─");
    lines.push(truncateToWidth("  " + th.fg("border", sepLine), width));

    // Visible rows
    const visibleRows = this.rows.slice(this.scrollOffset, this.scrollOffset + this.maxVisible);
    visibleRows.forEach((row, i) => {
      const actualIndex = this.scrollOffset + i;
      const isSelected = actualIndex === this.selectedRow;

      const cells = this.columns.map((col, ci) => {
        const raw = row.cells[ci] || "";
        const fitted = col.align === "right"
          ? raw.padStart(col.width).slice(-col.width)
          : raw.padEnd(col.width).slice(0, col.width);
        const color = isSelected ? "accent" : (col.color || "text");
        return th.fg(color, fitted);
      });

      const prefix = isSelected ? th.fg("accent", "▸ ") : "  ";
      lines.push(truncateToWidth(prefix + cells.join(sep), width));
    });

    // Scroll indicator
    if (this.rows.length > this.maxVisible) {
      const pos = Math.round((this.scrollOffset / (this.rows.length - this.maxVisible)) * 100);
      lines.push(truncateToWidth(
        `  ${th.fg("dim", `${this.rows.length} rows — ${pos}%`)}`,
        width
      ));
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

**Design notes**: `▸` prefix on selected row — more distinctive than `>`. Right-align numbers, left-align text — column `align` property. Box-drawing `┼` at column intersections. Scroll window tracks selected row.

## Persistent Widget

Above-editor widget showing live state. Minimal surface area — just a factory function returning `render`/`invalidate`.

```typescript
// In an extension's session_start handler:
pi.on("session_start", async (_event, ctx) => {
  let items = [
    { label: "Redis", ok: true },
    { label: "Qdrant", ok: true },
    { label: "Inngest", ok: false },
  ];

  ctx.ui.setWidget("health", (_tui, theme) => {
    return {
      render: () => {
        const parts = items.map(s => {
          const icon = s.ok ? theme.fg("success", "●") : theme.fg("error", "●");
          const label = s.ok ? theme.fg("muted", s.label) : theme.fg("text", s.label);
          return `${icon} ${label}`;
        });
        return [parts.join(theme.fg("dim", "  │  "))];
      },
      invalidate: () => {},
    };
  });
});
```

**Design notes**: Single line. Status dots before labels — scan left edge for red. `│` separator in `dim` — structure without weight. Widget is the lightest delivery surface — use it for ambient information that doesn't need interaction.

## Tool Renderer

Custom `renderCall`/`renderResult` for a tool. Return `Text` with `(0, 0)` padding — the wrapping `Box` handles padding.

```typescript
pi.registerTool({
  name: "deploy",
  label: "Deploy",
  description: "Deploy to an environment",
  parameters: Type.Object({
    env: StringEnum(["dev", "staging", "prod"] as const),
    service: Type.String(),
  }),

  async execute(_id, params, _signal, onUpdate) {
    onUpdate?.({
      content: [{ type: "text", text: `Deploying ${params.service}...` }],
      details: { phase: "starting", env: params.env, service: params.service },
    });

    // ... actual deploy logic ...

    return {
      content: [{ type: "text", text: `Deployed ${params.service} to ${params.env}` }],
      details: { phase: "complete", env: params.env, service: params.service, duration: 4200 },
    };
  },

  // Compact call display
  renderCall(args, theme) {
    const envColor = args.env === "prod" ? "warning" : "muted";
    return new Text(
      theme.fg("toolTitle", theme.bold("deploy "))
        + theme.fg(envColor, args.env)
        + theme.fg("dim", " → ")
        + theme.fg("text", args.service),
      0, 0
    );
  },

  // Result with expandable detail
  renderResult(result, { expanded, isPartial }, theme) {
    const d = result.details as { phase: string; env: string; service: string; duration?: number };

    if (isPartial) {
      return new Text(theme.fg("warning", `⠋ Deploying ${d.service}...`), 0, 0);
    }

    let text = theme.fg("success", "✓ ") + theme.fg("muted", `${d.service} → ${d.env}`);
    if (d.duration) text += theme.fg("dim", ` (${(d.duration / 1000).toFixed(1)}s)`);

    if (expanded) {
      text += "\n" + theme.fg("dim", JSON.stringify(d, null, 2));
    }

    return new Text(text, 0, 0);
  },
});
```

**Design notes**: `prod` gets `warning` color — draw attention to dangerous deploys. `isPartial` shows spinner character. Duration in `dim` parenthetical — secondary info. Expanded view dumps full details for debugging.

## Overlay Panel

Side panel using overlay anchoring. Demonstrates responsive visibility — hides when terminal is too narrow.

```typescript
pi.registerCommand("sidepanel", {
  description: "Show info panel",
  handler: async (_args, ctx) => {
    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
        const items = ["Item A", "Item B", "Item C"];
        let selected = 0;

        return {
          render(width: number): string[] {
            const lines: string[] = [];
            lines.push(theme.fg("accent", theme.bold("  Panel")));
            lines.push(theme.fg("border", "  " + "─".repeat(width - 4)));
            for (let i = 0; i < items.length; i++) {
              const prefix = i === selected
                ? theme.fg("accent", "  ▸ ")
                : "    ";
              const color = i === selected ? "accent" : "muted";
              lines.push(truncateToWidth(prefix + theme.fg(color, items[i]), width));
            }
            lines.push("");
            lines.push(truncateToWidth(theme.fg("dim", "  esc close"), width));
            return lines;
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, Key.up) && selected > 0) { selected--; tui.requestRender(); }
            else if (matchesKey(data, Key.down) && selected < items.length - 1) { selected++; tui.requestRender(); }
            else if (matchesKey(data, Key.escape)) { done(); }
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "right-center",
          width: "30%",
          minWidth: 30,
          maxHeight: "60%",
          margin: { top: 2, right: 2, bottom: 2, left: 0 },
          // Hide on narrow terminals — don't cramp the editor
          visible: (termWidth) => termWidth >= 100,
        },
      }
    );
  },
});
```

**Design notes**: `right-center` anchor keeps it out of the editor's way. `minWidth: 30` prevents illegible squeeze. `visible` callback hides the panel entirely below 100 columns — better than a crushed layout. Margin only on non-editor side.
