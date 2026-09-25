/**
 * Kanban board rendering: the frame, banner, column grid, single-column view,
 * inspector and detail pane.
 *
 * Split out of `kanban.ts` (line-limit campaign) as a base class so the method
 * bodies stay verbatim. `KanbanBoard` in `kanban.ts` extends this and keeps the
 * data loading, mutations and input handling. The board state lives here because
 * the renderers read it; nothing here touches the TUI handle or the cwd.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SpaiIndex, SpaiIndexEntry, SpaiStatus } from "../spai.js";
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
} from "../palette.js";
import { COLUMNS, type KanbanColumn } from "./kanban-model.js";

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

export function wrapText(text: string, width: number): string[] {
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

export abstract class KanbanBoardRenderer {
  protected index: SpaiIndex = { version: 1, lastUpdated: "", records: [] };
  protected focusCol = 0;
  protected selected: number[] = COLUMNS.map(() => 0);
  protected mode: "browse" | "add" | "detail" = "browse";
  protected addBuf = "";
  protected detailTitle = "";
  protected detailBody = "";
  protected detailOffset = 0;
  protected notice = "";
  protected columnTasks(status: SpaiStatus): SpaiIndexEntry[] {
    return this.index.records.filter((r) => r.type === "Todo" && r.status === status);
  }
  protected focusedColumn(): KanbanColumn {
    return COLUMNS[this.focusCol] ?? COLUMNS[0]!;
  }
  protected selectedEntry(): SpaiIndexEntry | null {
    const col = this.focusedColumn();
    return this.columnTasks(col.status)[this.selected[this.focusCol] ?? 0] ?? null;
  }
  protected pad(lines: string[], width: number, height: number): string[] {
    const out = lines.slice(0, height).map((l) => padToWidth(l, width));
    while (out.length < height) out.push(" ".repeat(width));
    return out;
  }
  protected banner(innerWidth: number, wide: boolean): string {
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
  protected hints(innerWidth: number, wide: boolean): string {
    const key = (k: string) => cyanGlow(k);
    const text = wide
      ? `  ${key("←→")}: column  ${key("↑↓")}: task  ${key("1-5")}: status  ${key("space")}: move  ${key("x")}: done  ${key("n")}: new  ${key("enter")}: detail  ${key("r")}: reload  ${key("esc")}: close`
      : `  ${key("←→")}: column  ${key("↑↓")}: task  ${key("1-5")}: status  ${key("n")}: new  ${key("esc")}: close`;
    return clip(text, innerWidth);
  }
  protected renderWide(width: number, height: number): string[] {
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
  protected renderNarrow(width: number, height: number): string[] {
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
  protected inspector(width: number): string {
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
  protected renderDetail(width: number, height: number): string[] {
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
