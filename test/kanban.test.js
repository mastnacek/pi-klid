/**
 * Characterization tests for `KanbanBoard` — the SPAI kanban overlay.
 *
 * Written before splitting the 666-line module (line-limit campaign), so the split
 * is checked against real rendering and input behaviour rather than my reading of
 * the code. Everything runs against a throwaway ledger directory, and assertions
 * are structural (line counts, widths, mode markers) so they survive unrelated
 * styling tweaks while still failing on any behavioural change.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { KanbanBoard } from "../kanban.js";

const ANSI = /\x1b\[[0-9;]*m/g;
/** Strip styling so assertions read the visible text. */
const plain = (s) => s.replace(ANSI, "");
const flat = (board, width = 100) => plain(board.render(width).join("\n"));

/** A ledger with real markdown files plus the .index.json fast path. */
function seedLedger(cwd, tasks) {
	const dir = join(cwd, "docs", "spai");
	mkdirSync(dir, { recursive: true });
	const records = [];
	for (const [id, title, status] of tasks) {
		const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
		const file = `2026-01-01-${id}-${slug}.md`;
		writeFileSync(
			join(dir, file),
			`---\ntype: Todo\ntitle: "${title}"\nstatus: ${status}\nsource: pi-klid\n---\n\n# ${id}: ${title}\n\n. ${title}\n`,
			"utf8",
		);
		records.push({ id, title, type: "Todo", status, symbol: "", timestamp: "", tags: [], file });
	}
	writeFileSync(join(dir, ".index.json"), JSON.stringify({ version: 1, lastUpdated: "", records }), "utf8");
	return dir;
}

/** Fresh temp cwd + board with a recording TUI stub. */
function setup(t, { tasks = [], height = 24 } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-klid-kanban-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	seedLedger(cwd, tasks);
	const calls = { render: 0, close: 0 };
	const board = new KanbanBoard({
		tui: {
			requestRender() {
				calls.render += 1;
			},
		},
		cwd,
		close: () => {
			calls.close += 1;
		},
		height: () => height,
	});
	return { board, cwd, calls };
}

const indexPath = (cwd) => join(cwd, "docs", "spai", ".index.json");
const readIndex = (cwd) => JSON.parse(readFileSync(indexPath(cwd), "utf8"));

// --- layout invariants -------------------------------------------------------

test("render fills exactly the requested height at the requested width", (t) => {
	const { board } = setup(t, { height: 24 });
	const lines = board.render(100);
	assert.equal(lines.length, 24);
	for (const line of lines) assert.equal(visibleWidth(line), 100, "every row is padded to the width");
});

test("render clamps width to 24 and height to 8", (t) => {
	const { board } = setup(t, { height: 2 });
	const lines = board.render(10);
	assert.equal(lines.length, 8, "height floor");
	for (const line of lines) assert.equal(visibleWidth(line), 24, "width floor");
});

test("the layout switches from the grid to one focused column at 75 columns", (t) => {
	const { board } = setup(t);
	const at75 = flat(board, 75);
	const at74 = flat(board, 74);
	assert.ok(at75.includes("┼"), "75 columns is the first grid layout");
	assert.ok(at75.includes("TODO"));
	assert.equal(at74.includes("┼"), false, "74 columns falls back to a single column");
	assert.ok(at74.includes("←/→ to switch"), "narrow shows one focused column");
	assert.equal(at74.includes("WORKING"), false, "narrow hides the other columns");
});

test("a grid that is just wide enough clips the trailing column labels", (t) => {
	// Pinned: at exactly 75 columns each column gets 14 cells, so the last label is
	// cut to "CANCELL…". It only fits in full once the grid is wider.
	const { board } = setup(t);
	const at75 = flat(board, 75);
	assert.equal(at75.includes("CANCELLED"), false, "clipped at the breakpoint");
	assert.ok(at75.includes("CANCELL…"), "clipped with an ellipsis");
	assert.ok(flat(board, 100).includes("CANCELLED"), "fits at 100 columns");
});

test("an empty column renders its empty marker", (t) => {
	const { board } = setup(t);
	assert.ok(flat(board).includes("· empty ·"));
});

test("task rows shorten the SPAI id and keep the title", (t) => {
	const { board } = setup(t, { tasks: [["SPAI-001", "First task", "todo"]] });
	const out = flat(board);
	assert.ok(out.includes("#1"), "id shortened to #1");
	assert.ok(out.includes("First task"), "title preserved");
});

test("the focused column is marked and h/l move it within bounds", (t) => {
	const { board } = setup(t);
	const header = (b) => plain(b.render(100)[5] ?? "");
	assert.ok(header(board).includes("▶ ○ TODO"), "starts on the first column");

	board.handleInput("h");
	assert.ok(header(board).includes("▶ ○ TODO"), "cannot move left of the first column");

	for (let i = 0; i < 10; i++) board.handleInput("l");
	assert.ok(header(board).includes("▶ ✗ CANCELLED"), "clamps at the last column");
});

test("j/k move the selection inside the column and clamp", (t) => {
	const { board } = setup(t, {
		tasks: [
			["SPAI-001", "One", "todo"],
			["SPAI-002", "Two", "todo"],
		],
	});
	const selected = (b) => b.render(100).map(plain).filter((l) => l.includes("▸"));
	assert.ok(selected(board).some((l) => l.includes("#1")), "first row selected");

	board.handleInput("j");
	assert.ok(selected(board).some((l) => l.includes("#2")));
	board.handleInput("j");
	assert.ok(selected(board).some((l) => l.includes("#2")), "clamped at the bottom");

	board.handleInput("k");
	assert.ok(selected(board).some((l) => l.includes("#1")));
	board.handleInput("k");
	assert.ok(selected(board).some((l) => l.includes("#1")), "clamped at the top");
});

