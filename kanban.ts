/**
 * pi-klid — SPAI kanban board for quiet mode.
 *
 * A five-column board (todo / working / waiting / done / cancelled) over the
 * same SPAI ledger pi-spai uses: `docs/spai/.index.json` +
 * `YYYY-MM-DD-SPAI-NNN-*.md`. Shown as a working view while the agent runs,
 * so a long run can be spent moving real tasks instead of watching output.
 *
 * Keys:
 *   ←/→  h/l    focus column
 *   ↑/↓  k/j    move inside column
 *   space/tab   push task one column right
 *   ⌫    [      pull task one column left
 *   1-5         send task straight to a status (t/w/p/d/c/z aliases)
 *   x           toggle done
 *   n           new item (SPAI syntax)
 *   enter       open detail
 *   r           reload index from disk
 *   esc  q      close
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  loadIndex,
  parseSpai,
  readRecordBody,
  saveRecord,
  updateRecordStatus,
  type SpaiIndexEntry,
  type SpaiStatus,
} from "./spai.js";

interface KanbanColumn {
  status: SpaiStatus;
  label: string;
  glyph: string;
  shortcut: string;
  color: ThemeColor;
}

const COLUMNS: KanbanColumn[] = [
  { status: "todo", label: "TODO", glyph: "○", shortcut: "1", color: "accent" },
  { status: "working", label: "WORKING", glyph: "◐", shortcut: "2", color: "warning" },
  { status: "waiting", label: "WAITING", glyph: "⏳", shortcut: "3", color: "borderAccent" },
  { status: "done", label: "DONE", glyph: "✓", shortcut: "4", color: "success" },
  { status: "cancelled", label: "CANCELLED", glyph: "✗", shortcut: "5", color: "muted" },
];

const DIRECT_STATUS: Record<string, SpaiStatus> = {
  "1": "todo",
  t: "todo",
  "2": "working",
  w: "working",
  "3": "waiting",
  p: "waiting",
  "4": "done",
  d: "done",
  "5": "cancelled",
  c: "cancelled",
  z: "cancelled",
};

const WIDE_MIN = 84;

function padToWidth(text: string, width: number): string {
  const v = visibleWidth(text);
  if (v >= width) return truncateToWidth(text, width, "…");
  return text + " ".repeat(width - v);
}

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "…");
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  const w = Math.max(8, width);
  for (const para of text.split("\n")) {
    if (para.trim().length === 0) {
      out.push("");
      continue;
    }
    let cur = "";
    let curLen = 0;
    for (const word of para.split(/(\s+)/)) {
      const l = visibleWidth(word);
      if (curLen + l > w && cur.length > 0) {
        out.push(cur);
        cur = "";
        curLen = 0;
      }
      cur += word;
      curLen += l;
    }
    if (cur) out.push(cur);
  }
  return out;
}

export interface KanbanBoardOptions {
  tui: TUI;
  theme: Theme;
  cwd: string;
  close: () => void;
  /** Rows available to the overlay (transcript region height). */
  height: () => number;
}

export class KanbanBoard implements Component {
  private tui: TUI;
  private theme: Theme;
  private cwd: string;
  private close: () => void;
  private height: () => number;

  private items: SpaiIndexEntry[] = [];
  private focusCol = 0;
  private selected: number[] = COLUMNS.map(() => 0);
  private mode: "browse" | "add" | "detail" = "browse";
  private addBuf = "";
  private detailTitle = "";
  private detailBody = "";
  private detailOffset = 0;
  private notice = "";

  constructor(opts: KanbanBoardOptions) {
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.cwd = opts.cwd;
    this.close = opts.close;
    this.height = opts.height;
    this.reload();
  }

  invalidate(): void {}

  dispose(): void {}

  // -- data ----------------------------------------------------------------

  private reload(): void {
    try {
      this.items = loadIndex(this.cwd).records;
    } catch {
      this.items = [];
      this.notice = "index read failed";
    }
    this.clampAll();
  }

  private columnTasks(status: SpaiStatus): SpaiIndexEntry[] {
    return this.items.filter(
      (r) => r.type === "Todo" && r.status === status,
    );
  }

