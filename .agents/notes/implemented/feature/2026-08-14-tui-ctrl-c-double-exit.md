# Agent Note: TUI double-Ctrl+C exit

Status: implemented

English | [中文](2026-08-14-tui-ctrl-c-double-exit.zh.md)

## Problem

A single Ctrl+C quit the entire TUI surface immediately — including while the user was typing a prompt or mid-turn. An accidental press (muscle-memory Ctrl+C from any shell) discarded the in-progress input and tore down the session surface, even though the session log itself was flushed first. Claude Code does not quit on one press: the first Ctrl+C takes the soft action the surface offers (interrupt a running generation, otherwise clear input), and only a second press inside a short window exits. The TUI deliberately mirrors Claude Code, so the single-press quit was a sharp edge in that direction.

## Decision

The frame-level `useInput` handler in `src/ui/App.tsx` turns Ctrl+C into an escalating ladder instead of an immediate quit:

- **Second press wins.** A press within `CTRL_C_EXIT_WINDOW_MS` (1000 ms) of the previous one always quits, whatever the first press did.
- **First press takes the softest action the current surface offers**, in order: reject an open approval (`decide('rejected')`, matching `n`/Esc); close an open picker; cancel the running turn when busy or compacting (`controller.cancelTurn()`, matching Esc); clear the prompt input; and finally, on an idle empty prompt, announce the window with a UI-side notice `press Ctrl+C again to exit`.
- The prompt's input is owned by the `Prompt` component's local state, so the shared `PromptState` ref (the existing `requestClose` pattern) gains `hasInput`/`requestClear`, registered by the Prompt each render. The frame reads and clears through it without lifting the value into the controller.

`TuiController.quit()` keeps its `exiting` guard; `pushNotice` is reused unchanged for the window announcement. Ink's own Ctrl+C handling stays disabled (`exitOnCtrlC: false`), so the process-level SIGINT escalation in `apps/cli` is untouched.

## Alternatives considered

**Single-press quit with a confirmation overlay.** Rejected: adds a modal step to the most common exit path and diverges from Claude Code's keybindings the surface already mirrors.

**Ctrl+C clears input only, never cancels the turn.** Rejected: the first press cancelling a running turn matches Claude Code's interrupt semantics and dsh's own Esc, so Ctrl+C and Esc stay coherent during a turn.

**Longer or configurable window.** Rejected: 1000 ms matches double-press muscle memory and needs no new config surface; a tunable would be a deployment knob with no consumer.

**No exit-window notice.** Rejected: with a bare first press the user gets no feedback, and the "did my press register" ambiguity is worse than a transient UI-side notice row (not persisted to the session log).

## Consequences

- Quitting always takes two Ctrl+C presses inside one second; the first press never quits.
- Changed pinned behavior: Ctrl+C while a picker is open no longer quits on the first press — it closes the picker (Esc does the same), and the second press quits.
- The notice is a `notice` projection row, so it is visible in the transcript but is not part of the session log (model-visible means logged is unaffected).
- Esc semantics are unchanged; `--help` text, the README keys bullet, and this note record the new ladder.
- The same change stabilizes the `loadArgumentItems` callback identity with `useCallback`: the inline arrow rebuilt every frame re-render, and the Prompt's argument-candidate effect treated it as a dependency change, so each re-render re-ran the effect and set a fresh state object — a render loop ("Maximum update depth exceeded") whenever an argument command like `/resume <prefix>` was active.

## Testing

`packages/tui/app/tests/app.spec.tsx` replaces the single-press quit test and adds: typed input clears on the first Ctrl+C with no quit; the exit-window notice on a bare first press; the second press quits in every surface; the running-turn cancel on a first press; picker close on a first press; and approval rejection on a first press. It also adds a regression test that forces an unrelated frame re-render while an argument command is active and asserts the candidate effect does not reload — the failing signal for the callback-identity render loop.
