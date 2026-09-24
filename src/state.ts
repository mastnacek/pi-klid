import { type Theme } from "@earendil-works/pi-coding-agent";
import { type OverlayHandle, type TUI, type Component } from "@earendil-works/pi-tui";
import { type KlidView } from "./types.js";

/**
 * Session-scoped mutable state. Living in one object keeps every module on the
 * same live values — ESM live bindings do not cover assignments made from
 * another module.
 */
export const klid = {
  enabled: false,
  view: "cover" as KlidView,
  /** Session cwd — the project layer of the config cascade hangs off it. */
  cwd: undefined as string | undefined,
  overlayActive: false,
  releaseOverlay: null as (() => void) | null,
  workingTouched: false,
  lastCoverHeight: 24,
  overlayTui: null as TUI | null,
  overlayHandle: null as OverlayHandle | null,
};

export function bottomBand(termHeight: number): number {
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
export function dockRows(tui: TUI | null, width: number): number {
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
export function reservedRows(tui: TUI | null, termWidth: number, termHeight: number): number {
  const measured = dockRows(tui, termWidth);
  // Keep at least 8 rows of cover so the surface still hides the run.
  if (measured > 0) return Math.min(measured, Math.max(1, termHeight - 8));
  return bottomBand(termHeight);
}
export function quietWorkingIndicator(theme: Theme): { frames: string[]; intervalMs: number } {
  return { frames: [theme.fg("dim", "·")], intervalMs: 1000 };
}
