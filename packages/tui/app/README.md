# @deepseek-ai/dsh-tui-app

English | [中文](README.zh.md)

The interactive terminal UI for dsh: an [Ink](https://github.com/vadimdemedes/ink)-driven agent surface over the core Agent/Session services, in the spirit of Claude Code. It creates or resumes one Agent through `ctx.agents`, folds the durable session log into a streaming transcript, and stays resident for multi-turn conversation.

Boot it through the [`@deepseek-ai/dsh-tui-app-bundle`](../../bundle/tui-app/README.md) profile layer:

```sh
dsh                                 # fresh session (tui is the default profile)
dsh -c                              # continue the newest session in this directory
dsh --resume <id>                   # reopen a persisted session
dsh --profile tui                   # the explicit form
```

## Features

- **Streaming transcript** — `assistant/chunk` deltas render live; `assistant/message` finalizes each step. A resume replays the durable log through the same projection (`src/projection.ts`), so history is always complete ("model-visible means logged").
- **Generic tool cards** — every `tool/call`/`tool/result` pair renders as a collapsible card (name, argument summary, result preview). Tools contributed by any third-party plugin appear with zero TUI-side adaptation.
- **Approval overlay** — the plugin answers the `approval/request` waterfall with a terminal prompt: `y` allow once, `n` reject, `a` always allow this tool (a UI-side memory for the rest of the session). Decisions land on the session log as `approval/asked`/`approval/decided` audit pairs.
- **Slash commands** — registered into the shared `ctx.commands` runtime: `/new`, `/resume` (opens a fuzzy-filtered session picker, or resumes by id), `/model` (opens a model picker, or switches by `<provider> <model>`, persisted via settings), `/tools`, `/settings`, `/help`, `/quit`. Plugin-contributed commands appear in `/help` and the `/` menu automatically.
- **Compaction status** — the `compaction/start`/`summary`/`end` lifecycle renders a live `compacting…` spinner (manual `/compact` included: it runs while the agent is idle, so the spinner does not depend on an open turn), a landed `compacted N history items (~M tokens)` notice, and an error notice for failed attempts. `compaction/prune` stays silent, matching the web client.
- **Status bar** — model, session id, cumulative token usage, and run state (running / compacting / idle).
- **Keys** — Enter submits; Shift+Enter or Ctrl+J inserts a newline; typing `/` opens the fuzzy slash-command menu (↑↓ select, Tab completes, Enter runs, Esc closes); Esc only closes UI surfaces (menu/picker) and never cancels a turn; Ctrl+C quits (flushing the session first). While an approval question is open the prompt stays editable — only `y`/`n`/`a`/`Esc` belong to the overlay.

## Architecture

- `src/startup.ts` (`tui-startup`) — the app's command-line provider: parses `--resume` and `-c/--continue` and publishes `ctx.tuiStartup`.
- `src/index.ts` (`tui-runner`) — mounts the surface: creates/resumes the agent after the loader settles, installs the mutable model selection, renders the Ink frame, and unwinds both on dispose.
- `src/controller.ts` — owns the live agent, the event subscription, slash-command handlers, the approval answerer, and session swaps; exposes a `subscribe`/`getSnapshot` store to the frame.
- `src/projection.ts` — the pure fold from `SessionEvent` to view rows, shared by live events and resume replay.
- `src/ui/App.tsx` — the Ink frame: finalized rows retire into the terminal scrollback (`Static`), the live region carries streaming text and running tools, plus the todo strip, approval overlay, prompt, and status bar.

## Settings, credentials, and plugins

The TUI reuses the stock mechanisms — nothing TUI-specific:

- Model and keys resolve per request from the `llm-deepseek:`/`llm-pi-ai:` sections of `$DSH_HOME/settings.yaml` over the credential store (`$DSH_HOME/.credentials.yaml`, overridden by the environment, e.g. `DEEPSEEK_API_KEY`). `/settings` prints the exact paths.
- Behavioral customization is the profile's `cordis.patch.yml` patch layer (hot-reloaded): any plugin row of the composition can be reconfigured or replaced there.
- Third-party plugins install with `dsh plugin --profile tui add <package>`; mount them with an `insert` row in the profile patch. Their `ctx.tools`/`ctx.commands` registrations show up in the TUI automatically.

## Model Experience

This package is a presentation surface: it never alters the model-visible transcript, tool schemas, or prompt assembly. The model interacts with the same core services as in every other profile; human-facing affordances (approvals, slash commands) resolve through the documented interaction seams.

## Known Limitations and Deferred Work

- The prompt edits at the tail only: no caret movement, selection, or kill-ring yet.
- Assistant text renders as plain text (no markdown syntax highlighting).
- The approval `always` choice is a UI-side per-tool memory; it is not persisted across restarts.
- Esc does not interrupt a manual `/compact` (the command's signal is UI-lifetime); the compaction spinner keeps showing progress until the transaction settles.
- Requires an interactive TTY; non-TTY invocation fails fast with a diagnostic (use `--profile headless` there).
