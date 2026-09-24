import { type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { klid } from "./state.js";

// ---------------------------------------------------------------------------
// Full-screen breathing overlay
// ---------------------------------------------------------------------------

/**
 * Static, opaque cover for the transcript region only. Renders a single dim
 * "Working..." line at the vertical center. No animation, no color cycling,
 * no timers — nothing to stare at, it only signals that work is in progress.
 * The bottom band (working row + input editor + footer) is never painted over.
 */
export class QuietCover implements Component {
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
    const H = Math.max(8, klid.lastCoverHeight);

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
// Kanban view: delegate to pi-spai's own board when it is installed
// ---------------------------------------------------------------------------

/**
 * pi-spai's board renders its own fixed height (10 task rows). The quiet cover
 * must stay opaque, so wrap it: same content and colors, padded to the whole
 * reserved transcript region so nothing shows through underneath.
 */
export function padToCover(inner: Component, width: number): string[] {
  const rows = Math.max(8, klid.lastCoverHeight);
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
