# pi-klid

Quiet zen mode for the [pi coding agent](https://pi.dev). One command, and while the
agent works the screen shows a calm, quiet surface instead of the noisy run:
no thinking dumps, no tool-call noise, no streaming churn. You can pick between a
static **Working...** cover and a live **SPAI task dashboard** to fill the time
productively. When the agent is done, the surface dissolves and only the clean
final answer appears.

---

## What it does

| While `/klid on` | Behavior |
|---|---|
| Thinking blocks | Hidden at the render level — live and in history. Display-only; model context and the session transcript are untouched (`registerMarkdownTransformer` returns `""` for `assistant-thinking`). |
| Tool activity | Covered by a quiet surface over the transcript, opened on `agent_start`. Every tool call, bash box, and streamed update stays out of sight until the agent settles. |
| Final answer | Revealed automatically when the agent fully settles (after retries, compaction, and queued continuations have finished). |

The cover is deliberately *unanimated*: a single dim **Working...** line at the
vertical center of the transcript area. No pulsing, no color cycling, no dot
progress — it signals that work is in progress without offering anything to
stare at, so it does not hold your attention while you wait.

The cover only paints the transcript region. The bottom band is **measured**,
not guessed: every render cycle the plugin sums the rendered height of pi's dock
(queued messages, status, widgets, the input editor, the footer) and reserves
exactly those rows, falling back to a ~22% band (clamped 6-12 rows) only when
that layout is not recognized. A multi-line prompt, an extra widget or a taller
footer therefore never pushes the editor under the cover.

In non-TUI modes where overlays cannot render (`--mode rpc`, `--mode json`,
`--mode print`) the plugin falls back to the built-in working row: a static
**Working...** message with a single dim dot.

## Working views

Three surfaces can hide the run while `/klid on`:

- **`cover`** (default) — a static, dim `Working...` line. Unanimated by design:
  nothing to stare at.
- **`spai`** — a live, interactive SPAI backlog list. Browsable while the agent
  works in the background: read tasks/ideas/notes from the project's
  `docs/spai/` ledger, add new ones, cycle statuses, and open full details.
- **`kanban`** — a five-column SPAI kanban board (todo / working / waiting /
  done / cancelled) showing only `Todo` records. Move tasks between columns
  while the agent works, so a slow run pays for itself. When `pi-spai` is
  installed next to this plugin, the board **is** pi-spai's own
  `KanbanBoardComponent` — one implementation, no drift — including its `n`
  capture flow (`ctx.ui.input` with the `. ` prefill, so `. `/`/ `/`/. `/`x `/`z `
  `/`? `/`- ` are recognized from the first character, tags and `!`/`@` metadata
  parsed), its `Enter` reading mode and its `r` realize prompt. Without pi-spai
  the bundled fallback board is used, with the same keys and palette.

Switch with `/klid view cover|spai|kanban`. The chosen view persists and is
restored on session start.

### SPAI dashboard keys

| Key | Action |
| --- | --- |
| `↑`/`↓` or `k`/`j` | Browse items |
| `n` | New item (SPAI syntax: `. task` `? idea` `- note` `!priority @deadline :tags:`) |
| `x` | Cycle status (todo → working → waiting → done → cancelled) |
| `Enter` | Open full item detail |
| `r` | Reload index from disk |
| `Esc` | Close dashboard |

### SPAI kanban keys

| Key | Action |
| --- | --- |
| `←`/`→` or `h`/`l` | Focus column |
| `↑`/`↓` or `k`/`j` | Move inside the focused column |
| `Space` / `Tab` | Push the selected task one column right |
| `⌫` / `[` / `Shift+←` | Pull the selected task one column left |
| `1`-`5` (`t` `w` `p` `d` `c` `z`) | Send the selected task to a status |
| `x` | Toggle done ↔ todo |
| `n` | New task (SPAI syntax) |
| `Enter` | Open full item detail |
| `r` | Reload index from disk |
| `Esc` / `q` | Close the board |

With pi-spai installed, the kanban board also keeps its `r` = realize (loads the
item into the prompt without sending it) and `Enter` = reading mode behaviours.

The board is the visual twin of pi-spai's `/spai board`: same Linkarzu truecolor
palette (pink todo / gold working / violet waiting / mint done / slate
cancelled), same frames, status ribbon, column badges and selection highlight —
colors are byte-identical to `pi-spai/src/viewer.ts`. It renders the
five-column grid down to 75 columns and falls back to a single focused column
with status tabs below that, matching pi-spai's breakpoint.

Everything written by the dashboard and the board uses the exact SPAI file
format pi-spai uses (`docs/spai/.index.json` + `YYYY-MM-DD-SPAI-NNN-*.md`), so
items recorded here appear in `/spai` and vice versa.

## Install

Add the plugin directory to your pi extensions (e.g. via your pi config's
`extensions` list), then reload the session.

## Usage

```
/klid               — help banner
/klid on            — enable quiet mode
/klid off           — disable quiet mode
/klid toggle        — flip quiet mode
/klid view cover    — static quiet cover while working
/klid view spai     — live SPAI task list while working
/klid view kanban   — live SPAI kanban board while working
/klid status        — show current state
```

The enabled state persists to `~/.pi/agent/pi-klid.json` and is restored on the
next session start, so you can leave quiet mode on permanently.

## How it works (overview)

- **Thinking hiding** — `pi.registerMarkdownTransformer` blanks
  `messageType === "assistant-thinking"` while enabled. This is a documented
  display-only hook: the original message stays unchanged in session and model
  context.
- **Overlay cover** — `agent_start` calls `ctx.ui.custom(..., { overlay: true })`
  with a non-capturing `QuietCover` (anchor `top-left`, `width: "100%"`). The
  terminal height is captured each render cycle via the overlay's `visible`
  callback, which also reserves an adaptive bottom band for the working row,
  input editor, and footer. The cover is static by design — no timers run while
  it is shown and the bottom band is never painted over.
- **Settle reveal** — `agent_settled` fires only when no retry / compaction /
  queued continuation remains; the plugin then calls the overlay's `done()` and
  restores the default working row and spinner. `input` and `session_shutdown`
  act as safety nets that force-close a stray overlay.

## Notes & limitations

- Tool calls remain in the scrollback *after* the run for audibility; only the
  live activity during the run is covered. Thinking, however, stays hidden
  permanently while enabled.
- Overlay rendering is best-effort; if pi is in a mode without a TUI the
  static working-row fallback (dim "Working..." + single dim dot) is used
  instead.
- The plugin restores the default working indicator after each run, which may
  reset a custom working indicator set by other extensions for the quieted run.

## License

MIT