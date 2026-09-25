/**
 * Interactive SPAI flows delegated to from the quiet kanban view. Kept apart
 * from cover.ts so the overlay graph stays acyclic:
 *   spai-flows -> overlay -> cover
 */
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component } from "@earendil-works/pi-tui";
import { klid, reservedRows } from "./state.js";
import { padToCover } from "./cover.js";
import { overlayOptions, realizeFromBoard } from "./overlay.js";
import { type SpaiBoardModule, type SpaiBoardRecord } from "../spai-board.js";
import { pinkGlow } from "../palette.js";

export async function runDelegatedKanban(ctx: ExtensionContext, mod: SpaiBoardModule): Promise<void> {
  while (!klid.overlayActive) {
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
        klid.releaseOverlay = close;
        klid.overlayTui = tui;
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

    klid.overlayActive = true;
    await view.catch(() => undefined);
    klid.overlayActive = false;
    klid.releaseOverlay = null;
    klid.overlayHandle = null;
    klid.overlayTui = null;

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
export async function runNewItemFlow(ctx: ExtensionContext, mod: SpaiBoardModule): Promise<void> {
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
export async function showReaderOverlay(
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
          const body = Math.max(6, klid.lastCoverHeight - 2);
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
          klid.lastCoverHeight = Math.max(8, h - reservedRows(klid.overlayTui, w, h));
          return true;
        },
      },
    },
  );
  return outcome;
}

/** Mirrors pi-spai's `r` (realize): put the item in the prompt, do not send it. */

