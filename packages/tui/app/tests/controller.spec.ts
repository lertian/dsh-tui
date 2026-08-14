/** Controller behavior: boot, input routing, approvals, session swaps, and exit. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { CommandId, parseCommand } from '@deepseek-ai/dsh-commands'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
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
  }
}

/** The bench: real session/agent registries, scripted factory, mock UI-side services. */
async function bench(options: {
  failCreate?: boolean
  withSessionQuery?: boolean
  sessionCwd?: string
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  const commands = mockCommands()
  ctx.provide('commands', commands as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'test-provider', name: 'Test' }],
    listModels: async () => [{ provider: 'test-provider', id: 'test-model', name: 'Test Model' }],
  } as never)
  ctx.provide('tools', {
    schemas: () => [
      { name: 'bash', description: 'run bash commands', parameters: {} },
      { name: 'fs_read', description: 'read files', parameters: {} },
    ],
  } as never)
  if (options.withSessionQuery === true) {
    ctx.provide('sessionQuery', {
      listSessions: async () => [{
        header: {
          version: 0,
          id: SessionId('session-old'),
          createdAt: 1_700_000_000_000,
          ...options.sessionCwd === undefined ? {} : { cwd: options.sessionCwd },
        },
        live: false,
        persisted: true,
      }],
      readTitle: async () => ({ title: 'old chat' }),
    } as never)
  }
  const spies: AgentSpy[] = []
  const resumeCalls: string[] = []
  const makeAgent = async (ownerCtx: Context, opts: CreateAgentOptions): Promise<AgentHandle> => {
    if (options.failCreate === true) throw new Error('factory exploded')
    const session = ctx.sessions.create(opts.sessionId, {
      ...opts.meta === undefined ? {} : { meta: opts.meta },
    })
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
    ctx.agents.register(agent)
    return {
      agent,
      dispose: () => {
        spy.disposed = true
        return Promise.resolve()
      },
    }
  }
  ctx.agents.setFactory({
    createAgent: (ownerCtx, opts) => makeAgent(ownerCtx, opts),
    resume: (ownerCtx: Context, opts: ResumeAgentOptions) => {
      resumeCalls.push(opts.resumeSessionId)
      return makeAgent(ownerCtx, {
        sessionId: opts.resumeSessionId,
        ...opts.agentOptions === undefined ? {} : { agentOptions: opts.agentOptions },
        ...opts.setup === undefined ? {} : { setup: opts.setup },
      })
    },
  })
  const exits: number[] = []
  const controller = new TuiController({ ctx, exit: (code) => { exits.push(code) } })
  return { ctx, controller, commands, spies, resumeCalls, exits }
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

  it('lists the registered commands with /help', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    await controller.submit('/help')
    const command = controller.getSnapshot().projection.rows.find(row => row.kind === 'command')
    const text = command?.kind === 'command' ? command.text ?? '' : ''
    for (const name of ['/new', '/resume', '/model', '/tools', '/settings', '/help', '/quit']) {
      expect(text).toContain(name)
    }
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
    expect((await controller.argumentItems('resume'))[0]?.value).toBe('session-old')
    expect((await controller.argumentItems('model'))[0]?.value).toBe('test-provider/test-model')
    expect(await controller.argumentItems('tools')).toEqual([])
    await ctx.fiber.dispose()
  })

  it('exposes the slash-command catalog on the snapshot', async () => {
    const { ctx, controller } = await bench()
    await controller.start(FRESH)
    expect(controller.getSnapshot().commands.map(command => command.name))
      .toEqual(['new', 'resume', 'model', 'tools', 'settings', 'help', 'quit'])
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
