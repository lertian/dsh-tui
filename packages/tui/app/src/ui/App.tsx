/**
 * The Ink frame: chat scrollback (finalized rows retire into Static), the
 * live region (streaming assistant, running tools, todos), the approval
 * overlay, the picker dialogs, the slash-command menu, the multiline prompt,
 * and the status bar.
 * @module @deepseek-ai/dsh-tui-app/ui/App
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Static, Text, useInput } from 'ink'
import type { ApprovalChoice, PickerState, SlashMenuItem, TuiController } from '../controller.ts'
import { fuzzyFilter } from '../fuzzy.ts'
import { preview } from '../projection.ts'
import { isFinalized } from '../types.ts'
import type { ChatRow } from '../types.ts'
import { SelectList } from './SelectList.tsx'
import type { SelectItem } from './SelectList.tsx'

/** Spinner frames for the busy indicator. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Cycle spinner frames while `active`. */
function useSpinnerFrame(active: boolean): string {
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => { setIndex(value => value + 1) }, 80)
    return () => { clearInterval(timer) }
  }, [active])
  const frame = SPINNER[index % SPINNER.length]
  return frame ?? SPINNER[0] ?? '…'
}

/** Render one transcript row; memoized because finalized rows never change. */
const RowView = React.memo(function RowView({ row }: { row: ChatRow }): React.JSX.Element {
  switch (row.kind) {
    case 'user':
      return <Text color="cyan">{'> '}{row.text}</Text>
    case 'assistant':
      return (
        <Box flexDirection="column">
          {row.reasoning !== '' && <Text dimColor italic>thought: {preview(row.reasoning)}</Text>}
          <Text>{row.text}</Text>
        </Box>
      )
    case 'tool': {
      const icon = row.status === 'running' ? '⏵' : row.isError === true ? '✗' : '✓'
      const color = row.status === 'running' ? 'yellow' : row.isError === true ? 'red' : 'green'
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={color}>{icon} {row.name}</Text>
            {row.argsSummary !== '' && <Text dimColor> {row.argsSummary}</Text>}
          </Text>
          {row.status === 'done' && row.resultPreview !== undefined && row.resultPreview !== ''
            && <Text dimColor>{'  ⎿ '}{row.resultPreview}</Text>}
        </Box>
      )
    }
    case 'command': {
      const color = row.status === 'running' ? 'yellow' : row.ok === false ? 'red' : 'green'
      const icon = row.status === 'running' ? '⏵' : row.ok === false ? '✗' : '✓'
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={color}>{icon} /{row.name}</Text>
            {row.args === '' ? '' : <Text dimColor> {row.args}</Text>}
          </Text>
          {row.status === 'done' && row.text !== undefined && row.text !== ''
            && <Text color={row.ok === false ? 'red' : 'gray'}>{row.text}</Text>}
        </Box>
      )
    }
    case 'approval': {
      const outcome = row.outcome ?? 'pending'
      const color = row.outcome === 'allowed-once' ? 'green' : row.outcome === undefined ? 'yellow' : 'red'
      return <Text color={color}>⚠ approval: {row.toolName} → {outcome}</Text>
    }
    case 'notice': {
      const color = row.tone === 'error' ? 'red' : row.tone === 'warn' ? 'yellow' : 'gray'
      return <Text color={color}>{row.text}</Text>
    }
  }
})

/** The running-todo strip above the prompt, when the session tracks todos. */
function TodoStrip({ todos }: { todos: readonly { content: string; status: string }[] }): React.JSX.Element | undefined {
  const open = todos.filter(todo => todo.status !== 'completed')
  if (open.length === 0) return undefined
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {open.slice(0, 5).map((todo, index) => (
        <Text key={index} color={todo.status === 'in_progress' ? 'yellow' : 'gray'}>
          {todo.status === 'in_progress' ? '●' : '○'} {todo.content}
        </Text>
      ))}
      {open.length > 5 && <Text dimColor>… {open.length - 5} more</Text>}
    </Box>
  )
}

/** The approval overlay that replaces the prompt while a question is open. */
function ApprovalOverlay({ toolName, reason }: { toolName: string; reason?: string }): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">Approve {toolName}?</Text>
      {reason !== undefined && reason !== '' && <Text>{reason}</Text>}
      <Text>[y] allow once   [n] reject   [a] always allow {toolName}</Text>
    </Box>
  )
}

