/** Session-log → view-model folding: rows, pairing, replay equivalence, and summaries. */

import { describe, expect, it } from 'vitest'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-commands/types'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-compaction/types'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { applyEvent, createProjection, oneLine, preview, replayEvents, summarizeArguments } from '../src/projection.ts'
import { isFinalized } from '../src/types.ts'
import type { ApprovalRow, AssistantRow, CommandRow, NoticeRow, ToolRow, UserRow } from '../src/types.ts'

let seq = 0

/** Build one log event with a monotonic seq; replay order is the call order. */
function ev<T extends SessionEventType>(type: T, data: SessionEventMap[T]): SessionEvent {
  seq += 1
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

/** A human prompt message. */
function prompt(text: string): SessionEventMap['user/message'] {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** A model reply message with the given text (and optional reasoning). */
function reply(text: string, reasoning?: string): SessionEventMap['assistant/message']['message'] {
  return createAssistantMessage({
    content: [
      ...reasoning === undefined ? [] : [{ type: 'reasoning' as const, text: reasoning }],
      { type: 'text' as const, text },
    ],
    source: { provider: 'test-provider', model: 'test-model' },
  })
}

/** One complete conversational turn's event sequence. */
function conversationTurn(turn: number): SessionEvent[] {
  return [
    ev('turn/start', { turn }),
    ev('step/start', { turn, step: 1 }),
    ev('user/message', prompt(`question ${turn}`)),
    ev('assistant/chunk', { turn, step: 1, chunk: { type: 'text-delta', index: 0, text: 'ans' } }),
    ev('assistant/chunk', { turn, step: 1, chunk: { type: 'text-delta', index: 0, text: 'wer' } }),
    ev('assistant/message', {
      turn,
      step: 1,
      message: reply('answer'),
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    ev('step/end', { turn, step: 1 }),
    ev('turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}

describe('oneLine/preview', () => {
  it('flattens whitespace and truncates to one line', () => {
    expect(oneLine('a\nb\tc')).toBe('a b c')
    expect(oneLine('x'.repeat(120))).toHaveLength(100)
    expect(oneLine('x'.repeat(120)).endsWith('…')).toBe(true)
  })

  it('bounds previews by lines and characters', () => {
    expect(preview('1\n2\n3')).toBe('1\n2\n3')
    expect(preview(Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n'))).toContain('… (4 more lines)')
    expect(preview('y'.repeat(700)).length).toBeLessThanOrEqual(600)
  })
})

describe('summarizeArguments', () => {
  it('prefers well-known fields', () => {
    expect(summarizeArguments('bash', '{"command":"ls -la","timeout":5}')).toBe('ls -la')
    expect(summarizeArguments('fs_read', '{"path":"/tmp/x"}')).toBe('/tmp/x')
  })

  it('falls back to the first string field, then to the raw text', () => {
    expect(summarizeArguments('custom', '{"n":1,"note":"hello there"}')).toBe('hello there')
    expect(summarizeArguments('custom', 'not json')).toBe('not json')
    expect(summarizeArguments('custom', '{}')).toBe('custom(…)')
  })
})

describe('applyEvent', () => {
  it('folds a full turn into user and assistant rows with usage accounting', () => {
    const projection = createProjection()
    for (const event of conversationTurn(1)) applyEvent(projection, event)
    expect(projection.rows).toHaveLength(2)
    const [user, assistant] = projection.rows as [UserRow, AssistantRow]
    expect(user).toMatchObject({ kind: 'user', text: 'question 1' })
    expect(assistant).toMatchObject({ kind: 'assistant', text: 'answer', model: 'test-provider/test-model' })
    expect(projection.streaming).toBeUndefined()
    expect(projection.busy).toBe(false)
    expect(projection.turn).toBe(1)
    expect(projection.usage).toEqual({ input: 10, output: 5 })
    expect(projection.rows.every(isFinalized)).toBe(true)
  })

  it('accumulates streaming deltas until the assembled message replaces them', () => {
    const projection = createProjection()
    applyEvent(projection, ev('turn/start', { turn: 1 }))
    applyEvent(projection, ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'he' } }))
    applyEvent(projection, ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: 'thinking' } }))
    applyEvent(projection, ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'llo' } }))
    expect(projection.streaming).toMatchObject({ text: 'hello', reasoning: 'thinking' })
    applyEvent(projection, ev('assistant/message', { turn: 1, step: 1, message: reply('hello') }))
    expect(projection.streaming).toBeUndefined()
    expect(projection.rows[0]).toMatchObject({ kind: 'assistant', text: 'hello' })
  })

  it('keeps reasoning blocks on assistant rows', () => {
    const projection = createProjection()
    applyEvent(projection, ev('assistant/message', { turn: 1, step: 1, message: reply('visible', 'inner') }))
    expect(projection.rows[0]).toMatchObject({ kind: 'assistant', text: 'visible', reasoning: 'inner' })
  })

  it('pairs tool calls with their results and flags errors', () => {
    const projection = createProjection()
    applyEvent(projection, ev('tool/call', { turn: 1, step: 1, callId: CallId('call-1'), name: 'bash', arguments: '{"command":"ls"}' }))
    let row = projection.rows[0] as ToolRow
    expect(row).toMatchObject({ kind: 'tool', name: 'bash', argsSummary: 'ls', status: 'running' })
    expect(isFinalized(row)).toBe(false)
    applyEvent(projection, ev('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: CallId('call-1'), content: [{ type: 'text', text: 'file.txt' }], isError: false }),
    }))
    row = projection.rows[0] as ToolRow
    expect(row).toMatchObject({ status: 'done', resultPreview: 'file.txt', isError: false })
    expect(isFinalized(row)).toBe(true)
    expect(projection.rows).toHaveLength(1)
  })

  it('marks tool errors from the block and the event error identity', () => {
    const projection = createProjection()
    applyEvent(projection, ev('tool/call', { turn: 1, step: 1, callId: CallId('call-2'), name: 'bash', arguments: '{}' }))
    applyEvent(projection, ev('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: CallId('call-2'), content: [{ type: 'text', text: 'boom' }], isError: true }),
      error: { name: 'HarnessError', code: 'SANDBOX' },
    }))
    expect(projection.rows[0]).toMatchObject({ status: 'done', isError: true, resultPreview: 'boom' })
  })

  it('materializes an orphan tool result as its own settled row', () => {
    const projection = createProjection()
    applyEvent(projection, ev('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: CallId('call-x'), content: [{ type: 'text', text: 'late' }], isError: false }),
    }))
    expect(projection.rows[0]).toMatchObject({ kind: 'tool', status: 'done', resultPreview: 'late' })
  })

  it('pairs command lifecycle events and carries the result text', () => {
    const projection = createProjection()
    applyEvent(projection, ev('command/run', { commandId: CommandId('cmd-1'), name: 'tools', args: '', source: { kind: 'user' } }))
    expect(projection.rows[0]).toMatchObject({ kind: 'command', name: 'tools', status: 'running' })
    applyEvent(projection, ev('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'bash — run commands' }))
    const row = projection.rows[0] as CommandRow
    expect(row).toMatchObject({ status: 'done', ok: true, text: 'bash — run commands' })
    expect(isFinalized(row)).toBe(true)
  })

  it('records approval questions and their outcomes', () => {
    const projection = createProjection()
    applyEvent(projection, ev('approval/asked', { id: ApprovalRequestId('apr-1'), toolName: 'bash', reason: 'needs write access' }))
    expect(projection.rows[0]).toMatchObject({ kind: 'approval', toolName: 'bash' })
    expect((projection.rows[0] as ApprovalRow).outcome).toBeUndefined()
    expect(isFinalized(projection.rows[0] as ApprovalRow)).toBe(false)
    applyEvent(projection, ev('approval/decided', { id: ApprovalRequestId('apr-1'), outcome: 'allowed-once' }))
    const row = projection.rows[0] as ApprovalRow
    expect(row.outcome).toBe('allowed-once')
    expect(isFinalized(row)).toBe(true)
  })

  it('skips non-human user messages (injected plugin context)', () => {
    const projection = createProjection()
    applyEvent(projection, ev('user/message', createUserMessage({
      content: [{ type: 'text', text: 'injected context' }],
      source: { kind: 'plugin', plugin: 'test' },
    })))
    expect(projection.rows).toHaveLength(0)
  })

  it('renders turn-end reasons as notices, quietly for completion', () => {
    const projection = createProjection()
    applyEvent(projection, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(projection.rows).toHaveLength(0)
    applyEvent(projection, ev('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
    applyEvent(projection, ev('turn/end', { turn: 3, reason: { kind: 'error', error: { code: 'AUTH', message: 'bad key' } } }))
    applyEvent(projection, ev('turn/end', { turn: 4, reason: { kind: 'max-tokens' } }))
    applyEvent(projection, ev('turn/end', { turn: 5, reason: { kind: 'interrupted' } }))
    const tones = projection.rows.map(row => [(row as NoticeRow).tone, (row as NoticeRow).text])
    expect(tones).toEqual([
      ['info', 'turn aborted'],
      ['error', 'AUTH: bad key'],
      ['warn', 'output token ceiling reached'],
      ['warn', 'previous run interrupted; resumed from the durable log'],
    ])
    expect(projection.busy).toBe(false)
  })

  it('tracks the latest todo snapshot', () => {
    const projection = createProjection()
    applyEvent(projection, ev('todo/write', { todos: [{ content: 'task a', status: 'in_progress' }] }))
    expect(projection.todos).toEqual([{ content: 'task a', status: 'in_progress' }])
    applyEvent(projection, ev('todo/write', { todos: [{ content: 'task a', status: 'completed' }] }))
    expect(projection.todos).toEqual([{ content: 'task a', status: 'completed' }])
  })

  it('ignores log-only events (headers, contexts, seed markers, prune metering)', () => {
    const projection = createProjection()
    applyEvent(projection, ev('session/end-seed', {}))
    applyEvent(projection, ev('request/context', { provider: 'p', model: 'm' }))
    applyEvent(projection, ev('compaction/prune', {
      shadowedRange: { start: 1, end: 2 },
      shadowedSeqs: [1, 2],
      shadowedTokenCount: 42,
    }))
    expect(projection.rows).toHaveLength(0)
    expect(projection.busy).toBe(false)
    expect(projection.compaction).toBeUndefined()
  })
})

describe('compaction events', () => {
  const COMPACTION_ID = CompactionId('compact-1')

  function compactionSummary(): SessionEventMap['compaction/summary'] {
    return {
      compactionId: COMPACTION_ID,
      summary: [{ type: 'text', text: 'checkpoint' }],
      shadowedRange: { start: 1, end: 3 },
      shadowedSeqs: [1, 2, 3],
      shadowedTokenCount: 1200,
      provider: 'test-provider',
      model: 'test-model',
      llmStreamCall: true,
      rawOutput: [{ type: 'text', text: 'checkpoint' }],
    }
  }

  it('opens the transaction on start and settles it with a landed notice on end', () => {
    const projection = createProjection()
    applyEvent(projection, ev('compaction/start', { compactionId: COMPACTION_ID, turn: null }))
    expect(projection.compaction).toEqual({ id: COMPACTION_ID, running: true })
    expect(projection.rows).toHaveLength(0)
    applyEvent(projection, ev('compaction/summary', compactionSummary()))
    expect(projection.compaction).toEqual({ id: COMPACTION_ID, running: true, shadowedItems: 3, shadowedTokens: 1200 })
    applyEvent(projection, ev('compaction/end', { compactionId: COMPACTION_ID, turn: null }))
    expect(projection.compaction).toBeUndefined()
    const [row] = projection.rows as [NoticeRow]
    expect(row).toMatchObject({ kind: 'notice', tone: 'info', text: 'compacted 3 history items (~1200 tokens)' })
    expect(isFinalized(row)).toBe(true)
  })

  it('records a failed compaction as an error notice and clears the state', () => {
    const projection = createProjection()
    applyEvent(projection, ev('compaction/start', { compactionId: COMPACTION_ID, turn: null }))
    applyEvent(projection, ev('compaction/end', {
      compactionId: COMPACTION_ID,
      turn: null,
      error: 'summarization failed',
    }))
    expect(projection.compaction).toBeUndefined()
    expect(projection.rows[0]).toMatchObject({
      kind: 'notice',
      tone: 'error',
      text: 'compaction failed: summarization failed',
    })
  })

  it('stays quiet when a successful end has no landed summary stats', () => {
    const projection = createProjection()
    applyEvent(projection, ev('compaction/end', { compactionId: COMPACTION_ID, turn: null }))
    expect(projection.rows).toHaveLength(0)
    expect(projection.compaction).toBeUndefined()
  })

  it('pairs an unmatched summary with its own closing end notice', () => {
    const projection = createProjection()
    applyEvent(projection, ev('compaction/summary', compactionSummary()))
    expect(projection.compaction).toEqual({ id: COMPACTION_ID, running: true, shadowedItems: 3, shadowedTokens: 1200 })
    applyEvent(projection, ev('compaction/end', { compactionId: COMPACTION_ID, turn: null }))
    expect(projection.rows[0]).toMatchObject({ kind: 'notice', text: 'compacted 3 history items (~1200 tokens)' })
  })

  it('keeps the turn busy during an automatic in-turn compaction', () => {
    const projection = createProjection()
    applyEvent(projection, ev('turn/start', { turn: 2 }))
    applyEvent(projection, ev('compaction/start', { compactionId: COMPACTION_ID, turn: 2 }))
    expect(projection.busy).toBe(true)
    expect(projection.compaction).toEqual({ id: COMPACTION_ID, running: true })
  })
})

describe('replayEvents', () => {
  it('rebuilds the identical projection from the durable log (resume replay)', () => {
    const replayCompaction = CompactionId('replay-compact')
    const events = [
      ...conversationTurn(1),
      ev('compaction/start', { compactionId: replayCompaction, turn: null }),
      ev('compaction/summary', {
        compactionId: replayCompaction,
        summary: [{ type: 'text', text: 'older history' }],
        shadowedRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        shadowedTokenCount: 300,
        provider: 'test-provider',
        model: 'test-model',
        llmStreamCall: true,
        rawOutput: [{ type: 'text', text: 'older history' }],
      }),
      ev('compaction/end', { compactionId: replayCompaction, turn: null }),
      ev('tool/call', { turn: 2, step: 1, callId: CallId('call-9'), name: 'fs_read', arguments: '{"path":"/tmp/a"}' }),
      ev('tool/result', {
        turn: 2,
        step: 1,
        message: createToolResultMessage({ callId: CallId('call-9'), content: [{ type: 'text', text: 'data' }], isError: false }),
      }),
      ...conversationTurn(2),
    ]
    const incremental = createProjection()
    for (const event of events) applyEvent(incremental, event)
    expect(replayEvents(events)).toEqual(incremental)
  })
})
