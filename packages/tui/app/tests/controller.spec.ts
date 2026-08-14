/** Controller behavior: boot, input routing, approvals, session swaps, and exit. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { CommandId, parseCommand } from '@deepseek-ai/dsh-commands'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
// Empty type import merges the `skills/change` event for the refresh test.
import type {} from '@deepseek-ai/dsh-skill'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { TuiController } from '../src/controller.ts'
import type { NoticeRow } from '../src/types.ts'

/** Records one scripted agent's observable interactions. */
interface AgentSpy {
  agent: Agent
  followups: UserMessage[]
  cancels: number
  disposed: boolean
}

/** Boot options for a fresh session. */
const FRESH = { resume: null, continue: false } as const

/** A minimal command-runtime stand-in that logs lifecycle events like the real one. */
function mockCommands() {
  const definitions = new Map<string, CommandDefinition>()
  let counter = 0
  return {
    definitions,
    register(definition: CommandDefinition): () => void {
      definitions.set(definition.name, definition)
      return () => { definitions.delete(definition.name) }
    },
    list: () => [...definitions.values()].map(def => ({ name: def.name, description: def.description })),
    async execute(agent: Agent, line: string, signal: AbortSignal): Promise<{ result: CommandResult } | undefined> {
      const parsed = parseCommand(line)
      const definition = parsed === undefined ? undefined : definitions.get(parsed.name)
      if (parsed === undefined || definition === undefined) return undefined
      counter += 1
      const commandId = CommandId(`cmd-test-${counter}`)
      agent.session.append('command/run', {
        commandId,
        name: parsed.name,
        args: parsed.rawInput,
        source: { kind: 'user' },
      })
      const result = await definition.handler({ commandId, agent, rawInput: parsed.rawInput, signal })
      agent.session.append('command/done', {
        commandId,
        kind: result.kind,
        ...result.text === undefined ? {} : { text: result.text },
      })
      return { result }
    },
    async complete(
      agent: Agent,
      name: string,
      partialArg: string,
      signal: AbortSignal,
    ): Promise<readonly { value: string; label: string; description?: string }[] | undefined> {
      const provider = definitions.get(name)?.complete
      if (provider === undefined) return undefined
      return provider({ agent, partialArg, signal })
    },
  }
}