/** A fuzzy-filtered selection dialog that replaces the prompt (pi-style). */
function PickerView({ picker, onSelect, onCancel }: {
  picker: PickerState
  onSelect: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(0)
  const matches = fuzzyFilter(picker.items, filter, item => `${item.label} ${item.value}`)
  const clamped = Math.min(selected, Math.max(0, matches.length - 1))
  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.upArrow) {
      setSelected(index => Math.max(0, index - 1))
      return
    }
    if (key.downArrow) {
      setSelected(index => Math.min(matches.length - 1, index + 1))
      return
    }
    if (key.return) {
      const item = matches[clamped]
      if (item !== undefined) onSelect(item.value)
      return
    }
    if (key.backspace || key.delete) {
      setFilter(previous => previous.slice(0, -1))
      setSelected(0)
      return
    }
    if (key.tab || key.leftArrow || key.rightArrow || key.ctrl || key.meta) return
    const text = input.replaceAll(/\r\n?/gu, '')
    if (text !== '') {
      setFilter(previous => previous + text)
      setSelected(0)
    }
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{picker.title} <Text dimColor>({matches.length}/{picker.items.length})</Text></Text>
      <Text>{'› '}{filter}<Text inverse> </Text></Text>
      <SelectList items={matches} selectedIndex={clamped} maxVisible={8} />
      <Text dimColor>type to filter · ↑↓ select · enter confirm · esc cancel</Text>
    </Box>
  )
}

/** Shared menu state so the frame-level Esc handler can close an open menu. */
interface SlashMenuState {
  open: boolean
  /** Dismiss the menu for the current input; provided by the Prompt. */
  requestClose: () => void
}

