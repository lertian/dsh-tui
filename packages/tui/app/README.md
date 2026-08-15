# @deepseek-ai/dsh-tui-app

English | [中文](README.zh.md)

The interactive terminal UI for dsh: an [Ink](https://github.com/vadimdemedes/ink)-driven agent surface over the core Agent/Session services, in the spirit of Claude Code. It creates or resumes one Agent through `ctx.agents`, folds the durable session log into a streaming transcript, and stays resident for multi-turn conversation.

Boot it through the [`@deepseek-ai/dsh-tui-app-bundle`](../../bundle/tui-app/README.md) profile layer:

```sh
dsh                                 # fresh session (tui is the default profile)
dsh -c                              # continue the newest session in this directory
dsh --resume <id>                   # reopen a persisted session (full id or unique short prefix)
dsh --profile tui                   # the explicit form
```

## Features

- **Welcome banner** — a fresh session opens with a Claude Code-style banner: the DeepSeek whale in terminal block art, a few getting-started tips, and the model · session · cwd line. It retires as soon as the first transcript row lands.
- **Streaming transcript** — `assistant/chunk` deltas render live; `assistant/message` finalizes each step. A resume replays the durable log through the same projection (`src/projection.ts`), so history is always complete ("model-visible means logged").
- **Generic tool cards** — every `tool/call`/`tool/result` pair renders as a truncated-preview card (name, argument summary, result preview). Tools contributed by any third-party plugin appear with zero TUI-side adaptation.
- **Approval overlay** — the plugin answers the `approval/request` waterfall with a terminal prompt: `y` allow once, `n` reject, `a` always allow this tool (a UI-side memory for the rest of the session). Decisions land on the session log as `approval/asked`/`approval/decided` audit pairs.
- **Slash commands** — registered into the shared `ctx.commands` runtime: `/new`, `/resume` (opens a fuzzy-filtered session picker, or resumes by id or unique short prefix), `/model` (opens a model picker, or switches the current session's model by `<provider> <model>`, saved as the default for new sessions), `/tools`, `/settings`, `/help`, `/clear` (clears the view; the session log is untouched), `/quit`. Plugin-contributed commands appear in `/help` and the `/` menu automatically.
- **Skills** — user-invocable skills from the `dsh-skill` registry appear in the same `/` menu (a `user-only ·` marker flags `disable-model-invocation` skills). Submitting `/name` for a user-invocable skill forwards it to the model as an ordinary user message, where `dsh-tool-skill` injects the rendered body; a command name always wins over a colliding skill name. Skill names also list in `/help`.
- **Compaction status** — the `compaction/start`/`summary`/`end` lifecycle renders a live `compacting…` spinner (manual `/compact` included: it runs while the agent is idle, so the spinner does not depend on an open turn), a landed `compacted N history items (~M tokens)` notice, and an error notice for failed attempts. `compaction/prune` stays silent, matching the web client.
- **Input history** — ↑/↓ recall previously submitted lines readline-style: consecutive duplicates collapse, and ↓ returns to the in-progress draft. History persists to `$DSH_HOME/profiles/tui/history` (the newest 200 lines) across restarts.
- **Thinking mode** — Shift+Tab cycles the reasoning effort across the levels the current model advertises (off/high/max for DeepSeek). The selected level shows in the status bar. Model selection is per-session: a resume restores the session's own last-used model and effort from its log, while a switch also updates the settings default used by new sessions.
- **Status bar** — model, thinking level, session id, cumulative token usage, and run state (running / cancelling / compacting / idle).
- **Keys** — Enter submits; Shift+Enter or Ctrl+J inserts a newline; ↑/↓ recall history; Shift+Tab cycles the thinking level; typing `/` opens the fuzzy menu of slash commands and skills (↑↓ select, Tab completes, Enter runs, Esc closes); Esc cancels the running turn once menus and pickers are closed; Ctrl+O expands or collapses the last turn's tool results and thinking; Ctrl+C clears the input or cancels the turn — a second press quits (flushing the session first). Cancelling a turn stops the working indicator and clears the prompt immediately, showing `cancelling…` until the agent's cooperative abort settles. While an approval question is open the prompt is read-only — `y`/`n`/`a`/`Esc` belong to the overlay.

## Semantic palette

Third-party plugins follow one status-color convention: **selected = inverse**, **running = yellow**, **success = green**, **failure = red**, **info = gray**, **approval/danger = yellow**. Tool cards, command rows, notices, and selection lists all use it.

## Architecture

- `src/startup.ts` (`tui-startup`) — the app's command-line provider: parses `--resume` and `-c/--continue` and publishes `ctx.tuiStartup`.
- `src/index.ts` (`tui-runner`) — mounts the surface: creates/resumes the agent after the loader settles, installs the mutable model selection, renders the Ink frame, and unwinds both on dispose.
- `src/controller.ts` — owns the live agent, the event subscription, slash-command handlers, the approval answerer, and session swaps; exposes a `subscribe`/`getSnapshot` store to the frame.
- `src/projection.ts` — the pure fold from `SessionEvent` to view rows, shared by live events and resume replay.
- `src/ui/App.tsx` — the Ink frame: the fresh-session welcome banner, finalized rows retiring into the terminal scrollback (`Static`), the live region carrying streaming text and running tools, plus the todo strip, approval overlay, prompt, and status bar.

## Settings, credentials, and plugins

The TUI reuses the stock mechanisms — nothing TUI-specific:

- Model and keys resolve per request from the `llm-deepseek:`/`llm-pi-ai:` sections of `$DSH_HOME/settings.yaml` over the credential store (`$DSH_HOME/.credentials.yaml`, overridden by the environment, e.g. `DEEPSEEK_API_KEY`). `/settings` prints the exact paths.
- Behavioral customization is the profile's `cordis.patch.yml` patch layer (hot-reloaded): any plugin row of the composition can be reconfigured or replaced there.
- Third-party plugins install with `dsh plugin --profile tui add <package>`; mount them with an `insert` row in the profile patch. Their `ctx.tools`/`ctx.commands` registrations show up in the TUI automatically.

## Model Experience

This package is a presentation surface: beyond submitting the user's own input as ordinary messages, it never alters the model-visible transcript, tool schemas, or prompt assembly. A `/name` skill gesture is forwarded as a plain user message and `dsh-tool-skill` performs the injection; the TUI itself adds no prompt machinery. The model interacts with the same core services as in every other profile; human-facing affordances (approvals, slash commands, skills) resolve through the documented interaction seams.

## Known Limitations and Deferred Work

- The prompt edits at the tail only: no caret movement, selection, or kill-ring yet (↑/↓ history recall is supported).
- Assistant text renders a terminal-markdown subset: ``` code blocks (regex-highlighted: comments, strings, keywords, numbers), headings, lists, quotes, bold/italic/inline code; tables and links are not supported.
- Commands and skills share one flat `/` menu (skills are distinguished by their description, not a group header).
- The approval `always` choice is a UI-side per-tool memory; it is not persisted across restarts.
- Esc does not interrupt a manual `/compact` (the command's signal is UI-lifetime); the compaction spinner keeps showing progress until the transaction settles.
- Cancellation is cooperative: the UI stops showing the turn as running and clears the prompt immediately, but the underlying agent may keep settling for a moment (tool SIGTERM grace, a CPU fold) before `turn/end` lands.
- Requires an interactive TTY; non-TTY invocation fails fast with a diagnostic (use `--profile headless` there).