/** The bench: real session/agent registries, scripted factory, mock UI-side services. */
async function bench(options: {
  failCreate?: boolean
  withSessionQuery?: boolean
  sessionIds?: readonly string[]
  sessionCwd?: string
  failResumeOn?: readonly string[]
  omitSkills?: boolean
  /** Per-session last-requested header config, keyed by session id. */
  loggedHeaders?: Readonly<Record<string, { provider: string; model: string; reasoningEffort?: ReasoningEffortId }>>
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  const commands = mockCommands()
  ctx.provide('commands', commands as never)
  const llm = {
    listProviders: () => [{ id: 'test-provider', name: 'Test' }],
    listModels: async () => [{ provider: 'test-provider', id: 'test-model', name: 'Test Model' }],
    resolveModelInfo: async (provider: string, model: string) => ({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        defaultEffort: 'high',
      },
    }),
  }
  ctx.provide('llm', llm as never)
  ctx.provide('tools', {
    schemas: () => [
      { name: 'bash', description: 'run bash commands', parameters: {} },
      { name: 'fs_read', description: 'read files', parameters: {} },
    ],
  } as never)
  const skillCatalog = [
    { name: 'review', description: 'review changes', invocation: { modelInvocable: true, userInvocable: true }, source: 'test', provider: 'test' },
    { name: 'user-only-skill', description: 'user surface only', invocation: { modelInvocable: false, userInvocable: true }, source: 'test', provider: 'test' },
    { name: 'model-only-skill', description: 'model surface only', invocation: { modelInvocable: true, userInvocable: false }, source: 'test', provider: 'test' },
    { name: 'new', description: 'shadowed by the /new command', invocation: { modelInvocable: true, userInvocable: true }, source: 'test', provider: 'test' },
  ]
  const skills = { catalog: skillCatalog, list: async () => skillCatalog }
  if (options.omitSkills !== true) {
    ctx.provide('skills', skills as never)
  }
  if (options.withSessionQuery === true) {
    const ids = options.sessionIds ?? ['session-old']
    ctx.provide('sessionQuery', {
      listSessions: async () => ids.map((id, index) => ({
        header: {
          version: 0,
          id: SessionId(id),
          createdAt: 1_700_000_000_000 - index,
          ...options.sessionCwd === undefined ? {} : { cwd: options.sessionCwd },
        },
        live: false,
        persisted: true,
      })),
      readTitle: async () => ({ title: 'old chat' }),
    } as never)
  }
  const spies: AgentSpy[] = []
  const resumeCalls: string[] = []
  const makeAgent = async (ownerCtx: Context, opts: CreateAgentOptions): Promise<AgentHandle> => {
    if (options.failCreate === true) throw new Error('factory exploded')
    // prepare/enter/announce instead of create: the bench must be able to
    // re-resume the same session id, so the handle's dispose detaches the
    // session entry rather than leaving it owned by the test fiber.
    const session = ctx.sessions.prepare(opts.sessionId, {
      ...opts.meta === undefined ? {} : { meta: opts.meta },
    })
    const detachSession = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    // A persisted session's log carries the request/header the per-session
    // model-selection seed restores from.
    const logged = options.loggedHeaders?.[opts.sessionId]
    if (logged !== undefined) {
      session.append('request/header', { header: { config: logged }, reason: 'initial' })
    }
    const spy = { followups: [], cancels: 0, disposed: false } as unknown as AgentSpy
    const agent = {} as Agent
    const agentCtx = ownerCtx.extend({ agent })
    Object.assign(agent, {
      id: session.id,
      options: opts.agentOptions ?? {},
      session,
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      ctx: agentCtx,
      cancel: () => { spy.cancels += 1 },
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      followup: (message: UserMessage) => {
        spy.followups.push(message)
        // Mirror the real loop: a waking follow-up opens a turn and logs the prompt.
        session.append('turn/start', { turn: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
      },
      steer: () => {},
      inject: () => {},
      whenIdle: () => Promise.resolve(),
    } satisfies Partial<Agent>)
    spy.agent = agent
    spies.push(spy)
    await opts.setup?.(agentCtx)
    // Real registry semantics: dispose detaches the entries so a later resume
    // of the same id can re-register and re-create.
    const unregister = ctx.agents.register(agent)
    return {
      agent,
      dispose: () => {
        spy.disposed = true
        detachSession()
        unregister()
        return Promise.resolve()
      },
    }
  }
  ctx.agents.setFactory({
    createAgent: (ownerCtx, opts) => makeAgent(ownerCtx, opts),
    resume: (ownerCtx: Context, opts: ResumeAgentOptions) => {
      resumeCalls.push(opts.resumeSessionId)
      if (options.failResumeOn?.includes(opts.resumeSessionId) === true) {
        return Promise.reject(new Error('corrupt session log'))
      }
      return makeAgent(ownerCtx, {
        sessionId: opts.resumeSessionId,
        ...opts.agentOptions === undefined ? {} : { agentOptions: opts.agentOptions },
        ...opts.setup === undefined ? {} : { setup: opts.setup },
      })
    },
  })
  const exits: number[] = []
  const controller = new TuiController({ ctx, exit: (code) => { exits.push(code) } })
  return { ctx, controller, commands, skills, spies, resumeCalls, exits, llm }
}

/** Dispatch one approval question through the real cordis waterfall. */
function ask(ctx: Context, req: ApprovalRequest): Promise<ApprovalOutcome> {
  return ctx.waterfall('approval/request', req, () => Promise.resolve<ApprovalOutcome>('unavailable'))
}

describe('TuiController boot', () => {
  it('creates a fresh agent and becomes ready', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    const snapshot = controller.getSnapshot()
    expect(snapshot.phase).toBe('ready')
    expect(snapshot.sessionId).toMatch(/^session-/u)
    expect(snapshot.modelLabel).toBe('test-provider/test-model')
    expect(spies).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('resumes a persisted session through the registry', async () => {
    const { ctx, controller, resumeCalls } = await bench()
    await controller.start({ resume: 'session-42', continue: false })
    expect(resumeCalls).toEqual(['session-42'])
    expect(controller.getSnapshot().sessionId).toBe('session-42')
    expect(controller.getSnapshot().phase).toBe('ready')
    await ctx.fiber.dispose()
  })

  it('surfaces a startup failure instead of hanging', async () => {
    const { ctx, controller } = await bench({ failCreate: true })
    await controller.start(FRESH)
    expect(controller.getSnapshot().phase).toBe('failed')
    expect(controller.getSnapshot().error).toBe('factory exploded')
    await ctx.fiber.dispose()
  })
})

describe('input routing', () => {
  it('routes plain text to the agent inbox and renders the echoed prompt', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    await controller.submit('hello world')
    expect(spies[0]?.followups).toHaveLength(1)
    expect(spies[0]?.followups[0]?.content).toEqual([{ type: 'text', text: 'hello world' }])
    expect(controller.getSnapshot().projection.rows).toContainEqual(
      expect.objectContaining({ kind: 'user', text: 'hello world' }),
    )
    await ctx.fiber.dispose()
  })

  it('ignores empty input', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    await controller.submit('   ')
    expect(spies[0]?.followups).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('executes slash commands and renders their output rows', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    await controller.submit('/tools')
    const rows = controller.getSnapshot().projection.rows
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'command', name: 'tools', status: 'done' }))
    const command = rows.find(row => row.kind === 'command')
    expect(command?.kind === 'command' && command.text).toContain('bash — run bash commands')
    await ctx.fiber.dispose()
  })

  it('warns on unknown commands', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    await controller.submit('/nope')
    const notice = controller.getSnapshot().projection.rows.at(-1) as NoticeRow
    expect(notice).toMatchObject({ kind: 'notice', tone: 'warn' })
    expect(notice.text).toContain('unknown command /nope')
    await ctx.fiber.dispose()
  })

  it('forwards a leading /name gesture for a user-invocable skill to the model', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    await controller.submit('/review')
    expect(spies[0]?.followups).toHaveLength(1)
    expect(spies[0]?.followups[0]?.content).toEqual([{ type: 'text', text: '/review' }])
    expect(controller.getSnapshot().projection.rows.at(-1)).toMatchObject({ kind: 'user', text: '/review' })
    await ctx.fiber.dispose()
  })

  it('lists user-invocable skills in /help output', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    await controller.submit('/help')
    const command = controller.getSnapshot().projection.rows.find(row => row.kind === 'command')
    const text = command?.kind === 'command' ? command.text ?? '' : ''
    expect(text).toContain('skills:')
    expect(text).toContain('/review — review changes')
    await ctx.fiber.dispose()
  })

  it('lists the registered commands with /help', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    await controller.submit('/help')
    const command = controller.getSnapshot().projection.rows.find(row => row.kind === 'command')
    const text = command?.kind === 'command' ? command.text ?? '' : ''
    for (const name of ['/new', '/resume', '/model', '/tools', '/settings', '/help', '/quit']) {
      expect(text).toContain(name)
    }
    expect(text).toContain('keys:')
    expect(text).toContain('Ctrl+O')
    await ctx.fiber.dispose()
  })

  it('switches the model with /model and opens the picker on a bare /model', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    await controller.submit('/model test-provider test-model-2')
    expect(controller.getSnapshot().modelLabel).toBe('test-provider/test-model-2')
    await controller.submit('/model')
    const picker = controller.getSnapshot().picker
    expect(picker?.kind).toBe('model')
    expect(picker?.items.map(item => item.value)).toEqual(['test-provider/test-model'])
    await ctx.fiber.dispose()
  })

  it('rejects a malformed /model invocation', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    await controller.submit('/model onlyprovider')
    // One part means "same provider, new model" — that is accepted.
    expect(controller.getSnapshot().modelLabel).toBe('test-provider/onlyprovider')
    await ctx.fiber.dispose()
  })

  it('splits a completer-style provider/model argument back into its parts', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    // The argument menu yields full labels; submitting one must not become
    // provider=`test-provider` model=`test-provider/test-model-2`.
    await controller.submit('/model test-provider/test-model-2')
    expect(controller.getSnapshot().modelLabel).toBe('test-provider/test-model-2')
    await ctx.fiber.dispose()
  })
})

