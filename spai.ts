/**
 * Minimal self-contained SPAI ledger reader/writer for pi-klid.
 *
 * Format is 1:1 compatible with pi-spai / mozek_rust:
 *   docs/spai/
 *   ├── .index.json              # fast index (status, tags, deadlines)
 *   └── YYYY-MM-DD-SPAI-NNN-*.md # SPAI markdown with YAML frontmatter
 *
 * First non-empty line decides type/status:
 *   .   todo       /   working       /.  waiting
 *   x   done       z   cancelled     ?   idea      -   note
 *   !   high priority        @YYYY-MM-DD deadline        :tag: chained tags
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

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

interface PrefixDef {
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

const DEFAULT_SPAI_DIR = join("docs", "spai");
const CANDIDATES = [join("docs", "spai"), join(".pi", "spai")];
const INDEX_FILENAME = ".index.json";

export function getSpaiDir(cwd: string): string {
  for (const cand of CANDIDATES) {
    const full = join(cwd, cand);
    if (existsSync(full)) return full;
  }
  return join(cwd, DEFAULT_SPAI_DIR);
}

function matchPrefix(line: string): PrefixDef | null {
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

function extractMeta(raw: string): {
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

function formatDateTime(d = new Date()): string {
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
  _fileName = "",
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
  const hm =
    body.match(/^#\s*(SPAI-\d+)?:\s*(.+)$/m) || body.match(/^#\s*(.+)$/m);
  let id = "SPAI-001";
  let title = "Untitled";
  if (hm) {
    if (hm[1]) id = hm[1].trim();
    if (hm[2]) title = hm[2].trim();
    else if (hm[1]) title = hm[1].trim();
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
export function loadIndex(cwd: string): SpaiIndex {
  const dir = getSpaiDir(cwd);
  const indexPath = join(dir, INDEX_FILENAME);
  try {
    const raw = readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw) as SpaiIndex;
    if (parsed && Array.isArray(parsed.records)) {
      return {
        version: parsed.version ?? 1,
        lastUpdated: parsed.lastUpdated ?? "",
        records: parsed.records.filter(
          (r): r is SpaiIndexEntry => !!r && typeof r.id === "string",
        ),
      };
    }
  } catch {
    // fall through to scan
  }

  const entries: SpaiIndexEntry[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md") || file.startsWith(".")) continue;
      const content = readFileSync(join(dir, file), "utf8");
      const parsed = parseSpaiMarkdown(content, file);
      if (!parsed) continue;
      const meta = extractMeta(parsed.body);
      entries.push({
        id: parsed.id,
        title: parsed.title,
        type: parsed.type,
        status: parsed.status,
        symbol: "",
        timestamp: "",
        tags: meta.tags,
        priority: meta.priority,
        deadline: meta.deadline,
        file,
      });
    }
  } catch {
    // No spai dir yet
  }
  entries.sort((a, b) => idNum(a.id) - idNum(b.id));
  return { version: 1, lastUpdated: "", records: entries };
}

function idNum(id: string): number {
  const m = id.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${Date.now()}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSyncSafe(tmp, path);
  } finally {
    try {
      rmSafe(tmp);
    } catch {
      // ignore
    }
  }
}

function renameSyncSafe(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    rmSafe(to);
    renameSync(from, to);
  }
}
function rmSafe(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    // ignore
  }
}

function nextId(records: Array<{ id: string }>): string {
  let max = 0;
  for (const r of records) {
    const m = r.id.match(/^SPAI-(\d+)$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `SPAI-${(max + 1).toString().padStart(3, "0")}`;
}

function formatFrontmatter(rec: {
  type: SpaiNoteType;
  title: string;
  timestamp: string;
  status: SpaiStatus;
  tags: string[];
  priority?: SpaiPriority;
  deadline?: string;
  project: string;
  symbol: string;
}): string[] {
  const lines = [
    "---",
    `type: ${rec.type}`,
    `title: "${(rec.title || "").replace(/"/g, '\\"')}"`,
    `timestamp: ${rec.timestamp}`,
    `status: ${rec.status}`,
    "source: pi-klid",
  ];
  if (rec.tags.length > 0) lines.push(`tags: [${rec.tags.join(", ")}]`);
  if (rec.priority || rec.deadline || rec.project) {
    lines.push("facets:");
    if (rec.priority) lines.push(`  priority: ${rec.priority}`);
    if (rec.deadline) lines.push(`  deadline: ${rec.deadline}`);
    if (rec.project) lines.push(`  project: ${rec.project}`);
  }
  if (rec.symbol) lines.push(`spai_symbol: '${rec.symbol}'`);
  lines.push("---", "");
  return lines;
}

/** Saves a new raw SPAI item (mirrors pi-spai saveRecord). */
export function saveRecord(
  cwd: string,
  rawText: string,
): { id: string; title: string } {
  const dir = getSpaiDir(cwd);
  mkdirSync(dir, { recursive: true });
  const index = loadIndex(cwd);
  const parsed = parseSpai(rawText);
  const meta = extractMeta(rawText);

  const id = nextId(index.records);
  const timestamp = formatDateTime();
  const datePrefix = timestamp.split(" ")[0] ?? "2026-08-27";
  const slug = slugify(parsed.title) || "polozka";
  const fileName = `${datePrefix}-${id}-${slug}.md`;

  const record = {
    id,
    title: parsed.title,
    type: parsed.type,
    status: parsed.status,
    symbol: parsed.symbol,
    timestamp,
    tags: meta.tags,
    priority: meta.priority,
    deadline: meta.deadline,
    project: basename(cwd),
  };

  const frontmatter = formatFrontmatter({ ...record, project: basename(cwd) });
  const markdown = `${frontmatter.join("\n")}\n# ${id}: ${parsed.title}\n\n${rawText.trim()}\n`;
  atomicWrite(join(dir, fileName), markdown);

  const entry: SpaiIndexEntry = {
    id,
    title: parsed.title,
    type: parsed.type,
    status: parsed.status,
    symbol: parsed.symbol,
    timestamp,
    tags: meta.tags,
    priority: meta.priority,
    deadline: meta.deadline,
    file: fileName,
  };
  index.records = index.records.filter((r) => r.id !== id);
  index.records.push(entry);
  index.records.sort((a, b) => idNum(a.id) - idNum(b.id));
  index.lastUpdated = formatDateTime();
  atomicWrite(join(dir, INDEX_FILENAME), JSON.stringify(index, null, 2) + "\n");

  return { id, title: parsed.title };
}