/** The multiline prompt box with the pi-style slash menu above it. */
function Prompt({ disabled, approvalActive, commands, loadArgumentItems, menuState, onToggleThinking, onSubmit }: {
  disabled: boolean
  /** While an approval question is open, its y/n/a keys must not echo here. */
  approvalActive: boolean
  commands: readonly SlashMenuItem[]
  loadArgumentItems: (command: string) => Promise<readonly SelectItem[]>
  menuState: { current: SlashMenuState }
  onToggleThinking: () => void
  onSubmit: (text: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [selected, setSelected] = useState(0)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [argumentItems, setArgumentItems] = useState<{ command: string; items: readonly SelectItem[] } | null>(null)
  const valueRef = useRef('')
  valueRef.current = value
  menuState.current.requestClose = () => { setDismissedFor(valueRef.current) }

  // Readline-style input history: `historyRef` holds every submitted line in
  // order (consecutive duplicates collapsed), `historyPosRef` is the recall
  // cursor (`history.length` = the live line), and `draftRef` preserves the
  // in-progress line so ↓ can return to it.
  const historyRef = useRef<string[]>([])
  const historyPosRef = useRef(0)
  const draftRef = useRef('')

  /** Record one submitted line and park the cursor at the live line. */
  const recordHistory = (text: string): void => {
    const history = historyRef.current
    if (history[history.length - 1] !== text) history.push(text)
    historyPosRef.current = history.length
    draftRef.current = ''
  }

  /** Move the recall cursor one line back (-1) or forward (1). */
  const recall = (delta: -1 | 1): void => {
    const history = historyRef.current
    if (history.length === 0) return
    const pos = historyPosRef.current
    if (delta === -1) {
      if (pos === history.length) draftRef.current = valueRef.current
      const next = Math.max(0, pos - 1)
      historyPosRef.current = next
      setValue(history[next] ?? '')
    } else {
      if (pos >= history.length) return
      const next = pos + 1
      historyPosRef.current = next
      setValue(next >= history.length ? draftRef.current : (history[next] ?? ''))
    }
    setSelected(0)
  }

  /** Submit one non-empty line: record it, clear the box, and hand it off. */
  const submit = (text: string): void => {
    recordHistory(text)
    setValue('')
    setDismissedFor(null)
    onSubmit(text)
  }

  // Command-name mode (`/to`) versus argument mode (`/resume 5feb`): the
  // latter loads the command's argument candidates once per command name.
  const commandMatch = /^\/([a-zA-Z0-9_-]*)$/u.exec(value)
  const argumentMatch = /^\/([a-z][a-z0-9_-]*) (.*)$/su.exec(value)
  const argumentCommand = argumentMatch?.[1] ?? null
  useEffect(() => {
    if (argumentCommand === null) {
      setArgumentItems(null)
      return undefined
    }
    let cancelled = false
    void loadArgumentItems(argumentCommand).then((items) => {
      if (!cancelled) setArgumentItems({ command: argumentCommand, items })
    })
    return () => { cancelled = true }
  }, [argumentCommand, loadArgumentItems])

  const candidates: readonly SelectItem[] = commandMatch !== null
    ? fuzzyFilter(commands, commandMatch[1] ?? '', command => command.name)
      .slice(0, 8)
      .map(command => ({
        value: command.name,
        label: `/${command.name}`,
        description: command.hint === '' ? command.description : `${command.hint} — ${command.description}`,
      }))
    : argumentMatch !== null && argumentItems !== null && argumentItems.command === argumentMatch[1]
      ? fuzzyFilter(argumentItems.items, argumentMatch[2] ?? '', item => `${item.label} ${item.value}`).slice(0, 8)
      : []
  const menuOpen = !disabled && candidates.length > 0 && dismissedFor !== value
  menuState.current.open = menuOpen
  const clamped = Math.min(selected, candidates.length - 1)

  /** Replace the input with the highlighted candidate; arguments complete, command names append a space. */
  const completeWith = (item: SelectItem): void => {
    if (commandMatch !== null) {
      const command = commands.find(entry => entry.name === item.value)
      if (command !== undefined && command.hint === '') {
        setValue(`/${item.value}`)
      } else {
        setValue(`/${item.value} `)
      }
      setSelected(0)
      return
    }
    setValue(`/${argumentMatch?.[1] ?? ''} ${item.value}`)
    setSelected(0)
  }

  useInput((input, key) => {
    if (disabled) return
    if (approvalActive && !key.ctrl && !key.meta && (input === 'y' || input === 'n' || input === 'a')) return
    if (key.tab && key.shift) {
      onToggleThinking()
      return
    }
    if (menuOpen) {
      if (key.upArrow) {
        setSelected(index => Math.max(0, index - 1))
        return
      }
      if (key.downArrow) {
        setSelected(index => Math.min(candidates.length - 1, index + 1))
        return
      }
      if (key.tab || key.rightArrow) {
        const item = candidates[clamped]
        if (item !== undefined) completeWith(item)
        return
      }
      if (key.escape) {
        setDismissedFor(valueRef.current)
        return
      }
      if (key.return && !key.shift) {
        const item = candidates[clamped]
        if (item === undefined) return
        if (commandMatch !== null) {
          // A fully-typed command name runs as typed, even when it takes an
          // argument (`/resume` Enter opens the picker, it does not complete).
          const typed = commandMatch[1] ?? ''
          if (commands.some(entry => entry.name === typed)) {
            submit(valueRef.current)
            return
          }
          const command = commands.find(entry => entry.name === item.value)
          if (command !== undefined && command.hint === '') {
            submit(`/${item.value}`)
            return
          }
          completeWith(item)
          return
        }
        // Argument mode: Enter completes; a second Enter on the completed
        // line submits it.
        const completed = `/${argumentMatch?.[1] ?? ''} ${item.value}`
        if (valueRef.current === completed) {
          submit(completed)
          return
        }
        setValue(completed)
        setSelected(0)
        return
      }
    }
    if (key.return) {
      if (key.shift) {
        setValue(previous => previous + '\n')
        return
      }
      const text = valueRef.current
      if (text.trim() === '') {
        setValue('')
        setDismissedFor(null)
        return
      }
      submit(text)
      return
    }
    if (key.ctrl && input === 'j') {
      setValue(previous => previous + '\n')
      return
    }
    if (key.backspace || key.delete) {
      setValue(previous => previous.slice(0, -1))
      setSelected(0)
      return
    }
    if (key.upArrow) {
      recall(-1)
      return
    }
    if (key.downArrow) {
      recall(1)
      return
    }
    if (key.leftArrow || key.rightArrow || key.tab || key.escape || (key.ctrl && input !== 'j')) return
    // Pasted multi-line text arrives as one input batch: normalize its line
    // endings into newlines instead of leaking raw carriage returns.
    const text = input.replaceAll(/\r\n?/gu, '\n')
    if (text !== '') {
      setValue(previous => previous + text)
      setSelected(0)
    }
  })
  return (
    <Box flexDirection="column">
      {menuOpen && (
        <Box flexDirection="column">
          <SelectList items={candidates} selectedIndex={clamped} maxVisible={8} />
          <Text dimColor>↑↓ select · tab completes · enter {commandMatch !== null ? 'runs' : 'completes'} · esc closes</Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor={disabled ? 'gray' : 'cyan'} paddingX={1}>
        <Text>{'❯ '}{value === '' ? <Text dimColor>{disabled ? 'waiting…' : 'message the agent, / for commands'}</Text> : value}<Text inverse> </Text></Text>
      </Box>
    </Box>
  )
}

/** The bottom status line: model, session, token totals, and turn state. */
function StatusBar({ model, thinking, sessionId, input, output, busy, compacting }: {
  model: string
  thinking: string
  sessionId: string | undefined
  input: number
  output: number
  busy: boolean
  compacting: boolean
}): React.JSX.Element {
  const shortId = sessionId === undefined ? '…' : sessionId.replace(/^session-/u, '').slice(0, 8)
  const state = busy ? 'running' : compacting ? 'compacting…' : 'idle'
  const modelLabel = thinking === '' ? model : `${model} · ${thinking}`
  return (
    <Text dimColor>
      {modelLabel} · session {shortId} · ↑{input} ↓{output} tok · {state} · /help
    </Text>
  )
}

/** Root frame props: the controller store. */
export interface AppProps {
  readonly controller: TuiController
}

/** The TUI root component. */
export function App({ controller }: AppProps): React.JSX.Element {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const { projection } = snapshot

  // Finalized rows retire into the terminal scrollback via Static (never
  // repainted). Static membership is append-only per session; a session swap
  // resets the ledger. Mutations only ever replace non-finalized rows, which
  // have not retired yet, so the static prefix is stable.
  const ledger = useRef<{ session: string | undefined; rows: ChatRow[] }>({ session: undefined, rows: [] })
  if (ledger.current.session !== snapshot.sessionId) {
    ledger.current = { session: snapshot.sessionId, rows: [] }
  }
  const retired = ledger.current.rows
  let splitAt = retired.length
  while (splitAt < projection.rows.length && isFinalized(projection.rows[splitAt] as ChatRow)) splitAt += 1
  const retiring = projection.rows.slice(retired.length, splitAt)
  if (retiring.length > 0) ledger.current = { session: snapshot.sessionId, rows: [...retired, ...retiring] }
  const liveRows = projection.rows.slice(splitAt)

  const pending = snapshot.pendingApproval
  const picker = snapshot.picker
  const slashMenu = useRef<SlashMenuState>({ open: false, requestClose: () => {} })
  const compacting = projection.compaction?.running === true
  const spinner = useSpinnerFrame((projection.busy || compacting) && projection.streaming === undefined)

  const decide = (choice: ApprovalChoice): void => { pending?.decide(choice) }
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      void controller.quit()
      return
    }
    if (pending !== undefined) {
      if (input === 'y') {
        decide('allowed-once')
        return
      }
      if (input === 'n') {
        decide('rejected')
        return
      }
      if (input === 'a') {
        decide('always')
        return
      }
      if (key.escape) {
        decide('rejected')
        return
      }
      // No early return for any other key: the Prompt stays mounted below the
      // overlay, so the user can keep typing while the question is open.
    }
    if (key.escape) {
      // Esc closes an open menu first; on a clear surface it cancels the turn.
      if (slashMenu.current.open) {
        slashMenu.current.requestClose()
        return
      }
      controller.cancelTurn()
    }
  })

  return (
    <Box flexDirection="column">
      <Static items={ledger.current.rows}>
        {row => <RowView key={row.key} row={row} />}
      </Static>
      {snapshot.phase === 'starting' && <Text dimColor>starting the agent…</Text>}
      {snapshot.phase === 'failed' && <Text color="red">startup failed: {snapshot.error}</Text>}
      {liveRows.map(row => <RowView key={row.key} row={row} />)}
      {projection.streaming !== undefined && projection.streaming.reasoning !== ''
        && <Text dimColor italic>thought: {preview(projection.streaming.reasoning)}</Text>}
      {projection.streaming !== undefined && <Text>{projection.streaming.text}<Text color="gray">▌</Text></Text>}
      {(projection.busy || compacting) && projection.streaming === undefined
        && <Text color="yellow">{spinner} {compacting ? 'compacting…' : 'working…'}</Text>}
      <TodoStrip todos={projection.todos} />
      {pending !== undefined && (
        <ApprovalOverlay toolName={pending.toolName} {...pending.reason === undefined ? {} : { reason: pending.reason }} />
      )}
      {picker !== null
        ? (
          <PickerView
            picker={picker}
            onSelect={(value) => { void controller.applyPickerSelection(value) }}
            onCancel={() => { controller.closePicker() }}
          />
        )
        : (
          <Prompt
            disabled={snapshot.phase !== 'ready'}
            approvalActive={pending !== undefined}
            commands={snapshot.commands}
            loadArgumentItems={command => controller.argumentItems(command)}
            menuState={slashMenu}
            onToggleThinking={() => { void controller.cycleReasoningEffort() }}
            onSubmit={(text) => { void controller.submit(text) }}
          />
        )}
      <StatusBar
        model={snapshot.modelLabel}
        thinking={snapshot.thinkingLabel}
        sessionId={snapshot.sessionId}
        input={projection.usage.input}
        output={projection.usage.output}
        busy={projection.busy}
        compacting={compacting}
      />
    </Box>
  )
}