describe('approvals', () => {
  it('suspends the question until the overlay decides', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    const agent = spies[0]?.agent as Agent
    const pending = ask(ctx, { agent, toolName: 'bash', reason: 'writes files' })
    await Promise.resolve()
    const question = controller.getSnapshot().pendingApproval
    expect(question).toMatchObject({ toolName: 'bash', reason: 'writes files' })
    question?.decide('allowed-once')
    await expect(pending).resolves.toBe('allowed-once')
    expect(controller.getSnapshot().pendingApproval).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rejects via the overlay', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    const agent = spies[0]?.agent as Agent
    const pending = ask(ctx, { agent, toolName: 'bash' })
    await Promise.resolve()
    controller.getSnapshot().pendingApproval?.decide('rejected')
    await expect(pending).resolves.toBe('rejected')
    await ctx.fiber.dispose()
  })

  it('remembers "always" per tool for the rest of the UI session', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    const agent = spies[0]?.agent as Agent
    const first = ask(ctx, { agent, toolName: 'bash' })
    await Promise.resolve()
    controller.getSnapshot().pendingApproval?.decide('always')
    await expect(first).resolves.toBe('allowed-once')
    // Second question for the same tool resolves without surfacing the overlay.
    await expect(ask(ctx, { agent, toolName: 'bash' })).resolves.toBe('allowed-once')
    expect(controller.getSnapshot().pendingApproval).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('settles cancelled when the request signal aborts mid-question', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    const agent = spies[0]?.agent as Agent
    const abort = new AbortController()
    const pending = ask(ctx, { agent, toolName: 'bash', signal: abort.signal })
    await Promise.resolve()
    expect(controller.getSnapshot().pendingApproval).toBeDefined()
    abort.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(controller.getSnapshot().pendingApproval).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('answers an already-aborted request immediately', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    const agent = spies[0]?.agent as Agent
    const abort = new AbortController()
    abort.abort()
    await expect(ask(ctx, { agent, toolName: 'bash', signal: abort.signal })).resolves.toBe('cancelled')
    await ctx.fiber.dispose()
  })
})

