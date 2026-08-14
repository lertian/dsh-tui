/**
 * The TUI controller: owns the live Agent, folds its session log into the
 * view model, mediates input, slash commands, approvals, and session
 * switching, and exposes a subscribe/snapshot store for the Ink frame.
 * @module @deepseek-ai/dsh-tui-app/controller
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { AppExit } from '@deepseek-ai/dsh-cmdline'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Value import of the canonical user-invocation predicate; loading this module
// also merges the `ctx.skills` service key and the `skills/change` event into
// the cordis Context, like the empty type imports below.
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
// Empty type imports merge the service keys this controller reads through
// `ctx.get(...)` into the cordis Context interface.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-tools'
import { applyEvent, createProjection, oneLine, replayEvents } from './projection.ts'
import type { Projection } from './types.ts'
import type { SelectItem } from './ui/SelectList.tsx'

/** How many persisted sessions the session picker lists. */
const SESSION_PICKER_LIMIT = 30

/** How many newest same-directory sessions `-c` may walk past unreadable logs. */
const CONTINUE_CANDIDATE_LIMIT = 5

/** The answerer choice the approval overlay offers; `always` is a UI-side memory. */
export type ApprovalChoice = 'allowed-once' | 'rejected' | 'always'

/** The live approval prompt the overlay renders. */
export interface PendingApproval {
  readonly toolName: string
  readonly reason?: string
  /** Settle the question; the first call wins. */
  readonly decide: (choice: ApprovalChoice) => void
}

/** Lifecycle of the surface itself. */
export type TuiPhase = 'starting' | 'ready' | 'failed'

/** One row in the slash-command menu above the input box. */
export interface SlashMenuItem {
  readonly name: string
  readonly description: string
  /** The argument hint, e.g. "session id"; an empty string means no argument. */
  readonly hint: string
}

/** An interactive selection dialog the frame renders in place of the prompt. */
export interface PickerState {
  readonly kind: 'session' | 'model'
  readonly title: string
  readonly items: readonly SelectItem[]
}

/** The immutable snapshot the Ink frame renders from. */
export interface TuiSnapshot {
  readonly phase: TuiPhase
  /** Startup failure text when `phase` is `failed`. */
  readonly error: string | undefined
  /** The transcript projection of the current session. */
  readonly projection: Projection
  /** The live session id, or undefined before the agent is ready. */
  readonly sessionId: string | undefined
  /** The session's working directory (agent header), for the welcome banner. */
  readonly cwd: string
  /** `provider/model` of the next request. */
  readonly modelLabel: string
  /** The pending approval question, when one awaits the user. */
  readonly pendingApproval: PendingApproval | undefined
  /** The slash-command menu catalog, refreshed on `commands/change`. */
  readonly commands: readonly SlashMenuItem[]
  /** The user-invocable skill catalog, refreshed on `skills/change`. */
  readonly skills: readonly SlashMenuItem[]
  /** The open picker dialog, when one awaits a selection. */
  readonly picker: PickerState | null
  /** The current thinking level for the status bar; empty means provider default. */
  readonly thinkingLabel: string
  /** Where the input history persists, for the prompt to load and append. */
  readonly historyPath: string
  /**
   * Whether the user cancelled the open turn and the cooperative abort has
   * not converged yet. UI-side only: the frame presents `cancelling…` instead
   * of the running state until `turn/end` or the next `turn/start` lands.
   */
  readonly cancelPending: boolean
  /** Bumps on every /clear so the frame can reset its retired-row ledger. */
  readonly viewEpoch: number
}

/** Options for {@link TuiController}; services resolve through `ctx` lazily. */
export interface TuiControllerOptions {
  readonly ctx: Context
  readonly exit: AppExit
}

/**
 * Drive one interactive terminal session surface. One controller instance owns
 * one agent at a time; `/new` and `/resume` swap the agent and rebuild the
 * projection from the target session's durable log.
 */
