# Agent Note: The dsh TUI surfaces user-invocable skills in the `/` menu and forwards `/name`

Status: implemented

English | [中文](2026-08-14-tui-skill-surfacing-and-invocation.zh.md)

## Problem

The web client already exposes the skill catalog next to slash commands (`ui-skill` + `ui-input-trigger` surface skills; a skill pick ships the literal `/name` and `dsh-tool-skill`'s pre-step injects the rendered body; command names win over skill names). The TUI did neither:

1. **Skills were not surfaced.** `TuiController.commandItems()` read only `ctx.commands.list()`, so the `/` fuzzy menu listed commands alone, unlike Claude Code / Pi.
2. **`/name` never reached the model.** `TuiController.submit()` routed every leading-`/` line to `commands.execute()` and, on `undefined`, pushed `unknown command /name — try /help` without ever calling `agent.followup`. The `dsh-tool-skill` user-invocation gesture (`/name` → inject rendered skill body) therefore could not fire from the TUI.

## Decision

- **Skill catalog on the snapshot.** `TuiSnapshot` gains `skills` (a `SlashMenuItem[]` slice). `TuiController.refreshSkills()` reads the optional `ctx.get('skills')` registry with `skills.list({ cwd: agent.session.header.cwd, signal, scope: agent })`, keeps only `isUserInvocable` entries, and drops any name that collides with a registered command (command wins, matching the web client's client-side adjudication). `disable-model-invocation` skills stay listed with a `user-only ·` description prefix (the web `menu.userOnly` marker). The refresh runs after `registerCommands()` at boot (so shadowing is correct), after every `swapAgent` (via `/new` and `/resume`), and on `skills/change`. A missing registry or a listing failure degrades to an empty/last-good catalog and never fails the surface.
- **`/name` forwarding.** In `submit()`, when `commands.execute()` returns `undefined`, a leading `/name` matching a surfaced skill forwards the line as an ordinary `user/message` (`createUserMessage`), leaving the authoritative injection to `dsh-tool-skill`'s existing pre-step. `isSkillGesture(line, name)` mirrors the skill gesture's word-boundary grammar (name right after the slash, ending at end-of-line or whitespace), so digit-leading kebab names (`/3d-model`) match too. Unknown names keep the `unknown command` warning.
- **Menu composition.** `Prompt` receives `skills` alongside `commands` and fuzzes over one combined `menuEntries` list (commands first, then skills). A fully-typed skill name submits as typed; a highlighted skill completes to `/name ` (trailing space, like the web picker). `/help` also lists skills under a `skills:` heading.

## Alternatives considered

**Forward every non-command `/` line to the model and let `dsh-tool-skill` decide.** Rejected: it would erase the TUI's `unknown command` feedback (and the Claude/Pi parity the surface already established) for genuinely unknown commands. The registry-checked forward keeps the warning while fixing skill invocation, and matches the web client's "adjudication claims the line client-side" stance.

**Inline the `invocation.userInvocable` read instead of importing `isUserInvocable`.** Rejected: `isUserInvocable` is the exported predicate already used by `api-proxy` and `dsh-tool-skill`; reusing it keeps one canonical filter (and its value import also merges `ctx.skills`/`skills/change`).

**A grouped/headered `/` menu for skills.** Deferred: the existing `SelectList` is a flat window and the description marker is enough to distinguish skills; a group header is recorded in the package README's Known Limitations.

## Consequences

- The TUI now depends on `@deepseek-ai/dsh-skill` (peer + dev) — a type-and-value edge on a package `dsh-base` already mounts, so any TUI-capable composition resolves it.
- A forwarded `/name` is an ordinary `user/message` (surface op `append`); `dsh-tool-skill` remains the single authority for injection and its `skill-invocation` source, so no new session-event type is introduced.
- The catalog is a derived cache of the skill registry, refreshed on `skills/change`; a stale-agent guard discards in-flight results after `/new`/`/resume`.
- Command names shadow colliding skill names in both the menu and `submit()`, so a skill named like a command can only be reached by its command form.
