# Agent Note: The dsh TUI adds input history, a thinking-mode key, and real Esc-to-cancel

Status: implemented

English | [中文](2026-08-14-tui-input-history-thinking-mode-esc-cancel.zh.md)

## Problem

Three prompt-surface gaps against the interactive-agent expectations set by Claude Code (and the old `pi` product):

1. **No input history.** The prompt (`packages/tui/app/src/ui/App.tsx` `Prompt`) cleared its `value` on every submit and kept no record of prior lines, so ↑/↓ had nothing to recall. The keys were even blocked: `useInput` returned early on `upArrow`/`downArrow`.
2. **No thinking-mode adjustment.** The controller carried a mutable `ModelSelection` (provider/model plus an optional `reasoningEffort`) but nothing in the UI exposed the effort. `installModelSelection` already strips an absent effort back to provider default, and the web client's `ModelSelect` renders the full effort list per exact model — the TUI had no equivalent.
3. **Esc did not cancel the turn.** `startup.ts` help text promised "Esc cancels the running turn", but `App.tsx` explicitly did the opposite ("Esc closes the slash menu only; it never cancels a turn") and `TuiController` had no cancel method, even though `Agent.cancel({ kind: 'user' })` is the documented seam.

## Decision

- **Input history (readline-style).** `Prompt` keeps `historyRef` (submitted lines, consecutive duplicates collapsed), `historyPosRef` (recall cursor; `history.length` = the live line), and `draftRef` (the in-progress line, so ↓ returns to it). ↑/↓ walk the history; all submit paths funnel through one `submit()` helper that records the line. History is per-surface, in-memory only — no persistence.
- **Thinking mode on Shift+Tab.** `TuiController.cycleReasoningEffort()` reads the current selection, calls `llm.resolveModelInfo(provider, model)` for the exact model's advertised `reasoning.efforts`, and advances to the next level (wrapping). It persists via `agentDefaultModel.saveSelection`, emits a `thinking: <name>` notice, and the snapshot gains `thinkingLabel` so the status bar shows the current level (`model · High`). Models with no reasoning metadata get an info notice instead. The DeepSeek adapter advertises `off`/`high`/`max`, so Shift+Tab is the binary "thinking on/off" plus the effort budget in one cycle, matching the web client's per-model effort list.
- **Esc cancels the turn.** `TuiController.cancelTurn()` delegates to `agent.cancel({ kind: 'user' })`, which is a no-op when idle. `App`'s frame-level handler now resolves Esc by precedence: a pending approval rejects on Esc; an open picker closes itself; an open slash menu closes; otherwise the turn cancels. The aborted turn folds a `turn aborted` notice through the existing `turn/end` projection, so feedback needs no new rendering path.

## Alternatives considered

**Persist input history to `$DSH_HOME` (shell-history parity).** Rejected for now: no existing settings/history seam to reuse, and per-surface recall already covers the immediate need; persistence is deferred work, not a correctness gap.

**A binary thinking toggle (on/off) instead of cycling the effort list.** Rejected: the adapter advertises three levels and the web client lists them all; cycling the advertised list is strictly more capable and keeps one code path, with `off` as the "thinking off" position.

**Make Shift+Tab a global `App`-level binding.** Rejected: the `Prompt` is the input surface and already owns arrow/tab handling; a prompt-local binding avoids double-handling between the frame and the prompt while the picker/menu are closed.

## Consequences

- `Agent.cancel` also clears the inbox, so Esc "stop" discards queued follow-ups — the intended interrupt semantics, matching the help text.
- `thinkingLabel` is derived from the selection's effort id (capitalized), not the adapter's display name; the resolved name appears only in the per-toggle notice. If an adapter uses effort ids whose capitalized form is misleading, the status bar label and the notice will differ slightly.
- The selection persists through `agentDefaultModel.saveSelection`, so a thinking change survives restarts and is also honored by the web client on the same settings document.
- Esc no longer does nothing on a clear surface; the changed behavior updated the "bare Escape" and "second Escape" tests, which previously asserted the no-op.
