# Agent Note: Slash-command argument completion registers on the command itself

Status: implemented

English | [中文](2026-08-14-command-argument-completion-contract.zh.md)

## Problem

The dsh TUI resolved slash-command argument candidates through a hardcoded special-case chain: `TuiController.argumentItems()` had `resume`/`model`/`permission` branches, and the `/permission` branch reached into `ctx.permissionPresets` directly. A third-party plugin registering a command could not offer argument completion at all — the knowledge of "how to complete this command's arguments" lived in the surface, not next to the command. This is the mechanism behind the TUI handoff's todo #4 (`/permission` completion), and Gemini's `SlashCommand.completion(context, partialArg)` — completion registered on the command itself — is the prior art.

## Decision

- **`CommandDefinition.complete`.** `@deepseek-ai/dsh-commands` gains an optional `complete?: (invocation: CommandCompleteInvocation) => readonly CommandCompletionItem[] | Promise<...>` where the invocation carries `{ agent, partialArg, signal }` and an item is `{ value, label, description? }`. The field registers on the command (its producer's registration), so every command — including third-party ones — owns its candidates.
- **Registry dispatch.** `CommandRuntime.complete(agent, name, partialArg, signal)` resolves the scoped-shadowed definition, calls its provider under the UI's abort signal (`withAbort`), and normalizes the result at the boundary (array of rows; non-empty string `value`; string `label`; optional string `description`; frozen, detached). Unknown names and commands without a provider return `undefined`. The handler-free wire descriptor (`list()`) stays function-free: `complete` never crosses it. Completion logs nothing and has no model impact — it is UI-plane only.
- **Surfaces consume the contract, not commands.** The TUI's `argumentItems(command, partialArg)` now calls `commands.complete(...)` and degrades to `[]` (with a warn) on provider failure; `/resume` and `/model` carry their own `complete` providers on their registrations, and `dsh-permission-presets` carries `/permission`'s (preset names with the `(current)` marker — the marker logic moved from the TUI into the package). The TUI prompt passes the live partial and re-asks as it changes, so providers may narrow server-side; the menu still fuzzy-ranks the rows.

## Alternatives considered

**A transitional controller-side Map of completion providers (deferred contract change).** Rejected: the registry contract is the correct foundation and the pre-release stance favors it over shims; the Map adds a second mechanism that the contract would later subsume.

**`complete(context)` without `partialArg` (providers always return the full list).** Rejected: the reference shape and server-side narrowing both need the partial, and the TUI already passes it per keystroke; providers that ignore it behave exactly like the full-list design.

**A `@Remote` completion method for the Web client.** Deferred: the web client has no argument-completion UI yet, and the repo requires a current consumer for wire surface; the host-side `complete` is the seam a future Remote can mirror.

## Consequences

- `@deepseek-ai/dsh-tui-app` drops its `@deepseek-ai/dsh-permission-presets` dependency (and tsconfig reference): the surface no longer reads the preset service; the command carries its completion.
- A provider's failure or malformed rows surface as a thrown error from `commands.complete`, which adapters contain (the TUI warns and shows an empty list); no lifecycle events are logged for completion.
- The TUI's argument menu now re-asks the provider as the partial changes (per keystroke), instead of loading once per command name; local providers return cheap lists and the existing cancelled-flag guard drops stale responses.
- Completion stays out of the model: no token, cache, or transcript effect; the commands README documents this under Model Experience.