export class TuiController {
  /** Mutable model selection coupled to the live agent's request routing. */
  private selectionRef: ModelSelectionRef = { current: undefined, assembled: undefined }
  private handle: AgentHandle | undefined
  private agent: Agent | undefined
  private projection = createProjection()
  private pendingApproval: PendingApproval | undefined
  private readonly alwaysAllowed = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private readonly disposers: (() => void)[] = []
  private readonly uiAbort = new AbortController()
  private snapshot: TuiSnapshot
  private phase: TuiPhase = 'starting'
  private error: string | undefined
  private picker: PickerState | null = null
  /** The live user-invocable skill catalog, backing the menu and gesture forwarding. */
  private skills: SlashMenuItem[] = []
  private exiting = false
  private sessionUnsubscribe: (() => void) | undefined
  /** UI-side flag: the user cancelled the open turn; see `TuiSnapshot.cancelPending`. */
  private cancelPending = false
  private viewEpoch = 0

  constructor(private readonly options: TuiControllerOptions) {
    this.snapshot = this.buildSnapshot()
  }

  /** React store protocol: subscribe to snapshot changes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** React store protocol: the current immutable snapshot. */
  readonly getSnapshot = (): TuiSnapshot => this.snapshot

  /** The live agent, when one is bound. */
  get currentAgent(): Agent | undefined {
    return this.agent
  }

  /**
   * Boot the surface: settle sibling loader entries, create or resume the
   * agent, replay its log, then wire events, approvals, and slash commands.
   * `--continue` walks the newest same-directory sessions and skips any whose
   * log fails to load, so one corrupt session cannot strand the startup.
   * @param options.resume - persisted session id to reopen, or null.
   * @param options.continue - reopen the newest readable session from this cwd.
   */
  async start(options: { resume: string | null; continue: boolean }): Promise<void> {
    const ctx = this.options.ctx
    try {
      // Loader siblings mount concurrently; await the full application so the
      // agent's scoped tools and adapters are not half-composed.
      await ctx.get('loader')?.await()
      let bound = false
      let notice: string | undefined
      if (options.resume !== null) {
        await this.swapAgent(await this.resolveSessionId(options.resume))
        bound = true
      } else if (options.continue) {
        const candidates = await this.recentSessionsInCwd()
        for (const candidate of candidates) {
          try {
            await this.swapAgent(candidate)
            bound = true
            break
          } catch {
            // Unreadable log: fall through to the next-newest candidate.
          }
        }
        if (!bound) {
          notice = candidates.length === 0
            ? 'no earlier session in this directory — starting fresh'
            : 'recent sessions in this directory are unreadable — starting fresh'
        }
      }
      if (!bound) await this.swapAgent(undefined)
      // After the swap: rebuilding the projection would drop an earlier notice.
      if (notice !== undefined) this.pushNotice('info', notice)
      this.registerApprovalAnswerer()
      this.registerCommands()
      // Commands must be registered first so colliding skill names are shadowed
      // (command wins) in the slash menu.
      await this.refreshSkills()
      this.phase = 'ready'
      this.touch()
    } catch (error: unknown) {
      this.phase = 'failed'
      this.error = error instanceof Error ? error.message : String(error)
      this.touch()
    }
  }

