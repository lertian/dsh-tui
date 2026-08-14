/**
 * Fold a session's event log into the TUI view model. Live events and resume
 * replay share this one path: the log is the source of truth, so replaying it
 * rebuilds the complete transcript ("model-visible means logged").
 * @module @deepseek-ai/dsh-tui-app/projection
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type imports merge `command/*`, `approval/*`, and `compaction/*`
// into SessionEventMap, so the switch below narrows `event.data` without casts.
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRow, ChatRow, CommandRow, Projection, ToolRow } from './types.ts'

/** Tool-result preview bounding: at most this many lines and characters survive. */
const PREVIEW_LINES = 6
const PREVIEW_CHARS = 600

/** One-line argument summaries prefer these well-known fields, in order. */
const SUMMARY_KEYS = ['command', 'path', 'filePath', 'file_path', 'pattern', 'query', 'url', 'prompt', 'task', 'todos'] as const

/** Create an empty projection (a fresh session before any event). */
export function createProjection(): Projection {
  return { rows: [], streaming: undefined, todos: [], turn: 0, busy: false, compaction: undefined, usage: { input: 0, output: 0 } }
}

/** Truncate `text` to one bounded line for dense row rendering. */
export function oneLine(text: string, max = 100): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Bound a multi-line payload for a collapsible card preview. */
export function preview(text: string): string {
  const trimmed = text.replaceAll(/\r\n/gu, '\n').replace(/\n+$/u, '')
  const lines = trimmed.split('\n')
  const cutLines = lines.length > PREVIEW_LINES ? [...lines.slice(0, PREVIEW_LINES), `… (${lines.length - PREVIEW_LINES} more lines)`] : lines
  const joined = cutLines.join('\n')
  return joined.length <= PREVIEW_CHARS ? joined : `${joined.slice(0, PREVIEW_CHARS - 1)}…`
}

/** Join the visible text of message content blocks; images degrade to a marker. */
export function blocksText(content: readonly ContentBlock[]): string {
  return content.map((block) => {
    switch (block.type) {
      case 'text': return block.text
      case 'image': return '[image]'
      default: return ''
    }
  }).filter(part => part !== '').join('\n')
}

/** Join the reasoning text of message content blocks. */
function blocksReasoning(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'reasoning').map(block => block.text).join('\n')
}

/**
 * A one-line summary of a tool call's raw JSON arguments: a well-known field
 * when present, else the first string field, else the truncated raw text.
 * @param name - the tool being called (only used for fallback labeling).
 * @param raw - the exact arguments JSON string the model produced.
 * @returns a single bounded line.
 */
export function summarizeArguments(name: string, raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      for (const key of SUMMARY_KEYS) {
        const value = record[key]
        if (typeof value === 'string' && value.trim() !== '') return oneLine(value)
      }
      for (const value of Object.values(record)) {
        if (typeof value === 'string' && value.trim() !== '') return oneLine(value)
      }
      return `${name}(…)`
    }
  } catch {
    // The raw stream may be truncated mid-flight; fall through to the raw preview.
  }
  return raw.trim() === '' ? `${name}(…)` : oneLine(raw)
}

/** Replace the row matching `key`, or append `fallback` when no such row exists. */
function upsertRow(rows: ChatRow[], key: string, patch: (row: ChatRow) => ChatRow, fallback: () => ChatRow): void {
  const index = rows.findIndex(row => row.key === key)
  if (index === -1) {
    rows.push(fallback())
    return
  }
  const current = rows[index]
  if (current !== undefined) rows[index] = patch(current)
}

/**
 * Fold one session event into the projection. Unknown or log-only events
 * (headers, seed markers, …) are skipped by design.
 * @param projection - the mutable view model being accumulated.
 * @param event - the next session event in log order.
 */
