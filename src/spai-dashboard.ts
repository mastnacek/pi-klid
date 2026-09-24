import { type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { klid } from "./state.js";
import { cycleStatus, loadIndex, parseSpai, readRecordBody, saveRecord, updateRecordStatus, type SpaiIndexEntry, type SpaiStatus } from "../spai.js";

// ---------------------------------------------------------------------------
// SPAI dashboard overlay (interactive; shown instead of the cover while working)
// ---------------------------------------------------------------------------

export const SPAI_GLYPH: Record<string, string> = {
  todo: "○",
  working: "◐",
  waiting: "⏳",
  done: "✓",
  cancelled: "✗",
  idea: "💡",
  note: "•",
  inbox: "•",
};

export function spaiStatusColor(s: SpaiStatus): "accent" | "dim" | "muted" | "text" | "warning" {
  switch (s) {
    case "working":
      return "accent";
    case "waiting":
      return "warning";
    case "idea":
      return "warning";
    case "done":
    case "cancelled":
    case "note":
      return "dim";
    case "inbox":
      return "muted";
    default:
      return "text";
  }
}

export function wrapText(text: string, w: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      out.push("");
      continue;
    }
    let cur = "";
    let curLen = 0;
    for (const word of para.split(/(\s+)/)) {
      const l = word.length;
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

/**
 * Interactive SPAI backlog dashboard. Loads every SPAI task/idea/note from the
 * project's docs/spai ledger and lets the user browse it, add new items, cycle
 * statuses, and read full details while the agent keeps working in the
 * background. Data is written back through the same SPAI file format pi-spai
 * uses, so anything recorded here shows up in /spai too.
 */
export class SpaiDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private cwd: string;
  private close: () => void;
  private items: SpaiIndexEntry[] = [];
  private selected = 0;
  private offset = 0;
  private mode: "browse" | "add" | "detail" = "browse";
  private addBuf = "";
  private detailTitle = "";
  private detailBody = "";
  private notice = "";

  constructor(tui: TUI, theme: Theme, cwd: string, close: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.cwd = cwd;
    this.close = close;
    this.reload();
  }

  // Called when the process re-renders after theme changes etc.
  invalidate(): void {}

  dispose(): void {}

  private reload(): void {
    try {
      const records = loadIndex(this.cwd).records;
      const rank = (s: SpaiStatus) => (s === "done" || s === "cancelled" ? 1 : 0);
      this.items = [...records].sort((a, b) => rank(a.status) - rank(b.status));
    } catch {
      this.items = [];
    }
    if (this.selected > Math.max(0, this.items.length - 1)) {
      this.selected = Math.max(0, this.items.length - 1);
    }
  }

  private move(delta: number): void {
    if (this.items.length === 0) return;
    this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + delta));
  }

  private toggleSelected(): void {
    const it = this.items[this.selected];
    if (!it) return;
    const next = cycleStatus(it.status, it.type);
    try {
      if (updateRecordStatus(this.cwd, it.id, next)) {
        this.notice = `${it.id} → ${next}`;
        this.reload();
      } else {
        this.notice = `${it.id}: update failed`;
      }
    } catch {
      this.notice = "update failed";
    }
  }

  private openDetail(): void {
    const it = this.items[this.selected];
    if (!it) return;
    this.detailTitle = `${it.id}: ${it.title}`;
    this.detailBody = readRecordBody(this.cwd, it);
    this.mode = "detail";
  }

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
          const saved = saveRecord(this.cwd, text);
          this.reload();
          const idx = this.items.findIndex((e) => e.id === saved.id);
          this.selected = idx >= 0 ? idx : this.selected;
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

  handleInput(data: string): void {
    if (this.mode === "add") {
      this.handleAdd(data);
      return;
    }
    if (this.mode === "detail") {
      if (matchesKey(data, "escape") || matchesKey(data, "return")) {
        this.mode = "browse";
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "escape")) {
      this.close();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.move(-1);
    } else if (matchesKey(data, "down") || data === "j") {
      this.move(1);
    } else if (data === "n") {
      this.mode = "add";
      this.addBuf = "";
      this.notice = "";
      this.tui.requestRender();
      return;
    } else if (data === "r") {
      this.reload();
      this.notice = `index reloaded (${this.items.length} items)`;
    } else if (data === "x" && this.items.length > 0) {
      this.toggleSelected();
    } else if (matchesKey(data, "return") && this.items.length > 0) {
      this.openDetail();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const th = this.theme;
    const W = Math.max(24, width);
    const H = Math.max(10, klid.lastCoverHeight);
    const grid: string[][] = Array.from({ length: H }, () => Array<string>(W).fill(" "));
    let row = 0;
    const sink = (s: string) => {
      if (row >= H) return;
      for (let i = 0; i < s.length && i < W; i++) grid[row]![i] = s[i]!;
      row++;
    };
    const open = this.items.filter(
      (i) => i.status !== "done" && i.status !== "cancelled",
    ).length;

    sink(`${th.fg("accent", "SPAI")} backlog · ${open} open / ${this.items.length} total`);
    sink("");

    if (this.mode === "detail") {
      sink(th.fg("accent", `# ${this.detailTitle}`));
      sink("");
      const lines = wrapText(this.detailBody, W - 2);
      for (const ln of lines) {
        if (row >= H - 3) break;
        sink(th.fg("text", ln));
      }
    } else {
      const maxRows = H - 5;
      const more = this.items.length > maxRows;
      if (this.selected < this.offset) this.offset = this.selected;
      if (this.selected >= this.offset + maxRows) {
        this.offset = Math.max(0, this.selected - maxRows + 1);
      }
      const list = this.items.slice(this.offset, this.offset + maxRows);
      for (const it of list) {
        const sel = it.id === this.items[this.selected]?.id;
        const mark = sel ? th.fg("accent", "›") : " ";
        const glyph = th.fg(spaiStatusColor(it.status), SPAI_GLYPH[it.status] ?? "•");
        let line = `${mark} ${glyph} ${sel ? th.bold(it.title) : it.title}`;
        if (it.tags.length > 0) line += th.fg("muted", ` [${it.tags.join(",")}]`);
        if (it.priority === "high") line += th.fg("warning", " !");
        if (it.deadline) line += th.fg("dim", ` @${it.deadline}`);
        sink(line);
      }
      if (this.items.length === 0) {
        sink(th.fg("dim", "  (no SPAI items yet — press n to add one)"));
      } else if (more) {
        sink(th.fg("dim", `${this.offset + 1}-${Math.min(this.items.length, this.offset + maxRows)} of ${this.items.length}`));
      }
    }

    if (!this.notice || row < H - 1) sink("");
    if (this.notice) sink(th.fg("muted", this.notice));

    if (this.mode === "add") {
      const preview = parseSpai(this.addBuf);
      sink(th.fg("muted", `${preview.type}/${preview.status}`) + `  new> ${this.addBuf}${th.fg("accent", "▌")}`);
      sink(th.fg("dim", "prefix: . todo · / working · ? idea · - note · !priority @deadline :tags:"));
      sink(th.fg("dim", "enter save · esc cancel"));
    } else if (this.mode === "detail") {
      sink(th.fg("dim", "esc / enter — back to list"));
    } else {
      sink(th.fg("dim", "↑↓ browse · n new · x status · enter detail · r refresh · esc close"));
    }

    return grid.map((r) => r.join(""));
  }
}