  private focusedColumn(): KanbanColumn {
    return COLUMNS[this.focusCol] ?? COLUMNS[0]!;
  }

  private selectedEntry(): SpaiIndexEntry | null {
    const col = this.focusedColumn();
    const tasks = this.columnTasks(col.status);
    return tasks[this.selected[this.focusCol] ?? 0] ?? null;
  }

  private clampAll(): void {
    COLUMNS.forEach((col, idx) => {
      const len = this.columnTasks(col.status).length;
      const cur = this.selected[idx] ?? 0;
      this.selected[idx] = len === 0 ? 0 : Math.max(0, Math.min(len - 1, cur));
    });
  }

  private counts(): { open: number; done: number; total: number } {
    const tasks = this.items.filter((r) => r.type === "Todo");
    return {
      open: tasks.filter((t) => t.status !== "done" && t.status !== "cancelled").length,
      done: tasks.filter((t) => t.status === "done").length,
      total: tasks.length,
    };
  }

  // -- mutations -----------------------------------------------------------

  private moveToStatus(status: SpaiStatus): void {
    const entry = this.selectedEntry();
    if (!entry || entry.status === status) return;
    const targetCol = COLUMNS.findIndex((c) => c.status === status);
    try {
      if (!updateRecordStatus(this.cwd, entry.id, status)) {
        this.notice = `${entry.id}: update failed`;
        return;
      }
    } catch (err) {
      this.notice = `update failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    const id = entry.id;
    this.reload();
    if (targetCol >= 0) {
      this.focusCol = targetCol;
      const idx = this.columnTasks(status).findIndex((t) => t.id === id);
      this.selected[targetCol] = idx >= 0 ? idx : 0;
    }
    this.notice = `${id} → ${status}`;
  }

  private step(direction: "left" | "right"): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    const targetIdx =
      direction === "left"
        ? (this.focusCol - 1 + COLUMNS.length) % COLUMNS.length
        : (this.focusCol + 1) % COLUMNS.length;
    const status = COLUMNS[targetIdx]?.status;
    if (status) this.moveToStatus(status);
  }

  private openDetail(): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    this.detailTitle = `${entry.id}: ${entry.title}`;
    this.detailBody = readRecordBody(this.cwd, entry);
    this.detailOffset = 0;
    this.mode = "detail";
  }

  // -- input ---------------------------------------------------------------

  private handleAdd(data: string): void {
    if (matchesKey(data, "escape")) {
      this.mode = "browse";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "return")) {
      const text = this.addBuf.trim();
      if (text) {
        try {
          const parsed = parseSpai(text);
          const saved = saveRecord(this.cwd, text);
          this.reload();
          const colIdx = COLUMNS.findIndex((c) => c.status === parsed.status);
          if (colIdx >= 0) {
            this.focusCol = colIdx;
            const idx = this.columnTasks(parsed.status).findIndex((t) => t.id === saved.id);
            this.selected[colIdx] = idx >= 0 ? idx : 0;
          }
          this.notice = `saved ${saved.id}: ${saved.title}`;
        } catch (err) {
          this.notice = `save failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      this.mode = "browse";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.addBuf = this.addBuf.slice(0, -1);
      this.tui.requestRender();
      return;
    }
    if (data.length >= 1 && data.charCodeAt(0) >= 32) {
      this.addBuf += data;
      this.tui.requestRender();
    }
  }

