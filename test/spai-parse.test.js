/**
 * Characterization tests for the pure half of `spai.ts`.
 *
 * The SPAI markdown/frontmatter format is a cross-tool contract ("1:1 compatible
 * with pi-spai / mozek_rust"), so these pin the parsing and status-cycle rules
 * exactly as the shipped code behaves — including the rough edges, which are
 * asserted deliberately rather than silently corrected.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	cycleStatus,
	getStatusPrefix,
	parseSpai,
	parseSpaiMarkdown,
	slugify,
} from "../spai.js";

// --- parseSpai: prefix -> type/status/symbol ---------------------------------

test("parseSpai maps every document prefix to its type and status", () => {
	const cases = [
		[". Buy milk", "Todo", "todo", "."],
		["/ Fix the bug", "Todo", "working", "/"],
		["/. Waiting on review", "Todo", "waiting", "/."],
		["x Shipped it", "Todo", "done", "x"],
		["X Shipped it", "Todo", "done", "x"],
		["z Dropped it", "Todo", "cancelled", "z"],
		["Z Dropped it", "Todo", "cancelled", "z"],
		["- A note", "Note", "note", "-"],
		["? An idea", "Idea", "idea", "?"],
		["# Unsorted inbox item", "Note", "inbox", ""],
	];
	for (const [line, type, status, symbol] of cases) {
		const r = parseSpai(line);
		assert.deepEqual(
			[r.type, r.status, r.symbol],
			[type, status, symbol],
			`prefix mapping for ${JSON.stringify(line)}`,
		);
	}
});

test("parseSpai falls back to a Note when no prefix matches", () => {
	const r = parseSpai("plain text with no prefix");
	assert.deepEqual([r.type, r.status, r.symbol, r.title], ["Note", "note", "", "plain text with no prefix"]);
});

test("parseSpai returns an Empty inbox note for blank input", () => {
	assert.deepEqual(parseSpai(""), { type: "Note", status: "inbox", symbol: "", title: "Empty" });
	assert.deepEqual(parseSpai("\n\n   \n\t\n"), {
		type: "Note",
		status: "inbox",
		symbol: "",
		title: "Empty",
	});
});

test("parseSpai reads the FIRST NON-EMPTY line, not necessarily the first", () => {
	const r = parseSpai("\n\n  \n. Real item\n. Second item");
	assert.deepEqual([r.status, r.title], ["todo", "Real item"]);
});

test("parseSpai only matches a prefix at column 0", () => {
	// Leading whitespace defeats prefix detection — pinned as-is.
	const r = parseSpai("  . Indented item");
	assert.deepEqual([r.type, r.status, r.symbol], ["Note", "note", ""]);
	assert.equal(r.title, ". Indented item");
});

test("parseSpai strips a leading markdown header from the title", () => {
	assert.equal(parseSpai(". # Title after prefix").title, "Title after prefix");
});

test("parseSpai removes priority, deadline and tag facets from the title", () => {
	assert.equal(parseSpai(". ! Urgent thing").title, "Urgent thing");
	assert.equal(parseSpai(". Ship it @2026-01-02").title, "Ship it");
	assert.equal(parseSpai(". Tagged task :alpha:beta:").title, "Tagged task");
	assert.equal(parseSpai(". @2026-01-02 ! Mixed :tag:").title, "Mixed");
});

test("parseSpai falls back to 'New item' when the title is only facets", () => {
	assert.equal(parseSpai(". :tag:").title, "New item");
	assert.equal(parseSpai("x ").title, "New item");
	assert.equal(parseSpai(". ! ").title, "New item");
});

// --- slugify -----------------------------------------------------------------

test("slugify strips diacritics, punctuation and collapses separators", () => {
	assert.equal(slugify("Příliš žluťoučký kůň"), "prilis-zlutoucky-kun");
	assert.equal(slugify("Hello, World!"), "hello-world");
	assert.equal(slugify("  Mixed   Case  "), "mixed-case");
	assert.equal(slugify("under_score-dash"), "under-score-dash");
	assert.equal(slugify("--trim me--"), "trim-me");
});

test("slugify caps the result at 50 characters and can return empty", () => {
	assert.equal(slugify("a".repeat(60)).length, 50);
	assert.equal(slugify(""), "");
	assert.equal(slugify("!!! ???"), "");
});

// --- getStatusPrefix ---------------------------------------------------------

test("getStatusPrefix maps statuses back to their document prefix", () => {
	const expected = {
		working: { prefix: "/ ", symbol: "/" },
		waiting: { prefix: "/. ", symbol: "/." },
		done: { prefix: "x ", symbol: "x" },
		cancelled: { prefix: "z ", symbol: "z" },
		idea: { prefix: "? ", symbol: "?" },
		note: { prefix: "- ", symbol: "-" },
		todo: { prefix: ". ", symbol: "." },
	};
	for (const [status, want] of Object.entries(expected)) {
		assert.deepEqual(getStatusPrefix(status), want, `prefix for ${status}`);
	}
});

test("getStatusPrefix sends inbox (and anything unknown) to the todo prefix", () => {
	assert.deepEqual(getStatusPrefix("inbox"), { prefix: ". ", symbol: "." });
});

// --- cycleStatus -------------------------------------------------------------

test("cycleStatus walks the Todo cycle and wraps", () => {
	const chain = ["todo", "working", "waiting", "done", "cancelled", "todo"];
	for (let i = 0; i < chain.length - 1; i++) {
		assert.equal(cycleStatus(chain[i], "Todo"), chain[i + 1], `${chain[i]} -> ${chain[i + 1]}`);
	}
	assert.equal(cycleStatus("note", "Todo"), "todo", "unknown states land on todo");
});

test("cycleStatus walks the Idea cycle and converts through todo", () => {
	assert.equal(cycleStatus("idea", "Idea"), "todo");
	assert.equal(cycleStatus("todo", "Idea"), "working");
	assert.equal(cycleStatus("working", "Idea"), "waiting");
	assert.equal(cycleStatus("waiting", "Idea"), "done");
	assert.equal(cycleStatus("done", "Idea"), "cancelled");
	assert.equal(cycleStatus("cancelled", "Idea"), "idea", "wraps back to idea");
});

test("cycleStatus collapses the Note cycle to three states", () => {
	assert.equal(cycleStatus("note", "Note"), "todo");
	assert.equal(cycleStatus("todo", "Note"), "done");
	assert.equal(cycleStatus("done", "Note"), "note");
	assert.equal(cycleStatus("cancelled", "Note"), "note");
});

// --- parseSpaiMarkdown -------------------------------------------------------

test("parseSpaiMarkdown reads the header id/title and the frontmatter overrides", () => {
	const content = "---\ntype: Todo\nstatus: done\n---\n# SPAI-005: My title\n\nBody text\n";
	const r = parseSpaiMarkdown(content, "SPAI-005-my-title.md");
	assert.ok(r, "never returns null");
	assert.equal(r.id, "SPAI-005");
	assert.equal(r.title, "My title");
	assert.equal(r.type, "Todo");
	assert.equal(r.status, "done");
	assert.equal(r.body, "Body text");
});

test("parseSpaiMarkdown derives type/status from the body when frontmatter omits them", () => {
	const r = parseSpaiMarkdown("---\ntitle: x\n---\n. Todo item\n");
	assert.ok(r);
	assert.equal(r.type, "Todo");
	assert.equal(r.status, "todo");
	assert.equal(r.title, "Untitled", "no header means no title");
	assert.equal(r.body, ". Todo item");
});

test("parseSpaiMarkdown puts a header without a SPAI id into the id field", () => {
	const r = parseSpaiMarkdown("# Just a title\n\nBody\n");
	assert.ok(r);
	// Pinned quirk: the fallback regex captures the title, which the code then
	// treats as the id — so any other .md in the ledger dir gets the header text as id.
	assert.equal(r.id, "Just a title");
	assert.equal(r.title, "Just a title");
});

test("parseSpaiMarkdown survives content with no header and no frontmatter", () => {
	const r = parseSpaiMarkdown("just body text");
	assert.ok(r);
	assert.deepEqual([r.id, r.title, r.type, r.status, r.body], [
		"SPAI-001",
		"Untitled",
		"Note",
		"note",
		"just body text",
	]);
	assert.ok(parseSpaiMarkdown("", "empty.md"), "empty content still yields a record");
});

test("parseSpaiMarkdown treats an unterminated frontmatter block as body", () => {
	const r = parseSpaiMarkdown("---\ntype: Todo\n# SPAI-007: Unclosed\n");
	assert.ok(r);
	assert.equal(r.id, "SPAI-007");
	assert.equal(r.title, "Unclosed");
	// No closing delimiter means no YAML is applied, so the body's own first line
	// ("---") decides the type and matches no prefix.
	assert.equal(r.type, "Note");
	assert.equal(r.status, "note");
});
