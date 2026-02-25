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
- [Command Palette Overlay](#command-palette-overlay) — Fuzzy command search with queued selection and progress dots
- [Config Management Overlay](#config-management-overlay) — Add/delete items with save-on-close
- [Powerline Footer Segment](#powerline-footer-segment) — Segment registry and footer composition
- [Render Helper Library](#render-helper-library) — Shared helper utilities for consistent layout

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

## Command Palette Overlay

Command palette from Nico repos: fuzzy search, scrollable results, queued selection state, and rainbow progress dots.

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

interface PaletteItem {
  id: string;
  name: string;
  description: string;
}

interface PaletteResult {
  action: "select" | "unqueue" | "cancel";
  item: PaletteItem | null;
}

const RAINBOW_COLORS = [
  "38;2;184;129;214", "38;2;215;135;175", "38;2;254;188;56",
  "38;2;228;192;15", "38;2;137;210;129", "38;2;0;175;175", "38;2;23;143;185",
];

function fg(code: string, text: string): string {
  return code ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function rainbowProgress(filled: number, total: number): string {
  const parts: string[] = [];
  for (let i = 0; i < total; i++) {
    const color = RAINBOW_COLORS[i % RAINBOW_COLORS.length];
    const dot = i < filled ? "●" : "○";
    parts.push(fg(color, dot));
  }
  return parts.join(" ");
}

function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 + (q.length / t.length) * 50;
  let score = 0;
  let qi = 0;
  let consecutive = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += 10 + consecutive;
      consecutive += 5;
      qi++;
    } else {
      consecutive = 0;
    }
  }
  return qi === q.length ? score : 0;
}

function fuzzyFilter<T extends { name: string; description: string }>(items: T[], query: string): T[] {
  const q = query.trim();
  if (!q) return items;
  return items
    .map((item) => ({ item, score: Math.max(fuzzyScore(q, item.name), fuzzyScore(q, item.description) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

class CommandPaletteOverlay implements Component, Focusable {
  focused = false;
  private query = "";
  private selected = 0;
  private filtered: PaletteItem[];
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly INACTIVITY_MS = 60_000;
  private readonly width = 74;
  private readonly maxVisible = 8;
  private scrollOffset = 0;

  constructor(
    private _tui: TUI,
    private theme: Theme,
    private done: (result: PaletteResult) => void,
    private items: PaletteItem[],
    private queuedItemId: string | null,
  ) {
    this.filtered = items;
  }

  private resetInactivity(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => this.done({ action: "cancel", item: null }), CommandPaletteOverlay.INACTIVITY_MS);
  }

  handleInput(data: string): void {
    this.resetInactivity();

    if (matchesKey(data, "escape")) {
      this.done({ action: "cancel", item: null });
      return;
    }

    if (matchesKey(data, "return")) {
      const chosen = this.filtered[this.selected];
      if (!chosen) return;
      this.done({ action: chosen.id === this.queuedItemId ? "unqueue" : "select", item: chosen });
      return;
    }

    if (matchesKey(data, "up")) {
      this.selected = this.filtered.length ? Math.max(0, this.selected - 1) : 0;
      this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.filtered.length - this.maxVisible));
      return;
    }

    if (matchesKey(data, "down")) {
      this.selected = this.filtered.length ? Math.min(this.filtered.length - 1, this.selected + 1) : 0;
      return;
    }

    if (matchesKey(data, "backspace")) {
      this.query = this.query.slice(0, -1);
      this.filtered = fuzzyFilter(this.items, this.query);
      this.selected = 0;
      this.scrollOffset = 0;
      return;
    }

    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.query += data;
      this.filtered = fuzzyFilter(this.items, this.query);
      this.selected = 0;
      this.scrollOffset = 0;
    }
  }

  render(_width: number): string[] {
    const width = this.width;
    const innerW = width - 2;
    const lines: string[] = [];
    const border = (s: string) => this.theme.fg("dim", s);
    const row = (content: string) => border("│") + truncateToWidth(" " + content, innerW) + border("│");
    const empty = () => border("│") + " ".repeat(innerW) + border("│");

    const start = Math.max(0, Math.min(this.selected - Math.floor(this.maxVisible / 2), this.filtered.length - this.maxVisible));
    const end = Math.min(start + this.maxVisible, this.filtered.length);

    this.scrollOffset = Math.max(0, start);
    const title = " Skill Palette ";
    lines.push(border(`╭${"─".repeat(Math.max(0, innerW - title.length))} ${title} ${"─".repeat(Math.max(0, innerW - title.length))}`));
    lines.push(empty());
    const q = this.query ? `${this.query}▌` : "type to filter...";
    lines.push(row(`◎  ${q}`));
    lines.push(empty());
    lines.push(border("├" + "─".repeat(innerW) + "┤"));
    lines.push(empty());

    if (this.filtered.length === 0) {
      lines.push(row(this.theme.fg("warning", "No matching entries")));
    } else {
      for (let i = start; i < end; i++) {
        const item = this.filtered[i];
        const isSelected = i === this.selected;
        const isQueued = item.id === this.queuedItemId;
        const marker = isSelected ? this.theme.fg("accent", "▸") : this.theme.fg("dim", "·");
        const name = isSelected ? this.theme.fg("accent", item.name) : item.name;
        const queued = isQueued ? this.theme.fg("success", " ●") : "";
        const desc = truncateToWidth(item.description, Math.max(4, innerW - 20), "…");
        lines.push(row(`${marker} ${name}${queued}  — ${desc}`));
      }
      if (this.filtered.length > this.maxVisible) {
        const prog = Math.round(((this.selected + 1) / this.filtered.length) * 10);
        const scrollInfo = `${this.selected + 1}/${this.filtered.length}`;
        lines.push(empty());
        lines.push(row(`${rainbowProgress(prog, 10)}  ${this.theme.fg("dim", scrollInfo)}`));
      }
    }

    lines.push(empty());
    lines.push(row(this.theme.fg("dim", "↑↓ navigate  enter select  esc cancel")));
    lines.push(border("╰" + "─".repeat(innerW) + "╯"));
    return lines;
  }

  invalidate(): void {}
  dispose(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  }
}

export default function commandPaletteExample(pi: ExtensionAPI) {
  const items: PaletteItem[] = [
    { id: "build", name: "Build", description: "Run project build pipeline" },
    { id: "test", name: "Test", description: "Run automated tests" },
    { id: "lint", name: "Lint", description: "Run lint checks" },
  ];
  let queued: PaletteItem | null = null;

  pi.registerCommand("skill-palette", {
    description: "Open command palette overlay",
    handler: async (_args, ctx: ExtensionContext) => {
      const result = await ctx.ui.custom<PaletteResult>(
        (_tui, theme, _kb, done) => new CommandPaletteOverlay(_tui, theme, done, items, queued?.id ?? null),
        { overlay: true, overlayOptions: { anchor: "center", width: 74 } },
      );

      if (result.action === "select" && result.item) {
        queued = result.item;
        ctx.ui.notify(`Queued: ${result.item.name}`, "info");
      } else if (result.action === "unqueue" && result.item) {
        queued = null;
        ctx.ui.notify(`Removed from queue: ${result.item.name}`, "info");
      }
    },
  });
}
```

**Design notes**: Fuzzy matching drives every input event, so the overlay remains predictable at scale. The queued item is surfaced inline, and timeout cancel is a safe fallback.

## Config Management Overlay

Nico messenger-style management UI with add/delete and save-on-exit.

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

const CFG_DIR = join(homedir(), ".pi", "agent", "extensions", "pi-tui-design");
const CFG_PATH = join(CFG_DIR, "settings.json");

function loadPaths(): string[] {
  if (!existsSync(CFG_PATH)) return [];
  const raw = readFileSync(CFG_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed?.paths) ? parsed.paths : [];
}

function savePaths(paths: string[]): void {
  mkdirSync(CFG_DIR, { recursive: true });
  writeFileSync(CFG_PATH, JSON.stringify({ paths }, null, 2));
}

class ConfigManagementOverlay implements Component, Focusable {
  focused = false;
  private paths: string[];
  private selected = 0;
  private dirty = false;
  private statusMessage = "";

  constructor(
    private tui: TUI,
    private theme: Theme,
    private done: () => void,
  ) {
    this.paths = loadPaths();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      if (this.dirty) savePaths(this.paths);
      this.done();
      return;
    }
    if (matchesKey(data, "a")) {
      const cwd = process.cwd();
      if (!this.paths.includes(cwd)) {
        this.paths.push(cwd);
        this.selected = this.paths.length - 1;
        this.dirty = true;
        this.statusMessage = "Added folder";
      } else {
        this.statusMessage = "Already configured";
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "d") || matchesKey(data, "backspace")) {
      if (this.paths.length > 0) {
        const removed = this.paths[this.selected];
        this.paths.splice(this.selected, 1);
        this.selected = Math.min(this.selected, Math.max(0, this.paths.length - 1));
        this.dirty = true;
        this.statusMessage = `Removed ${removed}`;
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = Math.min(this.paths.length - 1, this.selected + 1);
      this.tui.requestRender();
    }
  }

  render(_width: number): string[] {
    const width = 68;
    const innerW = width - 2;
    const border = (s: string) => this.theme.fg("dim", s);
    const row = (content: string) => border("│") + truncateToWidth(" " + content, innerW) + border("│");
    const empty = () => border("│") + " ".repeat(innerW) + border("│");
    const lines: string[] = [];
    const title = " Config Manager ";
    lines.push(border(`╭${"─".repeat(Math.max(0, (innerW - title.length - 0) / 2))} ${title} ${"─".repeat(Math.max(0, (innerW - title.length + 1) / 2)}╮`));
    lines.push(empty());

    if (this.paths.length === 0) {
      lines.push(row("  (no configured folders)"));
    } else {
      for (let i = 0; i < this.paths.length; i++) {
        const selected = i === this.selected;
        const prefix = selected ? this.theme.fg("accent", "▸") : " ";
        const text = `${selected ? this.theme.fg("accent", this.paths[i]) : this.paths[i]}`;
        lines.push(row(`${prefix} ${truncateToWidth(text, innerW - 4)}`));
      }
    }

    lines.push(empty());
    lines.push(row(this.statusMessage ? this.theme.fg("accent", this.statusMessage) : this.theme.fg("dim", "a add · d delete · ↑↓ navigate · esc save&close")));
    lines.push(border("╰" + "─".repeat(innerW) + "╯"));
    return lines;
  }

  invalidate(): void {
    this.statusMessage = "";
  }
  dispose(): void {}
}

export default function configOverlayExample(pi: ExtensionAPI) {
  pi.registerCommand("config-overlay", {
    description: "Open configuration overlay",
    handler: async (_args, ctx: ExtensionContext) => {
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => new ConfigManagementOverlay(tui, theme, done),
        { overlay: true, overlayOptions: { anchor: "center", width: 68 } },
      );
      ctx.ui.notify("Config saved", "info");
    },
  });
}
```

**Design notes**: Save only when state changes. The overlay remains keyboard-driven and avoids extra command plumbing.

## Powerline Footer Segment

Segment registry + conditional visibility inspired by `pi-powerline-footer`.

```typescript
import type { ExtensionAPI, ExtensionContext, Theme, ReadonlyFooterDataProvider } from "@mariozechner/pi-coding-agent";

type SegmentContext = {
  model?: { name?: string };
  branch?: string | null;
  sessionId?: string;
  tokens?: number;
};

interface RenderedSegment {
  content: string;
  visible: boolean;
}

interface StatusLineSegment {
  id: "model" | "branch" | "session" | "tokens";
  render(ctx: SegmentContext, theme: Theme): RenderedSegment;
}

const modelSegment: StatusLineSegment = {
  id: "model",
  render(ctx, theme) {
    if (!ctx.model?.name) return { content: "", visible: false };
    return { content: theme.fg("success", `🤖 ${ctx.model.name}`), visible: true };
  },
};

const branchSegment: StatusLineSegment = {
  id: "branch",
  render(ctx, theme) {
    if (!ctx.branch) return { content: "", visible: false };
    return { content: theme.fg("warning", ` ${ctx.branch}`), visible: true };
  },
};

const sessionSegment: StatusLineSegment = {
  id: "session",
  render(ctx, theme) {
    if (!ctx.sessionId) return { content: "", visible: false };
    return { content: theme.fg("accent", `sid:${ctx.sessionId.slice(0, 8)}`), visible: true };
  },
};

const tokenSegment: StatusLineSegment = {
  id: "tokens",
  render(ctx, theme) {
    if (!ctx.tokens) return { content: "", visible: false };
    return { content: theme.fg("muted", `⧖ ${ctx.tokens}`), visible: true };
  },
};

const SEGMENTS: Record<string, StatusLineSegment> = {
  model: modelSegment,
  branch: branchSegment,
  session: sessionSegment,
  tokens: tokenSegment,
};

function renderSegment(id: keyof typeof SEGMENTS, ctx: SegmentContext, theme: Theme): RenderedSegment {
  return SEGMENTS[id].render(ctx, theme);
}

function compose(parts: string[], theme: Theme): string {
  if (parts.length === 0) return "";
  const sep = theme.fg("dim", " ┃ ");
  return ` ${theme.fg("dim", "▐")} ` + parts.join(sep);
}

export default function powerlineSegmentExample(pi: ExtensionAPI) {
  pi.registerCommand("powerline-demo", {
    description: "Preview custom powerline segments",
    handler: async (_args, ctx: ExtensionContext) => {
      ctx.ui.setFooter((_tui, theme, footerData: ReadonlyFooterDataProvider) => {
        return {
          invalidate() {},
          dispose: footerData.onBranchChange(() => _tui.requestRender()),
          render(width: number): string[] {
            const ctx: SegmentContext = {
              model: { name: "gpt-4.1" },
              branch: "main",
              sessionId: footerData.getSessionId?.(),
              tokens: 1234,
            };

            const ids: Array<keyof typeof SEGMENTS> = ["model", "branch", "session", "tokens"];
            const visible = ids
              .map((id) => renderSegment(id, ctx, theme))
              .filter((seg) => seg.visible && seg.content);

            const line = compose(visible.map((seg) => seg.content), theme);
            return line ? [truncateToWidth(line, width)] : [];
          },
        };
      });
    },
  });
}
```

**Design notes**: This stays close to Nico's model: each segment is independent, each returns `{content, visible}`, footer only joins rendered segments.

## Render Helper Library

Core helpers from `pi-subagents/render-helpers.ts` as a utility module.

```typescript
import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

export function pad(s: string, len: number): string {
  const vis = visibleWidth(s);
  return s + " ".repeat(Math.max(0, len - vis));
}

export function row(content: string, width: number, theme: Theme): string {
  const innerW = width - 2;
  return theme.fg("border", "│") + pad(" " + content, innerW) + theme.fg("border", "│");
}

export function renderHeader(text: string, width: number, theme: Theme): string {
  const innerW = width - 2;
  const padLen = Math.max(0, innerW - visibleWidth(text));
  const left = Math.floor(padLen / 2);
  const right = padLen - left;
  return (
    theme.fg("border", "╭" + "─".repeat(left)) +
    theme.fg("accent", text) +
    theme.fg("border", "─".repeat(right) + "╮")
  );
}

export function renderFooter(text: string, width: number, theme: Theme): string {
  const innerW = width - 2;
  const padLen = Math.max(0, innerW - visibleWidth(text));
  const left = Math.floor(padLen / 2);
  const right = padLen - left;
  return (
    theme.fg("border", "╰" + "─".repeat(left)) +
    theme.fg("dim", text) +
    theme.fg("border", "─".repeat(right) + "╯")
  );
}

export function fuzzyFilter<T extends { name: string; description: string }>(items: T[], query: string): T[] {
  const q = query.trim();
  if (!q) return items;
  const fuzzyScore = (text: string) => {
    const lower = text.toLowerCase();
    if (lower.includes(q.toLowerCase())) return 1;
    return 0;
  };
  return items
    .map((item) => ({ item, score: Math.max(fuzzyScore(item.name), fuzzyScore(item.description)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

export function formatPath(filePath: string): string {
  const home = process.env.HOME;
  return home && filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

export function formatScrollInfo(above: number, below: number): string {
  const up = above > 0 ? `↑ ${above} more` : "";
  const down = below > 0 ? `${up ? "  " : ""}↓ ${below} more` : "";
  return up + down;
}
```

**Design notes**: Centralizing these helpers gives you predictable width math, readable borders, and faster iteration across overlays.
