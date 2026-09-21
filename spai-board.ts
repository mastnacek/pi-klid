/**
 * pi-klid — optional delegation to pi-spai's own kanban board.
 *
 * pi-klid ships a local board as a fallback, but when pi-spai is installed
 * next to it (both live under the same plugins/packages directory, in the dev
 * repo and in the installed git clones alike) the real component from
 * `pi-spai/src/kanban.ts` is used instead: one implementation, one behaviour,
 * no drift between the two boards.
 *
 * pi's extension loader runs on jiti, which resolves `./x.js` to `./x.ts`, so
 * the sibling import works for TypeScript sources without a build step.
 *
 * Nothing here is required: if the import fails, `loadSpaiBoard()` resolves to
 * `null` and the caller keeps its local board.
 */

import type { Component } from "@earendil-works/pi-tui";

export interface SpaiBoardRecord {
  id: string;
  title: string;
  type?: string;
  status?: string;
  priority?: string;
  deadline?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface SpaiBoardModule {
  /** pi-spai's KanbanBoardComponent. */
  BoardComponent: new (options: Record<string, unknown>) => Component;
  loadIndex: (cwd: string) => Promise<unknown>;
  saveRecord: (
    cwd: string,
    text: string,
  ) => Promise<{ id: string; title: string; type?: string; status?: string }>;
  readRecord: (cwd: string, id: string) => Promise<SpaiBoardRecord | undefined>;
  formatReadingMode: (record: SpaiBoardRecord) => string;
}

// Computed specifier: keeps TypeScript from resolving a sibling package that is
// not part of this project's dependency graph.
const KANBAN_SPECIFIER = "../pi-spai/src/kanban.js";
const STORAGE_SPECIFIER = "../pi-spai/src/storage.js";
const VIEWER_SPECIFIER = "../pi-spai/src/viewer.js";

let cached: SpaiBoardModule | null | undefined;
let loadError: string | null = null;

/** Loads pi-spai's board once; `null` means "not installed, use the local one". */
export async function loadSpaiBoard(): Promise<SpaiBoardModule | null> {
  if (cached !== undefined) return cached;
  try {
    const [kanban, storage, viewer] = await Promise.all([
      import(KANBAN_SPECIFIER) as Promise<Record<string, unknown>>,
      import(STORAGE_SPECIFIER) as Promise<Record<string, unknown>>,
      import(VIEWER_SPECIFIER) as Promise<Record<string, unknown>>,
    ]);

    const BoardComponent = kanban["KanbanBoardComponent"] as SpaiBoardModule["BoardComponent"] | undefined;
    const loadIndex = storage["loadIndex"] as SpaiBoardModule["loadIndex"] | undefined;
    const saveRecord = storage["saveRecord"] as SpaiBoardModule["saveRecord"] | undefined;
    const readRecord = storage["readRecord"] as SpaiBoardModule["readRecord"] | undefined;
    const formatReadingMode = viewer["formatReadingMode"] as SpaiBoardModule["formatReadingMode"] | undefined;

    if (!BoardComponent || !loadIndex || !saveRecord || !readRecord || !formatReadingMode) {
      loadError = "pi-spai found but its board API is missing";
      cached = null;
      return cached;
    }

    loadError = null;
    cached = { BoardComponent, loadIndex, saveRecord, readRecord, formatReadingMode };
  } catch (err) {
    // pi-spai absent, renamed, or moved — fall back to the local board.
    loadError = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
    cached = null;
  }
  return cached;
}

/**
 * Which board the kanban view will use, and why. Surfaced by `/klid status` so
 * a silent fallback to the bundled board becomes visible instead of invisible.
 */
export function spaiBoardSource(): { source: "pi-spai" | "local"; detail: string } {
  if (cached) return { source: "pi-spai", detail: "pi-spai's own KanbanBoardComponent" };
  if (cached === undefined) {
    return { source: "local", detail: "not loaded yet — pi-spai's board is tried on the first kanban run" };
  }
  return { source: "local", detail: loadError ?? "pi-spai not installed next to pi-klid" };
}

/** Mirrors pi-spai's internal `formatRealizePrompt`. */
export function formatRealizePrompt(record: SpaiBoardRecord): string {
  const isTask = record.type === "Todo";
  const body = typeof record["body"] === "string" ? (record["body"] as string).trim() : "";
  const bodyText = body ? `\n\n${body}` : "";
  return `Realizuj ${isTask ? "úkol" : "položku"} ${record.id}: ${record.title}${bodyText}`;
}
