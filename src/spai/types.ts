/**
 * SPAI ledger data model — the shapes shared by the parser and the store.
 *
 * Split out of `spai.ts`; the format is 1:1 compatible with pi-spai / mozek_rust.
 */

export type SpaiNoteType = "Note" | "Todo" | "Idea";

export type SpaiStatus =
  | "todo"
  | "working"
  | "waiting"
  | "done"
  | "cancelled"
  | "note"
  | "idea"
  | "inbox";

export type SpaiPriority = "high" | "medium" | "low";

export interface SpaiIndexEntry {
  id: string;
  title: string;
  type: SpaiNoteType;
  status: SpaiStatus;
  symbol: string;
  timestamp: string;
  tags: string[];
  priority?: SpaiPriority;
  deadline?: string;
  file: string;
}

export interface SpaiIndex {
  version: number;
  lastUpdated: string;
  records: SpaiIndexEntry[];
}