  private handleDetail(data: string): void {
    const lines = wrapText(this.detailBody, 80);
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.mode = "browse";
    } else if (matchesKey(data, "down") || data === "j") {
      this.detailOffset = Math.min(Math.max(0, lines.length - 1), this.detailOffset + 1);
    } else if (matchesKey(data, "up") || data === "k") {
      this.detailOffset = Math.max(0, this.detailOffset - 1);
    }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.mode === "add") {
      this.handleAdd(data);
      return;
    }
    if (this.mode === "detail") {
      this.handleDetail(data);
      return;
    }

    const direct = DIRECT_STATUS[data];
    if (direct) {
      this.moveToStatus(direct);
    } else if (matchesKey(data, "left") || data === "h") {
      if (this.focusCol > 0) this.focusCol--;
    } else if (matchesKey(data, "right") || data === "l") {
      if (this.focusCol < COLUMNS.length - 1) this.focusCol++;
    } else if (matchesKey(data, "up") || data === "k") {
      this.selected[this.focusCol] = Math.max(0, (this.selected[this.focusCol] ?? 0) - 1);
    } else if (matchesKey(data, "down") || data === "j") {
      const len = this.columnTasks(this.focusedColumn().status).length;
      this.selected[this.focusCol] = Math.min(Math.max(0, len - 1), (this.selected[this.focusCol] ?? 0) + 1);
    } else if (data === "x") {
      const entry = this.selectedEntry();
      if (entry) this.moveToStatus(entry.status === "done" ? "todo" : "done");
    } else if (
      matchesKey(data, "space") ||
      matchesKey(data, "tab") ||
      data === "L" ||
      data === "]" ||
      data === ">" ||
      matchesKey(data, "shift+right") ||
      matchesKey(data, "shift+l")
    ) {
      this.step("right");
    } else if (
      matchesKey(data, "shift+tab") ||
      matchesKey(data, "backspace") ||
      data === "H" ||
      data === "[" ||
      data === "<" ||
      matchesKey(data, "shift+left") ||
      matchesKey(data, "shift+h")
    ) {
      this.step("left");
    } else if (data === "n" || data === "a") {
      this.mode = "add";
      this.addBuf = "";
      this.notice = "";
      this.tui.requestRender();
      return;
    } else if (data === "r") {
      this.reload();
      this.notice = `index reloaded (${this.items.length} items)`;
    } else if (matchesKey(data, "return")) {
      this.openDetail();
      return;
    } else if (matchesKey(data, "escape") || data === "q") {
      this.close();
      return;
    }
    this.clampAll();
    this.tui.requestRender();
  }

  // -- render --------------------------------------------------------------

  render(width: number): string[] {
    const th = this.theme;
    const W = Math.max(24, width);
    const H = Math.max(8, this.height());

    if (this.mode === "detail") {
      return this.pad(this.renderDetail(W, H), W, H);
    }

    const lines = W >= WIDE_MIN ? this.renderWide(W, H) : this.renderNarrow(W, H);
    if (this.mode === "add") {
      const parsed = parseSpai(this.addBuf);
      lines.push(th.fg("dim", "─".repeat(W)));
      lines.push(
        th.fg("muted", `${parsed.type}/${parsed.status}`) +
          `  new> ${this.addBuf}${th.fg("accent", "▌")}`,
      );
      lines.push(
        th.fg("dim", "prefix: . todo · / working · ? idea · - note · !priority @deadline :tags:"),
      );
      lines.push(th.fg("dim", "enter save · esc cancel"));
    } else if (this.notice) {
      lines.push(th.fg("muted", this.notice));
    }

    return this.pad(lines, W, H);
  }

  private pad(lines: string[], width: number, height: number): string[] {
    const out = lines.slice(0, height).map((l) => padToWidth(l, width));
    while (out.length < height) out.push(" ".repeat(width));
    return out;
  }

  private border(text: string): string {
    return this.theme.fg("border", text);
  }

  private colColor(col: KanbanColumn, text: string): string {
    return this.theme.fg(col.color, text);
  }

  private headerLines(width: number, wide: boolean): string[] {
    const th = this.theme;
    const c = this.counts();
    const title = th.bold(this.colColor(COLUMNS[0]!, "◈ SPAI KANBAN ◈"));
    const stats = `${th.fg("warning", `⚡${c.open}`)} ${th.fg("success", `✓${c.done}`)} ${th.fg("muted", `Σ${c.total}`)}`;
    const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(stats));
    const line = clip(`${title}${" ".repeat(gap)}${stats}`, width);
    const hints = wide
      ? "←→ column · ↑↓ task · space/⌫ move · 1-5 status · x done · n new · enter detail · r reload · esc close"
      : "←→ column · ↑↓ task · space/⌫ move · 1-5 status · n new · enter · esc";
    return [padToWidth(line, width), th.fg("dim", clip(hints, width))];
  }

  private renderWide(width: number, height: number): string[] {
    const th = this.theme;
    const W = width;
    const rows = Math.max(3, Math.min(14, height - 10));
    const numCols = COLUMNS.length;
    const inner = W - 2;
    const available = Math.max(numCols, inner - (numCols - 1));
    const base = Math.floor(available / numCols);
    const rem = available % numCols;
    const widths = COLUMNS.map((_, i) => base + (i < rem ? 1 : 0));

    const lines: string[] = [];
    lines.push(this.border(`╭${"─".repeat(inner)}╮`));
    for (const l of this.headerLines(inner, true)) {
      lines.push(this.border("│") + padToWidth(l, inner) + this.border("│"));
    }
    lines.push(this.border(`├${widths.map((w) => "─".repeat(w)).join("┬")}┤`));

    const headerSegments = COLUMNS.map((col, i) => {
      const w = widths[i] ?? 16;
      const focused = i === this.focusCol;
      const text = `${col.glyph} ${col.label} [${col.shortcut}] (${this.columnTasks(col.status).length})`;
      const styled = focused
        ? th.bold(this.colColor(col, ` ▶ ${text}`))
        : this.colColor(col, `   ${text}`);
      return padToWidth(styled, w);
    });
    lines.push(this.border("│") + headerSegments.join(this.border("│")) + this.border("│"));
    lines.push(this.border(`├${widths.map((w) => "─".repeat(w)).join("┼")}┤`));

    for (let r = 0; r < rows; r++) {
      const segments: string[] = [];
      COLUMNS.forEach((col, i) => {
        const w = widths[i] ?? 16;
        const tasks = this.columnTasks(col.status);
        const task = tasks[r];
        const isSelected = i === this.focusCol && (this.selected[i] ?? 0) === r;
        if (task) {
          const id = task.id.replace(/^SPAI-0*/i, "#");
          const avail = Math.max(6, w - 4);
          const prio = task.priority === "high" ? " !" : task.priority === "low" ? " ▽" : "";
          const title = clip(task.title, Math.max(4, avail - id.length - prio.length - 2));
          const body = `${id} ${title}${prio}`;
          const cell = isSelected
            ? ` ${th.bg("selectedBg", th.bold(padToWidth(clip(`▸ ${body}`, w - 1), w - 2)))} `
            : ` ${this.colColor(col, id)} ${title}${prio ? th.fg("warning", prio) : ""}`;
          segments.push(padToWidth(cell, w));
        } else if (r === 0 && tasks.length === 0) {
          const empty = i === this.focusCol ? this.colColor(col, " · empty ·") : th.fg("dim", " · — ·");
          segments.push(padToWidth(empty, w));
        } else {
          segments.push(" ".repeat(w));
        }
      });
      lines.push(this.border("│") + segments.join(this.border("│")) + this.border("│"));
    }

    lines.push(this.border(`├${widths.map((w) => "─".repeat(w)).join("┴")}┤`));
    lines.push(this.border("│") + padToWidth(this.inspector(inner), inner) + this.border("│"));
    lines.push(this.border(`╰${"─".repeat(inner)}╯`));
    return lines;
  }

  private renderNarrow(width: number, height: number): string[] {
    const th = this.theme;
    const W = width;
    const rows = Math.max(3, Math.min(14, height - 9));
    const inner = W - 2;
    const lines: string[] = [];

    lines.push(this.border(`╭${"─".repeat(inner)}╮`));
    for (const l of this.headerLines(inner, false)) {
      lines.push(this.border("│") + padToWidth(l, inner) + this.border("│"));
    }

    const tabs = COLUMNS.map((col, i) => {
      const count = this.columnTasks(col.status).length;
      const label = `${col.glyph}${count}`;
      return i === this.focusCol
        ? th.bg("selectedBg", th.bold(this.colColor(col, ` ▶${label}◀ `)))
        : this.colColor(col, ` ${label} `);
    }).join(th.fg("dim", "│"));
    lines.push(this.border("│") + padToWidth(` ${tabs}`, inner) + this.border("│"));
    lines.push(this.border(`├${"─".repeat(inner)}┤`));

    const col = this.focusedColumn();
    const tasks = this.columnTasks(col.status);
    const sel = this.selected[this.focusCol] ?? 0;
    const start = Math.max(0, Math.min(Math.max(0, tasks.length - rows), sel - Math.floor(rows / 2)));
    for (let r = 0; r < rows; r++) {
      const task = tasks[start + r];
      if (!task) {
        lines.push(this.border("│") + " ".repeat(inner) + this.border("│"));
        continue;
      }
      const isSelected = start + r === sel;
      const id = task.id.replace(/^SPAI-0*/i, "#");
      const prio = task.priority === "high" ? " !" : task.priority === "low" ? " ▽" : "";
      const dead = task.deadline ? ` @${task.deadline}` : "";
      const meta = `${prio}${dead}`;
      const title = clip(task.title, Math.max(4, inner - id.length - visibleWidth(meta) - 6));
      const body = `${id} ${title}`;
      const cell = isSelected
        ? ` ${th.bg("selectedBg", th.bold(padToWidth(clip(`▸ ${body}${meta}`, inner - 2), inner - 2)))} `
        : `   ${this.colColor(col, id)} ${title}${meta ? th.fg("warning", meta) : ""}`;
      lines.push(this.border("│") + padToWidth(cell, inner) + this.border("│"));
    }

    if (tasks.length === 0) {
      lines.push(
        this.border("│") +
          padToWidth(th.fg("dim", `  ${col.label}: no tasks — press n to add one`), inner) +
          this.border("│"),
      );
    }

    lines.push(this.border(`├${"─".repeat(inner)}┤`));
    lines.push(this.border("│") + padToWidth(this.inspector(inner), inner) + this.border("│"));
    lines.push(this.border(`╰${"─".repeat(inner)}╯`));
    return lines;
  }

  private inspector(width: number): string {
    const th = this.theme;
    const entry = this.selectedEntry();
    if (!entry) {
      const col = this.focusedColumn();
      return th.fg("dim", ` ${col.label} is empty — [n] new task`);
    }
    const id = this.colColor(this.focusedColumn(), entry.id);
    const title = th.bold(clip(entry.title, Math.max(8, width - entry.id.length - 24)));
    const prio = entry.priority === "high" ? th.fg("warning", " !high") : entry.priority === "low" ? th.fg("dim", " ▽low") : "";
    const dead = entry.deadline ? th.fg("muted", ` @${entry.deadline}`) : "";
    const tags = entry.tags.length > 0 ? th.fg("muted", ` :${entry.tags.join(":")}:`) : "";
    return clip(` ▶ ${id} ${title}${prio}${dead}${tags}`, width);
  }

  private renderDetail(width: number, height: number): string[] {
    const th = this.theme;
    const inner = width - 2;
    const bodyRows = Math.max(3, height - 6);
    const lines: string[] = [];
    lines.push(this.border(`╭${"─".repeat(inner)}╮`));
    lines.push(this.border("│") + padToWidth(th.bold(clip(` ${this.detailTitle}`, inner)), inner) + this.border("│"));
    lines.push(this.border(`├${"─".repeat(inner)}┤`));

    const wrapped = wrapText(this.detailBody, Math.max(10, inner - 2));
    const start = Math.max(0, Math.min(Math.max(0, wrapped.length - bodyRows), this.detailOffset));
    for (let r = 0; r < bodyRows; r++) {
      const line = wrapped[start + r] ?? "";
      lines.push(this.border("│") + padToWidth(` ${line}`, inner) + this.border("│"));
    }

    lines.push(this.border(`├${"─".repeat(inner)}┤`));
    lines.push(
      this.border("│") +
        padToWidth(th.fg("dim", ` ↑↓ scroll · esc back  (${Math.min(wrapped.length, start + bodyRows)}/${wrapped.length})`), inner) +
        this.border("│"),
    );
    lines.push(this.border(`╰${"─".repeat(inner)}╯`));
    return lines;
  }
}
