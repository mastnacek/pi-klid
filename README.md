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
| Tool activity | Covered by a full-screen breathing overlay opened on `agent_start`. Every tool call, bash box, and streamed update stays out of sight until the agent settles. |
| Final answer | Revealed automatically when the agent fully settles (after retries, compaction, and queued continuations have finished). |

The breathing animation is a slowly pulsing ring (accent echo rings on `muted`
tones) above **Working...** whose dot-count and brightness follow one breath
cycle (~5.6 s). It runs at a calm 10 fps.

In non-TUI modes where overlays cannot render (`--mode rpc`, `--mode json`,
`--mode print`) the plugin falls back to the built-in working row: a breathing
**Working...** message with an animated breathing indicator.

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
  with a full-screen, non-capturing `BreathingComponent` (anchor `top-left`,
  `width: "100%"`, dynamic `maxHeight: "100%"`). The terminal height is captured
  each render cycle via the overlay's `visible` callback so the cover always
  fills the screen.
- **Settle reveal** — `agent_settled` fires only when no retry / compaction /
  queued continuation remains; the plugin then calls the overlay's `done()` and
  restores the default working row and spinner. `input` and `session_shutdown`
  act as safety nets that force-close a stray overlay.

## Notes & limitations

- Tool calls remain in the scrollback *after* the run for audibility; only the
  live activity during the run is covered. Thinking, however, stays hidden
  permanently while enabled.
- Overlay rendering is best-effort; if pi is in a mode without a TUI the
  breathing working-row fallback is used instead.
- The plugin restores the default working indicator after each run, which may
  reset a custom working indicator set by other extensions for the quieted run.

## License

MIT