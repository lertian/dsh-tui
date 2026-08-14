/**
 * The Ink frame: chat scrollback (finalized rows retire into Static), the
 * live region (streaming assistant, running tools, todos), the approval
 * overlay, the picker dialogs, the slash-command menu, the multiline prompt,
 * and the status bar.
 * @module @deepseek-ai/dsh-tui-app/ui/App
 */

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Static, Text, useInput } from 'ink'
import type { ApprovalChoice, PickerState, SlashMenuItem, TuiController } from '../controller.ts'
import { fuzzyFilter } from '../fuzzy.ts'
import { preview } from '../projection.ts'
import { appendHistory, loadHistory } from '../history.ts'
import { isFinalized } from '../types.ts'
import type { AssistantRow, ChatRow, ToolRow } from '../types.ts'
import { SelectList } from './SelectList.tsx'
import type { SelectItem } from './SelectList.tsx'

/** Spinner frames for the busy indicator. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** How long the first Ctrl+C keeps the quit window armed for a second press. */
const CTRL_C_EXIT_WINDOW_MS = 1000

/** The DeepSeek whale, as terminal block art (rendered from the brand favicon). */
const WHALE_LOGO = [
  '           ▄▄▄▄    ▄▄',
  '   ▄██████████▄    ███▄ ▄▄▄█▀',
  ' ▄██████████████▄  ▀████████',
  '██████████████████▄  ████▀▀',
  '██    ▀▀███████▀▀███████',
  '██       ▀▀█████  ▀████▀',
  '██▄        ▀█████▄▄████',
  '▀██▄         ▀████████',
  ' ▀███▄   █▄▄  ▀█████▀',
  '   ▀███▄▄████▄▄▄██████',
  '      ▀▀██████▀▀',
]

/** Delete one trailing grapheme (locale-aware; safe across surrogate pairs). */
export function backspace(text: string): string {
  const graphemes = Array.from(new Intl.Segmenter().segment(text), part => part.segment)
  graphemes.pop()
  return graphemes.join('')
}

/** One prose or code run of an assistant message, split on ``` fences. */
export interface FencePart {
  /** Whether this run sits inside a ``` fence (renders as a code block). */
  readonly code: boolean
  readonly text: string
}

/** Split markdown on ``` fence lines; the fence lines themselves do not render. */
export function fenceParts(text: string): FencePart[] {
  const parts: FencePart[] = []
  let buffer: string[] = []
  let inCode = false
  const flush = (): void => {
    const block = buffer.join('\n')
    buffer = []
    if (block !== '') parts.push({ code: inCode, text: block })
  }
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      flush()
      inCode = !inCode
    } else {
      buffer.push(line)
    }
  }
  flush()
  return parts
}

