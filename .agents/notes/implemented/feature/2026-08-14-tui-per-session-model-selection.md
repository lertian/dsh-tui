# Agent Note: The dsh TUI restores per-session model selection from the session log

Status: implemented

English | [中文](2026-08-14-tui-per-session-model-selection.zh.md)

## Problem

The TUI's `TuiController` held ONE mutable `selectionRef` for every session it ever bound. `swapAgent` seeded it from the global default (`agentDefaultModel.currentSelection()`) on every create and resume, and `setModel`/`cycleReasoningEffort` wrote back through that same ref AND `agentDefaultModel.saveSelection`. With two sessions that meant: resuming a session reset its model to the global default instead of what the session actually used, and switching the model in one session overwrote the global default, changing the model of every other session still open or resumed later. The web client (`packages/host/apiproxy/src/api-proxy.ts` `selectionFor`) instead keeps a per-agent selection with a three-tier precedence — this-process picks, else the session's own logged `request/header` config, else the global default — resolved on every read.

## Decision

`swapAgent` seeds the session's selection from its own durable log once the agent is bound (`packages/tui/app/src/controller.ts`): `handle.agent.session.requestHeader()?.config` yields the session's last-requested provider/model/effort, which becomes `selectionRef.current`. A blank session (no `request/header` yet) keeps the global default ref, so fresh `/new` sessions still start from settings. `setModel` and `cycleReasoningEffort` are unchanged: they still write `selectionRef.current` and best-effort `saveSelection`, so the global default now only shapes sessions created afterwards — an already-open or resumed session keeps its own seeded selection.

The seed mutates the ref in place rather than replacing the object, because `installModelSelection`'s waterfall listeners close over the exact ref object passed to setup; replacing it would orphan those listeners and silently drop every later `/model` or Shift+Tab switch for that session.

## Alternatives considered

**Re-read the log on every selection read (the web's exact `selectionFor` shape).** Rejected for the TUI: the controller re-seeds at every bind and reads through `selectionRef`, so the web's per-read getter machinery would duplicate state without a second consumer.

**Replace `this.selectionRef` with a fresh object at seed time.** Rejected: `installModelSelection(agentCtx, this.selectionRef)` captures the object identity at setup time, so replacing it after binding would leave the request waterfalls reading the old ref while the UI writes the new one.

## Consequences

- Two sessions bound in one process keep independent selections: switching one session's model no longer changes another's, and a resume restores the session's own last-requested model and effort.
- A model switched in a session but never followed by a request does not land in that session's log, so a later resume shows the last-requested (old) model — identical to the web client, where a pick lives only in process memory.
- The global default is now a create-time fallback; `saveSelection` still updates it for future new sessions.
- Related: [the thinking-mode note](2026-08-14-tui-input-history-thinking-mode-esc-cancel.md) — the Shift+Tab cycling UI and its `saveSelection` are unchanged; this note adds the log-restore precedence over the settings default.