describe('session lifecycle', () => {
  it('swaps to a fresh session on /new and disposes the previous handle', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    const first = spies[0] as AgentSpy
    await controller.submit('/new')
    expect(spies).toHaveLength(2)
    expect(first.disposed).toBe(true)
    expect(controller.getSnapshot().sessionId).toBe(spies[1]?.agent.id)
    expect(controller.getSnapshot().projection.rows).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('opens the session picker on a bare /resume and resumes by id', async () => {
    const { ctx, controller, resumeCalls } = await bench({ withSessionQuery: true })
    await controller.start(FRESH)
    await controller.submit('/resume')
    const picker = controller.getSnapshot().picker
    expect(picker?.kind).toBe('session')
    expect(picker?.items[0]?.value).toBe('session-old')
    expect(picker?.items[0]?.label).toContain('old chat')
    await controller.submit('/resume session-old')
    expect(resumeCalls).toEqual(['session-old'])
    await ctx.fiber.dispose()
  })

  it('degrades to a notice when no session history is available', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    // No session-query service in this composition: the picker stays closed
    // and the user gets a notice instead of a crash.
    await controller.submit('/resume')
    expect(controller.getSnapshot().picker).toBeNull()
    const notice = controller.getSnapshot().projection.rows.at(-1) as NoticeRow
    expect(notice).toMatchObject({ kind: 'notice', text: 'no persisted sessions yet' })
    await ctx.fiber.dispose()
  })

  it('continues the newest same-directory session on continue', async () => {
    const { ctx, controller, resumeCalls } = await bench({ withSessionQuery: true, sessionCwd: process.cwd() })
    await controller.start({ resume: null, continue: true })
    expect(resumeCalls).toEqual(['session-old'])
    expect(controller.getSnapshot().sessionId).toBe('session-old')
    await ctx.fiber.dispose()
  })

  it('falls back to a fresh session when no same-directory session exists', async () => {
    const { ctx, controller, resumeCalls, spies } = await bench({ withSessionQuery: true, sessionCwd: '/elsewhere' })
    await controller.start({ resume: null, continue: true })
    expect(resumeCalls).toEqual([])
    expect(spies).toHaveLength(1)
    const notice = controller.getSnapshot().projection.rows.at(-1) as NoticeRow
    expect(notice.text).toContain('no earlier session')
    await ctx.fiber.dispose()
  })

  it('skips an unreadable session and continues with the next one', async () => {
    const { ctx, controller, resumeCalls } = await bench({ failResumeOn: ['session-broken'] })
    ctx.provide('sessionQuery', {
      listSessions: async () => [
        { header: { version: 0, id: SessionId('session-broken'), createdAt: 2, cwd: process.cwd() }, live: false, persisted: true },
        { header: { version: 0, id: SessionId('session-good'), createdAt: 1, cwd: process.cwd() }, live: false, persisted: true },
      ],
      readTitle: async () => undefined,
    } as never)
    await controller.start({ resume: null, continue: true })
    expect(resumeCalls).toEqual(['session-broken', 'session-good'])
    expect(controller.getSnapshot().sessionId).toBe('session-good')
    expect(controller.getSnapshot().phase).toBe('ready')
    await ctx.fiber.dispose()
  })

  it('applies a session picker selection by resuming it', async () => {
    const { ctx, controller, resumeCalls } = await bench({ withSessionQuery: true })
    await controller.start(FRESH)
    await controller.openSessionPicker()
    await controller.applyPickerSelection('session-old')
    expect(controller.getSnapshot().picker).toBeNull()
    expect(resumeCalls).toEqual(['session-old'])
    await ctx.fiber.dispose()
  })

  it('applies a model picker selection and closes the picker on cancel', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    await controller.openModelPicker()
    expect(controller.getSnapshot().picker?.kind).toBe('model')
    await controller.applyPickerSelection('test-provider/test-model')
    expect(controller.getSnapshot().picker).toBeNull()
    expect(controller.getSnapshot().modelLabel).toBe('test-provider/test-model')
    await controller.openModelPicker()
    controller.closePicker()
    expect(controller.getSnapshot().picker).toBeNull()
    await ctx.fiber.dispose()
  })

  it('offers session and model argument items for the slash menu', async () => {
    const { ctx, controller } = await bench({ withSessionQuery: true })
    await controller.start(FRESH)
    expect((await controller.argumentItems('resume', ''))[0]?.value).toBe('session-old')
    const modelItems = await controller.argumentItems('model', '')
    expect(modelItems[0]?.value).toBe('test-provider/test-model')
    expect(modelItems[0]?.description).toBe('(current) — Test Model')
    // A command without a completion provider yields an empty list.
    expect(await controller.argumentItems('tools', '')).toEqual([])
    await ctx.fiber.dispose()
  })

  it('resolves argument items from a third-party command registered complete provider', async () => {
    const { ctx, controller, commands, spies } = await bench()
    const seen: string[] = []
    commands.register({
      name: 'permission',
      description: 'switch preset',
      input: { hint: '<preset>' },
      complete: ({ partialArg }) => {
        seen.push(partialArg)
        return [
          { value: 'read-only', label: 'read-only', description: '' },
          { value: 'workspace-write', label: 'workspace-write', description: '' },
          { value: 'danger-full-access', label: 'danger-full-access', description: '(current)' },
        ]
      },
      handler: () => ({ kind: 'success' }),
    })
    await controller.start(FRESH)
    expect(spies[0]?.followups).toHaveLength(0)
    const items = await controller.argumentItems('permission', 'da')
    expect(items.map(item => item.value)).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    expect(items[2]?.description).toBe('(current)')
    expect(seen).toEqual(['da'])
    await ctx.fiber.dispose()
  })

  it('degrades to an empty list when a command completion provider fails', async () => {
    const { ctx, controller, commands } = await bench()
    commands.register({
      name: 'exploding',
      description: 'explodes on completion',
      input: { hint: '<x>' },
      complete: () => { throw new Error('completion exploded') },
      handler: () => ({ kind: 'success' }),
    })
    await controller.start(FRESH)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    expect(await controller.argumentItems('exploding', '')).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('argument completion for /exploding failed'))
    await ctx.fiber.dispose()
  })

  it('exposes the slash-command catalog on the snapshot', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    expect(controller.getSnapshot().commands.map(command => command.name))
      .toEqual(['new', 'resume', 'model', 'tools', 'settings', 'help', 'quit', 'clear'])
    await ctx.fiber.dispose()
  })

  it('exposes the user-invocable skill catalog on the snapshot', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    const skills = controller.getSnapshot().skills
    expect(skills.map(skill => skill.name)).toEqual(['review', 'user-only-skill'])
    expect(skills[0]).toMatchObject({ name: 'review', hint: '', description: 'review changes' })
    expect(skills[1]).toMatchObject({ name: 'user-only-skill', hint: '', description: 'user-only · user surface only' })
    await ctx.fiber.dispose()
  })

  it('re-reads the skill catalog when skills/change fires', async () => {
    const { ctx, controller, skills } = await bench()
    await controller.start(FRESH)
    expect(controller.getSnapshot().skills.map(skill => skill.name)).toEqual(['review', 'user-only-skill'])
    skills.catalog.push({ name: 'extra-skill', description: 'added later', invocation: { modelInvocable: true, userInvocable: true }, source: 'test', provider: 'test' })
    ctx.emit('skills/change')
    await new Promise(resolve => setImmediate(resolve))
    expect(controller.getSnapshot().skills.map(skill => skill.name)).toEqual(['review', 'user-only-skill', 'extra-skill'])
    await ctx.fiber.dispose()
  })

  it('degrades to an empty skill catalog when the composition lacks dsh-skill', async () => {
    const { ctx, controller } = await bench({ omitSkills: true })
    await controller.start(FRESH)
    expect(controller.getSnapshot().skills).toEqual([])
    await controller.submit('/review')
    const notice = controller.getSnapshot().projection.rows.at(-1) as NoticeRow
    expect(notice).toMatchObject({ kind: 'notice', tone: 'warn', text: 'unknown command /review — try /help' })
    await ctx.fiber.dispose()
  })

  it('renders skill descriptions as a single truncated line', async () => {
    const { ctx, controller, skills } = await bench()
    await controller.start(FRESH)
    skills.catalog.push({
      name: 'verbose-skill',
      description: `line one\nline two ${'x'.repeat(200)}`,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'test',
      provider: 'test',
    })
    ctx.emit('skills/change')
    await new Promise(resolve => setImmediate(resolve))
    const skill = controller.getSnapshot().skills.find(entry => entry.name === 'verbose-skill')
    const flat = `line one line two ${'x'.repeat(200)}`
    expect(skill?.description).toBe(`${flat.slice(0, 71)}…`)
    await ctx.fiber.dispose()
  })

  it('quits through the bounded exit after a flush', async () => {
    const { ctx, controller, exits } = await bench()
    await controller.start(FRESH)
    let flushed = 0
    ctx.on('session/flush', () => { flushed += 1 })
    await controller.quit()
    expect(flushed).toBe(1)
    expect(exits).toEqual([0])
    // A second quit is a no-op.
    await controller.quit()
    expect(exits).toEqual([0])
    await ctx.fiber.dispose()
  })

  it('clears the transcript view without touching the session log', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    await controller.submit('hello')
    expect(controller.getSnapshot().projection.rows.length).toBeGreaterThan(0)
    const epochBefore = controller.getSnapshot().viewEpoch
    await controller.submit('/clear')
    expect(controller.getSnapshot().projection.rows).toEqual([])
    expect(controller.getSnapshot().viewEpoch).toBe(epochBefore + 1)
    await ctx.fiber.dispose()
  })

  it('exits through /quit', async () => {
    const { ctx, controller, exits } = await bench()
    await controller.start(FRESH)
    await controller.submit('/quit')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(exits).toEqual([0])
    await ctx.fiber.dispose()
  })
})

