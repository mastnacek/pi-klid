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
import { matchesKey, type AutocompleteItem, type Component, type TUI } from "@earendil-works/pi-tui";
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

/** Slow breathing cycle in milliseconds. */
const BREATH_MS = 5600;
/** Animation refresh rate (slow, calm — 10 fps is plenty). */
const FRAME_MS = 100;

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
// Breathing animation frames (fallback working indicator, non-TUI modes)
// ---------------------------------------------------------------------------

function breathingFrames(theme: Theme): { frames: string[]; intervalMs: number } {
  const d = (c: string) => theme.fg("dim", c);
  const m = (c: string) => theme.fg("muted", c);
  const a = (c: string) => theme.fg("accent", c);
  // Slow inhale → peak → exhale, rendered with dim/muted/accent depth.
  return {
    frames: [d("·"), m("•"), a("●"), m("•"), d("·"), d("·"), d("·"), d("·")],
    intervalMs: 700,
  };
}

// ---------------------------------------------------------------------------
// Full-screen breathing overlay
// ---------------------------------------------------------------------------

class BreathingComponent implements Component {
  private tui: TUI;
  private theme: Theme;
  private closed = false;
  private release: () => void;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(tui: TUI, theme: Theme, release: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.release = release;
    this.interval = setInterval(() => {
      if (!this.closed) this.tui.requestRender();
    }, FRAME_MS);
  }

  // Called when the process re-renders after theme changes etc.
  invalidate(): void {}

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.close();
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispose();
    this.release();
  }

  render(width: number): string[] {
    const th = this.theme;
    const W = Math.max(20, width);
    const H = Math.max(12, lastTermHeight);

    // Character grid for the whole screen so the cover is opaque everywhere.
    const grid: string[][] = Array.from({ length: H }, () => Array<string>(W).fill(" "));

    const t = (Date.now() % BREATH_MS) / BREATH_MS;
    const breath = Math.sin(2 * Math.PI * t); // -1 exhale … +1 inhale peak
    const cx = Math.floor(W / 2);
    const cy = Math.floor(H / 2) - 1;

    // Ring radius breathes slowly between ~1.1 and ~2.5.
    const radius = 1.1 + 1.4 * (0.5 + 0.5 * breath);

    const paintRing = (r: number, ch: string): void => {
      if (r < 0.4) return;
      const span = Math.ceil(r + 1);
      for (let dy = -span; dy <= span; dy++) {
        for (let dx = -span; dx <= span; dx++) {
          const d = Math.hypot(dx, dy);
          if (Math.abs(d - r) < 0.45) {
            const px = cx + dx;
            const py = cy + dy;
            if (px >= 0 && px < W && py >= 0 && py < H) grid[py]![px] = ch;
          }
        }
      }
    };

    // Echo rings fade at the edges of the breath; main ring is accent.
    paintRing(radius - 1.15, th.fg("muted", "○"));
    paintRing(radius + 1.15, th.fg("muted", "○"));
    paintRing(radius, th.fg("accent", "●"));
    if (radius < 1.45) grid[cy]![cx] = th.fg("dim", "·");

    // "Working…" beneath the orb — dots count with the breath, color deepens.
    const light = 0.5 + 0.5 * breath;
    const dots = ".".repeat(1 + Math.floor(1 + light)); // 1..3 dots at peak
    const wordColor = light > 0.66 ? "accent" : light > 0.33 ? "muted" : "dim";
    const word = `Working${dots}`;
    const wordX = Math.max(0, Math.floor((W - word.length) / 2));
    const wordY = cy + Math.ceil(radius) + 2;
    if (wordY < H) {
      for (let i = 0; i < word.length && wordX + i < W; i++) {
        grid[wordY]![wordX + i] = th.fg(wordColor as "accent" | "muted" | "dim", word[i]!);
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
    (tui, theme, _kb, done) => {
      const component = new BreathingComponent(tui, theme, () => {
        try {
          done(undefined);
        } catch {
          // Overlay already closed.
        }
      });
      releaseOverlay = () => {
        try {
          done(undefined);
        } catch {
          // Overlay already closed.
        }
      };
      return component;
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
    ctx.ui.setWorkingIndicator(breathingFrames(ctx.ui.theme));
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