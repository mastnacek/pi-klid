/**
 * pi-klid — Quiet zen mode for the pi coding agent.
 *
 * `/klid on` hides thinking blocks at the render level and, while the agent is
 * running, covers every tool call / streaming update behind a quiet surface:
 * either the static "Working..." cover, a live SPAI task list, or the SPAI
 * kanban board. When the agent settles, the overlay dissolves and only the
 * clean final answer is revealed. Nothing disturbs you in between.
 *
 * Usage:
 *   /klid            — help banner
 *   /klid on         — enable quiet mode
 *   /klid off        — disable quiet mode
 *   /klid toggle     — flip quiet mode
 *   /klid view spai   — show the SPAI task list while working
 *   /klid view kanban — show the SPAI kanban board while working
 *   /klid view cover  — show the static quiet cover while working
 *   /klid status     — show current state
 *
 * The enabled state + view persist to ~/.pi/agent/pi-klid.json and are
 * restored on session start.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type AutocompleteItem,
  type Component,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  cycleStatus,
  loadIndex,
  parseSpai,
  readRecordBody,
  saveRecord,
  updateRecordStatus,
  type SpaiIndexEntry,
  type SpaiStatus,
} from "./spai.js";
import { KanbanBoard } from "./kanban.js";
import {
  formatRealizePrompt,
  loadSpaiBoard,
  spaiBoardSource,
  type SpaiBoardModule,
  type SpaiBoardRecord,
} from "./spai-board.js";
import { pinkGlow } from "./palette.js";

type KlidView = "cover" | "spai" | "kanban";

const KLID_VIEWS: KlidView[] = ["cover", "spai", "kanban"];

interface KlidConfig {
  enabled: boolean;
  view: KlidView;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-klid.json");
const STATUS_KEY = "klid";
// TUI-only state is also mirrored as a custom session entry so it survives
// reloads and follows /tree branch navigation (AGENTS.md §5/§6).
const STATE_ENTRY_TYPE = "pi-klid-state";

const COMMAND_DOCS: Record<string, string> = {
  on: "enable quiet mode",
  off: "disable quiet mode",
  toggle: "flip quiet mode",
  view: "select working view (cover | spai | kanban)",
  status: "show current quiet state",
  help: "display this reference banner",
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let klidEnabled = false;
let klidView: KlidView = "cover";
let overlayActive = false;
let releaseOverlay: (() => void) | null = null; // closes the live overlay
let workingTouched = false; // we customized the working row
let lastCoverHeight = 24;
let overlayTui: TUI | null = null; // live TUI, for dock measurement
let overlayHandle: OverlayHandle | null = null;

/**
 * Fallback band: rows left untouched when the dock cannot be measured. Used
 * only when pi's component shape is unrecognized (unknown host/fullscreen).
 */
function bottomBand(termHeight: number): number {
  return Math.min(12, Math.max(6, Math.round(termHeight * 0.22)));
}

/**
 * Rows occupied by pi's bottom dock — queued messages, status, widgets, the
 * input editor and the footer. Pi mounts the transcript container first and the
 * dock after it (interactive-mode `mountInteractiveTui`), so everything past
 * the first child is dock. Returns 0 when that shape is not recognized, which
 * makes the caller fall back to `bottomBand`.
 *
 * Measuring beats guessing: a fixed 22% band is smaller than the dock as soon
 * as a widget, status row or multi-line prompt appears, and the overlay then
 * paints over the top of the input editor.
 */
function dockRows(tui: TUI | null, width: number): number {
  const children = (tui as { children?: Component[] } | null)?.children;
  if (!Array.isArray(children) || children.length < 2) return 0;
  let rows = 0;
  try {
    for (const child of children.slice(1)) {
      rows += Math.max(0, child.render(Math.max(1, width)).length);
    }
  } catch {
    return 0;
  }
  return rows;
}

