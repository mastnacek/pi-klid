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
  type AutocompleteItem,
  type Component,
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

type KlidView = "cover" | "spai" | "kanban";

const KLID_VIEWS: KlidView[] = ["cover", "spai", "kanban"];

interface KlidConfig {
  enabled: boolean;
  view: KlidView;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-klid.json");
const STATUS_KEY = "klid";

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

/**
 * Bottom band rows left untouched by the cover: working row + input editor +
 * footer. Adaptive to terminal height so the editor never gets overpainted.
 */
function bottomBand(termHeight: number): number {
  return Math.min(12, Math.max(6, Math.round(termHeight * 0.22)));
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
      if (kind === "spai") return new SpaiDashboard(tui, theme, ctx.cwd, close);
      if (kind === "kanban") {
        return new KanbanBoard({
          tui,
          theme,
          cwd: ctx.cwd,
          close,
          height: () => lastCoverHeight,
        });
      }
      return new QuietCover(theme);
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        // The cover is passive; the SPAI views capture keys for navigation.
        nonCapturing: kind === "cover",
        // Capture the real terminal height each cycle and reserve the bottom
        // band (working row + input + footer) so it stays visible and clean.
        visible: (_w, h) => {
          lastCoverHeight = Math.max(8, h - bottomBand(h));
          return true;
        },
      },
    },
  );

  overlayActive = true;
  view
    .catch(() => undefined)
    .finally(() => {
      overlayActive = false;
      releaseOverlay = null;
    });
}

function closeOverlay(): void {
  if (releaseOverlay) {
    const release = releaseOverlay;
    releaseOverlay = null;
    release();
  }
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
  // Hiding thinking: display-only transformer. While quiet mode is on, thinking
  // blocks (live + history) render as nothing. Session/model context untouched.
  pi.registerMarkdownTransformer((markdown, context) => {
    if (klidEnabled && context.messageType === "assistant-thinking") return "";
    return markdown;
  });

  pi.on("session_start", async (_event, ctx) => {
    const cfg = loadConfig();
    klidEnabled = cfg.enabled;
    klidView = cfg.view;
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, klidEnabled ? "quiet" : undefined);
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!klidEnabled) return;
    applyQuietUi(ctx, true);
    openOverlay(ctx, klidView);
  });

  // Fully settles only when no retry/compaction/continuation is left — that is
  // exactly when the user can look at the answer again.
  pi.on("agent_settled", async (_event, ctx) => {
    if (!klidEnabled) {
      if (workingTouched) applyQuietUi(ctx, false);
      return;
    }
    closeOverlay();
    applyQuietUi(ctx, false);
  });

  // Safety net: a fresh prompt while an overlay is somehow still open.
  pi.on("input", async (_event, ctx) => {
    closeOverlay();
    if (workingTouched) applyQuietUi(ctx, false);
  });

  pi.on("session_shutdown", async () => {
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
      const items = Object.entries(COMMAND_DOCS)
        .filter(([key]) => key.toLowerCase().startsWith(typed))
        .map(([value, description]) => ({ value, label: value, description }));
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
          ctx.ui.notify("klid: quiet mode ON — I'll leave you alone while I work", "info");
          break;
        case "off":
          setEnabled(ctx, false);
          applyQuietUi(ctx, false);
          ctx.ui.notify("klid: quiet mode OFF", "info");
          break;
        case "toggle":
          setEnabled(ctx, !klidEnabled);
          if (!klidEnabled) applyQuietUi(ctx, false);
          ctx.ui.notify(`klid: quiet mode ${klidEnabled ? "ON" : "OFF"}`, "info");
          break;
        case "view":
        case "dashboard": {
          const target = (tokens[1] ?? "").toLowerCase();
          if (KLID_VIEWS.includes(target as KlidView)) {
            setView(ctx, target as KlidView);
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
          ctx.ui.notify(
            `klid: ${state} | thinking: ${thinking} | view: ${klidView} | persists: ~/.pi/agent/pi-klid.json`,
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