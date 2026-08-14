# Agent Note: The dsh TUI renders the compaction lifecycle (spinner, landed notice, errors)

Status: implemented

English | [中文](2026-08-14-tui-compaction-status-rendering.zh.md)

## Problem

The TUI's projection (`packages/tui/app/src/projection.ts`) skipped every `compaction/*` session event, and its spinner was driven solely by `turn/start`/`turn/end` (`Projection.busy`). Automatic compaction happened inside an open turn, so it inherited the generic `working…` spinner by accident; manual `/compact` runs while the agent is idle (an open turn is a `busy` rejection), so the whole summarization call — often tens of seconds — rendered with no loading indication at all: no spinner, a status bar reading `idle`, and a bare `/compact` command row with no running icon. The web client already rendered the full lifecycle: `ui-trajectory` folds `compaction/start→summary→end` into a request whose status stays `running` until `compaction/end`, and `ui-conversation` renders a landed marker with the shadowed counts ("compacted N items / ~M tokens") plus a running card for the `/compact` command. The TUI gap was observable user-facing behavior, not a missing internal seam.

## Decision

The TUI now consumes the durable compaction lifecycle as view state, mirroring the web client's semantics on a linear transcript:

- `Projection.compaction: CompactionState | undefined` records the open transaction (`id`, `running`) and, from `compaction/summary`, the shadowed counts (`shadowedItems`/`shadowedTokens`). `compaction/start` opens it; `compaction/end` closes it. `compaction/prune` stays silent — the web client renders no prune either.
- The spinner condition is `busy || compacting` (`App.tsx`), so a manual compaction on an idle agent shows `⠋ compacting…`; an in-turn automatic compaction labels the same line `compacting…` instead of `working…`. The status bar gains a `compacting…` state between `running — esc interrupts` and `idle`.
- `compaction/end` settles a notice row: success renders `compacted N history items (~M tokens)` (the same copy family as `dsh-command-compact`'s settlement text); `error` renders `compaction failed: <error>`. A successful end with no landed summary stays quiet. Rows are finalized at creation, so they retire into the scrollback like other notices.
- Command rows (the `/compact` row included) now carry the tool rows' status icons — `⏵` running, `✓` success, `✗` error — instead of a bare magenta line.
- The dependency on `@deepseek-ai/dsh-compaction` is type-only (`import type {} from '@deepseek-ai/dsh-compaction/types'` to merge the event vocabulary into `SessionEventMap`): the projection reads event payload fields; nothing at runtime imports compaction code.

## Alternatives considered

**Drive the spinner from `busy` alone (reuse the turn spinner).** Rejected: manual compaction requires an idle agent, so `busy` is false for exactly the slowest, most visible compaction path; an event-derived transaction state is also what the web client already keys on.

**Render the checkpoint summary body as an expandable marker (web `CompactionItem` parity).** Rejected: the checkpoint content is written for the model and is hundreds of lines long; the terminal transcript keeps a one-line landed notice, and the durable log remains the source of truth for the full text.

**Special-case the `/compact` command name for its running subtitle.** Rejected: the transaction state covers both automatic and manual compaction uniformly, and a name check would render wrongly for third-party commands that trigger compaction under another name.

## Consequences

- Esc does not interrupt a manual `/compact`: the command runs on the controller's UI-lifetime signal, and `cancelTurn` is a no-op while the agent is idle. The spinner shows progress until the transaction settles; the README documents this as a limitation.
- The presentation change is view-only: no model-visible transcript, tool schema, or prompt-assembly change, and the new rows derive from log-only events the projection previously skipped. Replay (`replayEvents`) rebuilds the identical state, so a resumed session renders compaction notices it did not see live.
- The web client and the TUI now agree on lifecycle semantics (in-flight status, landed counts, error surfacing) even though their render forms differ; `compaction/prune` stays unrendered on both surfaces.