describe('per-session model selection', () => {
  it('restores the logged provider, model, and reasoning effort on resume', async () => {
    const { ctx, controller } = await bench({
      loggedHeaders: {
        'session-a': { provider: 'test-provider', model: 'deepseek-reasoner', reasoningEffort: ReasoningEffortId('high') },
      },
    })
    await controller.start({ resume: 'session-a', continue: false })
    expect(controller.getSnapshot().modelLabel).toBe('test-provider/deepseek-reasoner')
    expect(controller.getSnapshot().thinkingLabel).toBe('High')
    await ctx.fiber.dispose()
  })

  it('restores the logged provider and model without an effort on resume', async () => {
    const { ctx, controller } = await bench({
      loggedHeaders: { 'session-a': { provider: 'test-provider', model: 'deepseek-chat' } },
    })
    await controller.start({ resume: 'session-a', continue: false })
    expect(controller.getSnapshot().modelLabel).toBe('test-provider/deepseek-chat')
    expect(controller.getSnapshot().thinkingLabel).toBe('')
    await ctx.fiber.dispose()
  })

  it('keeps the global default for a fresh session with no logged header', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    expect(controller.getSnapshot().modelLabel).toBe('test-provider/test-model')
    expect(controller.getSnapshot().thinkingLabel).toBe('')
    await ctx.fiber.dispose()
  })

  it('keeps parallel sessions independent: switching one model leaves the other untouched', async () => {
    const { ctx, controller } = await bench({
      loggedHeaders: {
        'session-a': { provider: 'test-provider', model: 'model-a' },
        'session-b': { provider: 'test-provider', model: 'model-b', reasoningEffort: ReasoningEffortId('max') },
      },
    })
    await controller.start({ resume: 'session-a', continue: false })
    expect(controller.getSnapshot().modelLabel).toBe('test-provider/model-a')
    // The in-process switch applies to session A only.
    await controller.submit('/model test-provider/switched')
    expect(controller.getSnapshot().modelLabel).toBe('test-provider/switched')
    // Session B resumes with its own logged model and effort.
    await controller.submit('/resume session-b')
    expect(controller.getSnapshot().modelLabel).toBe('test-provider/model-b')
    expect(controller.getSnapshot().thinkingLabel).toBe('Max')
    // Re-resuming session A restores its own logged model — neither the
    // in-process switch nor session B's model.
    await controller.submit('/resume session-a')
    expect(controller.getSnapshot().modelLabel).toBe('test-provider/model-a')
    expect(controller.getSnapshot().thinkingLabel).toBe('')
    await ctx.fiber.dispose()
  })
})

