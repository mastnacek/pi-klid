/**
 * pi-klid — SPAI kanban board for quiet mode.
 *
 * Visual twin of pi-spai's `/spai board` (`src/kanban.ts` + `src/viewer.ts`):
 * same Linkarzu truecolor palette, same frames, status ribbon, column badges
 * and selection highlight. Shown as a working view while the agent runs, so a
 * long run can be spent moving real tasks instead of watching output.
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
  type SpaiIndex,
  type SpaiIndexEntry,
  type SpaiStatus,
} from "./spai.js";
import {
  coralGlow,
  cyanGlow,
  defaultBold,
  dividerGlow,
  getStatusCounts,
  goldGlow,
  greenGlow,
  pinkGlow,
  renderSpaiRibbon,
  slateGlow,
  violetGlow,
} from "./palette.js";

interface KanbanColumn {
  status: SpaiStatus;
  label: string;
  glyph: string;
  shortcut: string;
  colorFn: (text: string) => string;
  bgColorAnsi: string;
}

const COLUMNS: KanbanColumn[] = [
  {
    status: "todo",
    label: "TODO",
    glyph: "○",
    shortcut: "1",
    colorFn: pinkGlow,
    bgColorAnsi: "\x1b[48;2;249;77;255m\x1b[38;2;13;17;22m",
  },
  {
    status: "working",
    label: "WORKING",
    glyph: "◐",
    shortcut: "2",
    colorFn: goldGlow,
    bgColorAnsi: "\x1b[48;2;241;252;121m\x1b[38;2;13;17;22m",
  },
  {
    status: "waiting",
    label: "WAITING",
    glyph: "⏳",
    shortcut: "3",
    colorFn: violetGlow,
    bgColorAnsi: "\x1b[48;2;152;122;251m\x1b[38;2;13;17;22m",
  },
  {
    status: "done",
    label: "DONE",
    glyph: "✓",
    shortcut: "4",
    colorFn: greenGlow,
    bgColorAnsi: "\x1b[48;2;55;244;153m\x1b[38;2;13;17;22m",
  },
  {
    status: "cancelled",
    label: "CANCELLED",
    glyph: "✗",
    shortcut: "5",
    colorFn: slateGlow,
    bgColorAnsi: "\x1b[48;2;95;107;138m\x1b[38;2;255;255;255m",
  },
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

// Same breakpoint as pi-spai's board: below 75 columns it switches from the
// five-column grid to a single focused column with status tabs.
const WIDE_MIN = 75;

function colBadge(status: SpaiStatus): string {
  const col = COLUMNS.find((c) => c.status === status);
  if (!col) return status;
  return col.colorFn(`[${col.glyph} ${col.label}]`);
}

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
  cwd: string;
  close: () => void;
  /** Rows available to the overlay (transcript region height). */
  height: () => number;
}

export class KanbanBoard implements Component {
  private tui: TUI;
  private cwd: string;
  private close: () => void;
  private height: () => number;

