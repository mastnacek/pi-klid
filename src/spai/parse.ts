/**
 * SPAI ledger text parsing — the document prefix grammar, facet extraction and
 * status cycling. All pure functions: no filesystem access lives here.
 */

import type { SpaiNoteType, SpaiPriority, SpaiStatus } from "./types.js";

export interface PrefixDef {
  prefix: string;
  symbol: string;
  type: SpaiNoteType;
  status: SpaiStatus;
}

const PREFIXES: PrefixDef[] = [
  { prefix: "/. ", symbol: "/.", type: "Todo", status: "waiting" },
  { prefix: ". ", symbol: ".", type: "Todo", status: "todo" },
  { prefix: "/ ", symbol: "/", type: "Todo", status: "working" },
  { prefix: "x ", symbol: "x", type: "Todo", status: "done" },
  { prefix: "X ", symbol: "x", type: "Todo", status: "done" },
  { prefix: "z ", symbol: "z", type: "Todo", status: "cancelled" },
  { prefix: "Z ", symbol: "z", type: "Todo", status: "cancelled" },
  { prefix: "- ", symbol: "-", type: "Note", status: "note" },
  { prefix: "? ", symbol: "?", type: "Idea", status: "idea" },
  { prefix: "# ", symbol: "", type: "Note", status: "inbox" },
];

export function matchPrefix(line: string): PrefixDef | null {
  for (const def of PREFIXES) {
    if (line.startsWith(def.prefix)) return def;
  }
  return null;
}

function extractTags(text: string): { tags: string[]; clean: string } {
  const tags: string[] = [];
  const re = /(?:^|\s):([A-Za-z0-9_./-]+(?::[A-Za-z0-9_./-]+)*):(?:\s|$)/g;
  const clean = text
    .replace(re, (_m, chain: string) => {
      for (const t of chain.split(":").filter(Boolean)) tags.push(t.toLowerCase());
      return " ";
    })
    .trim();
  return { tags: Array.from(new Set(tags)), clean };
}

export function extractMeta(raw: string): {
  priority?: SpaiPriority;
  deadline?: string;
  tags: string[];
  clean: string;
} {
  let priority: SpaiPriority | undefined;
  let text = raw;
  const prioRe = /(?:^|\s)!(?:\s|$)/;
  if (prioRe.test(text)) {
    priority = "high";
    text = text.replace(prioRe, " ").trim();
  }

  let deadline: string | undefined;
  const deadRe =
    /(?:^|\s)@(?:(\d{4}-\d{2}-\d{2})|(\d{1,2}\.\d{1,2}\.(?:\d{4})?))(?:\s|$)/;
  const dm = text.match(deadRe);
  if (dm) {
    if (dm[1]) {
      deadline = dm[1];
    } else if (dm[2]) {
      const parts = dm[2].split(".").filter(Boolean);
      const dd = (parts[0] ?? "").padStart(2, "0");
      const mm = (parts[1] ?? "").padStart(2, "0");
      const yyyy = (parts[2] || new Date().getFullYear().toString()).toString();
      deadline = `${yyyy}-${mm}-${dd}`;
    }
    text = text.replace(deadRe, " ").trim();
  }

  const t = extractTags(text);
  return { priority, deadline, tags: t.tags, clean: t.clean };
}

/** Parses the first non-empty line into an item type/status + title. */

export function parseSpai(
  text: string,
): { type: SpaiNoteType; status: SpaiStatus; symbol: string; title: string } {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.trim().length > 0);
  if (idx === -1) {
    return { type: "Note", status: "inbox", symbol: "", title: "Empty" };
  }
  const raw = lines[idx] ?? "";
  const prefix = matchPrefix(raw);
  const type: SpaiNoteType = prefix?.type ?? "Note";
  const status: SpaiStatus = prefix?.status ?? (type === "Todo" ? "todo" : "note");
  const symbol = prefix?.symbol ?? "";
  let title = prefix ? raw.slice(prefix.prefix.length).trim() : raw.trim();
  if (title.startsWith("# ")) title = title.slice(2).trim();
  title = extractMeta(title).clean || "New item";
  return { type, status, symbol, title };
}

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function formatDateTime(d = new Date()): string {
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function getStatusPrefix(status: SpaiStatus): { prefix: string; symbol: string } {
  switch (status) {
    case "working":
      return { prefix: "/ ", symbol: "/" };
    case "waiting":
      return { prefix: "/. ", symbol: "/." };
    case "done":
      return { prefix: "x ", symbol: "x" };
    case "cancelled":
      return { prefix: "z ", symbol: "z" };
    case "idea":
      return { prefix: "? ", symbol: "?" };
    case "note":
      return { prefix: "- ", symbol: "-" };
    case "todo":
    default:
      return { prefix: ". ", symbol: "." };
  }
}

export function cycleStatus(current: SpaiStatus, type: SpaiNoteType): SpaiStatus {
  if (type === "Idea") {
    if (current === "idea") return "todo";
    if (current === "todo") return "working";
    if (current === "working") return "waiting";
    if (current === "waiting") return "done";
    if (current === "done") return "cancelled";
    return "idea";
  }
  if (type === "Note") {
    if (current === "note") return "todo";
    if (current === "todo") return "done";
    return "note";
  }
  switch (current) {
    case "todo":
      return "working";
    case "working":
      return "waiting";
    case "waiting":
      return "done";
    case "done":
      return "cancelled";
    case "cancelled":
    default:
      return "todo";
  }
}

/** Parses a SPAI markdown file (YAML frontmatter + `# ID: title` header). */

export function parseSpaiMarkdown(
  content: string,
  fileName = "",
): { id: string; title: string; type: SpaiNoteType; status: SpaiStatus; body: string } | null {
  let yamlRaw = "";
  let body = content;
  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) {
      yamlRaw = content.slice(4, end).trim();
      body = content.slice(end + 4).trimStart().replace(/^\n/, "");
    }
  }
  // The header may or may not carry the id. The fallback regex captures the TITLE,
  // so the two shapes have to be distinguished — otherwise the header text ends up
  // in `id` and every id-less file gets a title for an id.
  const withId = body.match(/^#\s*(SPAI-\d+):\s*(.+)$/m);
  const plainHeader = body.match(/^#\s*(.+)$/m);
  // Without a header id, fall back to the id in the file name (`saveRecord` writes
  // `YYYY-MM-DD-SPAI-NNN-slug.md`) so id-less files cannot all collapse onto SPAI-001.
  let id = fileName.match(/SPAI-\d+/i)?.[0]?.toUpperCase() ?? "SPAI-001";
  let title = "Untitled";
  if (withId) {
    id = withId[1].trim();
    title = withId[2].trim();
  } else if (plainHeader) {
    title = plainHeader[1].trim();
  }
  const cleanBody = body.replace(/^#\s*.+$/m, "").trim();
  const parsed = parseSpai(cleanBody || title);
  let type: SpaiNoteType = parsed.type;
  let status: SpaiStatus = parsed.status;
  if (yamlRaw) {
    const tm = yamlRaw.match(/^type:\s*(.+)$/m);
    if (tm) type = tm[1].trim() as SpaiNoteType;
    const sm = yamlRaw.match(/^status:\s*(.+)$/m);
    if (sm) status = sm[1].trim() as SpaiStatus;
  }
  return { id, title, type, status, body: cleanBody };
}

/** Builds the index in memory: reads `.index.json` or scans `*.md` files. */