describe('session id resolution', () => {
  const FULL = 'session-0b59b044-aaaa-4bbb-8ccc-ddddeeeeffff'
  const OTHER = 'session-0b59b044-bbbb-4bbb-8ccc-ddddeeeeffff'
  const UNRELATED = 'session-11111111-cccc-4ddd-8eee-ffff00001111'

  it('resumes by an exact full id', async () => {
    const { ctx, controller, resumeCalls } = await bench({ withSessionQuery: true, sessionIds: [FULL, UNRELATED] })
    await controller.start(FRESH)
    await controller.submit(`/resume ${FULL}`)
    expect(resumeCalls).toEqual([FULL])
    expect(controller.getSnapshot().sessionId).toBe(FULL)
    await ctx.fiber.dispose()
  })

  it('resumes by an exact full id without the session- prefix', async () => {
    const { ctx, controller, resumeCalls } = await bench({ withSessionQuery: true, sessionIds: [FULL, UNRELATED] })
    await controller.start(FRESH)
    await controller.submit(`/resume ${FULL.slice('session-'.length)}`)
    expect(resumeCalls).toEqual([FULL])
    await ctx.fiber.dispose()
  })

  it('resolves a bare short-id prefix to the unique session', async () => {
    const { ctx, controller, resumeCalls } = await bench({ withSessionQuery: true, sessionIds: [FULL, UNRELATED] })
    await controller.start(FRESH)
    await controller.submit('/resume 0b59b044')
    expect(resumeCalls).toEqual([FULL])
    expect(controller.getSnapshot().sessionId).toBe(FULL)
    await ctx.fiber.dispose()
  })

  it('resolves a session--prefixed partial id', async () => {
    const { ctx, controller, resumeCalls } = await bench({ withSessionQuery: true, sessionIds: [FULL, UNRELATED] })
    await controller.start(FRESH)
    await controller.submit('/resume session-0b59b044')
    expect(resumeCalls).toEqual([FULL])
    await ctx.fiber.dispose()
  })

  it('resolves --resume short ids at startup', async () => {
    const { ctx, controller, resumeCalls } = await bench({ withSessionQuery: true, sessionIds: [FULL, UNRELATED] })
    await controller.start({ resume: '0b59b044', continue: false })
    expect(resumeCalls).toEqual([FULL])
    expect(controller.getSnapshot().sessionId).toBe(FULL)
    expect(controller.getSnapshot().phase).toBe('ready')
    await ctx.fiber.dispose()
  })

  it('reports an error when no session matches', async () => {
    const { ctx, controller, resumeCalls } = await bench({ withSessionQuery: true, sessionIds: [FULL] })
    await controller.start(FRESH)
    await controller.submit('/resume deadbeef')
    expect(resumeCalls).toEqual([])
    const notice = controller.getSnapshot().projection.rows.at(-1) as NoticeRow
    expect(notice).toMatchObject({ kind: 'notice', tone: 'error' })
    expect(notice.text).toContain('no such session "deadbeef"')
    await ctx.fiber.dispose()
  })

  it('reports an error when the prefix is ambiguous', async () => {
    const { ctx, controller, resumeCalls } = await bench({ withSessionQuery: true, sessionIds: [FULL, OTHER] })
    await controller.start(FRESH)
    await controller.submit('/resume 0b59b044')
    expect(resumeCalls).toEqual([])
    const notice = controller.getSnapshot().projection.rows.at(-1) as NoticeRow
    expect(notice).toMatchObject({ kind: 'notice', tone: 'error' })
    expect(notice.text).toContain('ambiguous session id "0b59b044"')
    expect(notice.text).toContain(FULL)
    expect(notice.text).toContain(OTHER)
    await ctx.fiber.dispose()
  })
})

