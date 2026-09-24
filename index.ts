/**
 * pi-klid — Quiet zen mode for the pi coding agent (composition root).
 *
 * `/klid on` hides thinking blocks at the render level and, while the agent is
 * running, covers every tool call / streaming update behind a quiet surface:
 * either the static "Working..." cover, a live SPAI task list, or the SPAI
 * kanban board. When the agent settles, the overlay dissolves and only the
 * clean final answer is revealed.
 *
 * Module graph (one direction, acyclic):
 *   index -> command -> overlay -> cover
 *                    -> spai-flows -> overlay, cover
 *   all -> types (config cascade) -> state
 *
 * Config cascade: defaults <- ~/.pi/agent/pi-klid.json <- <cwd>/.pi/pi-klid.json,
 * with `/klid --global <sub>` writing the global layer.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerKlidCommand } from "./src/command.js";
import { applyQuietUi, closeOverlay, openOverlay } from "./src/overlay.js";
import { runDelegatedKanban } from "./src/spai-flows.js";
import { loadSpaiBoard } from "./spai-board.js";
import { klid } from "./src/state.js";
import {
  KLID_VIEWS,
  STATUS_KEY,
  STATE_ENTRY_TYPE,
  loadConfig,
  type KlidView,
} from "./src/types.js";

export type { KlidView, KlidConfig } from "./src/types.js";

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
      pi.appendEntry(STATE_ENTRY_TYPE, { enabled: klid.enabled, view: klid.view });
    } catch {
      // Best-effort: a missing session must not break the command.
    }
  };

  // Hiding thinking: display-only transformer. While quiet mode is on, thinking
  // blocks (live + history) render as nothing. Session/model context untouched.
  pi.registerMarkdownTransformer((markdown, context) => {
    if (klid.enabled && context.messageType === "assistant-thinking") return "";
    return markdown;
  });

  track(pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // A fresh/rebound session must never inherit a stale overlay that would
    // keep covering the editor while the agent is idle.
    closeOverlay();
    klid.cwd = ctx.cwd;
    const cfg = loadConfig(ctx.cwd);
    klid.enabled = cfg.enabled;
    klid.view = cfg.view;
    // Session entry (branch-aware) wins over the config cascade, last one wins.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as { enabled?: boolean; view?: KlidView } | undefined;
        if (typeof data?.enabled === "boolean") klid.enabled = data.enabled;
        if (data?.view && KLID_VIEWS.includes(data.view)) klid.view = data.view;
      }
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, klid.enabled ? "quiet" : undefined);
    }
  }));

  track(pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
    if (!klid.enabled) return;
    applyQuietUi(ctx, true);
    if (klid.view === "kanban") {
      // Prefer pi-spai's own board; the local one is only a fallback.
      const mod = await loadSpaiBoard();
      if (mod) {
        void runDelegatedKanban(ctx, mod);
        return;
      }
    }
    openOverlay(ctx, klid.view);
  }));

  // Fully settles only when no retry/compaction/continuation is left — that is
  // exactly when the user can look at the answer again.
  track(pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    if (!klid.enabled) {
      closeOverlay();
      if (klid.workingTouched) applyQuietUi(ctx, false);
      return;
    }
    closeOverlay();
    applyQuietUi(ctx, false);
  }));

  // Safety net: a fresh prompt while an overlay is somehow still open.
  track(pi.on("input", async (_event, ctx: ExtensionContext) => {
    closeOverlay();
    if (klid.workingTouched) applyQuietUi(ctx, false);
  }));

  pi.on("session_shutdown", async () => {
    while (unsubscribers.length > 0) unsubscribers.pop()?.();
    closeOverlay();
  });

  registerKlidCommand(pi, persistEntry);
}