/** Cycles a SPAI item's status and rewrites its file + index. */
export function updateRecordStatus(
  cwd: string,
  id: string,
  nextStatus: SpaiStatus,
): boolean {
  const dir = getSpaiDir(cwd);
  const index = loadIndex(cwd);
  const entry = index.records.find((r) => r.id === id);
  if (!entry) return false;

  const filePath = join(dir, entry.file);
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, "utf8");
  const parsed = parseSpaiMarkdown(content, entry.file);
  if (!parsed) return false;

  const { prefix, symbol } = getStatusPrefix(nextStatus);
  const lines = parsed.body.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx === -1) return false;
  const rawLine = lines[firstIdx] ?? "";
  const trimmed = rawLine.trimStart();
  const indent = rawLine.slice(0, rawLine.length - trimmed.length);
  const prefixMatch = matchPrefix(trimmed);
  lines[firstIdx] = `${indent}${prefix}${prefixMatch ? trimmed.slice(prefixMatch.prefix.length) : trimmed}`;

  const oldFrontmatter = content.slice(0, content.indexOf("---", 4) + 3);
  const newBody = `${oldFrontmatter}\n${lines.join("\n")}\n`;
  atomicWrite(filePath, newBody);

  entry.status = nextStatus;
  entry.symbol = symbol;
  if (entry.type === "Idea" && (nextStatus === "todo" || nextStatus === "working")) {
    entry.type = "Todo";
  }
  index.lastUpdated = formatDateTime();
  atomicWrite(join(dir, INDEX_FILENAME), JSON.stringify(index, null, 2) + "\n");
  return true;
}

/** Reads a full item body (after frontmatter + header) for the detail view. */
export function readRecordBody(cwd: string, entry: SpaiIndexEntry): string {
  const dir = getSpaiDir(cwd);
  try {
    const content = readFileSync(join(dir, entry.file), "utf8");
    const parsed = parseSpaiMarkdown(content, entry.file);
    return parsed?.body || "";
  } catch {
    return "";
  }
}