/** Rows to leave uncovered at the bottom of the overlay. */
function reservedRows(tui: TUI | null, termWidth: number, termHeight: number): number {
  const measured = dockRows(tui, termWidth);
  // Keep at least 8 rows of cover so the surface still hides the run.
  if (measured > 0) return Math.min(measured, Math.max(1, termHeight - 8));
  return bottomBand(termHeight);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadConfig(): KlidConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<KlidConfig>;
      return {
        enabled: raw.enabled === true,
        view: KLID_VIEWS.includes(raw.view as KlidView) ? (raw.view as KlidView) : "cover",
      };
    }
  } catch {
    // Corrupt/missing config — non-fatal, default to off.
  }
  return { enabled: false, view: "cover" };
}

function saveConfig(cfg: KlidConfig): void {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ enabled: cfg.enabled, view: cfg.view }, null, 2) + "\n", "utf8");
  } catch {
    // Non-fatal: persistence is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Static working indicator (fallback for non-TUI modes). Single dim frame —
// deliberately unanimated: it signals work without rewarding watching.
// ---------------------------------------------------------------------------

function quietWorkingIndicator(theme: Theme): { frames: string[]; intervalMs: number } {
  return { frames: [theme.fg("dim", "·")], intervalMs: 1000 };
}

// ---------------------------------------------------------------------------
// Full-screen breathing overlay
// ---------------------------------------------------------------------------

/**
 * Static, opaque cover for the transcript region only. Renders a single dim
 * "Working..." line at the vertical center. No animation, no color cycling,
 * no timers — nothing to stare at, it only signals that work is in progress.
 * The bottom band (working row + input editor + footer) is never painted over.
 */
class QuietCover implements Component {
  private theme: Theme;

  constructor(theme: Theme) {
    this.theme = theme;
  }

  // Called when the process re-renders after theme changes etc.
  invalidate(): void {}

  handleInput(): void {
    // Overlay is non-capturing; nothing to handle.
  }

  render(width: number): string[] {
    const th = this.theme;
    const W = Math.max(20, width);
    const H = Math.max(8, lastCoverHeight);

    // Character grid for the whole cover region so it is opaque everywhere.
    const grid: string[][] = Array.from({ length: H }, () => Array<string>(W).fill(" "));

    const word = "Working...";
    const x = Math.max(0, Math.floor((W - word.length) / 2));
    const y = Math.floor(H / 2);
    if (y < H) {
      for (let i = 0; i < word.length && x + i < W; i++) {
        grid[y]![x + i] = th.fg("dim", word[i]!);
      }
    }

    return grid.map((row) => row.join(""));
  }
}

// ---------------------------------------------------------------------------
// SPAI dashboard overlay (interactive; shown instead of the cover while working)
// ---------------------------------------------------------------------------

const SPAI_GLYPH: Record<string, string> = {
  todo: "○",
  working: "◐",
  waiting: "⏳",
  done: "✓",
  cancelled: "✗",
  idea: "💡",
  note: "•",
  inbox: "•",
};

function spaiStatusColor(s: SpaiStatus): "accent" | "dim" | "muted" | "text" | "warning" {
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

function wrapText(text: string, w: number): string[] {
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
class SpaiDashboard implements Component {
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
    const H = Math.max(10, lastCoverHeight);
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

// ---------------------------------------------------------------------------
// Overlay lifecycle
// ---------------------------------------------------------------------------

/**
 * Shared overlay options: full width from the top, and a bottom band sized
 * from pi's measured dock so the input editor and footer stay visible.
 * `nonCapturing` is true only for the passive cover.
 */
function overlayOptions(kind: KlidView): Parameters<ExtensionContext["ui"]["custom"]>[1] {
  return {
    overlay: true,
    overlayOptions: {
      anchor: "top-left",
      width: "100%",
      nonCapturing: kind === "cover",
      // Measure pi's real dock every cycle (queued messages, status, widgets,
      // editor, footer) and reserve exactly that many rows, so the input
      // editor and footer are never painted over — no matter how tall the
      // dock grows or how many lines the prompt has.
      visible: (w, h) => {
        lastCoverHeight = Math.max(8, h - reservedRows(overlayTui, w, h));
        return true;
      },
    },
    onHandle: (handle) => {
      overlayHandle = handle;
    },
  };
}

function openOverlay(ctx: ExtensionContext, kind: KlidView): void {
  if (overlayActive) return;
  if (ctx.mode !== "tui" || !ctx.hasUI) return;

  const view = ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      const close = () => {
        try {
          done(undefined);
        } catch {
          // Overlay already closed.
        }
      };
      releaseOverlay = close;
      overlayTui = tui;
      if (kind === "spai") return new SpaiDashboard(tui, theme, ctx.cwd, close);
      if (kind === "kanban") {
        return new KanbanBoard({
          tui,
          cwd: ctx.cwd,
          close,
          height: () => lastCoverHeight,
        });
      }
      return new QuietCover(theme);
    },
    overlayOptions(kind),
  );

  overlayActive = true;
  view
    .catch(() => undefined)
    .finally(() => {
      overlayActive = false;
      releaseOverlay = null;
      overlayHandle = null;
      overlayTui = null;
    });
}

// ---------------------------------------------------------------------------
// Kanban view: delegate to pi-spai's own board when it is installed
// ---------------------------------------------------------------------------

/**
 * pi-spai's board renders its own fixed height (10 task rows). The quiet cover
 * must stay opaque, so wrap it: same content and colors, padded to the whole
 * reserved transcript region so nothing shows through underneath.
 */
function padToCover(inner: Component, width: number): string[] {
  const rows = Math.max(8, lastCoverHeight);
  const W = Math.max(1, width);
  const lines = inner.render(W).slice(0, rows).map((line) => {
    const v = visibleWidth(line);
    if (v >= W) return truncateToWidth(line, W, "");
    return line + " ".repeat(W - v);
  });
  while (lines.length < rows) lines.push(" ".repeat(W));
  return lines;
}

/**
 * pi-spai's board is the same component `/spai board` uses, so the quiet view
 * cannot drift from it. Its `onNewTask` / `onOpenRecord` / `onRealizeRecord`
 * callbacks close the board and hand the request back here; we then run the
 * same flows pi-spai runs and reopen the board while the run is still going.
 */
async function runDelegatedKanban(ctx: ExtensionContext, mod: SpaiBoardModule): Promise<void> {
  while (!overlayActive) {
    let index: unknown;
    try {
      index = await mod.loadIndex(ctx.cwd);
    } catch {
      return;
    }

    let requestKind: "none" | "new" | "open" | "realize" = "none";
    let requestRecord: SpaiBoardRecord | null = null;

    const view = ctx.ui.custom<void>(
      (tui, _theme, _kb, done) => {
        const close = () => {
          try {
            done(undefined);
          } catch {
            // Overlay already closed.
          }
        };
        releaseOverlay = close;
        overlayTui = tui;
        const board = new mod.BoardComponent({
          cwd: ctx.cwd,
          index,
          onClose: close,
          onRequestRender: () => tui.requestRender(),
          onNewTask: () => {
            requestKind = "new";
            close();
          },
          onOpenRecord: (record: SpaiBoardRecord) => {
            requestKind = "open";
            requestRecord = record;
            close();
          },
          onRealizeRecord: (record: SpaiBoardRecord) => {
            requestKind = "realize";
            requestRecord = record;
            close();
          },
        });
        return {
          invalidate: () => board.invalidate(),
          handleInput: (data: string) => board.handleInput?.(data),
          render: (width: number) => padToCover(board, width),
        };
      },
      overlayOptions("kanban"),
    );

    overlayActive = true;
    await view.catch(() => undefined);
    overlayActive = false;
    releaseOverlay = null;
    overlayHandle = null;
    overlayTui = null;

    if (requestKind === "none") return;

    if (requestKind === "new") {
      await runNewItemFlow(ctx, mod);
    } else if (requestKind === "open" && requestRecord) {
      // pi-spai's board reopens after the reader closes (and its reader can
      // hand the item to the prompt with `r`).
      const outcome = await showReaderOverlay(ctx, mod, requestRecord);
      if (outcome === "realize") {
        realizeFromBoard(ctx, requestRecord);
        return;
      }
    } else if (requestRecord) {
      realizeFromBoard(ctx, requestRecord);
      return;
    }

    // Reopen the board only while the agent is still working; once it settles
    // the answer belongs on screen, not behind a board.
    if (ctx.isIdle()) return;
  }
}

/** Same capture flow as pi-spai's `/spai new`: one input, SPAI prefix syntax. */
async function runNewItemFlow(ctx: ExtensionContext, mod: SpaiBoardModule): Promise<void> {
  if (!ctx.hasUI) return;
  let text = "";
  try {
    const input = await ctx.ui.input(
      "Enter a task (. ), an idea (? ) or a note (- ):",
      ". ",
    );
    text = input?.trim() ?? "";
  } catch {
    return;
  }
  if (!text) return;

  try {
    const saved = await mod.saveRecord(ctx.cwd, text);
    ctx.ui.notify(
      `Created ${pinkGlow(saved.id)}: ${saved.title}`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(
      `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      "warning",
    );
  }
}

/** Read-only view built from pi-spai's own reading-mode formatter. */
async function showReaderOverlay(
  ctx: ExtensionContext,
  mod: SpaiBoardModule,
  record: SpaiBoardRecord,
): Promise<"back" | "realize"> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return "back";
  const text = mod.formatReadingMode(record);
  let outcome: "back" | "realize" = "back";
  await ctx.ui.custom<void>(
    (_tui, theme, _kb, done) => {
      const component: Component = {
        invalidate: () => {},
        render: (width: number) => {
          const inner = Math.max(20, width);
          const lines = text.split("\n").map((l) => l.slice(0, inner));
          const hint = theme.fg("dim", "esc — back · r — realize");
          const body = Math.max(6, lastCoverHeight - 2);
          const out = lines.slice(0, body);
          while (out.length < body) out.push("");
          out.push(hint);
          return out.map((l) => l.padEnd(inner));
        },
        handleInput: (data: string) => {
          if (data === "r") {
            outcome = "realize";
            done(undefined);
            return;
          }
          if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") {
            done(undefined);
          }
        },
      };
      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        visible: (w, h) => {
          lastCoverHeight = Math.max(8, h - reservedRows(overlayTui, w, h));
          return true;
        },
      },
    },
  );
  return outcome;
}

/** Mirrors pi-spai's `r` (realize): put the item in the prompt, do not send it. */
function realizeFromBoard(ctx: ExtensionContext, record: SpaiBoardRecord): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.setEditorText(formatRealizePrompt(record));
    ctx.ui.notify(`Inserted ${pinkGlow(record.id)} into the prompt.`, "info");
  } catch {
    // Editor not reachable (non-TUI host) — nothing else to do.
  }
}

function closeOverlay(): void {
  const release = releaseOverlay;
  releaseOverlay = null;
  if (release) {
    release();
  } else {
    // Stale overlay with a lost release callback (e.g. after an extension
    // reload): remove it directly so it cannot keep covering the editor.
    try {
      overlayHandle?.hide();
    } catch {
      // Already gone.
    }
  }
  overlayHandle = null;
  overlayTui = null;
  overlayActive = false;
}

// ---------------------------------------------------------------------------
// Apply quiet state to the host UI
// ---------------------------------------------------------------------------

function applyQuietUi(ctx: ExtensionContext, running: boolean): void {
  if (!ctx.hasUI) return;
  if (running) {
    ctx.ui.setWorkingMessage("Working...");
    ctx.ui.setWorkingIndicator(quietWorkingIndicator(ctx.ui.theme));
    workingTouched = true;
  } else {
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
    workingTouched = false;
  }
}

function setEnabled(ctx: ExtensionContext, on: boolean): void {
  klidEnabled = on;
  saveConfig({ enabled: on, view: klidView });
  if (ctx.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, on ? "quiet" : undefined);
  }
  if (on) {
    // Make sure the quiet working row is armed for the next run.
    applyQuietUi(ctx, false);
  }
}

const VIEW_LABELS: Record<KlidView, string> = {
  cover: "quiet cover",
  spai: "SPAI dashboard",
  kanban: "SPAI kanban board",
};

function setView(ctx: ExtensionContext, view: KlidView): void {
  klidView = view;
  saveConfig({ enabled: klidEnabled, view });
  if (ctx.hasUI) {
    ctx.ui.notify(`klid: working view → ${VIEW_LABELS[view]}`, "info");
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  /** Unsubscribers from every `pi.on()`; drained on session_shutdown (AGENTS §5). */
  const unsubscribers: Array<() => void> = [];

  /** Retain a `pi.on()` return value; older engine typings declare it void. */
  const track = (result: unknown): void => {
    if (typeof result === "function") unsubscribers.push(result as () => void);
  };

  // Mirror the TUI-only enabled/view state into the session transcript.
  const persistEntry = (): void => {
    try {
      pi.appendEntry(STATE_ENTRY_TYPE, { enabled: klidEnabled, view: klidView });
    } catch {
      // Best-effort: a missing session must not break the command.
    }
  };

  // Hiding thinking: display-only transformer. While quiet mode is on, thinking
  // blocks (live + history) render as nothing. Session/model context untouched.
  pi.registerMarkdownTransformer((markdown, context) => {
    if (klidEnabled && context.messageType === "assistant-thinking") return "";
    return markdown;
  });

  track(pi.on("session_start", async (_event, ctx) => {
    // A fresh/rebound session must never inherit a stale overlay that would
    // keep covering the editor while the agent is idle.
    closeOverlay();
    const cfg = loadConfig();
    klidEnabled = cfg.enabled;
    klidView = cfg.view;
    // Session entry (branch-aware) wins over the global file, last one wins.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as { enabled?: boolean; view?: KlidView } | undefined;
        if (typeof data?.enabled === "boolean") klidEnabled = data.enabled;
        if (data?.view && KLID_VIEWS.includes(data.view)) klidView = data.view;
      }
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, klidEnabled ? "quiet" : undefined);
    }
  }));

  track(pi.on("agent_start", async (_event, ctx) => {
    if (!klidEnabled) return;
    applyQuietUi(ctx, true);
    if (klidView === "kanban") {
      // Prefer pi-spai's own board; the local one is only a fallback.
      const mod = await loadSpaiBoard();
      if (mod) {
        void runDelegatedKanban(ctx, mod);
        return;
      }
    }
    openOverlay(ctx, klidView);
  }));

  // Fully settles only when no retry/compaction/continuation is left — that is
  // exactly when the user can look at the answer again.
  track(pi.on("agent_settled", async (_event, ctx) => {
    if (!klidEnabled) {
      closeOverlay();
      if (workingTouched) applyQuietUi(ctx, false);
      return;
    }
    closeOverlay();
    applyQuietUi(ctx, false);
  }));

  // Safety net: a fresh prompt while an overlay is somehow still open.
  track(pi.on("input", async (_event, ctx) => {
    closeOverlay();
    if (workingTouched) applyQuietUi(ctx, false);
  }));

  pi.on("session_shutdown", async () => {
    while (unsubscribers.length > 0) unsubscribers.pop()?.();
    closeOverlay();
  });

  pi.registerCommand("klid", {
    description: "Quiet zen mode: hide thinking and tool activity behind a breathing Working... animation",
    getArgumentCompletions: async (prefix: string): Promise<AutocompleteItem[] | null> => {
      const tokens = prefix.split(/\s+/).filter(Boolean);
      const trailing = /\s$/.test(prefix);

      // Second level: view/dashboard accept cover|spai.
      if (tokens.length === 2 || (trailing && tokens.length === 1)) {
        const cmd = (tokens[0] ?? "").toLowerCase();
        if (cmd === "view" || cmd === "dashboard") {
          const typed = (tokens[1] ?? "").toLowerCase();
          const opts = KLID_VIEWS.filter((v) => v.startsWith(typed)).map((v) => ({
            value: `view ${v}`,
            label: `view ${v}`,
            description:
              v === "cover"
                ? "static quiet cover while working (passive)"
                : v === "spai"
                  ? "SPAI task list while working (interactive)"
                  : "SPAI kanban board while working (interactive)",
          }));
          return opts.length > 0 ? opts : null;
        }
        return null;
      }
      if (tokens.length > 2) return null;

      const typed = (tokens[0] ?? "").toLowerCase();
      const NON_TERMINAL = new Set(["view", "dashboard"]);
      const items: AutocompleteItem[] = [];
      for (const [key, description] of Object.entries(COMMAND_DOCS)) {
        if (key.toLowerCase().startsWith(typed)) {
          items.push({
            value: NON_TERMINAL.has(key) ? `${key} ` : key,
            label: key,
            description,
          });
        }
      }
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = (tokens[0] ?? "").toLowerCase();

      const helpText = [
        "# pi-klid — Quiet Mode",
        "Hides thinking blocks and every tool-call / streaming update behind a",
        "quiet surface while the agent works — either a static \"Working...\"",
        "cover or a live SPAI task dashboard.",
        "",
        "### Commands:",
        "  /klid on                — Enable quiet mode",
        "  /klid off               — Disable quiet mode",
        "  /klid toggle            — Flip quiet mode",
        "  /klid view <view>       — cover | spai (task list) | kanban (board)",
        "  /klid status            — Show current quiet state",
        "  /klid help              — Display this reference banner",
        "",
        "While enabled, thinking never renders (live or history). Tool",
        "activity is covered while the agent works; only the final answer",
        "appears when it settles. State + view persist across sessions.",
      ].join("\n");

      if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
        ctx.ui.notify(helpText, "info");
        return;
      }

      switch (sub) {
        case "on":
          setEnabled(ctx, true);
          persistEntry();
          ctx.ui.notify("klid: quiet mode ON — I'll leave you alone while I work", "info");
          break;
        case "off":
          setEnabled(ctx, false);
          applyQuietUi(ctx, false);
          persistEntry();
          ctx.ui.notify("klid: quiet mode OFF", "info");
          break;
        case "toggle":
          setEnabled(ctx, !klidEnabled);
          if (!klidEnabled) applyQuietUi(ctx, false);
          persistEntry();
          ctx.ui.notify(`klid: quiet mode ${klidEnabled ? "ON" : "OFF"}`, "info");
          break;
        case "view":
        case "dashboard": {
          const target = (tokens[1] ?? "").toLowerCase();
          if (KLID_VIEWS.includes(target as KlidView)) {
            setView(ctx, target as KlidView);
            persistEntry();
          } else {
            ctx.ui.notify(
              `klid: working view is \"${klidView}\". Use: /klid view cover|spai|kanban`,
              "info",
            );
          }
          break;
        }
        case "status": {
          const state = klidEnabled ? "quiet mode ON" : "quiet mode OFF";
          const thinking = klidEnabled ? "hidden" : "visible";
          // Resolve the board source so the status is truthful even before the
          // first kanban run (a silent fallback is otherwise invisible).
          await loadSpaiBoard();
          const board = spaiBoardSource();
          const boardText =
            board.source === "pi-spai"
              ? "kanban: pi-spai's board"
              : `kanban: local fallback (${board.detail})`;
          ctx.ui.notify(
            `klid: ${state} | thinking: ${thinking} | view: ${klidView} | ${boardText} | persists: ~/.pi/agent/pi-klid.json`,
            "info",
          );
          break;
        }
        default:
          ctx.ui.notify(`klid: unknown subcommand "${sub}". Use: /klid help`, "warning");
          break;
      }
    },
  });
}