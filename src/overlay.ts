import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type KlidView, STATUS_KEY, saveConfig } from "./types.js";
import { klid, reservedRows, quietWorkingIndicator } from "./state.js";
import { QuietCover } from "./cover.js";
import { SpaiDashboard } from "./spai-dashboard.js";
import { KanbanBoard } from "../kanban.js";
import { formatRealizePrompt, type SpaiBoardRecord } from "../spai-board.js";
import { pinkGlow } from "../palette.js";

// ---------------------------------------------------------------------------
// Overlay lifecycle
// ---------------------------------------------------------------------------

/**
 * Shared overlay options: full width from the top, and a bottom band sized
 * from pi's measured dock so the input editor and footer stay visible.
 * `nonCapturing` is true only for the passive cover.
 */
export function overlayOptions(kind: KlidView): Parameters<ExtensionContext["ui"]["custom"]>[1] {
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
        klid.lastCoverHeight = Math.max(8, h - reservedRows(klid.overlayTui, w, h));
        return true;
      },
    },
    onHandle: (handle) => {
      klid.overlayHandle = handle;
    },
  };
}

export function openOverlay(ctx: ExtensionContext, kind: KlidView): void {
  if (klid.overlayActive) return;
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
      klid.releaseOverlay = close;
      klid.overlayTui = tui;
      if (kind === "spai") return new SpaiDashboard(tui, theme, ctx.cwd, close);
      if (kind === "kanban") {
        return new KanbanBoard({
          tui,
          cwd: ctx.cwd,
          close,
          height: () => klid.lastCoverHeight,
        });
      }
      return new QuietCover(theme);
    },
    overlayOptions(kind),
  );

  klid.overlayActive = true;
  view
    .catch(() => undefined)
    .finally(() => {
      klid.overlayActive = false;
      klid.releaseOverlay = null;
      klid.overlayHandle = null;
      klid.overlayTui = null;
    });
}
export function realizeFromBoard(ctx: ExtensionContext, record: SpaiBoardRecord): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.setEditorText(formatRealizePrompt(record));
    ctx.ui.notify(`Inserted ${pinkGlow(record.id)} into the prompt.`, "info");
  } catch {
    // Editor not reachable (non-TUI host) — nothing else to do.
  }
}

export function closeOverlay(): void {
  const release = klid.releaseOverlay;
  klid.releaseOverlay = null;
  if (release) {
    release();
  } else {
    // Stale overlay with a lost release callback (e.g. after an extension
    // reload): remove it directly so it cannot keep covering the editor.
    try {
      klid.overlayHandle?.hide();
    } catch {
      // Already gone.
    }
  }
  klid.overlayHandle = null;
  klid.overlayTui = null;
  klid.overlayActive = false;
}

// ---------------------------------------------------------------------------
// Apply quiet state to the host UI
// ---------------------------------------------------------------------------

export function applyQuietUi(ctx: ExtensionContext, running: boolean): void {
  if (!ctx.hasUI) return;
  if (running) {
    ctx.ui.setWorkingMessage("Working...");
    ctx.ui.setWorkingIndicator(quietWorkingIndicator(ctx.ui.theme));
    klid.workingTouched = true;
  } else {
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
    klid.workingTouched = false;
  }
}

export function setEnabled(ctx: ExtensionContext, on: boolean, isGlobal = false): void {
  klid.enabled = on;
  saveConfig({ enabled: on, view: klid.view }, isGlobal, klid.cwd);
  if (ctx.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, on ? "quiet" : undefined);
  }
  if (on) {
    // Make sure the quiet working row is armed for the next run.
    applyQuietUi(ctx, false);
  }
}

export const VIEW_LABELS: Record<KlidView, string> = {
  cover: "quiet cover",
  spai: "SPAI dashboard",
  kanban: "SPAI kanban board",
};

export function setView(ctx: ExtensionContext, view: KlidView, isGlobal = false): void {
  klid.view = view;
  saveConfig({ enabled: klid.enabled, view }, isGlobal, klid.cwd);
  if (ctx.hasUI) {
    ctx.ui.notify(
      `klid: working view → ${VIEW_LABELS[view]}${isGlobal ? " (saved globally)" : " (saved for this project)"}`,
      "info",
    );
  }
}