  /**
   * Submit one input batch: slash commands route to the command runtime (and
   * never reach the model); anything else queues a follow-up turn.
   * @param text - the raw input box content.
   */
  async submit(text: string): Promise<void> {
    const agent = this.agent
    if (agent === undefined || text.trim() === '' || this.phase !== 'ready') return
    if (!text.startsWith('/')) {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      return
    }
    const commands = this.options.ctx.get('commands')
    if (commands === undefined) {
      this.pushNotice('error', 'the command service is unavailable in this composition')
      return
    }
    try {
      const execution = await commands.execute(agent, text, this.uiAbort.signal)
      if (execution === undefined) {
        // A leading `/name` that is not a slash command but names a
        // user-invocable skill is the deterministic skill-load gesture:
        // forward it to the model so `dsh-tool-skill`'s pre-step injects the
        // rendered body. Command names already won above (`execute` resolved).
        if (this.skills.some(skill => isSkillGesture(text, skill.name))) {
          agent.followup(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }))
          return
        }
        const name = /^\/([a-z][a-z0-9_-]*)/u.exec(text)?.[1] ?? text
        this.pushNotice('warn', `unknown command /${name} — try /help`)
      }
    } catch (error: unknown) {
      if (this.uiAbort.signal.aborted) return
      this.pushNotice('error', error instanceof Error ? error.message : String(error))
    }
  }

  /** Flush the live session and request bounded process exit. */
  async quit(): Promise<void> {
    if (this.exiting) return
    this.exiting = true
    try {
      if (this.agent !== undefined) await this.options.ctx.get('sessions')?.flush(this.agent.session)
    } catch {
      // A flush failure must not trap the user in the UI.
    }
    this.options.exit(0)
  }

  /**
   * Cancel the active turn (Esc, or the first Ctrl+C while busy) and flip the
   * UI off the running state immediately. The agent's cooperative abort is
   * unchanged — it converges in the background and may take seconds (tool
   * SIGTERM grace, a CPU fold) — so the frame stops presenting the turn as
   * running now: the live streaming state clears, a `cancelling…` notice
   * lands, and `cancelPending` shows `cancelling…` in the status bar and live
   * region until `turn/end` (or the next `turn/start`) settles it. When the
   * agent is idle this is a no-op.
   */
  cancelTurn(): void {
    this.agent?.cancel({ kind: 'user' })
    if (this.cancelPending || !this.projection.busy) return
    this.cancelPending = true
    this.projection.streaming = undefined
    this.pushNotice('info', 'cancelling…')
  }

  /** Detach listeners and release the UI; process exit itself belongs to the launcher. */
  dispose(): void {
    this.uiAbort.abort()
    for (const dispose of this.disposers.splice(0)) dispose()
    this.sessionUnsubscribe?.()
    this.sessionUnsubscribe = undefined
    this.listeners.clear()
  }

  /** Start a fresh session (`/new`). */
  async newSession(): Promise<void> {
    await this.swapAgent(undefined)
    await this.refreshSkills()
  }

  /** Resume a persisted session (`/resume <id>`); the id may be a unique short prefix. */
  async resumeSession(id: string): Promise<void> {
    await this.swapAgent(await this.resolveSessionId(id))
    await this.refreshSkills()
  }

  /**
   * Resolve a user-supplied resume argument to the unique full id it names.
   * The input may be a complete `session-<uuid>` id, a bare uuid, or a unique
   * prefix of either form: `0b59b044` names `session-0b59b044-…`, and
   * `session-0b59b044` does too. Matching is case-sensitive against the literal
   * lower-case ids, over the same live/persisted corpus the session picker
   * lists. An exact full-id hit returns before any prefix scan.
   * @param input - the raw resume argument from `--resume` or `/resume`.
   * @returns the unique full {@link SessionId}.
   * @throws when no session matches, or when more than one session prefix-matches.
   */
  private async resolveSessionId(input: string): Promise<SessionId> {
    const id = input.trim()
    const full = `session-${id.replace(/^session-/u, '')}`
    const query = this.options.ctx.get('sessionQuery')
    // Without the query service (an unusual composition) fall back to exact-id
    // semantics: prefix a bare id and resume it, preserving prior behavior.
    if (query === undefined) return SessionId(full)
    const records = await query.listSessions(this.uiAbort.signal)
    const exact = records.find(record => record.header.id === id || record.header.id === full)
    if (exact !== undefined) return exact.header.id
    const candidates = records.filter(record => record.header.id.startsWith(id) || record.header.id.startsWith(full))
    const only = candidates.length === 1 ? candidates[0] : undefined
    if (only !== undefined) return only.header.id
    if (candidates.length === 0) throw new Error(`no such session "${id}"`)
    throw new Error(`ambiguous session id "${id}" — candidates: ${candidates.map(record => record.header.id).join(', ')}`)
  }

  /**
   * The picker rows for persisted sessions, newest first: short id, compact
   * timestamp, and title, with the directory named for other-cwd sessions.
   */
  private async sessionPickerItems(): Promise<SelectItem[]> {
    const query = this.options.ctx.get('sessionQuery')
    if (query === undefined) return []
    const cwd = process.cwd()
    const records = (await query.listSessions(this.uiAbort.signal))
      .filter(record => record.persisted && record.header.id !== this.agent?.id)
      .slice(0, SESSION_PICKER_LIMIT)
    return Promise.all(records.map(async (record): Promise<SelectItem> => {
      const title = await query.readTitle(record.header.id, this.uiAbort.signal)
        .then(snapshot => snapshot?.title, () => undefined)
      const here = record.header.cwd === cwd
      return {
        value: record.header.id,
        label: `${record.header.id.replace(/^session-/u, '').slice(0, 8)}  ${timeLabel(record.header.createdAt)}  ${title ?? '(untitled)'}`,
        description: here || record.header.cwd === undefined ? '' : basename(record.header.cwd),
      }
    }))
  }

  /** The picker rows for the advertised model catalog: `provider/model`. */
  private async modelPickerItems(): Promise<SelectItem[]> {
    const llm = this.options.ctx.get('llm')
    if (llm === undefined) return []
    const currentLabel = this.modelLabel()
    const groups = await Promise.all(llm.listProviders().map(async (provider) => {
      const models = await llm.listModels(provider.id).catch(() => [] as const)
      return models.map((model): SelectItem => {
        const label = `${provider.id}/${model.id}`
        return {
          value: label,
          label,
          description: label === currentLabel ? `(current) — ${oneLine(model.name, 48)}` : oneLine(model.name, 48),
        }
      })
    }))
    return groups.flat()
  }

  /**
   * Argument candidates for one command, resolved from the command's own
   * `complete` provider (the command-registry contract) — no per-command
   * special cases: `/resume` and `/model` carry theirs on their registrations
   * below, and `/permission` on its plugin's registration. A missing provider
   * or a failed call degrades to an empty list, never an error.
   * @param command - command name without a slash.
   * @param partialArg - the argument typed so far after the command name.
   */
  async argumentItems(command: string, partialArg: string): Promise<readonly SelectItem[]> {
    const agent = this.agent
    if (agent === undefined) return []
    const commands = this.options.ctx.get('commands')
    if (commands === undefined) return []
    try {
      return await commands.complete(agent, command, partialArg, this.uiAbort.signal) ?? []
    } catch (error: unknown) {
      if (this.uiAbort.signal.aborted) return []
      this.options.ctx.logger.warn(`tui: argument completion for /${command} failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /** Open the session picker (`/resume` with no id). */
  async openSessionPicker(): Promise<void> {
    const items = await this.sessionPickerItems()
    if (items.length === 0) {
      this.pushNotice('info', 'no persisted sessions yet')
      return
    }
    this.picker = { kind: 'session', title: 'resume a session', items }
    this.touch()
  }

  /** Open the model picker (`/model` with no arguments). */
  async openModelPicker(): Promise<void> {
    const items = await this.modelPickerItems()
    if (items.length === 0) {
      this.pushNotice('info', 'no provider advertises a model catalog — use /model <provider> <model>')
      return
    }
    this.picker = { kind: 'model', title: 'switch model', items }
    this.touch()
  }

  /** Dismiss the open picker without applying anything (Esc). */
  closePicker(): void {
    if (this.picker === null) return
    this.picker = null
    this.touch()
  }

  /** Apply the highlighted picker row: resume the session or switch the model. */
  async applyPickerSelection(value: string): Promise<void> {
    const picker = this.picker
    if (picker === null) return
    this.picker = null
    this.touch()
    if (picker.kind === 'session') {
      await this.resumeSession(value)
      this.pushNotice('info', `resumed session ${value}`)
      return
    }
    const separator = value.indexOf('/')
    await this.setModel(value.slice(0, separator), value.slice(separator + 1))
    this.pushNotice('info', `model switched to ${value}`)
  }

  /** The newest persisted sessions created in this cwd, for `-c/--continue`. */
  private async recentSessionsInCwd(): Promise<SessionId[]> {
    const query = this.options.ctx.get('sessionQuery')
    if (query === undefined) return []
    const cwd = process.cwd()
    const records = await query.listSessions(this.uiAbort.signal)
    return records
      .filter(record => record.persisted && record.header.cwd === cwd)
      .slice(0, CONTINUE_CANDIDATE_LIMIT)
      .map(record => record.header.id)
  }

  /**
   * Switch the next request's model and persist it as the default selection.
   * @param provider - registered provider route.
   * @param model - provider-owned model id.
   */
  async setModel(provider: string, model: string): Promise<void> {
    const selection: ModelSelection = { provider, model }
    this.selectionRef.current = selection
    await this.options.ctx.get('agentDefaultModel')?.saveSelection(selection)
    this.touch()
  }

  /** The current selection as `provider/model`. */
  modelLabel(): string {
    const current = this.selectionRef.current
    return current === undefined ? '(default)' : `${current.provider}/${current.model}`
  }

  /** The current thinking level for the status bar; empty means provider default. */
  thinkingLabel(): string {
    const effort = this.selectionRef.current?.reasoningEffort
    if (effort === undefined) return ''
    const id = String(effort)
    return id === '' ? '' : `${id.charAt(0).toUpperCase()}${id.slice(1)}`
  }

  /**
   * Cycle the selected reasoning effort to the next level the current model
   * advertises (Shift+Tab). The levels come from the adapter's exact-model
   * metadata, so `off` disables thinking and the remaining levels re-enable it
   * at that effort. Unsupported models report a notice instead.
   */
  async cycleReasoningEffort(): Promise<void> {
    if (this.phase !== 'ready' || this.agent === undefined) return
    const llm = this.options.ctx.get('llm')
    const defaultModel = this.options.ctx.get('agentDefaultModel')
    if (llm === undefined || defaultModel === undefined) {
      this.pushNotice('error', 'the llm or default-model service is unavailable in this composition')
      return
    }
    const selected = this.selectionRef.current ?? defaultModel.currentSelection()
    let info
    try {
      info = await llm.resolveModelInfo(selected.provider, selected.model, this.uiAbort.signal)
    } catch (error: unknown) {
      if (this.uiAbort.signal.aborted) return
      this.pushNotice('error', error instanceof Error ? error.message : String(error))
      return
    }
    const reasoning = info.reasoning
    const efforts = reasoning?.efforts
    if (efforts === undefined || efforts.length === 0) {
      this.pushNotice('info', `model ${selected.provider}/${selected.model} has no thinking-mode levels`)
      return
    }
    const current = selected.reasoningEffort ?? reasoning?.defaultEffort
    const index = efforts.findIndex(effort => effort.id === current)
    const next = efforts[(index < 0 ? 0 : index + 1) % efforts.length]
    if (next === undefined) return
    const nextSelection: ModelSelection = {
      provider: selected.provider,
      model: selected.model,
      reasoningEffort: next.id,
    }
    this.selectionRef.current = nextSelection
    await defaultModel.saveSelection(nextSelection)
    this.pushNotice('info', `thinking: ${next.name}`)
    this.touch()
  }

  /** The available provider routes for `/model` output. */
  listProviderIds(): string[] {
    return this.options.ctx.get('llm')?.listProviders().map(info => info.id) ?? []
  }

  /** Append a controller-originated notice row (not part of the session log). */
  pushNotice(tone: 'info' | 'warn' | 'error', text: string): void {
    this.projection.rows.push({
      kind: 'notice',
      key: `ui:${randomUUID()}`,
      tone,
      text,
    })
    this.touch()
  }

  /** Create or resume the agent, swap the binding, and rebuild the projection. */
  private async swapAgent(resume: SessionId | undefined): Promise<void> {
    const ctx = this.options.ctx
    const agents = ctx.get('agents')
    const defaultModel = ctx.get('agentDefaultModel')
    if (agents === undefined || defaultModel === undefined) {
      throw new Error('tui: the composition must mount ctx.agents and ctx.agentDefaultModel (the dsh-base bundle provides them)')
    }
    const previous = this.handle
    this.handle = undefined
    this.agent = undefined
    // The catalog belongs to the agent being swapped away; drop it now so the
    // frame never shows a stale skill list while the new agent binds.
    this.skills = []
    this.sessionUnsubscribe?.()
    this.sessionUnsubscribe = undefined
    if (previous !== undefined) {
      try {
        await ctx.get('sessions')?.flush(previous.agent.session)
      } catch {
        // Dispose proceeds regardless: durability is best-effort at swap time.
      }
      await previous.dispose()
    }
    const selection = defaultModel.currentSelection()
    this.selectionRef = { current: selection, assembled: undefined }
    const handle = resume === undefined
      ? await agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => { installModelSelection(agentCtx, this.selectionRef) },
      })
      : await agents.resume({
        resumeSessionId: resume,
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => { installModelSelection(agentCtx, this.selectionRef) },
      })
    this.handle = handle
    this.agent = handle.agent
    // Session-local model selection (web parity): a resume restores the model
    // and effort the session's own log last requested, instead of the global
    // default; a blank session keeps the default. The seed mutates the ref in
    // place so the installModelSelection waterfall listeners installed during
    // setup keep reading this same object.
    const logged = handle.agent.session.requestHeader()?.config
    if (logged !== undefined) {
      this.selectionRef.current = {
        provider: logged.provider,
        model: logged.model,
        ...logged.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: logged.reasoningEffort },
      }
    }
    const agentId = handle.agent.id
    // Replay the durable log, then fold live events. The subscription filters
    // by exact identity so swapped-away sessions never leak into the frame.
    this.cancelPending = false
    this.projection = replayEvents(handle.agent.session.events)
    this.sessionUnsubscribe = ctx.on('session/event', (session, event: SessionEvent) => {
      if (session.id !== agentId) return
      // A landed turn/end (or a fresh turn/start) settles a pending cancel:
      // the cooperative abort has converged, or a new turn supersedes it.
      if (event.type === 'turn/end' || event.type === 'turn/start') this.cancelPending = false
      applyEvent(this.projection, event)
      this.touch()
    })
    this.touch()
  }

  /** Answer approval questions with a terminal overlay; UI-side `always` memory. */
  private registerApprovalAnswerer(): void {
    const ctx = this.options.ctx
    this.disposers.push(ctx.on('approval/request', (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
      if (this.exiting || this.phase !== 'ready') return next()
      if (this.alwaysAllowed.has(req.toolName)) return Promise.resolve<ApprovalOutcome>('allowed-once')
      if (req.signal?.aborted) return Promise.resolve<ApprovalOutcome>('cancelled')
      return new Promise<ApprovalOutcome>((resolve) => {
        let settled = false
        const onAbort = (): void => { settle('cancelled') }
        const settle = (outcome: ApprovalOutcome): void => {
          if (settled) return
          settled = true
          req.signal?.removeEventListener('abort', onAbort)
          this.pendingApproval = undefined
          this.touch()
          resolve(outcome)
        }
        req.signal?.addEventListener('abort', onAbort, { once: true })
        this.pendingApproval = {
          toolName: req.toolName,
          ...req.reason === undefined ? {} : { reason: req.reason },
          decide: (choice) => {
            if (choice === 'always') {
              this.alwaysAllowed.add(req.toolName)
              settle('allowed-once')
              return
            }
            settle(choice)
          },
        }
        this.touch()
      })
    }))
  }

  /** Register the TUI's slash commands into the shared command runtime. */
  private registerCommands(): void {
    const commands = this.options.ctx.get('commands')
    if (commands === undefined) return
    this.disposers.push(commands.register({
      name: 'new',
      description: 'start a fresh session',
      handler: async () => {
        await this.newSession()
        return { kind: 'success', text: `started new session ${this.agent?.id ?? ''}` }
      },
    }))
    this.disposers.push(commands.register({
      name: 'resume',
      description: 'resume a persisted session by id or unique prefix: /resume <id>, or pick from a list',
      input: { hint: 'session id or prefix' },
      // Registered on the command itself (the registry completion contract):
      // the argument menu asks the command, never the surface.
      complete: () => this.sessionPickerItems(),
      handler: async ({ rawInput }) => {
        const id = rawInput.trim()
        if (id === '') {
          await this.openSessionPicker()
          return { kind: 'success', text: '' }
        }
        await this.resumeSession(id)
        return { kind: 'success', text: `resumed session ${id}` }
      },
    }))
    this.disposers.push(commands.register({
      name: 'model',
      description: 'show or switch the model: /model <provider> <model>, or pick from a list',
      input: { hint: 'provider model' },
      complete: () => this.modelPickerItems(),
      handler: async ({ rawInput }) => {
        const parts = rawInput.trim().split(/\s+/u).filter(part => part !== '')
        if (parts.length === 0) {
          await this.openModelPicker()
          return { kind: 'success', text: '' }
        }
        const current = this.selectionRef.current
        // One argument is usually a bare model id on the current provider;
        // the argument completer hands over a full `provider/model` label,
        // which must split back into its two parts instead.
        const [provider, model] = parts.length === 1
          ? parts[0]?.includes('/') === true
            ? [parts[0].slice(0, parts[0].indexOf('/')), parts[0].slice(parts[0].indexOf('/') + 1)]
            : [current?.provider, parts[0]]
          : [parts[0], parts[1]]
        if (provider === undefined || model === undefined) {
          return { kind: 'error', text: 'usage: /model <provider> <model>' }
        }
        await this.setModel(provider, model)
        return { kind: 'success', text: `model switched to ${provider}/${model}` }
      },
    }))
    this.disposers.push(commands.register({
      name: 'tools',
      description: 'list the tools available to the agent',
      handler: ({ agent }) => {
        const schemas = this.options.ctx.get('tools')?.schemas(agent) ?? []
        if (schemas.length === 0) return { kind: 'success', text: 'no tools registered' }
        const lines = schemas.map(schema => `${schema.name} — ${oneLine(schema.description, 72)}`)
        return { kind: 'success', text: lines.join('\n') }
      },
    }))
    this.disposers.push(commands.register({
      name: 'settings',
      description: 'where settings and credentials live',
      handler: () => {
        const home = resolveDshHome()
        return {
          kind: 'success',
          text: [
            `settings:    ${home}/settings.yaml   (llm-deepseek:, llm-pi-ai:, agent-default-model: sections; hot-reloaded)`,
            `credentials: ${home}/.credentials.yaml   (managed keys; the environment overrides it, e.g. DEEPSEEK_API_KEY)`,
            `profile:     ${home}/profiles/tui/cordis.patch.yml   (your plugin/config patch layer for this TUI)`,
            'plugins:     dsh plugin --profile tui add <package>   (third-party Cordis plugins mount their tools/commands here)',
            `model:       ${this.modelLabel()}   (switch with /model)`,
          ].join('\n'),
        }
      },
    }))
    this.disposers.push(commands.register({
      name: 'help',
      description: 'list the available slash commands',
      handler: ({ agent }) => {
        const list = this.options.ctx.get('commands')?.list(agent) ?? []
        const lines = list.map(command => `/${command.name} — ${command.description}`)
        if (this.skills.length > 0) {
          lines.push('', 'skills:')
          for (const skill of this.skills) lines.push(`/${skill.name} — ${skill.description}`)
        }
        lines.push('', 'keys:')
        lines.push([
          'Enter submit · Shift+Enter/Ctrl+J newline · ↑/↓ history · Shift+Tab thinking',
          'Esc cancel · Ctrl+O expand/collapse · Ctrl+C clears/interrupts, twice quits',
        ].join(' · '))
        return { kind: 'success', text: lines.join('\n') }
      },
    }))
    this.disposers.push(commands.register({
      name: 'quit',
      description: 'flush the session and exit',
      handler: () => {
        // Let command/done commit before the bounded exit disposes the tree.
        setImmediate(() => { void this.quit() })
        return { kind: 'success', text: 'bye' }
      },
    }))
    this.disposers.push(commands.register({
      name: 'clear',
      description: 'clear the transcript view (the session log is untouched)',
      handler: () => {
        this.projection.rows = []
        this.viewEpoch += 1
        this.touch()
        return { kind: 'success', text: 'view cleared — the session log is untouched' }
      },
    }))
    // Third-party plugins can register commands after boot; the menu re-reads.
    this.disposers.push(this.options.ctx.on('commands/change', () => { this.touch() }))
    // Skill providers may publish or change catalogs after boot; re-read the
    // user-invocable slice and republish the snapshot.
    this.disposers.push(this.options.ctx.on('skills/change', () => { void this.refreshSkills() }))
  }

  /** The slash-command menu catalog the input box renders above itself. */
  commandItems(): readonly SlashMenuItem[] {
    const agent = this.agent
    if (agent === undefined) return []
    const list = this.options.ctx.get('commands')?.list(agent) ?? []
    return list.map(command => ({
      name: command.name,
      description: command.description,
      hint: command.input?.hint ?? '',
    }))
  }

  /**
   * Refresh the user-invocable skill catalog for the live agent's scope.
   * Command names shadow colliding skill names (command wins, matching the web
   * client's client-side adjudication); `disable-model-invocation` skills stay
   * listed with a `user-only` marker. Failures and missing registries degrade
   * to an empty or last-good catalog and never fail the surface.
   */
  private async refreshSkills(): Promise<void> {
    const agent = this.agent
    if (agent === undefined) {
      this.skills = []
      return
    }
    const skills = this.options.ctx.get('skills')
    if (skills === undefined) {
      this.skills = []
      this.touch()
      return
    }
    try {
      const summaries = await skills.list({
        cwd: agent.session.header.cwd,
        signal: this.uiAbort.signal,
        scope: agent,
      })
      // A swap or teardown while the listing was in flight: discard the result.
      if (this.agent !== agent || this.uiAbort.signal.aborted) return
      const commands = this.options.ctx.get('commands')
      const commandNames = new Set((commands?.list(agent) ?? []).map(command => command.name))
      this.skills = summaries
        .filter(summary => isUserInvocable(summary) && !commandNames.has(summary.name))
        .map((summary) => {
          // Menu rows stay single-line: skill descriptions can be long or
          // multi-line frontmatter prose, which would wrap the fuzzy list.
          const description = oneLine(summary.description, 72)
          return {
            name: summary.name,
            description: summary.invocation.modelInvocable ? description : `user-only · ${description}`,
            hint: '',
          }
        })
    } catch (error: unknown) {
      this.options.ctx.logger.warn(`tui: skill catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.touch()
  }

  /** Publish a fresh snapshot to every subscribed frame. */
  private touch(): void {
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }

  /** Assemble the next immutable snapshot from the live fields. */
  private buildSnapshot(): TuiSnapshot {
    return {
      phase: this.phase,
      error: this.error,
      projection: this.projection,
      sessionId: this.agent?.id,
      cwd: this.agent?.session.header.cwd ?? process.cwd(),
      modelLabel: this.modelLabel(),
      pendingApproval: this.pendingApproval,
      commands: this.commandItems(),
      skills: this.skills,
      picker: this.picker,
      thinkingLabel: this.thinkingLabel(),
      cancelPending: this.cancelPending,
      historyPath: `${resolveDshHome()}/profiles/tui/history`,
      viewEpoch: this.viewEpoch,
    }
  }
}

/**
 * Whether `line` is a leading `/name` gesture for exactly this skill name:
 * the name must sit right after the slash and end at a word boundary (end of
 * line or whitespace), mirroring `dsh-tool-skill`'s gesture grammar so a
 * digit-leading kebab name (`/3d-model`) matches too.
 */
function isSkillGesture(line: string, name: string): boolean {
  const rest = line.slice(1)
  if (!rest.startsWith(name)) return false
  const after = rest[name.length]
  return after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '\r'
}

/** Compact timestamp for picker rows: today shows the clock time only. */
function timeLabel(createdAt: number): string {
  const date = new Date(createdAt)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString()} ${time}`
}
