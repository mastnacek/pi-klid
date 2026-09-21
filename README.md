# pi-klid

Quiet zen mode for the [pi coding agent](https://pi.dev). One command, and while the
agent works you see nothing but a slow breathing **Working...** animation.
No thinking dumps, no tool-call noise, no streaming churn. When the agent is
done, the animation dissolves and only the clean final answer appears.

---

## What it does

| While `/klid on` | Behavior |
|---|---|
| Thinking blocks | Hidden at the render level — live and in history. Display-only; model context and the session transcript are untouched (`registerMarkdownTransformer` returns `""` for `assistant-thinking`). |
| Tool activity | Covered by a quiet cover over the transcript, opened on `agent_start`. Every tool call, bash box, and streamed update stays out of sight until the agent settles. |
| Final answer | Revealed automatically when the agent fully settles (after retries, compaction, and queued continuations have finished). |

The cover is deliberately *unanimated*: a single dim **Working...** line at the
vertical center of the transcript area. No pulsing, no color cycling, no dot
progress — it signals that work is in progress without offering anything to
stare at, so it does not hold your attention while you wait.

The cover only paints the transcript region. The bottom band — working row,
input editor, and footer — is sized adaptively (~22% of terminal height,
clamped 6-12 rows) and is never overpainted, so the input window and footer
remain visible and intact while the agent works.

In non-TUI modes where overlays cannot render (`--mode rpc`, `--mode json`,
`--mode print`) the plugin falls back to the built-in working row: a static
**Working...** message with a single dim dot.

## Install

Add the plugin directory to your pi extensions (e.g. via your pi config's
`extensions` list), then reload the session.

## Usage

```
/klid            — help banner
/klid on         — enable quiet mode
/klid off        — disable quiet mode
/klid toggle     — flip quiet mode
/klid status     — show current state
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