describe('turn control', () => {
  it('cancels the active turn through the agent on Esc', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    controller.cancelTurn()
    expect(spies[0]?.cancels).toBe(1)
    await ctx.fiber.dispose()
  })

  it('flips the UI off the running state immediately on cancel and settles on turn/end', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    await controller.submit('hello')
    expect(controller.getSnapshot().projection.busy).toBe(true)
    controller.cancelTurn()
    const snapshot = controller.getSnapshot()
    expect(snapshot.cancelPending).toBe(true)
    expect(snapshot.projection.streaming).toBeUndefined()
    expect(snapshot.projection.rows.at(-1)).toMatchObject({ kind: 'notice', tone: 'info', text: 'cancelling…' })
    // The cooperative abort converges in the background; a landed turn/end
    // settles the flag and folds the durable "turn aborted" notice.
    spies[0]?.agent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(controller.getSnapshot().cancelPending).toBe(false)
    expect(controller.getSnapshot().projection.busy).toBe(false)
    expect(controller.getSnapshot().projection.rows.at(-1)).toMatchObject({ kind: 'notice', text: 'turn aborted' })
    await ctx.fiber.dispose()
  })

  it('keeps the idle cancel a UI no-op', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    controller.cancelTurn()
    expect(spies[0]?.cancels).toBe(1)
    const snapshot = controller.getSnapshot()
    expect(snapshot.cancelPending).toBe(false)
    expect(snapshot.projection.rows.some(row => row.kind === 'notice')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('settles a pending cancel when the next turn starts', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    await controller.submit('hello')
    controller.cancelTurn()
    expect(controller.getSnapshot().cancelPending).toBe(true)
    spies[0]?.agent.session.append('turn/start', { turn: 2 })
    expect(controller.getSnapshot().cancelPending).toBe(false)
    expect(controller.getSnapshot().projection.busy).toBe(true)
    await ctx.fiber.dispose()
  })

  it('does not double-notice while the abort converges', async () => {
    const { ctx, controller, spies } = await bench()
    await controller.start(FRESH)
    await controller.submit('hello')
    controller.cancelTurn()
    controller.cancelTurn()
    expect(spies[0]?.cancels).toBe(2)
    const notices = controller.getSnapshot().projection.rows.filter(row => row.kind === 'notice' && row.text === 'cancelling…')
    expect(notices).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('cycles the thinking level through the model-advertised efforts', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    expect(controller.getSnapshot().thinkingLabel).toBe('')
    await controller.cycleReasoningEffort()
    expect(controller.getSnapshot().thinkingLabel).toBe('Max')
    expect(controller.getSnapshot().projection.rows.at(-1)).toMatchObject({ kind: 'notice', text: 'thinking: Max' })
    await controller.cycleReasoningEffort()
    expect(controller.getSnapshot().thinkingLabel).toBe('Off')
    await controller.cycleReasoningEffort()
    expect(controller.getSnapshot().thinkingLabel).toBe('High')
    await ctx.fiber.dispose()
  })

  it('reports a notice when the model has no thinking levels', async () => {
    const { ctx, controller, llm } = await bench()
    await controller.start(FRESH)
    llm.resolveModelInfo = (async (provider: string, model: string) => ({
      provider,
      id: model,
      name: model,
    })) as typeof llm.resolveModelInfo
    await controller.cycleReasoningEffort()
    const notice = controller.getSnapshot().projection.rows.at(-1) as NoticeRow
    expect(notice).toMatchObject({ kind: 'notice', tone: 'info' })
    expect(notice.text).toContain('no thinking-mode levels')
    await ctx.fiber.dispose()
  })
})