  private index: SpaiIndex = { version: 1, lastUpdated: "", records: [] };
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
      this.index = loadIndex(this.cwd);
    } catch {
      this.index = { version: 1, lastUpdated: "", records: [] };
      this.notice = "index read failed";
    }
    this.clampAll();
  }

  private columnTasks(status: SpaiStatus): SpaiIndexEntry[] {
    return this.index.records.filter((r) => r.type === "Todo" && r.status === status);
  }

  private focusedColumn(): KanbanColumn {
    return COLUMNS[this.focusCol] ?? COLUMNS[0]!;
  }

  private selectedEntry(): SpaiIndexEntry | null {
    const col = this.focusedColumn();
    return this.columnTasks(col.status)[this.selected[this.focusCol] ?? 0] ?? null;
  }

  private clampAll(): void {
    COLUMNS.forEach((col, idx) => {
      const len = this.columnTasks(col.status).length;
      const cur = this.selected[idx] ?? 0;
      this.selected[idx] = len === 0 ? 0 : Math.max(0, Math.min(len - 1, cur));
    });
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
      this.selected[this.focusCol] = Math.min(
        Math.max(0, len - 1),
        (this.selected[this.focusCol] ?? 0) + 1,
      );
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
      this.notice = `index reloaded (${this.index.records.length} items)`;
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
    const W = Math.max(24, width);
    const H = Math.max(8, this.height());

    if (this.mode === "detail") return this.pad(this.renderDetail(W, H), W, H);

    const lines = W >= WIDE_MIN ? this.renderWide(W, H) : this.renderNarrow(W, H);

    if (this.mode === "add") {
      const parsed = parseSpai(this.addBuf);
      lines.push(dividerGlow("─".repeat(W)));
      lines.push(
        `${violetGlow(`${parsed.type}/${parsed.status}`)}  new> ${this.addBuf}${pinkGlow("▌")}`,
      );
      lines.push(
        dividerGlow("prefix: . todo · / working · ? idea · - note · !priority @deadline :tags:"),
      );
      lines.push(cyanGlow("enter") + dividerGlow(" save · ") + cyanGlow("esc") + dividerGlow(" cancel"));
    } else if (this.notice) {
      lines.push(violetGlow(this.notice));
    }

    return this.pad(lines, W, H);
  }

  private pad(lines: string[], width: number, height: number): string[] {
    const out = lines.slice(0, height).map((l) => padToWidth(l, width));
    while (out.length < height) out.push(" ".repeat(width));
    return out;
  }

  private banner(innerWidth: number, wide: boolean): string {
    const counts = getStatusCounts(this.index);
    const active = counts.todo + counts.working;
    const extra =
      counts.ideas > 0 || counts.notes > 0 ? ` (${counts.totalItems} total)` : "";
    const title = defaultBold(pinkGlow(" ◈ SPAI KANBAN BOARD ◈"));
    const stats = `${goldGlow(`⚡ ${active} active`)}  ${greenGlow(`✓ ${counts.done} done`)}  ${violetGlow(`Σ ${counts.totalTasks} tasks${extra}`)} `;
    const gap = Math.max(1, innerWidth - visibleWidth(title) - visibleWidth(stats));
    const line = clip(`${title}${" ".repeat(gap)}${stats}`, innerWidth);
    return wide ? line : clip(`${title}  ${stats}`, innerWidth);
  }

  private hints(innerWidth: number, wide: boolean): string {
    const key = (k: string) => cyanGlow(k);
    const text = wide
      ? `  ${key("←→")}: column  ${key("↑↓")}: task  ${key("1-5")}: status  ${key("space")}: move  ${key("x")}: done  ${key("n")}: new  ${key("enter")}: detail  ${key("r")}: reload  ${key("esc")}: close`
      : `  ${key("←→")}: column  ${key("↑↓")}: task  ${key("1-5")}: status  ${key("n")}: new  ${key("esc")}: close`;
    return clip(text, innerWidth);
  }

  private renderWide(width: number, height: number): string[] {
    const W = width;
    const inner = W - 2;
    const rows = Math.max(3, Math.min(10, height - 9));
    const numCols = COLUMNS.length;
    const available = Math.max(numCols, inner - (numCols - 1));
    const base = Math.floor(available / numCols);
    const rem = available % numCols;
    const widths = COLUMNS.map((_, i) => base + (i < rem ? 1 : 0));

    const lines: string[] = [];
    lines.push(dividerGlow(`╭${"─".repeat(inner)}╮`));
    lines.push(dividerGlow("│") + padToWidth(this.banner(inner, true), inner) + dividerGlow("│"));
    lines.push(
      dividerGlow("│") +
        padToWidth(` ${renderSpaiRibbon(getStatusCounts(this.index), Math.max(10, inner - 14))}`, inner) +
        dividerGlow("│"),
    );
    lines.push(dividerGlow("│") + padToWidth(this.hints(inner, true), inner) + dividerGlow("│"));
    lines.push(dividerGlow(`├${widths.map((w) => "─".repeat(w)).join("┬")}┤`));

    const headers = COLUMNS.map((col, i) => {
      const w = widths[i] ?? 16;
      const title = `${col.glyph} ${col.label} [${col.shortcut}] (${this.columnTasks(col.status).length})`;
      const text =
        i === this.focusCol
          ? defaultBold(col.colorFn(` ▶ ${title}`))
          : col.colorFn(`   ${title}`);
      return padToWidth(text, w);
    });
    lines.push(dividerGlow("│") + headers.join(dividerGlow("│")) + dividerGlow("│"));
    lines.push(dividerGlow(`├${widths.map((w) => "─".repeat(w)).join("┼")}┤`));

    for (let r = 0; r < rows; r++) {
      const cells: string[] = [];
      COLUMNS.forEach((col, i) => {
        const w = widths[i] ?? 16;
        const tasks = this.columnTasks(col.status);
        const task = tasks[r];
        const isSelected = i === this.focusCol && (this.selected[i] ?? 0) === r;

        if (task) {
          const id = task.id.replace(/^SPAI-0*/i, "#");
          const prio = task.priority === "high" ? "⚡" : "";
          const avail = Math.max(8, w - 3);
          const raw = `${id} ${task.title}${prio ? ` ${prio}` : ""}`;
          const truncated = truncateToWidth(raw, avail, "…");
          let cell: string;
          if (isSelected) {
            cell = ` ▸${col.bgColorAnsi} \x1b[1m${truncated}\x1b[0m`;
          } else {
            const title = task.title.slice(0, Math.max(4, avail - id.length - 1));
            const styledPrio = prio ? coralGlow(` ${prio}`) : "";
            cell = `   ${col.colorFn(id)} ${title}${styledPrio}`;
          }
          cells.push(padToWidth(cell, w));
        } else if (r === 0 && tasks.length === 0) {
          const empty =
            i === this.focusCol ? col.colorFn("   · empty ·") : dividerGlow("   · — ·");
          cells.push(padToWidth(empty, w));
        } else {
          cells.push(" ".repeat(w));
        }
      });
      lines.push(dividerGlow("│") + cells.join(dividerGlow("│")) + dividerGlow("│"));
    }

    lines.push(dividerGlow(`├${widths.map((w) => "─".repeat(w)).join("┴")}┤`));
    lines.push(dividerGlow("│") + padToWidth(this.inspector(inner), inner) + dividerGlow("│"));
    lines.push(dividerGlow(`╰${"─".repeat(inner)}╯`));
    return lines;
  }

  private renderNarrow(width: number, height: number): string[] {
    const W = width;
    const inner = W - 2;
    const rows = Math.max(3, Math.min(10, height - 9));
    const lines: string[] = [];

    lines.push(dividerGlow(`╭${"─".repeat(inner)}╮`));
    lines.push(dividerGlow("│") + padToWidth(this.banner(inner, false), inner) + dividerGlow("│"));

    const tabs = COLUMNS.map((col, i) => {
      const label = `${col.shortcut} ${col.glyph}`;
      const count = this.columnTasks(col.status).length;
      if (i === this.focusCol) {
        return `${col.bgColorAnsi} \x1b[1m▶ ${label} (${count}) ◀\x1b[0m`;
      }
      return col.colorFn(`[${label}:${count}]`);
    }).join(" ");
    lines.push(dividerGlow("│") + padToWidth(` ${tabs}`, inner) + dividerGlow("│"));

    lines.push(
      dividerGlow("│") +
        padToWidth(` ${renderSpaiRibbon(getStatusCounts(this.index), Math.max(10, inner - 14))}`, inner) +
        dividerGlow("│"),
    );
    lines.push(dividerGlow(`├${"─".repeat(inner)}┤`));

    const col = this.focusedColumn();
    const tasks = this.columnTasks(col.status);
    const sel = this.selected[this.focusCol] ?? 0;
    lines.push(
      dividerGlow("│") +
        padToWidth(
          defaultBold(
            col.colorFn(
              `  ${col.glyph} ${col.label} [${col.shortcut}] — ${tasks.length} task(s) (←/→ to switch)`,
            ),
          ),
          inner,
        ) +
        dividerGlow("│"),
    );
    lines.push(dividerGlow(`├${"─".repeat(inner)}┤`));

    const start = Math.max(0, Math.min(Math.max(0, tasks.length - rows), sel - Math.floor(rows / 2)));
    for (let r = 0; r < rows; r++) {
      const task = tasks[start + r];
      if (!task) {
        const empty =
          r === 0 && tasks.length === 0
            ? dividerGlow("   · empty · (press [n] for a new task)")
            : " ".repeat(inner);
        lines.push(dividerGlow("│") + padToWidth(empty, inner) + dividerGlow("│"));
        continue;
      }
      const isSelected = start + r === sel;
      const id = task.id.replace(/^SPAI-0*/i, "#");
      const prioStyled =
        task.priority === "high"
          ? coralGlow(" ⚡")
          : task.priority === "low"
            ? slateGlow(" ▽")
            : "";
      const deadStyled = task.deadline ? goldGlow(` ⏰${task.deadline}`) : "";
      const tagsStyled = task.tags.length > 0 ? violetGlow(` :${task.tags.join(":")}:`) : "";
      const meta = `${prioStyled}${deadStyled}${tagsStyled}`;
      const metaW = visibleWidth(`${prioStyled ? " ⚡" : ""}${task.deadline ? ` ⏰${task.deadline}` : ""}${task.tags.length > 0 ? ` :${task.tags.join(":")}:` : ""}`);
      const avail = Math.max(8, inner - 4);
      const titleW = Math.max(4, avail - id.length - metaW - 1);
      const title = clip(task.title, titleW);
      let cell: string;
      if (isSelected) {
        cell = ` ▸${col.bgColorAnsi} \x1b[1m${clip(`${id} ${title}`, avail)}${meta}\x1b[0m`;
      } else {
        cell = `   ${col.colorFn(id)} ${title}${meta}`;
      }
      lines.push(dividerGlow("│") + padToWidth(cell, inner) + dividerGlow("│"));
    }

    lines.push(dividerGlow(`├${"─".repeat(inner)}┤`));
    lines.push(dividerGlow("│") + padToWidth(this.inspector(inner), inner) + dividerGlow("│"));
    lines.push(dividerGlow("│") + padToWidth(this.hints(inner, false), inner) + dividerGlow("│"));
    lines.push(dividerGlow(`╰${"─".repeat(inner)}╯`));
    return lines;
  }

  private inspector(width: number): string {
    const entry = this.selectedEntry();
    if (!entry) {
      const col = this.focusedColumn();
      return violetGlow(`   Column ${col.label} is empty — press [n] for a new task.`);
    }
    const prio =
      entry.priority === "high"
        ? coralGlow(" ⚡ HIGH")
        : entry.priority === "low"
          ? slateGlow(" ▽ LOW")
          : "";
    const dead = entry.deadline ? goldGlow(` ⏰ ${entry.deadline}`) : "";
    const tags = entry.tags.length > 0 ? violetGlow(` :${entry.tags.join(":")}:`) : "";
    return clip(
      ` ▶ ${pinkGlow(entry.id)} ${defaultBold(entry.title)} ${colBadge(entry.status)}${prio}${dead}${tags}`,
      width,
    );
  }

  private renderDetail(width: number, height: number): string[] {
    const inner = width - 2;
    const bodyRows = Math.max(3, height - 6);
    const lines: string[] = [];
    lines.push(dividerGlow(`╭${"─".repeat(inner)}╮`));
    lines.push(
      dividerGlow("│") +
        padToWidth(defaultBold(pinkGlow(clip(` ◈ ${this.detailTitle}`, inner))), inner) +
        dividerGlow("│"),
    );
    lines.push(dividerGlow(`├${"─".repeat(inner)}┤`));

    const wrapped = wrapText(this.detailBody, Math.max(10, inner - 2));
    const start = Math.max(0, Math.min(Math.max(0, wrapped.length - bodyRows), this.detailOffset));
    for (let r = 0; r < bodyRows; r++) {
      lines.push(
        dividerGlow("│") +
          padToWidth(` ${wrapped[start + r] ?? ""}`, inner) +
          dividerGlow("│"),
      );
    }

    lines.push(dividerGlow(`├${"─".repeat(inner)}┤`));
    lines.push(
      dividerGlow("│") +
        padToWidth(
          `  ${cyanGlow("↑↓")}: scroll  ${cyanGlow("esc")}: back  ${dividerGlow(`(${Math.min(wrapped.length, start + bodyRows)}/${wrapped.length})`)}`,
          inner,
        ) +
        dividerGlow("│"),
    );
    lines.push(dividerGlow(`╰${"─".repeat(inner)}╯`));
    return lines;
  }
}