/** Split one string into code points; caret positions are measured in these. */
function codePoints(text: string): string[] {
  return Array.from(text)
}

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
const RowView = React.memo(function RowView({ row, isExpanded }: { row: ChatRow; isExpanded: boolean }): React.JSX.Element {
  switch (row.kind) {
    case 'user':
      return <Text color="cyan">{'> '}{row.text}</Text>
    case 'assistant':
      return (
        <Box flexDirection="column">
          {row.reasoning !== '' && (
            <Text dimColor italic>thought: {isExpanded ? row.reasoning : preview(row.reasoning)}</Text>
          )}
          {fenceParts(row.text).map((part, index) => (
            <Text key={index} dimColor={part.code}>{part.text}</Text>
          ))}
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
            && <Text dimColor>{'  ⎿ '}{isExpanded ? (row.resultText ?? row.resultPreview) : row.resultPreview}</Text>}
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

/** The startup welcome banner (Claude Code style): the whale logo, a tip list, and the session identity. */
function WelcomeBanner({ model, sessionId, cwd }: {
  model: string
  sessionId: string | undefined
  cwd: string
}): React.JSX.Element {
  const shortId = sessionId === undefined ? '…' : sessionId.replace(/^session-/u, '').slice(0, 8)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={2} paddingY={1}>
      <Text bold>DeepSeek Harness</Text>
      <Box flexDirection="row">
        <Box flexDirection="column">
          {WHALE_LOGO.map((line, index) => <Text key={index} color="cyan">{line}</Text>)}
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          <Text bold>Welcome!</Text>
          <Text dimColor>· type a message to start a turn</Text>
          <Text dimColor>· /help lists commands and keys</Text>
          <Text dimColor>· Shift+Tab cycles the thinking level</Text>
          <Text dimColor>· Ctrl+C clears or interrupts, twice quits</Text>
        </Box>
      </Box>
      <Text dimColor>{model} · session {shortId} · {cwd}</Text>
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
      setFilter(previous => backspace(previous))
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

/** Shared prompt state so frame-level handlers can close the menu, read, and clear the input. */
interface PromptState {
  open: boolean
  /** Dismiss the menu for the current input; provided by the Prompt. */
  requestClose: () => void
  /** Whether the prompt currently holds any input; provided by the Prompt. */
  hasInput: () => boolean
  /** Clear the prompt input; provided by the Prompt. */
  requestClear: () => void
}

/** The multiline prompt box with the pi-style slash menu above it. */
function Prompt({ disabled, commands, skills, loadArgumentItems, promptState, historyPath, onToggleThinking, onSubmit }: {
  disabled: boolean
  commands: readonly SlashMenuItem[]
  /** User-invocable skills listed in the same slash menu after commands. */
  skills: readonly SlashMenuItem[]
  loadArgumentItems: (command: string, partialArg: string) => Promise<readonly SelectItem[]>
  promptState: { current: PromptState }
  /** Where submitted lines persist; undefined keeps history in-memory only. */
  historyPath: string | undefined
  onToggleThinking: () => void
  onSubmit: (text: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState(0)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [argumentItems, setArgumentItems] = useState<{ command: string; items: readonly SelectItem[] } | null>(null)
  const valueRef = useRef('')
  valueRef.current = value
  const cursorRef = useRef(0)
  cursorRef.current = cursor
  /** Replace the buffer and clamp the caret into the new text (code-point index). */
  const setValueAndCursor = (text: string, nextCursor?: number): void => {
    setValue(text)
    setCursor(Math.min(Math.max(nextCursor ?? cursorRef.current, 0), codePoints(text).length))
  }
  promptState.current.requestClose = () => { setDismissedFor(valueRef.current) }
  promptState.current.hasInput = () => valueRef.current !== ''
  promptState.current.requestClear = () => { setValueAndCursor('', 0); setDismissedFor(null); setSelected(0) }

  // Readline-style input history: `historyRef` holds every submitted line in
  // order (consecutive duplicates collapsed), `historyPosRef` is the recall
  // cursor (`history.length` = the live line), and `draftRef` preserves the
  // in-progress line so ↓ can return to it.
  const historyRef = useRef<string[]>([])
  const historyPosRef = useRef(0)
  const draftRef = useRef('')
  // Persisted history seeds the in-memory recall buffer once per surface.
  useEffect(() => {
    if (historyPath === undefined) return undefined
    historyRef.current = loadHistory(historyPath)
    historyPosRef.current = historyRef.current.length
    return undefined
  }, [historyPath])

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
      const text = history[next] ?? ''
      setValueAndCursor(text, codePoints(text).length)
    } else {
      if (pos >= history.length) return
      const next = pos + 1
      historyPosRef.current = next
      const text = next >= history.length ? draftRef.current : (history[next] ?? '')
      setValueAndCursor(text, codePoints(text).length)
    }
    setSelected(0)
  }

  /** Submit one non-empty line: record it, clear the box, and hand it off. */
  const submit = (text: string): void => {
    recordHistory(text)
    setValueAndCursor('', 0)
    setDismissedFor(null)
    if (historyPath !== undefined) void appendHistory(historyPath, text)
    onSubmit(text)
  }

  // Command-name mode (`/to`) versus argument mode (`/resume 5feb`): the
  // latter asks the command's own completion provider for the current partial,
  // re-asking as the partial changes so providers may narrow server-side.
  const commandMatch = /^\/([a-zA-Z0-9_-]*)$/u.exec(value)
  const argumentMatch = /^\/([a-z][a-z0-9_-]*) (.*)$/su.exec(value)
  const argumentCommand = argumentMatch?.[1] ?? null
  const argumentPartial = argumentMatch?.[2] ?? ''
  useEffect(() => {
    if (argumentCommand === null) {
      setArgumentItems(null)
      return undefined
    }
    let cancelled = false
    void loadArgumentItems(argumentCommand, argumentPartial).then((items) => {
      if (!cancelled) setArgumentItems({ command: argumentCommand, items })
    })
    return () => { cancelled = true }
  }, [argumentCommand, argumentPartial, loadArgumentItems])

  // Commands first, then skills: one flat fuzzy list. Command names shadow
  // colliding skill names (the controller already drops those), and skills
  // complete to a trailing space like the web picker.
  const menuEntries: readonly (SlashMenuItem & { kind: 'command' | 'skill' })[] = [
    ...commands.map(command => ({ ...command, kind: 'command' as const })),
    ...skills.map(skill => ({ ...skill, kind: 'skill' as const })),
  ]
  const candidates: readonly SelectItem[] = commandMatch !== null
    ? fuzzyFilter(menuEntries, commandMatch[1] ?? '', entry => entry.name)
      .slice(0, 8)
      .map(entry => ({
        value: entry.name,
        label: `/${entry.name}`,
        description: entry.hint === '' ? entry.description : `${entry.hint} — ${entry.description}`,
      }))
    : argumentMatch !== null && argumentItems !== null && argumentItems.command === argumentMatch[1]
      ? fuzzyFilter(argumentItems.items, argumentMatch[2] ?? '', item => `${item.label} ${item.value}`).slice(0, 8)
      : []
  const menuOpen = !disabled && candidates.length > 0 && dismissedFor !== value
  promptState.current.open = menuOpen
  const clamped = Math.min(selected, candidates.length - 1)

  /** Replace the input with the highlighted candidate; arguments complete, command names append a space. */
  const completeWith = (item: SelectItem): void => {
    if (commandMatch !== null) {
      const command = commands.find(entry => entry.name === item.value)
      const text = command !== undefined && command.hint === '' ? `/${item.value}` : `/${item.value} `
      setValueAndCursor(text, codePoints(text).length)
      setSelected(0)
      return
    }
    const text = `/${argumentMatch?.[1] ?? ''} ${item.value}`
    setValueAndCursor(text, codePoints(text).length)
    setSelected(0)
  }

  /** Insert text at the caret and move the caret past it (code-point aware). */
  const insertText = (text: string): void => {
    const chars = codePoints(valueRef.current)
    const inserted = codePoints(text)
    chars.splice(cursorRef.current, 0, ...inserted)
    setValueAndCursor(chars.join(''), cursorRef.current + inserted.length)
    setSelected(0)
  }

  /** Delete the code-point range `[start, end)` and park the caret at `start`. */
  const deleteRange = (start: number, end: number): void => {
    const chars = codePoints(valueRef.current)
    chars.splice(start, end - start)
    setValueAndCursor(chars.join(''), start)
    setSelected(0)
  }

  /** Delete one grapheme before the caret. */
  const deleteBefore = (): void => {
    if (cursorRef.current === 0) return
    const before = codePoints(valueRef.current).slice(0, cursorRef.current).join('')
    const graphemes = Array.from(new Intl.Segmenter().segment(before), part => part.segment)
    const removed = graphemes.pop() ?? ''
    deleteRange(cursorRef.current - codePoints(removed).length, cursorRef.current)
  }

  /** Delete one grapheme after the caret. */
  const deleteAfter = (): void => {
    const chars = codePoints(valueRef.current)
    if (cursorRef.current >= chars.length) return
    const rest = chars.slice(cursorRef.current).join('')
    const graphemes = Array.from(new Intl.Segmenter().segment(rest), part => part.segment)
    const removed = graphemes[0] ?? ''
    deleteRange(cursorRef.current, cursorRef.current + codePoints(removed).length)
  }

  /** Delete the word before the caret (readline Ctrl+W: whitespace-bounded). */
  const deleteWordBefore = (): void => {
    const chars = codePoints(valueRef.current)
    let start = cursorRef.current
    while (start > 0 && /\s/u.test(chars[start - 1] ?? '')) start -= 1
    while (start > 0 && !/\s/u.test(chars[start - 1] ?? '')) start -= 1
    deleteRange(start, cursorRef.current)
  }

  useInput((input, key) => {
    if (disabled) return
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
          // A fully-typed name runs as typed — a command (even one that takes
          // an argument) or a user-invocable skill (forwarded to the model).
          const typed = commandMatch[1] ?? ''
          if (commands.some(entry => entry.name === typed) || skills.some(entry => entry.name === typed)) {
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
        setValueAndCursor(completed, codePoints(completed).length)
        setSelected(0)
        return
      }
    }
    if (key.return) {
      if (key.shift) {
        insertText('\n')
        return
      }
      const text = valueRef.current
      if (text.trim() === '') {
        setValueAndCursor('', 0)
        setDismissedFor(null)
        return
      }
      submit(text)
      return
    }
    if (key.ctrl && input === 'j') {
      insertText('\n')
      return
    }
    if (key.ctrl && input === 'a') {
      setCursor(0)
      return
    }
    if (key.ctrl && input === 'e') {
      setCursor(codePoints(valueRef.current).length)
      return
    }
    if (key.ctrl && input === 'u') {
      deleteRange(0, cursorRef.current)
      return
    }
    if (key.ctrl && input === 'k') {
      deleteRange(cursorRef.current, codePoints(valueRef.current).length)
      return
    }
    if (key.ctrl && input === 'w') {
      deleteWordBefore()
      return
    }
    if (key.backspace) {
      deleteBefore()
      return
    }
    if (key.delete) {
      deleteAfter()
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
    if (key.leftArrow) {
      setCursor(Math.max(0, cursorRef.current - 1))
      return
    }
    if (key.rightArrow) {
      setCursor(Math.min(codePoints(valueRef.current).length, cursorRef.current + 1))
      return
    }
    if (key.tab || key.escape || key.ctrl) return
    // Pasted multi-line text arrives as one input batch: normalize its line
    // endings into newlines instead of leaking raw carriage returns.
    const text = input.replaceAll(/\r\n?/gu, '\n')
    if (text !== '') insertText(text)
  })
  // Locate the caret as (line, code-point column) and render the prompt text
  // with a block caret (▌) at that position; continuation lines keep their
  // indent. The caret is a plain string on purpose: a nested inverse-space
  // Text is a wrap point for Ink's yoga layout and breaks lines unpredictably.
  const lines = value.split('\n')
  let cursorRow = 0
  let remaining = cursor
  while (cursorRow < lines.length - 1 && remaining > codePoints(lines[cursorRow] ?? '').length) {
    remaining -= codePoints(lines[cursorRow] ?? '').length + 1
    cursorRow += 1
  }
  const cursorLine = lines[cursorRow] ?? ''
  const cursorCol = Math.min(remaining, codePoints(cursorLine).length)
  const caretLineChars = codePoints(cursorLine)
  const beforeCaret = caretLineChars.slice(0, cursorCol).join('')
  const afterCaret = caretLineChars.slice(cursorCol).join('')
  return (
    <Box flexDirection="column">
      {menuOpen && (
        <Box flexDirection="column">
          <SelectList items={candidates} selectedIndex={clamped} maxVisible={8} />
          <Text dimColor>↑↓ select · tab completes · enter {commandMatch !== null ? 'runs' : 'completes'} · esc closes</Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor={disabled ? 'gray' : 'cyan'} paddingX={1}>
        <Text>
          {'❯ '}
          {value === ''
            ? <Text dimColor>{disabled ? 'waiting…' : ''}</Text>
            : lines.map((line, index) => (
              <React.Fragment key={index}>
                {index === 0 ? '' : '\n  '}
                {index === cursorRow ? `${beforeCaret}▌${afterCaret}` : line}
              </React.Fragment>
            ))}
        </Text>
      </Box>
    </Box>
  )
}

/** The bottom status line: model, session, token totals, and turn state. */
function StatusBar({ model, thinking, sessionId, input, output, busy, compacting, cancelling }: {
  model: string
  thinking: string
  sessionId: string | undefined
  input: number
  output: number
  busy: boolean
  compacting: boolean
  /** A user cancel is pending: the cooperative abort has not converged yet. */
  cancelling: boolean
}): React.JSX.Element {
  const shortId = sessionId === undefined ? '…' : sessionId.replace(/^session-/u, '').slice(0, 8)
  const state = cancelling ? 'cancelling…' : busy ? 'running' : compacting ? 'compacting…' : 'idle'
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
  // Keys of the current turn's rows rendered with their full text after Ctrl+O.
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set())

  // Finalized rows retire into the terminal scrollback via Static (never
  // repainted). Static membership is append-only per session; a session swap
  // resets the ledger. Mutations only ever replace non-finalized rows, which
  // have not retired yet, so the static prefix is stable.
  const ledger = useRef<{ session: string | undefined; viewEpoch: number; rows: ChatRow[] }>({ session: undefined, viewEpoch: 0, rows: [] })
  if (ledger.current.session !== snapshot.sessionId || ledger.current.viewEpoch !== snapshot.viewEpoch) {
    ledger.current = { session: snapshot.sessionId, viewEpoch: snapshot.viewEpoch, rows: [] }
  }
  // The current turn's expandable rows (tool cards, assistant rows with
  // reasoning) never retire into Static: they must stay repaintable so Ctrl+O
  // can expand and collapse them, and emptying Static's items would reset its
  // index and reprint the whole scrollback on restore.
  /** Expandable rows: tool cards and assistant rows that carry reasoning. */
  const isExpandableRow = (row: ChatRow): row is ToolRow | AssistantRow =>
    row.kind === 'tool' || (row.kind === 'assistant' && row.reasoning !== '')
  const liveTurnKeys = new Set<string>()
  for (const row of projection.rows) {
    if (isExpandableRow(row) && row.turn === projection.turn) liveTurnKeys.add(row.key)
  }
  const retired = ledger.current.rows
  let splitAt = retired.length
  while (
    splitAt < projection.rows.length
    && isFinalized(projection.rows[splitAt] as ChatRow)
    && !liveTurnKeys.has((projection.rows[splitAt] as ChatRow).key)
  ) splitAt += 1
  const retiring = projection.rows.slice(retired.length, splitAt)
  if (retiring.length > 0) ledger.current = { session: snapshot.sessionId, viewEpoch: snapshot.viewEpoch, rows: [...retired, ...retiring] }
  const liveRows = projection.rows.slice(splitAt)

  const pending = snapshot.pendingApproval
  const picker = snapshot.picker
  const promptState = useRef<PromptState>({ open: false, requestClose: () => {}, hasInput: () => false, requestClear: () => {} })
  const ctrlCAt = useRef(0)
  const compacting = projection.compaction?.running === true
  const cancelling = snapshot.cancelPending
  const spinner = useSpinnerFrame((projection.busy || compacting) && projection.streaming === undefined)

  const decide = (choice: ApprovalChoice): void => { pending?.decide(choice) }
  // Stable identity so the Prompt's argument-candidate effect does not re-run
  // on every frame render (an inline arrow would change each render, and the
  // effect's setState with a fresh object would then render-loop).
  const loadArgumentItems = useCallback(
    (command: string, partialArg: string) => controller.argumentItems(command, partialArg),
    [controller],
  )
  /** Expand or collapse the current turn's tool results and assistant reasoning. */
  const toggleLastTurn = (): void => {
    const lastTurnKeys = new Set<string>()
    for (const row of projection.rows) {
      if (row.kind !== 'tool' && row.kind !== 'assistant') continue
      if (row.kind === 'assistant' && row.reasoning === '') continue
      if (row.turn === projection.turn) lastTurnKeys.add(row.key)
    }
    const shouldExpand = [...lastTurnKeys].some(key => !expandedKeys.has(key))
    setExpandedKeys(shouldExpand ? new Set(lastTurnKeys) : new Set())
  }
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      // A second press inside the window always quits, whatever the first did.
      if (now - ctrlCAt.current < CTRL_C_EXIT_WINDOW_MS) {
        ctrlCAt.current = 0
        void controller.quit()
        return
      }
      ctrlCAt.current = now
      // The first press takes the softest action the current surface offers:
      // reject an open approval, close a picker, cancel the running turn, or
      // clear the input — never quit.
      if (pending !== undefined) {
        decide('rejected')
        return
      }
      if (picker !== null) {
        controller.closePicker()
        return
      }
      if (projection.busy || compacting) {
        // Cancelling also clears typed-ahead input (gemini's clearBuffer): the
        // cooperative abort may take seconds to converge, so the box must not
        // keep whatever was typed while the turn was running.
        if (projection.busy) promptState.current.requestClear()
        controller.cancelTurn()
        return
      }
      if (promptState.current.hasInput()) {
        promptState.current.requestClear()
        return
      }
      // Idle with an empty prompt: the next press quits.
      controller.pushNotice('info', 'press Ctrl+C again to exit')
      return
    }
    if (key.ctrl && input === 'o') {
      toggleLastTurn()
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
      // Any other key is ignored while the question owns the surface; the
      // prompt below stays mounted but read-only.
    }
    if (key.escape) {
      // A picker closes itself on Esc; only a clear surface cancels the turn.
      if (picker !== null) return
      if (promptState.current.open) {
        promptState.current.requestClose()
        return
      }
      // Cancelling a running turn clears typed-ahead input too, matching the
      // Ctrl+C ladder; an idle Esc keeps its no-op.
      if (projection.busy) promptState.current.requestClear()
      controller.cancelTurn()
    }
  })

  return (
    <Box flexDirection="column">
      <Static items={ledger.current.rows}>
        {row => <RowView key={row.key} row={row} isExpanded={expandedKeys.has(row.key)} />}
      </Static>
      {snapshot.phase === 'starting' && <Text dimColor>starting the agent…</Text>}
      {snapshot.phase === 'failed' && <Text color="red">startup failed: {snapshot.error}</Text>}
      {snapshot.phase === 'ready' && projection.rows.length === 0 && (
        <WelcomeBanner model={snapshot.modelLabel} sessionId={snapshot.sessionId} cwd={snapshot.cwd} />
      )}
      {liveRows.map(row => <RowView key={row.key} row={row} isExpanded={expandedKeys.has(row.key)} />)}
      {projection.streaming !== undefined && projection.streaming.reasoning !== ''
        && <Text dimColor italic>thought: {preview(projection.streaming.reasoning)}</Text>}
      {projection.streaming !== undefined && <Text>{projection.streaming.text}<Text color="gray">▌</Text></Text>}
      {(projection.busy || compacting) && projection.streaming === undefined
        && <Text color="yellow">{spinner} {cancelling ? 'cancelling…' : compacting ? 'compacting…' : 'working…'}</Text>}
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
            disabled={snapshot.phase !== 'ready' || pending !== undefined}
            commands={snapshot.commands}
            skills={snapshot.skills}
            loadArgumentItems={loadArgumentItems}
            promptState={promptState}
            historyPath={snapshot.historyPath}
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
        cancelling={cancelling}
      />
    </Box>
  )
}
