# Agent Note: TUI immediate cancel UX (gemini-cli style)

Status: implemented

English | [中文](2026-08-14-tui-immediate-cancel-ux.zh.md)

## Problem

Cancelling a running turn (Esc, or the first Ctrl+C while busy) only issued the cooperative `agent.cancel({ kind: 'user' })` abort. The projection's `busy` flag is derived from the session log and clears only when the loop's `turn/end` event folds in, so the status bar kept showing `running` and the live region kept spinning `working…` for the whole convergence window — which can take seconds when a tool ignores SIGTERM or a CPU fold is mid-flight. The prompt also kept whatever had been typed ahead. gemini-cli's `cancelOngoingRequest` does the opposite: it aborts, flips the stream state to Idle, and clears the input buffer immediately, letting the agent converge in the background. The dsh TUI deliberately mirrors gemini-cli/Claude Code, so the slow UI settle was a sharp edge in that direction.

## Decision

`TuiController.cancelTurn()` now flips the UI off the running state immediately while leaving the cooperative abort untouched:

- The controller arms a UI-side `cancelPending` flag on `TuiSnapshot`, cleared when `turn/end` or the next `turn/start` lands (and on session swap). The frame presents `cancelling…` in the status bar and the live region instead of `running`/`working…`, and the live streaming state clears.
- A `cancelling…` `notice` row lands immediately — the same `pushNotice` projection-row mechanism as `previous run interrupted; resumed from the durable log` — so the press is acknowledged the moment it happens. The durable `turn aborted` notice still lands when `turn/end` (aborted) converges; the two rows read as "cancelling…, then turn aborted".
- The frame clears the prompt through the existing `promptState.current.requestClear()` on both busy-cancel paths (Esc while busy, first Ctrl+C while busy), matching gemini's `clearBuffer`. The Ctrl+C ladder's idle-with-text clear branch is unchanged; an idle Esc keeps its no-op.
- When the agent is idle `cancelTurn()` stays a pure no-op: no flag, no notice, no presentation change.

The key bindings are untouched: Esc still closes pickers/menus first, Ctrl+C still quits on the second press inside `CTRL_C_EXIT_WINDOW_MS`, and approval rejection on Esc/first-Ctrl+C is unchanged.

## Alternatives considered

**Force-kill the agent process on cancel.** Rejected: gemini does not force-kill either — `agent.abort()` is cooperative (an ACP abort request; tools observe an AbortSignal and kill their children). Force-killing would strand durable state and race the log flush, violating "model-visible means logged".

**Mutate the in-flight tool rows to a `cancelled` status.** Rejected: the fold stays honest by leaving rows untouched until their real `tool/result` lands (a result or the loop's synthetic `tool call aborted before dispatch` error). A `cancelling…` presentation needs no new row status or `isFinalized` semantics and cannot disagree with a result that arrives after the cancel.

**Have the projection (not the snapshot) carry the flag.** Rejected: `cancelPending` is transient UI state. Replaying a session log must never reproduce it — it describes the live surface, not the session — so it belongs on `TuiSnapshot` beside the other frame-only state.

## Consequences

- The UI stops presenting the turn as running immediately: the status bar and live region show `cancelling…`, the prompt clears, and typed-ahead input is discarded on cancel.
- The underlying agent still converges in the background; cancellation is cooperative, not a force-kill. When `turn/end` (aborted) lands, the projection pushes the durable `turn aborted` notice, `busy` clears, and the flag settles. Tool rows keep their running marker during the window and settle with their real result.
- The session log and agent-loop semantics are unchanged: no new session event, nothing model-visible added or altered.
- `cancelPending` is UI-only and clears on `turn/start` too, so a fresh turn after an abort resumes the normal `working…` presentation without waiting for the old abort's `turn/end`.
- Related but not superseding: the Ctrl+C double-exit ladder ([2026-08-14-tui-ctrl-c-double-exit](2026-08-14-tui-ctrl-c-double-exit.md)) and the original Esc-to-cancel decision ([2026-08-14-tui-input-history-thinking-mode-esc-cancel](2026-08-14-tui-input-history-thinking-mode-esc-cancel.md)) keep their facts; this note only changes what `cancelTurn()` presents while the abort converges.

## Testing

`packages/tui/app/tests/controller.spec.ts` covers the flag lifecycle: a busy cancel arms `cancelPending`, clears streaming, and lands the `cancelling…` notice; `turn/end` (aborted) and the next `turn/start` settle it; an idle cancel stays a no-op; repeated cancels do not double-notice. `packages/tui/app/tests/app.spec.tsx` covers the frame: Esc while busy and the first Ctrl+C while busy clear typed-ahead input and stop `working…` in favor of `cancelling…`; a `cancelPending` snapshot renders `cancelling…` instead of `running`; the idle Esc ladder keeps its no-op on the input.
