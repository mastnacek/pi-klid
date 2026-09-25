/**
 * Kanban board data model: the five status columns and the direct-status
 * aliases. Split out of `kanban.ts` so the renderer and the board can share
 * them without importing each other.
 */
import type { SpaiStatus } from "../spai.js";
import { goldGlow, greenGlow, pinkGlow, slateGlow, violetGlow } from "../palette.js";

export interface KanbanColumn {
  status: SpaiStatus;
  label: string;
  glyph: string;
  shortcut: string;
  colorFn: (text: string) => string;
  bgColorAnsi: string;
}

export const COLUMNS: KanbanColumn[] = [
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

export const DIRECT_STATUS: Record<string, SpaiStatus> = {
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

export const WIDE_MIN = 75;
