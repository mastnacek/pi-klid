/**
 * SPAI ledger storage — where the ledger lives, the `.index.json` fast path, the
 * record writer and the status rewriter.
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
import type {
  SpaiIndex,
  SpaiIndexEntry,
  SpaiNoteType,
  SpaiPriority,
  SpaiStatus,
} from "./types.js";
import {
  extractMeta,
  formatDateTime,
  getStatusPrefix,
  matchPrefix,
  parseSpai,
  parseSpaiMarkdown,
  slugify,
} from "./parse.js";

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

  // Rewrite the frontmatter's status (and symbol) rather than copying it verbatim:
  // a stale `status:` contradicts the index, and parseSpaiMarkdown prefers YAML over
  // the body prefix, so any later rescan would read the old status straight back.
  const fmEnd = content.indexOf("---", 4);
  let frontmatter = fmEnd === -1 ? "" : content.slice(0, fmEnd + 3);
  if (/^status:\s*.+$/m.test(frontmatter)) {
    frontmatter = frontmatter.replace(/^status:\s*.+$/m, `status: ${nextStatus}`);
  }
  if (/^spai_symbol:.*$/m.test(frontmatter)) {
    frontmatter = frontmatter.replace(/^spai_symbol:.*$/m, `spai_symbol: '${symbol}'`);
  }

  // The `# ID: title` header belongs to the file, so keep it. Dropping it lost the id
  // for any later scan that had no .index.json to fall back on.
  const header = /^#\s/m.test(content) ? `# ${parsed.id}: ${parsed.title}\n\n` : "";
  const prefixBlock = frontmatter ? `${frontmatter}\n\n` : "";
  atomicWrite(filePath, `${prefixBlock}${header}${lines.join("\n")}\n`);

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
