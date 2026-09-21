/**
 * pi-klid — SPAI palette, ported 1:1 from pi-spai (`src/viewer.ts`).
 *
 * Same Linkarzu truecolor values, same glow helpers, same status ribbon, so the
 * kanban board in quiet mode looks identical to `/spai board`. These are raw
 * ANSI codes on purpose: the pi-spai board is theme-independent by design, and
 * matching it means matching the exact bytes.
 */

import type { SpaiIndex, SpaiStatus } from "./spai.js";

// Linkarzu theme colors from mozek_rust
export const LINKARZU_TODO = "\x1b[38;2;249;77;255m"; // #f94dff (vivid pink)
export const LINKARZU_WORKING = "\x1b[38;2;241;252;121m"; // #f1fc79 (electric yellow)
export const LINKARZU_WAITING = "\x1b[38;2;152;122;251m"; // #987afb (neon violet/purple)
export const LINKARZU_DONE = "\x1b[38;2;55;244;153m"; // #37f499 (neon mint green)
export const LINKARZU_CANCELLED = "\x1b[38;2;135;145;170m"; // #5f6b8a (slate grey)
export const LINKARZU_CYAN = "\x1b[38;2;4;209;249m"; // #04d1f9 (neon cyan / accent)
export const LINKARZU_CORAL = "\x1b[38;2;241;108;117m"; // #f16c75 (coral / danger)
export const LINKARZU_BORDER = "\x1b[38;2;60;75;105m"; // #314154 (border)

export function pinkGlow(text: string): string {
  return `${LINKARZU_TODO}${text}\x1b[39m`;
}

export function cyanGlow(text: string): string {
  return `${LINKARZU_CYAN}${text}\x1b[39m`;
}

export function greenGlow(text: string): string {
  return `${LINKARZU_DONE}${text}\x1b[39m`;
}

export function goldGlow(text: string): string {
  return `${LINKARZU_WORKING}${text}\x1b[39m`;
}

export function coralGlow(text: string): string {
  return `${LINKARZU_CORAL}${text}\x1b[39m`;
}

export function violetGlow(text: string): string {
  return `${LINKARZU_WAITING}${text}\x1b[39m`;
}

export function slateGlow(text: string): string {
  return `${LINKARZU_CANCELLED}${text}\x1b[39m`;
}

export function dividerGlow(text: string): string {
  return `${LINKARZU_BORDER}${text}\x1b[39m`;
}

export function defaultBold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

export interface SpaiStatusCounts {
  done: number;
  working: number;
  waiting: number;
  todo: number;
  cancelled: number;
  ideas: number;
  notes: number;
  totalTasks: number;
  totalItems: number;
  total: number;
}

/**
 * Computes SPAI status distribution, strictly distinguishing tasks from ideas
 * and notes — only Todo records count as tasks (pi-spai semantics).
 */
export function getStatusCounts(index: SpaiIndex): SpaiStatusCounts {
  let done = 0;
  let working = 0;
  let waiting = 0;
  let todo = 0;
  let cancelled = 0;
  let ideas = 0;
  let notes = 0;

  for (const r of index.records) {
    if (r.type === "Idea" || r.status === "idea") {
      ideas++;
    } else if (r.type === "Note" || r.status === "note" || r.status === "inbox") {
      notes++;
    } else {
      switch (r.status) {
        case "done":
          done++;
          break;
        case "working":
          working++;
          break;
        case "waiting":
          waiting++;
          break;
        case "cancelled":
          cancelled++;
          break;
        case "todo":
        default:
          todo++;
          break;
      }
    }
  }

  const totalTasks = done + working + waiting + todo + cancelled;
  const totalItems = totalTasks + ideas + notes;
  return {
    done,
    working,
    waiting,
    todo,
    cancelled,
    ideas,
    notes,
    totalTasks,
    totalItems,
    total: totalTasks,
  };
}

/**
 * Multi-segmented status ribbon: done (green) | working (yellow) | waiting
 * (violet) | todo (pink) | cancelled (slate), then `[done/total]` and percent.
 */
export function renderSpaiRibbon(counts: SpaiStatusCounts, barWidth = 24): string {
  const total = counts.total;
  if (total === 0 || barWidth <= 0) {
    return dividerGlow("⣿".repeat(Math.max(1, barWidth)));
  }

  const seg = (count: number): number => {
    if (total === 0) return 0;
    return Math.round((count / total) * barWidth);
  };

  let sDone = seg(counts.done);
  let sProg = seg(counts.working);
  const sWait = seg(counts.waiting);
  const sCancel = seg(counts.cancelled);
  let sPending = Math.max(0, barWidth - (sDone + sProg + sWait + sCancel));

  const sum = sDone + sProg + sWait + sCancel + sPending;
  if (sum > barWidth) {
    const diff = sum - barWidth;
    if (sPending >= diff) sPending -= diff;
    else if (sDone >= diff) sDone -= diff;
    else if (sProg >= diff) sProg -= diff;
  }

  const pct = Math.round((counts.done / total) * 100);

  const ribbon =
    greenGlow("⣿".repeat(sDone)) +
    goldGlow("⣿".repeat(sProg)) +
    violetGlow("⣿".repeat(sWait)) +
    pinkGlow("⣿".repeat(sPending)) +
    slateGlow("⣿".repeat(sCancel));

  const stats = ` ${greenGlow(`[${counts.done}/${total}]`)} ${dividerGlow(`${pct}%`)}`;
  return `${ribbon}${stats}`;
}

export function renderSpaiStatusBadge(status: SpaiStatus): string {
  switch (status) {
    case "done":
      return greenGlow("✓ done");
    case "working":
      return goldGlow("◐ working");
    case "waiting":
      return violetGlow("⏳ waiting");
    case "todo":
      return pinkGlow("○ todo");
    case "cancelled":
      return slateGlow("✗ cancelled");
    case "idea":
      return cyanGlow("💡 idea");
    case "note":
    default:
      return violetGlow("• note");
  }
}