// --- mutations ---------------------------------------------------------------

test("x toggles the selected task to done and reports it", (t) => {
	const { board, cwd } = setup(t, { tasks: [["SPAI-001", "One", "todo"]] });
	board.handleInput("x");
	assert.equal(readIndex(cwd).records[0].status, "done", "ledger updated");
	assert.ok(flat(board).includes("SPAI-001 → done"), "notice shown");
});

test("status aliases move the selected task straight to that column", (t) => {
	const { board, cwd } = setup(t, { tasks: [["SPAI-001", "One", "todo"]] });
	board.handleInput("w");
	assert.equal(readIndex(cwd).records[0].status, "working");
	assert.ok(flat(board).includes("SPAI-001 → working"));

	board.handleInput("5");
	assert.equal(readIndex(cwd).records[0].status, "cancelled");
	assert.ok(flat(board).includes("SPAI-001 → cancelled"));
});

test("a move to the current status is a no-op", (t) => {
	const { board } = setup(t, { tasks: [["SPAI-001", "One", "todo"]] });
	board.handleInput("t");
	assert.equal(flat(board).includes("SPAI-001 →"), false, "no notice for a same-column move");
});

test("r reloads the index from disk and reports the count", (t) => {
	const { board, cwd } = setup(t, { tasks: [["SPAI-001", "One", "todo"]] });
	seedLedger(cwd, [
		["SPAI-001", "One", "todo"],
		["SPAI-002", "Two", "todo"],
	]);
	board.handleInput("r");
	assert.ok(flat(board).includes("index reloaded (2 items)"));
});

// --- add mode ----------------------------------------------------------------

test("n opens add mode with a live type preview, escape cancels", (t) => {
	const { board } = setup(t);
	board.handleInput("n");
	assert.ok(flat(board).includes("new>"), "prompt visible");

	for (const ch of ". Fresh") board.handleInput(ch);
	const out = flat(board);
	assert.ok(out.includes("Todo/todo"), "live type/status preview");
	assert.ok(out.includes("new> . Fresh"), "buffer echoed");

	board.handleInput("\u001b");
	assert.equal(flat(board).includes("new>"), false, "prompt dismissed");
});

test("enter in add mode saves the task into the ledger", (t) => {
	const { board, cwd } = setup(t);
	board.handleInput("n");
	for (const ch of ". Fresh task") board.handleInput(ch);
	board.handleInput("\r");

	const records = readIndex(cwd).records;
	assert.equal(records.length, 1);
	assert.equal(records[0].title, "Fresh task");
	assert.equal(records[0].status, "todo");
	assert.ok(flat(board).includes("saved SPAI-001"), "notice shown");
});

test("backspace edits the add buffer", (t) => {
	const { board } = setup(t);
	board.handleInput("n");
	for (const ch of ". Abc") board.handleInput(ch);
	board.handleInput("\u007f");
	assert.ok(flat(board).includes("new> . Ab"), "last character removed");
});

// --- detail mode -------------------------------------------------------------

test("enter opens the detail view and escape returns to browse", (t) => {
	const { board } = setup(t, { tasks: [["SPAI-001", "One", "todo"]] });
	board.handleInput("\r");
	const out = flat(board);
	assert.ok(out.includes("◈ SPAI-001: One"), "detail title");
	assert.ok(out.includes(". One"), "body from the markdown file");
	assert.ok(out.includes("esc"), "detail hints");

	board.handleInput("\u001b");
	assert.equal(flat(board).includes("◈ SPAI-001: One"), false, "back to the board");
});

test("j/k scroll the detail body and clamp at the ends", (t) => {
	const { board, cwd } = setup(t);
	// A body long enough that the visible window is a fraction of the total.
	const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
	writeFileSync(
		join(cwd, "docs", "spai", "2026-01-01-SPAI-001-long.md"),
		`---\ntype: Todo\ntitle: "Long"\nstatus: todo\n---\n\n# SPAI-001: Long\n\n${long}\n`,
		"utf8",
	);
	writeFileSync(
		indexPath(cwd),
		JSON.stringify({
			version: 1,
			lastUpdated: "",
			records: [
				{
					id: "SPAI-001",
					title: "Long",
					type: "Todo",
					status: "todo",
					symbol: "",
					timestamp: "",
					tags: [],
					file: "2026-01-01-SPAI-001-long.md",
				},
			],
		}),
		"utf8",
	);
	board.handleInput("r");
	board.handleInput("\r");

	const counter = () => {
		const m = flat(board).match(/\((\d+)\/(\d+)\)/);
		return m ? [Number(m[1]), Number(m[2])] : null;
	};
	const [, total] = counter();
	assert.ok(total > 20, "body wrapped into many lines");

	board.handleInput("k");
	const atTop = counter();
	board.handleInput("j");
	const scrolled = counter();
	assert.equal(scrolled[0], atTop[0] + 1, "j scrolls one line down");

	for (let i = 0; i < 200; i++) board.handleInput("j");
	assert.equal(counter()[0], total, "clamped at the last line");
});

// --- component contract ------------------------------------------------------

test("q and escape close the board", (t) => {
	const { board, calls } = setup(t);
	board.handleInput("q");
	assert.equal(calls.close, 1);

	const second = setup(t);
	second.board.handleInput("\u001b");
	assert.equal(second.calls.close, 1);
});

test("input requests a re-render", (t) => {
	const { board, calls } = setup(t);
	const before = calls.render;
	board.handleInput("l");
	assert.ok(calls.render > before, "TUI was asked to redraw");
});

test("invalidate and dispose are no-ops", (t) => {
	const { board } = setup(t);
	assert.equal(board.invalidate(), undefined);
	assert.equal(board.dispose(), undefined);
});
