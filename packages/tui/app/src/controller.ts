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
  /** `provider/model` of the next request. */
  readonly modelLabel: string
  /** The pending approval question, when one awaits the user. */
  readonly pendingApproval: PendingApproval | undefined
  /** The slash-command menu catalog, refreshed on `commands/change`. */
  readonly commands: readonly SlashMenuItem[]
  /** The open picker dialog, when one awaits a selection. */
  readonly picker: PickerState | null
  /** The current thinking level for the status bar; empty means provider default. */
  readonly thinkingLabel: string
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
  private exiting = false
  private sessionUnsubscribe: (() => void) | undefined

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
   * @param options.resume - persisted session id to reopen, or null.
   * @param options.continue - reopen the newest session created in this cwd.
   */
  async start(options: { resume: string | null; continue: boolean }): Promise<void> {
    const ctx = this.options.ctx
    try {
      // Loader siblings mount concurrently; await the full application so the
      // agent's scoped tools and adapters are not half-composed.
      await ctx.get('loader')?.await()
      let target: SessionId | undefined
      let fellBackToFresh = false
      if (options.resume !== null) {
        target = SessionId(options.resume)
      } else if (options.continue) {
        target = await this.latestSessionInCwd()
        fellBackToFresh = target === undefined
      }
      await this.swapAgent(target)
      // After the swap: rebuilding the projection would drop an earlier notice.
      if (fellBackToFresh) this.pushNotice('info', 'no earlier session in this directory — starting fresh')
      this.registerApprovalAnswerer()
      this.registerCommands()
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
   * Cancel the active turn and clear queued input (Esc). When the agent is
   * idle this is a no-op; the aborted turn folds a "turn aborted" notice into
   * the transcript through the session log.
   */
  cancelTurn(): void {
    this.agent?.cancel({ kind: 'user' })
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
  }

  /** Resume a persisted session (`/resume <id>`). */
  async resumeSession(id: SessionId): Promise<void> {
    await this.swapAgent(id)
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
          description: label === currentLabel ? '(current)' : oneLine(model.name, 48),
        }
      })
    }))
    return groups.flat()
  }

  /** Argument candidates for `/resume` and `/model` after the command name. */
  async argumentItems(command: string): Promise<readonly SelectItem[]> {
    if (command === 'resume') return this.sessionPickerItems()
    if (command === 'model') return this.modelPickerItems()
    return []
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
      await this.resumeSession(SessionId(value))
      this.pushNotice('info', `resumed session ${value}`)
      return
    }
    const separator = value.indexOf('/')
    await this.setModel(value.slice(0, separator), value.slice(separator + 1))
    this.pushNotice('info', `model switched to ${value}`)
  }

  /** The newest persisted session created in this cwd, for `-c/--continue`. */
  private async latestSessionInCwd(): Promise<SessionId | undefined> {
    const query = this.options.ctx.get('sessionQuery')
    if (query === undefined) return undefined
    const cwd = process.cwd()
    const records = await query.listSessions(this.uiAbort.signal)
    return records.find(record => record.persisted && record.header.cwd === cwd)?.header.id
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
    const agentId = handle.agent.id
    // Replay the durable log, then fold live events. The subscription filters
    // by exact identity so swapped-away sessions never leak into the frame.
    this.projection = replayEvents(handle.agent.session.events)
    this.sessionUnsubscribe = ctx.on('session/event', (session, event: SessionEvent) => {
      if (session.id !== agentId) return
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
      description: 'resume a persisted session: /resume <id>, or pick from a list',
      input: { hint: 'session id' },
      handler: async ({ rawInput }) => {
        const id = rawInput.trim()
        if (id === '') {
          await this.openSessionPicker()
          return { kind: 'success', text: '' }
        }
        await this.resumeSession(SessionId(id))
        return { kind: 'success', text: `resumed session ${id}` }
      },
    }))
    this.disposers.push(commands.register({
      name: 'model',
      description: 'show or switch the model: /model <provider> <model>, or pick from a list',
      input: { hint: 'provider model' },
      handler: async ({ rawInput }) => {
        const parts = rawInput.trim().split(/\s+/u).filter(part => part !== '')
        if (parts.length === 0) {
          await this.openModelPicker()
          return { kind: 'success', text: '' }
        }
        const current = this.selectionRef.current
        const [provider, model] = parts.length === 1
          ? [current?.provider, parts[0]]
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
    // Third-party plugins can register commands after boot; the menu re-reads.
    this.disposers.push(this.options.ctx.on('commands/change', () => { this.touch() }))
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
      modelLabel: this.modelLabel(),
      pendingApproval: this.pendingApproval,
      commands: this.commandItems(),
      picker: this.picker,
      thinkingLabel: this.thinkingLabel(),
    }
  }
}

/** Compact timestamp for picker rows: today shows the clock time only. */
function timeLabel(createdAt: number): string {
  const date = new Date(createdAt)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString()} ${time}`
}