export function applyEvent(projection: Projection, event: SessionEvent): void {
  const rows = projection.rows
  switch (event.type) {
    case 'turn/start': {
      projection.turn = event.data.turn
      projection.busy = true
      return
    }
    case 'turn/end': {
      projection.busy = false
      projection.streaming = undefined
      const reason = event.data.reason
      switch (reason.kind) {
        case 'completed': return
        case 'aborted': {
          rows.push({ kind: 'notice', key: `n:${event.seq}`, tone: 'info', text: 'turn aborted' })
          return
        }
        case 'error': {
          rows.push({ kind: 'notice', key: `n:${event.seq}`, tone: 'error', text: `${reason.error.code}: ${reason.error.message}` })
          return
        }
        case 'max-tokens': {
          rows.push({ kind: 'notice', key: `n:${event.seq}`, tone: 'warn', text: 'output token ceiling reached' })
          return
        }
        case 'interrupted': {
          rows.push({ kind: 'notice', key: `n:${event.seq}`, tone: 'warn', text: 'previous run interrupted; resumed from the durable log' })
          return
        }
        default: {
          rows.push({ kind: 'notice', key: `n:${event.seq}`, tone: 'warn', text: `turn ended: ${reason.kind}` })
          return
        }
      }
    }
    case 'user/message': {
      // Only genuine human prompts render as chat; injected plugin context and
      // tool-result messages have their own rows (or none).
      if (event.data.source.kind !== 'user') return
      const text = blocksText(event.data.content)
      if (text === '') return
      rows.push({ kind: 'user', key: `u:${event.seq}`, text })
      return
    }
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return
      const streaming = projection.streaming ?? { turn: event.data.turn, text: '', reasoning: '' }
      if (chunk.type === 'text-delta') streaming.text += chunk.text
      else streaming.reasoning += chunk.text
      projection.streaming = streaming
      return
    }
    case 'assistant/message': {
      projection.streaming = undefined
      const text = blocksText(event.data.message.content)
      const reasoning = blocksReasoning(event.data.message.content)
      const source = event.data.message.source
      const usage = event.data.usage
      rows.push({
        kind: 'assistant',
        key: `a:${event.seq}`,
        text,
        reasoning,
        model: `${source.provider}/${source.model}`,
        ...usage === undefined ? {} : { usage },
      })
      if (usage !== undefined) {
        projection.usage.input += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        projection.usage.output += usage.outputTokens
      }
      return
    }
    case 'tool/call': {
      rows.push({
        kind: 'tool',
        key: `t:${event.data.callId}`,
        name: event.data.name,
        argsSummary: summarizeArguments(event.data.name, event.data.arguments),
        status: 'running',
      })
      return
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const text = preview(blocksText(block.content))
      const isError = block.isError || event.data.error !== undefined
      upsertRow(
        rows,
        `t:${block.toolCallId}`,
        (row): ChatRow => row.kind !== 'tool' ? row : { ...row, status: 'done', resultPreview: text, isError },
        (): ToolRow => ({
          kind: 'tool',
          key: `t:${block.toolCallId}`,
          name: block.toolCallId,
          argsSummary: '',
          status: 'done',
          resultPreview: text,
          isError,
        }),
      )
      return
    }
    case 'command/run': {
      rows.push({
        kind: 'command',
        key: `c:${event.data.commandId}`,
        name: event.data.name,
        args: event.data.args ?? '',
        status: 'running',
      })
      return
    }
    case 'command/done': {
      upsertRow(
        rows,
        `c:${event.data.commandId}`,
        (row): ChatRow => row.kind !== 'command' ? row : {
          ...row,
          status: 'done',
          ok: event.data.kind === 'success',
          ...event.data.text === undefined ? {} : { text: event.data.text },
        },
        (): CommandRow => ({
          kind: 'command',
          key: `c:${event.data.commandId}`,
          name: event.data.commandId,
          args: '',
          status: 'done',
          ok: event.data.kind === 'success',
          ...event.data.text === undefined ? {} : { text: event.data.text },
        }),
      )
      return
    }
    case 'approval/asked': {
      rows.push({
        kind: 'approval',
        key: `p:${event.data.id}`,
        toolName: event.data.toolName,
        ...event.data.reason === undefined ? {} : { reason: event.data.reason },
      })
      return
    }
    case 'approval/decided': {
      upsertRow(
        rows,
        `p:${event.data.id}`,
        (row): ChatRow => row.kind !== 'approval' ? row : { ...row, outcome: event.data.outcome },
        (): ApprovalRow => { throw new Error('unreachable') },
      )
      return
    }
    case 'todo/write': {
      projection.todos = event.data.todos
      return
    }
    case 'compaction/start': {
      projection.compaction = { id: event.data.compactionId, running: true }
      return
    }
    case 'compaction/summary': {
      // A well-formed log opens the transaction before the summary; when it
      // does not (unmatched marker), the stats still pair with the closing
      // event so the landed notice can render.
      projection.compaction = {
        id: event.data.compactionId,
        running: true,
        shadowedItems: event.data.shadowedSeqs.length,
        shadowedTokens: event.data.shadowedTokenCount,
      }
      return
    }
    case 'compaction/end': {
      const transaction = projection.compaction
      projection.compaction = undefined
      if (event.data.error !== undefined) {
        rows.push({ kind: 'notice', key: `n:${event.seq}`, tone: 'error', text: `compaction failed: ${event.data.error}` })
        return
      }
      const items = transaction?.shadowedItems
      const tokens = transaction?.shadowedTokens
      if (items !== undefined && tokens !== undefined) {
        rows.push({
          kind: 'notice',
          key: `n:${event.seq}`,
          tone: 'info',
          text: `compacted ${items} history items (~${tokens} tokens)`,
        })
      }
      return
    }
    default: {
      // Boundaries, headers, usage frames, seed markers, prune metering, and
      // unknown merge-extended events carry no transcript rendering.
      return
    }
  }
}

/**
 * Replay a complete stored log into a fresh projection (session resume).
 * @param events - the durable log in seq order.
 * @returns the rebuilt projection.
 */
export function replayEvents(events: readonly SessionEvent[]): Projection {
  const projection = createProjection()
  for (const event of events) applyEvent(projection, event)
  return projection
}
