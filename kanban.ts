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
 *
 * Rendering lives in `src/kanban-render.ts`; this module owns the data, the
 * mutations and the input handling.
 */
import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  loadIndex,
  parseSpai,
  readRecordBody,
  saveRecord,
  updateRecordStatus,
  type SpaiStatus,
} from "./spai.js";
import { cyanGlow, dividerGlow, pinkGlow, violetGlow } from "./palette.js";
import { KanbanBoardRenderer, wrapText } from "./src/kanban-render.js";
import { COLUMNS, DIRECT_STATUS, WIDE_MIN } from "./src/kanban-model.js";

export interface KanbanBoardOptions {
  tui: TUI;
  cwd: string;
  close: () => void;
  /** Rows available to the overlay (transcript region height). */
  height: () => number;
}

export class KanbanBoard extends KanbanBoardRenderer implements Component {
  private tui: TUI;
  private cwd: string;
  private close: () => void;
  private height: () => number;

  constructor(opts: KanbanBoardOptions) {
    super();
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
}
