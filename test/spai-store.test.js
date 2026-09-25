/**
 * Characterization tests for the filesystem half of `spai.ts` — the index, the
 * record writer and the status rewriter. Everything runs against a throwaway
 * temp directory, so these pin the on-disk format without touching a real ledger.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getSpaiDir,
	loadIndex,
	readRecordBody,
	saveRecord,
	updateRecordStatus,
} from "../spai.js";

/** A temp cwd with a ledger dir, cleaned up after the test. */
function makeCwd(t, { withDir = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-klid-spai-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	if (withDir) mkdirSync(join(dir, "docs", "spai"), { recursive: true });
	return dir;
}

/** Local-date prefix, matching how saveRecord names files. */
function todayPrefix() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// --- getSpaiDir --------------------------------------------------------------

test("getSpaiDir prefers docs/spai, then .pi/spai, then defaults", (t) => {
	const bare = makeCwd(t, { withDir: false });
	assert.equal(getSpaiDir(bare), join(bare, "docs", "spai"), "default when nothing exists");

	mkdirSync(join(bare, ".pi", "spai"), { recursive: true });
	assert.equal(getSpaiDir(bare), join(bare, ".pi", "spai"), ".pi/spai beats the default");

	mkdirSync(join(bare, "docs", "spai"), { recursive: true });
	assert.equal(getSpaiDir(bare), join(bare, "docs", "spai"), "docs/spai wins overall");
});

// --- loadIndex ---------------------------------------------------------------

test("loadIndex returns an empty index when the ledger dir is absent", (t) => {
	const bare = makeCwd(t, { withDir: false });
	assert.deepEqual(loadIndex(bare), { version: 1, lastUpdated: "", records: [] });
});

test("loadIndex scans markdown files, skipping dotfiles and non-markdown", (t) => {
	const cwd = makeCwd(t);
	const dir = join(cwd, "docs", "spai");
	writeFileSync(join(dir, "2026-01-01-SPAI-002-two.md"), "---\ntype: Todo\nstatus: todo\n---\n# SPAI-002: Two\n\nBody two\n");
	writeFileSync(join(dir, "2026-01-01-SPAI-001-one.md"), "---\ntype: Note\nstatus: note\n---\n# SPAI-001: One\n\nBody one :frombody:\n");
	writeFileSync(join(dir, "notes.txt"), "ignored");
	writeFileSync(join(dir, ".hidden.md"), "# ignored\n");

	const idx = loadIndex(cwd);
	assert.deepEqual(idx.records.map((r) => r.id), ["SPAI-001", "SPAI-002"], "sorted by id number");
	assert.equal(idx.records.length, 2);
	assert.equal(idx.records[0].file, "2026-01-01-SPAI-001-one.md");
	assert.deepEqual(idx.records[0].tags, ["frombody"], "tags come from the body");
	assert.equal(idx.records[0].symbol, "", "the scan path leaves symbol empty");
	assert.equal(idx.records[0].timestamp, "");
});

test("loadIndex trusts a valid .index.json and filters junk records", (t) => {
	const cwd = makeCwd(t);
	writeFileSync(
		join(cwd, "docs", "spai", ".index.json"),
		JSON.stringify({
			records: [
				{ id: "SPAI-009", title: "X", type: "Todo", status: "todo", symbol: "", timestamp: "", tags: [], file: "f.md" },
				{ nope: true },
				null,
			],
		}),
	);
	const idx = loadIndex(cwd);
	assert.equal(idx.version, 1, "missing version defaults to 1");
	assert.equal(idx.lastUpdated, "");
	assert.equal(idx.records.length, 1, "records without a string id are dropped");
	assert.equal(idx.records[0].id, "SPAI-009");
});

test("loadIndex falls back to a scan when .index.json is corrupt", (t) => {
	const cwd = makeCwd(t);
	const dir = join(cwd, "docs", "spai");
	writeFileSync(join(dir, ".index.json"), "{ not json");
	writeFileSync(join(dir, "2026-01-01-SPAI-003-three.md"), "---\ntype: Todo\nstatus: todo\n---\n# SPAI-003: Three\n\nBody\n");
	assert.deepEqual(loadIndex(cwd).records.map((r) => r.id), ["SPAI-003"]);
});

// --- saveRecord --------------------------------------------------------------

test("saveRecord writes the markdown file and updates the index", (t) => {
	const cwd = makeCwd(t);
	const saved = saveRecord(cwd, ". Buy milk");
	assert.deepEqual(saved, { id: "SPAI-001", title: "Buy milk" });

	const idx = loadIndex(cwd);
	assert.equal(idx.records.length, 1);
	const entry = idx.records[0];
	assert.equal(entry.file, `${todayPrefix()}-SPAI-001-buy-milk.md`);
	assert.ok(existsSync(join(cwd, "docs", "spai", entry.file)), "file exists on disk");
	assert.ok(idx.lastUpdated.length > 0, "index is stamped");

	const md = readFileSync(join(cwd, "docs", "spai", entry.file), "utf8");
	assert.match(md, /^---\n/);
	assert.match(md, /^type: Todo$/m);
	assert.match(md, /^title: "Buy milk"$/m);
	assert.match(md, /^status: todo$/m);
	assert.match(md, /^source: pi-klid$/m);
	assert.match(md, /^# SPAI-001: Buy milk$/m);
	assert.ok(md.endsWith(". Buy milk\n"), "the raw text is kept at the end");
});

test("saveRecord allocates the next id from the existing index", (t) => {
	const cwd = makeCwd(t);
	assert.equal(saveRecord(cwd, ". First").id, "SPAI-001");
	assert.equal(saveRecord(cwd, ". Second").id, "SPAI-002");
	assert.equal(saveRecord(cwd, ". Third").id, "SPAI-003");
	assert.deepEqual(loadIndex(cwd).records.map((r) => r.id), ["SPAI-001", "SPAI-002", "SPAI-003"]);
});

test("saveRecord records facets and escapes quotes in the title", (t) => {
	const cwd = makeCwd(t);
	const a = saveRecord(cwd, ". ! Urgent :alpha:beta: @2026-01-02");
	const b = saveRecord(cwd, ". Ship @2.1.2026");
	const c = saveRecord(cwd, '. Quote "inside"');
	const d = saveRecord(cwd, ". No year @2.1.");

	const byId = Object.fromEntries(loadIndex(cwd).records.map((r) => [r.id, r]));
	assert.equal(byId[a.id].priority, "high");
	assert.deepEqual(byId[a.id].tags, ["alpha", "beta"]);
	assert.equal(byId[a.id].deadline, "2026-01-02");
	assert.equal(byId[a.id].title, "Urgent");
	assert.equal(byId[b.id].deadline, "2026-01-02", "dotted deadline normalised to ISO");
	assert.equal(byId[d.id].deadline, `${new Date().getFullYear()}-01-02`, "year defaults to now");
	assert.match(
		readFileSync(join(cwd, "docs", "spai", byId[c.id].file), "utf8"),
		/^title: "Quote \\"inside\\""$/m,
		"quotes are escaped in the frontmatter",
	);
});

test("saveRecord gives an untitled record a fallback slug", (t) => {
	const cwd = makeCwd(t);
	const { id, title } = saveRecord(cwd, "? :tag:");
	assert.equal(title, "New item");
	assert.equal(loadIndex(cwd).records[0].file, `${todayPrefix()}-${id}-new-item.md`);
});

// --- updateRecordStatus ------------------------------------------------------

test("updateRecordStatus rewrites the prefix on the first body line", (t) => {
	const cwd = makeCwd(t);
	const { id } = saveRecord(cwd, ". Original task");

	assert.equal(updateRecordStatus(cwd, id, "done"), true);
	const entry = loadIndex(cwd).records.find((r) => r.id === id);
	assert.equal(entry.status, "done");
	assert.equal(entry.symbol, "x");
	assert.equal(readRecordBody(cwd, entry), "x Original task", "body carries the new prefix");
	assert.ok(loadIndex(cwd).lastUpdated.length > 0);

	const raw = readFileSync(join(cwd, "docs", "spai", entry.file), "utf8");
	assert.equal(/# SPAI-/.test(raw), false, "the '# ID: title' header is dropped on rewrite");
	// Pinned quirk: the frontmatter is copied verbatim, so its `status:` goes stale
	// and disagrees with the index until something rewrites the file.
	assert.match(raw, /^status: todo$/m, "frontmatter status is NOT rewritten");
});

test("updateRecordStatus promotes an Idea once it becomes actionable", (t) => {
	const cwd = makeCwd(t);
	const { id } = saveRecord(cwd, "? Great idea");
	assert.equal(loadIndex(cwd).records[0].type, "Idea");

	assert.equal(updateRecordStatus(cwd, id, "working"), true);
	assert.equal(loadIndex(cwd).records[0].type, "Todo", "idea -> todo when worked on");
	assert.equal(loadIndex(cwd).records[0].symbol, "/");

	const { id: other } = saveRecord(cwd, "? Another idea");
	assert.equal(updateRecordStatus(cwd, other, "done"), true);
	assert.equal(loadIndex(cwd).records.find((r) => r.id === other).type, "Idea", "done does not promote");
});

test("updateRecordStatus reports failure for unknown ids and missing files", (t) => {
	const cwd = makeCwd(t);
	assert.equal(updateRecordStatus(cwd, "SPAI-999", "done"), false, "unknown id");

	const { id } = saveRecord(cwd, ". Vanishing task");
	const entry = loadIndex(cwd).records[0];
	rmSync(join(cwd, "docs", "spai", entry.file));
	assert.equal(updateRecordStatus(cwd, id, "done"), false, "file removed behind our back");
});

// --- readRecordBody ----------------------------------------------------------

test("readRecordBody returns the body and is empty for a missing file", (t) => {
	const cwd = makeCwd(t);
	const { id } = saveRecord(cwd, "- A note :tag:");
	const entry = loadIndex(cwd).records.find((r) => r.id === id);
	assert.equal(readRecordBody(cwd, entry), "- A note :tag:");

	assert.equal(readRecordBody(cwd, { ...entry, file: "does-not-exist.md" }), "");
});
