# Agent Note: TUI short session-id resume

Status: implemented

English | [中文](2026-08-14-tui-short-session-id-resume.zh.md)

## Problem

`dsh --resume <id>` and the TUI `/resume <id>` slash command required the complete `session-<uuid>` string. Every other surface already abbreviates ids to the first eight uuid characters — the session picker's label and the status bar both render `id.replace(/^session-/u, '').slice(0, 8)` — so the id a user sees (`0b59b044`) was not an id the resume entry points accepted. Claude Code's `--resume`/`/resume` resolve a session from a short id, so requiring the full string was a sharp edge against the surface the TUI deliberately mirrors.

The JSONL persistence backend must stay exact-match: it names each session directory `encodeSegment(id)` and the coordinator relies on id-alone identity for resume determinism, so prefix matching there would let "which session" depend on what else happens to be on disk. Resolution therefore belongs in the UI/controller layer, over the `sessionQuery` listing.

## Decision

`TuiController.resolveSessionId(input)` resolves a resume argument to the unique full `SessionId` before any swap. It trims the input, strips one leading `session-` to derive `bare`, and forms the full candidate `session-${bare}`. It then reads the live-preferred corpus once through `ctx.get('sessionQuery')?.listSessions(...)`:

- **Exact hit first.** A record whose `header.id` equals the raw input or the full candidate returns immediately, so a complete id never takes the prefix path.
- **Unique prefix.** Otherwise every record whose `header.id` starts with the raw input or the full candidate is a candidate; exactly one candidate returns it. This makes a bare `0b59b044` and a prefixed `session-0b59b044` name the same `session-0b59b044-…`.
- **Zero matches** throw `no such session "<id>"`; **more than one** throw `ambiguous session id "<id>" — candidates: <full ids>`.
- Matching is case-sensitive against the literal lower-case ids.

When `sessionQuery` is absent (an unusual composition) resolution falls back to the full candidate, preserving the previous exact-id behavior. The method is wired into `start()`'s resume branch and into `resumeSession(id: string)`, which now accepts a raw string and resolves it; the `/resume` handler and `applyPickerSelection` pass strings through instead of pre-branding with `SessionId(...)`. Persistence is untouched; only the controller's short→full step is new.

## Alternatives considered

**Prefix matching inside `session-persistence-jsonl`'s `findLog`.** Rejected: the backend derives the storage path from the id alone and treats the id as exact identity; a prefix scan there would make resume nondeterministic against the on-disk corpus and break the coordinator's exact-id contract.

**Resolve in the `dsh` launcher (`apps/cli/src/args.ts`).** Rejected: the launcher forwards inner arguments verbatim and never parses `--resume`; it also would not cover the `/resume` slash command, and only the controller has the live `sessionQuery` corpus.

**Fuzzy/contains matching instead of prefix matching.** Rejected: a unique-prefix contract is deterministic and predictable from the displayed short id; fuzzy ranking would introduce ambiguity the interactive picker already handles.

## Consequences

- `dsh --resume 0b59b044` and `/resume 0b59b044` now resolve to the unique full id; `-c/--continue`, the short-id display, and the picker labels are unchanged.
- A resume argument with no unique match fails fast with the zero/ambiguous message, surfaced as a startup failure (`--resume`) or an error notice (`/resume`), never a silent wrong-session.
- Matching is case-sensitive; ids are lowercase `session-<uuid>`, so uppercase input simply does not match.

## Testing

`packages/tui/app/tests/controller.spec.ts` extends the `sessionQuery.listSessions` stub with a configurable `sessionIds` list and covers exact full-id match (with and without the `session-` prefix), bare and `session-`-prefixed short-id prefix resolution, `--resume` startup resolution, the zero-match error, and the ambiguity error.
