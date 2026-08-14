/**
 * View-model types for the dsh terminal UI: the chat rows a SessionEvent log
 * projects to, plus the live status slices the frame reads.
 * @module @deepseek-ai/dsh-tui-app/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { TodoItem } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

/** A human prompt as rendered in the scrollback. */
export interface UserRow {
  readonly kind: 'user'
  readonly key: string
  readonly text: string
}

/** One finalized assistant message (derived history, not raw chunks). */
export interface AssistantRow {
  readonly kind: 'assistant'
  readonly key: string
  readonly text: string
  /** Reasoning text, when the adapter produced any; rendered dimmed and collapsible. */
  readonly reasoning: string
  readonly model?: string
  readonly usage?: TokenUsage
}

/** A tool call paired with its settled result; `running` until `tool/result` lands. */
export interface ToolRow {
  readonly kind: 'tool'
  readonly key: string
  readonly name: string
  /** One-line human summary of the raw JSON arguments. */
  readonly argsSummary: string
  readonly status: 'running' | 'done'
  /** Truncated text preview of the result payload. */
  readonly resultPreview?: string
  readonly isError?: boolean
}

/** A slash command execution, paired across `command/run` and `command/done`. */
export interface CommandRow {
  readonly kind: 'command'
  readonly key: string
  readonly name: string
  readonly args: string
  readonly status: 'running' | 'done'
  readonly ok?: boolean
  readonly text?: string
}

/** An approval question and its recorded outcome. */
export interface ApprovalRow {
  readonly kind: 'approval'
  readonly key: string
  readonly toolName: string
  readonly reason?: string
  readonly outcome?: ApprovalOutcome
}

/** A turn-level notice (aborts, errors, token ceilings, controller messages). */
export interface NoticeRow {
  readonly kind: 'notice'
  readonly key: string
  readonly tone: 'info' | 'warn' | 'error'
  readonly text: string
}

/** One immutable entry of the rendered transcript. */
export type ChatRow = UserRow | AssistantRow | ToolRow | CommandRow | ApprovalRow | NoticeRow

/**
 * Whether a row can never change again — only finalized rows may move into
 * the terminal scrollback (Ink's Static region never repaints).
 * @param row - the row to test.
 * @returns true when no later event can mutate this row.
 */
export function isFinalized(row: ChatRow): boolean {
  switch (row.kind) {
    case 'tool': return row.status === 'done'
    case 'command': return row.status === 'done'
    case 'approval': return row.outcome !== undefined
    default: return true
  }
}

/** The in-flight assistant stream, accumulated from `assistant/chunk` deltas. */
export interface StreamingRow {
  readonly turn: number
  text: string
  reasoning: string
}

/**
 * The open compaction transaction, from `compaction/start` until
 * `compaction/end`. Automatic compactions sit inside an open turn; manual
 * `/compact` runs while the agent is idle, so this state (not `busy`) drives
 * the compaction spinner.
 */
export interface CompactionState {
  /** The transaction id `compaction/*` events pair on. */
  readonly id: string
  /** Whether the transaction is open (drives the compaction spinner). */
  readonly running: boolean
  /** Shadowed history-item count from the landed `compaction/summary`, when present. */
  readonly shadowedItems?: number
  /** Estimated shadowed token count from the landed `compaction/summary`, when present. */
  readonly shadowedTokens?: number
}

/** The full projection of one session log plus live turn status. */
export interface Projection {
  /** Finalized and in-flight transcript rows, in log order. Entries are immutable: updates replace the entry. */
  rows: ChatRow[]
  /** The currently streaming assistant output, when a step is producing one. */
  streaming: StreamingRow | undefined
  /** Latest `todo/write` snapshot (whole-list, last write wins). */
  todos: TodoItem[]
  /** The turn most recently started; 0 before any turn. */
  turn: number
  /** Whether a turn is open (drives the turn spinner). */
  busy: boolean
  /** The open compaction transaction, when one is in flight; undefined otherwise. */
  compaction: CompactionState | undefined
  /** Cumulative token accounting across finalized assistant messages. */
  usage: { input: number; output: number }
}
