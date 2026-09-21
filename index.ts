/**
 * pi-klid — Quiet zen mode for the pi coding agent.
 *
 * `/klid on` hides thinking blocks at the render level and, while the agent is
 * running, covers every tool call / streaming update behind a slow breathing
 * "Working..." animation. When the agent settles, the overlay dissolves and
 * only the clean final answer is revealed. Nothing disturbs you in between.
 *
 * Usage:
 *   /klid            — help banner
 *   /klid on         — enable quiet mode
 *   /klid off        — disable quiet mode
 *   /klid toggle     — flip quiet mode
 *   /klid status     — show current state
 *
 * The enabled state persists to ~/.pi/agent/pi-klid.json and is restored on
 * session start.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type Component } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface KlidConfig {
  enabled: boolean;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-klid.json");
const STATUS_KEY = "klid";

const COMMAND_DOCS: Record<string, string> = {
  on: "enable quiet mode",
  off: "disable quiet mode",
  toggle: "flip quiet mode",
  status: "show current quiet state",
  help: "display this reference banner",
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let klidEnabled = false;
let overlayActive = false;
let releaseOverlay: (() => void) | null = null; // closes the live overlay
let workingTouched = false; // we customized the working row
let lastTermHeight = 40;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadConfig(): KlidConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<KlidConfig>;
      return { enabled: raw.enabled === true };
    }
  } catch {
    // Corrupt/missing config — non-fatal, default to off.
  }
  return { enabled: false };
}

function saveConfig(cfg: KlidConfig): void {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
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
 * Static, opaque full-screen cover. Renders a single dim "Working..." line at
 * the vertical center. No animation, no color cycling, no timers — there is
 * nothing to stare at; it only signals that work is in progress.
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
    const H = Math.max(12, lastTermHeight);

    // Character grid for the whole screen so the cover is opaque everywhere.
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
// Overlay lifecycle
// ---------------------------------------------------------------------------

function openOverlay(ctx: ExtensionContext): void {
  if (overlayActive) return;
  if (ctx.mode !== "tui" || !ctx.hasUI) return;

  const view = ctx.ui.custom<void>(
    (_tui, theme, _kb, done) => {
      releaseOverlay = () => {
        try {
          done(undefined);
        } catch {
          // Overlay already closed.
        }
      };
      return new QuietCover(theme);
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
        // Capture the real terminal height as the cover renders each cycle.
        visible: (_w, h) => {
          lastTermHeight = h;
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
  saveConfig({ enabled: on });
  if (ctx.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, on ? "quiet" : undefined);
  }
  if (on) {
    // Make sure the breathing row is armed for the next run.
    applyQuietUi(ctx, false);
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
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, klidEnabled ? "quiet" : undefined);
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!klidEnabled) return;
    applyQuietUi(ctx, true);
    openOverlay(ctx);
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
      // Second-level arguments for /klid are booleans/literals; no completion needed.
      if (tokens.length > 1 || (/\s$/.test(prefix) && tokens.length === 1)) return null;
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
        "slow breathing \"Working...\" animation until the agent settles.",
        "",
        "### Commands:",
        "  /klid on          — Enable quiet mode",
        "  /klid off         — Disable quiet mode",
        "  /klid toggle      — Flip quiet mode",
        "  /klid status      — Show current quiet state",
        "  /klid help        — Display this reference banner",
        "",
        "While enabled, thinking never renders (live or history). Tool",
        "activity is covered while the agent works; only the final answer",
        "appears when it settles. State persists across sessions.",
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
        case "status": {
          const state = klidEnabled ? "quiet mode ON" : "quiet mode OFF";
          const thinking = klidEnabled ? "hidden" : "visible";
          ctx.ui.notify(`klid: ${state} | thinking: ${thinking} | persists: ~/.pi/agent/pi-klid.json`, "info");
          break;
        }
        default:
          ctx.ui.notify(`klid: unknown subcommand "${sub}". Use: /klid help`, "warning");
          break;
      }
    },
  });
}