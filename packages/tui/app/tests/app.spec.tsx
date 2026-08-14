/** Ink frame rendering and key handling, driven through a scripted controller store. */

import { describe, expect, it } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import type { ApprovalChoice, TuiController, TuiSnapshot } from '../src/controller.ts'
import { App, backspace, fenceParts } from '../src/ui/App.tsx'
import type { ChatRow } from '../src/types.ts'
import type { SelectItem } from '../src/ui/SelectList.tsx'

/** Wait for Ink's effect-scheduled stdin attachment and a repaint after input. */
async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** A ready snapshot with the given overrides. */
function snap(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return {
    phase: 'ready',
    error: undefined,
    projection: { rows: [], streaming: undefined, todos: [], turn: 0, busy: false, compaction: undefined, usage: { input: 12, output: 7 } },
    sessionId: 'session-abcd1234',
    cwd: '/tmp/workspace',
    modelLabel: 'test-provider/test-model',
    pendingApproval: undefined,
    commands: [],
    skills: [],
    picker: null,
    thinkingLabel: '',
    cancelPending: false,
    historyPath: undefined,
    viewEpoch: 0,
    ...overrides,
  }
}

/** A controller stand-in recording every UI-initiated call; the snapshot is live. */
function rig(snapshot: TuiSnapshot, options: { argumentItems?: readonly SelectItem[] } = {}) {
  const listeners = new Set<() => void>()
  let live = snapshot
  const state = {
    submitted: [] as string[],
    cancels: 0,
    thinkingToggles: 0,
    quits: 0,
    picked: [] as string[],
    pickerCloses: 0,
    notices: [] as { tone: 'info' | 'warn' | 'error'; text: string }[],
  }
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  const controller = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => live,
    submit: (text: string) => {
      state.submitted.push(text)
      return Promise.resolve()
    },
    cancelTurn: () => {
      state.cancels += 1
      // Mirror the controller's immediate UI flip (only while a turn is open)
      // so frame tests can assert the cancelling presentation end to end.
      if (!live.cancelPending && live.projection.busy) {
        live = { ...live, cancelPending: true, projection: { ...live.projection, streaming: undefined } }
        notify()
      }
    },
    cycleReasoningEffort: () => {
      state.thinkingToggles += 1
      return Promise.resolve()
    },
    quit: () => {
      state.quits += 1
      return Promise.resolve()
    },
    argumentItems: () => Promise.resolve(options.argumentItems ?? []),
    applyPickerSelection: (value: string) => {
      state.picked.push(value)
      return Promise.resolve()
    },
    closePicker: () => { state.pickerCloses += 1 },
    pushNotice: (tone: 'info' | 'warn' | 'error', text: string) => { state.notices.push({ tone, text }) },
  } as unknown as TuiController
  return { state, controller }
}

describe('App rendering', () => {
  it('renders transcript rows and the status bar', () => {
    const rows: ChatRow[] = [
      { kind: 'user', key: 'u:1', text: 'hello agent' },
      { kind: 'assistant', key: 'a:2', text: 'answer text', reasoning: '', model: 'test-provider/test-model', turn: 1 },
      { kind: 'tool', key: 't:c1', name: 'bash', argsSummary: 'ls', status: 'done', resultPreview: 'file.txt', isError: false, turn: 1 },
    ]
    const { controller } = rig(snap({
      projection: { rows, streaming: undefined, todos: [], turn: 1, busy: false, compaction: undefined, usage: { input: 12, output: 7 } },
    }))
    const { lastFrame } = render(<App controller={controller} />)
    const frame = lastFrame()
    expect(frame).toContain('hello agent')
    expect(frame).toContain('answer text')
    expect(frame).toContain('✓ bash')
    expect(frame).toContain('file.txt')
    expect(frame).toContain('test-provider/test-model')
    expect(frame).toContain('session abcd1234')
    expect(frame).toContain('↑12 ↓7 tok')
  })

  it('shows the thinking level in the status bar when one is selected', () => {
    const { controller } = rig(snap({ thinkingLabel: 'High' }))
    const { lastFrame } = render(<App controller={controller} />)
    expect(lastFrame()).toContain('test-provider/test-model · High')
  })

  it('shows a running tool with its live marker', () => {
    const rows: ChatRow[] = [
      { kind: 'tool', key: 't:c2', name: 'fs_read', argsSummary: '/tmp/a', status: 'running', turn: 1 },
    ]
    const { controller } = rig(snap({
      projection: { rows, streaming: undefined, todos: [], turn: 1, busy: true, compaction: undefined, usage: { input: 0, output: 0 } },
    }))
    const { lastFrame } = render(<App controller={controller} />)
    expect(lastFrame()).toContain('⏵ fs_read')
  })

  it('shows the compaction spinner and status while a manual compaction runs (agent idle)', () => {
    const { controller } = rig(snap({
      projection: {
        rows: [],
        streaming: undefined,
        todos: [],
        turn: 1,
        busy: false,
        compaction: { id: 'compact-1', running: true },
        usage: { input: 0, output: 0 },
      },
    }))
    const { lastFrame } = render(<App controller={controller} />)
    const frame = lastFrame()
    expect(frame).toContain('compacting…')
    expect(frame).not.toContain('idle')
  })

  it('labels the open-turn spinner as compacting during an automatic compaction', () => {
    const { controller } = rig(snap({
      projection: {
        rows: [],
        streaming: undefined,
        todos: [],
        turn: 1,
        busy: true,
        compaction: { id: 'compact-2', running: true },
        usage: { input: 0, output: 0 },
      },
    }))
    const { lastFrame } = render(<App controller={controller} />)
    expect(lastFrame()).toContain('compacting…')
  })

  it('keeps the generic working spinner for an open turn without compaction', () => {
    const { controller } = rig(snap({
      projection: { rows: [], streaming: undefined, todos: [], turn: 1, busy: true, compaction: undefined, usage: { input: 0, output: 0 } },
    }))
    const { lastFrame } = render(<App controller={controller} />)
    expect(lastFrame()).toContain('working…')
  })

  it('shows a running command with its live marker and settled icons', () => {
    const rows: ChatRow[] = [
      { kind: 'command', key: 'c:1', name: 'compact', args: '', status: 'running' },
      { kind: 'command', key: 'c:2', name: 'tools', args: '', status: 'done', ok: true, text: 'bash — run commands' },
      { kind: 'command', key: 'c:3', name: 'compact', args: '', status: 'done', ok: false, text: 'Compaction is unavailable…' },
    ]
    const { controller } = rig(snap({
      projection: { rows, streaming: undefined, todos: [], turn: 0, busy: false, compaction: undefined, usage: { input: 0, output: 0 } },
    }))
    const { lastFrame } = render(<App controller={controller} />)
    const frame = lastFrame()
    expect(frame).toContain('⏵ /compact')
    expect(frame).toContain('✓ /tools')
    expect(frame).toContain('✗ /compact')
    expect(frame).toContain('Compaction is unavailable…')
  })

  it('renders the streaming assistant output with a cursor', () => {
    const { controller } = rig(snap({
      projection: { rows: [], streaming: { turn: 1, text: 'partial ans', reasoning: '' }, todos: [], turn: 1, busy: true, compaction: undefined, usage: { input: 0, output: 0 } },
    }))
    const { lastFrame } = render(<App controller={controller} />)
    expect(lastFrame()).toContain('partial ans')
  })

  it('renders the todo strip while work is open', () => {
    const { controller } = rig(snap({
      projection: {
        rows: [],
        streaming: undefined,
        todos: [{ content: 'fix the bug', status: 'in_progress' }, { content: 'add tests', status: 'pending' }],
        turn: 1,
        busy: true,
        compaction: undefined,
        usage: { input: 0, output: 0 },
      },
    }))
    const { lastFrame } = render(<App controller={controller} />)
    const frame = lastFrame()
    expect(frame).toContain('● fix the bug')
    expect(frame).toContain('○ add tests')
  })

  it('surfaces a startup failure', () => {
    const { controller } = rig(snap({ phase: 'failed', error: 'factory exploded' }))
    const { lastFrame } = render(<App controller={controller} />)
    expect(lastFrame()).toContain('startup failed: factory exploded')
  })

  it('shows the welcome banner on a fresh empty session', () => {
    const { controller } = rig(snap())
    const { lastFrame } = render(<App controller={controller} />)
    const frame = lastFrame()
    expect(frame).toContain('DeepSeek Harness')
    expect(frame).toContain('Welcome!')
    expect(frame).toContain('type a message to start a turn')
    expect(frame).toContain('/help lists commands and keys')
    expect(frame).toContain('test-provider/test-model · session abcd1234 · /tmp/workspace')
  })

  it('hides the welcome banner once the transcript has rows', () => {
    const rows: ChatRow[] = [
      { kind: 'user', key: 'u:1', text: 'hello agent' },
    ]
    const { controller } = rig(snap({
      projection: { rows, streaming: undefined, todos: [], turn: 1, busy: false, compaction: undefined, usage: { input: 12, output: 7 } },
    }))
    const { lastFrame } = render(<App controller={controller} />)
    expect(lastFrame()).not.toContain('Welcome!')
  })
})

describe('App input', () => {
  it('submits the prompt on Enter', async () => {
    const { state, controller } = rig(snap())
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('hello agent')
    await flush()
    stdin.write('\r')
    await flush()
    expect(state.submitted).toEqual(['hello agent'])
  })

  it('does not submit whitespace-only input', async () => {
    const { state, controller } = rig(snap())
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('   ')
    await flush()
    stdin.write('\r')
    await flush()
    expect(state.submitted).toEqual([])
  })

  it('cancels the turn on a bare Escape', async () => {
    const { state, controller } = rig(snap())
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('\u001B')
    await flush()
    expect(state.cancels).toBe(1)
  })

  it('toggles thinking mode on Shift+Tab', async () => {
    const { state, controller } = rig(snap())
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('\u001B[Z')
    await flush()
    expect(state.thinkingToggles).toBe(1)
    expect(state.submitted).toEqual([])
  })

  it('recalls submitted history with Up and Down', async () => {
    const { state, controller } = rig(snap())
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('first')
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('second')
    await flush()
    stdin.write('\r')
    await flush()
    expect(state.submitted).toEqual(['first', 'second'])
    stdin.write('\u001B[A')
    await flush()
    expect(lastFrame()).toContain('second')
    stdin.write('\u001B[A')
    await flush()
    expect(lastFrame()).toContain('first')
    stdin.write('\u001B[B')
    await flush()
    expect(lastFrame()).toContain('second')
  })

  it('clears typed input on the first Ctrl+C and quits on the second', async () => {
    const { state, controller } = rig(snap())
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('half a message')
    await flush()
    expect(lastFrame()).toContain('half a message')
    stdin.write('\u0003')
    await flush()
    expect(state.quits).toBe(0)
    expect(lastFrame()).not.toContain('half a message')
    stdin.write('\u0003')
    await flush()
    expect(state.quits).toBe(1)
  })

  it('announces the exit window on a bare first Ctrl+C and quits on the second', async () => {
    const { state, controller } = rig(snap())
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('\u0003')
    await flush()
    expect(state.quits).toBe(0)
    expect(state.notices).toEqual([{ tone: 'info', text: 'press Ctrl+C again to exit' }])
    stdin.write('\u0003')
    await flush()
    expect(state.quits).toBe(1)
  })

  it('cancels a running turn on the first Ctrl+C: input clears, working stops, second press quits', async () => {
    const { state, controller } = rig(snap({
      projection: { rows: [], streaming: undefined, todos: [], turn: 1, busy: true, compaction: undefined, usage: { input: 0, output: 0 } },
    }))
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('half a message')
    await flush()
    expect(lastFrame()).toContain('half a message')
    stdin.write('\u0003')
    await flush()
    expect(state.cancels).toBe(1)
    expect(state.quits).toBe(0)
    expect(lastFrame()).not.toContain('half a message')
    expect(lastFrame()).not.toContain('working…')
    expect(lastFrame()).toContain('cancelling…')
    stdin.write('\u0003')
    await flush()
    expect(state.quits).toBe(1)
  })

  it('flips the UI immediately and clears typed input when Esc cancels a running turn', async () => {
    const { state, controller } = rig(snap({
      projection: { rows: [], streaming: undefined, todos: [], turn: 1, busy: true, compaction: undefined, usage: { input: 0, output: 0 } },
    }))
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('typed ahead')
    await flush()
    expect(lastFrame()).toContain('typed ahead')
    expect(lastFrame()).toContain('working…')
    stdin.write('\u001B')
    await flush()
    expect(state.cancels).toBe(1)
    expect(lastFrame()).not.toContain('typed ahead')
    expect(lastFrame()).not.toContain('working…')
    expect(lastFrame()).toContain('cancelling…')
  })

  it('shows the cancelling state instead of running while a cancel is pending', async () => {
    const { controller } = rig(snap({
      projection: { rows: [], streaming: undefined, todos: [], turn: 1, busy: true, compaction: undefined, usage: { input: 0, output: 0 } },
      cancelPending: true,
    }))
    const { lastFrame } = render(<App controller={controller} />)
    const frame = lastFrame()
    expect(frame).not.toContain('working…')
    expect(frame).not.toContain('running')
    expect(frame).toContain('cancelling…')
  })

  it('keeps the idle Esc ladder unchanged: the turn cancels but typed input survives', async () => {
    const { state, controller } = rig(snap())
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('draft text')
    await flush()
    stdin.write('\u001B')
    await flush()
    expect(state.cancels).toBe(1)
    expect(state.quits).toBe(0)
    expect(lastFrame()).toContain('draft text')
  })

  it('expands and collapses the last turn on Ctrl+O', async () => {
    const rows: ChatRow[] = [
      { kind: 'tool', key: 't:1', name: 'bash', argsSummary: '', status: 'done', turn: 3, resultPreview: 'preview…', resultText: 'full result text' },
      { kind: 'assistant', key: 'a:1', text: 'ans', reasoning: 'one\ntwo\nthree\nfour\nfive\nsix\nseven', turn: 3 },
      { kind: 'tool', key: 't:2', name: 'fs', argsSummary: '', status: 'done', turn: 2, resultPreview: 'old' },
    ]
    const { controller } = rig(snap({
      projection: { rows, streaming: undefined, todos: [], turn: 3, busy: false, compaction: undefined, usage: { input: 0, output: 0 } },
    }))
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    expect(lastFrame()).not.toContain('full result text')
    expect(lastFrame()).not.toContain('seven')
    stdin.write('\u000F')
    await flush()
    expect(lastFrame()).toContain('full result text')
    expect(lastFrame()).toContain('seven')
    expect(lastFrame()).toContain('old')
    stdin.write('\u000F')
    await flush()
    expect(lastFrame()).not.toContain('full result text')
    expect(lastFrame()).not.toContain('seven')
  })

  it('indents continuation lines in the multiline prompt', async () => {
    const { controller } = rig(snap())
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('line1')
    await flush()
    stdin.write('\u000A')
    await flush()
    stdin.write('line2')
    await flush()
    const frame = lastFrame()
    expect(frame).toContain('❯ line1')
    expect(frame).toContain('  line2')
  })
})


describe('assistant markdown fences', () => {
  it('renders fenced code without the fence lines and dims the code', async () => {
    const rows: ChatRow[] = [
      { kind: 'assistant', key: 'a:1', text: 'intro\n```\ncode line\n```\noutro', reasoning: '', turn: 1 },
    ]
    const { controller } = rig(snap({
      projection: { rows, streaming: undefined, todos: [], turn: 1, busy: false, compaction: undefined, usage: { input: 0, output: 0 } },
    }))
    const { lastFrame } = render(<App controller={controller} />)
    const frame = lastFrame()
    expect(frame).toContain('code line')
    expect(frame).toContain('intro')
    expect(frame).toContain('outro')
    expect(frame).not.toContain('```')
  })

  it('keeps fence-free text untouched', () => {
    expect(fenceParts('plain text')).toEqual([{ code: false, text: 'plain text' }])
    expect(fenceParts('a\n```\nb\n```\nc')).toEqual([
      { code: false, text: 'a' },
      { code: true, text: 'b' },
      { code: false, text: 'c' },
    ])
  })
})

describe('backspace helper', () => {
  it('deletes a trailing surrogate pair as one code point', () => {
    expect(backspace('a👨')).toBe('a')
    expect(backspace('👨')).toBe('')
    expect(backspace('')).toBe('')
    expect(backspace('a')).toBe('')
  })
})

describe('prompt editing', () => {
  /** A snapshot with one transcript row so the welcome banner stays hidden. */
  function editingSnap() {
    const rows: ChatRow[] = [{ kind: 'user', key: 'u:1', text: 'hi' }]
    return snap({
      projection: { rows, streaming: undefined, todos: [], turn: 1, busy: false, compaction: undefined, usage: { input: 0, output: 0 } },
    })
  }

  it('moves the caret left and inserts in the middle', async () => {
    const { state, controller } = rig(editingSnap())
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('ab')
    await flush()
    stdin.write('\u001B[D')
    await flush()
    stdin.write('x')
    await flush()
    expect(lastFrame()).toContain('ax▌b')
    stdin.write('\r')
    await flush()
    expect(state.submitted).toEqual(['axb'])
  })

  it('jumps the caret with Ctrl+A and Ctrl+E', async () => {
    const { state, controller } = rig(editingSnap())
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('ab')
    await flush()
    stdin.write('\u0001')
    await flush()
    stdin.write('x')
    await flush()
    expect(lastFrame()).toContain('x▌ab')
    stdin.write('\u0005')
    await flush()
    stdin.write('y')
    await flush()
    expect(lastFrame()).toContain('xaby▌')
    stdin.write('\r')
    await flush()
    expect(state.submitted).toEqual(['xaby'])
  })

  it('deletes before and after the caret', async () => {
    const { state, controller } = rig(editingSnap())
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('abcd')
    await flush()
    stdin.write('\u001B[D')
    await flush()
    stdin.write('\u001B[D')
    await flush()
    stdin.write('\u0008') // Backspace deletes the 'b' before the caret.
    await flush()
    expect(lastFrame()).toContain('a▌cd')
    stdin.write('\u007F') // Delete removes the 'c' after the caret.
    await flush()
    expect(lastFrame()).toContain('a▌d')
    stdin.write('\r')
    await flush()
    expect(state.submitted).toEqual(['ad'])
  })

  it('kills to the caret with Ctrl+U and to the end with Ctrl+K', async () => {
    const { state, controller } = rig(editingSnap())
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('hello world')
    await flush()
    stdin.write('\u001B[D')
    await flush()
    stdin.write('\u000B')
    await flush()
    expect(lastFrame()).toContain('hello worl▌')
    stdin.write('\u0015')
    await flush()
    expect(lastFrame()).not.toContain('hello worl')
    stdin.write('fresh')
    await flush()
    stdin.write('\r')
    await flush()
    expect(state.submitted).toEqual(['fresh'])
  })

  it('deletes the word before the caret with Ctrl+W', async () => {
    const { state, controller } = rig(editingSnap())
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('one two')
    await flush()
    stdin.write('\u0017')
    await flush()
    expect(lastFrame()).toContain('one ▌')
    expect(lastFrame()).not.toContain('two')
    stdin.write('\r')
    await flush()
    expect(state.submitted).toEqual(['one '])
  })

  it('inserts newlines at the caret', async () => {
    const { state, controller } = rig(editingSnap())
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('ab')
    await flush()
    stdin.write('\u001B[D')
    await flush()
    stdin.write('\u000A')
    await flush()
    stdin.write('\r')
    await flush()
    expect(state.submitted).toEqual(['a\nb'])
  })
})

describe('history persistence', () => {
  it('seeds recall from the history file and appends submissions', async () => {
    const path = join(tmpdir(), `dsh-tui-history-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const snapWith = () => snap({ historyPath: path })
    const first = rig(snapWith())
    const view = render(<App controller={first.controller} />)
    await flush()
    view.stdin.write('first line')
    await flush()
    view.stdin.write('\r')
    await flush()
    // Give the fire-and-forget append a moment, then check the file.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(readFileSync(path, 'utf8')).toContain('first line')
    view.unmount()
    // A fresh surface over the same file recalls the persisted line.
    const second = rig(snapWith())
    const view2 = render(<App controller={second.controller} />)
    await flush()
    view2.stdin.write('\u001B[A')
    await flush()
    expect(view2.lastFrame()).toContain('first line')
    view2.unmount()
    rmSync(path, { force: true })
  })
})

describe('approval overlay', () => {
  /** A snapshot with a live question whose decide records the choice. */
  function approvalRig() {
    const decided: ApprovalChoice[] = []
    const snapshot = snap({
      pendingApproval: {
        toolName: 'bash',
        reason: 'writes files',
        decide: (choice) => { decided.push(choice) },
      },
    })
    const { state, controller } = rig(snapshot)
    return { state, controller, decided }
  }

  it('renders the question and resolves on y', async () => {
    const { controller, decided } = approvalRig()
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    const frame = lastFrame()
    expect(frame).toContain('Approve bash?')
    expect(frame).toContain('writes files')
    stdin.write('y')
    await flush()
    expect(decided).toEqual(['allowed-once'])
  })

  it('rejects on n and on Escape', async () => {
    const first = approvalRig()
    const view = render(<App controller={first.controller} />)
    await flush()
    view.stdin.write('n')
    await flush()
    expect(first.decided).toEqual(['rejected'])
    view.unmount()
    const second = approvalRig()
    const view2 = render(<App controller={second.controller} />)
    await flush()
    view2.stdin.write('\u001B')
    await flush()
    expect(second.decided).toEqual(['rejected'])
    view2.unmount()
  })

  it('rejects an open approval on the first Ctrl+C', async () => {
    const { controller, decided } = approvalRig()
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('\u0003')
    await flush()
    expect(decided).toEqual(['rejected'])
  })

  it('remembers the tool on a', async () => {
    const { controller, decided } = approvalRig()
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('a')
    await flush()
    expect(decided).toEqual(['always'])
  })

  it('keeps the prompt read-only while the question is open', async () => {
    const { controller, decided } = approvalRig()
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    // The prompt is read-only while the overlay owns every key: a word that
    // contains no overlay key must neither echo into the box nor settle it.
    stdin.write('echo')
    await flush()
    expect(lastFrame()).not.toContain('echo')
    expect(decided).toEqual([])
    stdin.write('y')
    await flush()
    expect(decided).toEqual(['allowed-once'])
  })
})

describe('slash menu', () => {
  const COMMANDS = [
    { name: 'new', description: 'start a fresh session', hint: '' },
    { name: 'resume', description: 'resume a persisted session', hint: 'session id' },
    { name: 'tools', description: 'list the tools available to the agent', hint: '' },
  ]

  it('opens on / and fuzzy-filters as you type', async () => {
    const { controller } = rig(snap({ commands: COMMANDS }))
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('/')
    await flush()
    expect(lastFrame()).toContain('/new')
    expect(lastFrame()).toContain('session id — resume a persisted session')
    stdin.write('to')
    await flush()
    expect(lastFrame()).toContain('/tools')
    expect(lastFrame()).not.toContain('/new')
  })

  it('runs a no-argument command on Enter', async () => {
    const { state, controller } = rig(snap({ commands: COMMANDS }))
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('/to')
    await flush()
    stdin.write('\r')
    await flush()
    expect(state.submitted).toEqual(['/tools'])
  })

  it('lists skills in the slash menu after commands', async () => {
    const SKILLS = [
      { name: 'review', description: 'review changes', hint: '' },
      { name: 'user-only-skill', description: 'user-only · user surface only', hint: '' },
    ]
    const { controller } = rig(snap({ commands: COMMANDS, skills: SKILLS }))
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('/')
    await flush()
    expect(lastFrame()).toContain('/review')
    expect(lastFrame()).toContain('/user-only-skill')
    expect(lastFrame()).toContain('review changes')
    stdin.write('rev')
    await flush()
    expect(lastFrame()).toContain('/review')
    expect(lastFrame()).not.toContain('/tools')
  })

  it('submits a fully-typed skill name on Enter', async () => {
    const SKILLS = [{ name: 'review', description: 'review changes', hint: '' }]
    const { state, controller } = rig(snap({ commands: COMMANDS, skills: SKILLS }))
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('/review')
    await flush()
    stdin.write('\r')
    await flush()
    expect(state.submitted).toEqual(['/review'])
  })

  it('completes a skill name to a trailing space on Tab', async () => {
    const SKILLS = [{ name: 'review', description: 'review changes', hint: '' }]
    const { state, controller } = rig(snap({ commands: COMMANDS, skills: SKILLS }))
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('/rev')
    await flush()
    stdin.write('\t')
    await flush()
    expect(state.submitted).toEqual([])
    expect(lastFrame()).toContain('/review ')
  })

  it('completes a hinted command on Tab instead of running it', async () => {
    const { state, controller } = rig(snap({ commands: COMMANDS }))
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('/r')
    await flush()
    stdin.write('\t')
    await flush()
    expect(state.submitted).toEqual([])
    expect(lastFrame()).toContain('/resume ')
  })

  it('closes the menu on Escape, then a second Escape cancels the turn', async () => {
    const { state, controller } = rig(snap({ commands: COMMANDS }))
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('/')
    await flush()
    stdin.write('\u001B')
    await flush()
    expect(lastFrame()).not.toContain('/new')
    expect(state.cancels).toBe(0)
    stdin.write('\u001B')
    await flush()
    expect(state.cancels).toBe(1)
  })

  it('completes a command argument from the menu, then submits on the next Enter', async () => {
    const ARG_ITEMS = [
      { value: 'session-a', label: 'aaaa  12:00  first chat' },
      { value: 'session-b', label: 'bbbb  11:00  second chat' },
    ]
    const { state, controller } = rig(snap({ commands: COMMANDS }), { argumentItems: ARG_ITEMS })
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    stdin.write('/resume ')
    await flush() // the argument candidates load asynchronously
    await flush()
    expect(lastFrame()).toContain('first chat')
    stdin.write('\r') // Enter completes the highlighted candidate
    await flush()
    expect(state.submitted).toEqual([])
    expect(lastFrame()).toContain('/resume session-a')
    stdin.write('\r') // a second Enter submits the completed line
    await flush()
    expect(state.submitted).toEqual(['/resume session-a'])
  })

  it('does not reload argument candidates when the frame re-renders for unrelated reasons', async () => {
    // A live subscribe/store lets the test force a real App re-render. Before
    // the loadArgumentItems identity fix, every frame re-render rebuilt the
    // inline callback, re-ran the candidate effect, and setState with a fresh
    // object — a render loop ("Maximum update depth exceeded").
    const listeners = new Set<() => void>()
    let liveSnapshot = snap()
    const argumentCalls: string[] = []
    const controller = {
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      getSnapshot: () => liveSnapshot,
      argumentItems: async (command: string) => { argumentCalls.push(command); return [] },
      submit: () => Promise.resolve(),
      cancelTurn: () => {},
      cycleReasoningEffort: () => Promise.resolve(),
      quit: () => Promise.resolve(),
      applyPickerSelection: () => Promise.resolve(),
      closePicker: () => {},
      pushNotice: () => {},
    } as unknown as TuiController
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('/resume ')
    await flush()
    await flush()
    expect(argumentCalls).toEqual(['resume'])
    liveSnapshot = snap()
    for (const listener of [...listeners]) listener()
    await flush()
    expect(argumentCalls).toEqual(['resume'])
  })
})

describe('picker dialog', () => {
  const PICKER = {
    kind: 'session' as const,
    title: 'resume a session',
    items: [
      { value: 'session-a', label: 'aaaa  12:00  first chat', description: '' },
      { value: 'session-b', label: 'bbbb  11:00  second chat', description: 'other-dir' },
    ],
  }

  it('renders, fuzzy-filters, and confirms the highlighted row', async () => {
    const { state, controller } = rig(snap({ picker: PICKER }))
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    expect(lastFrame()).toContain('resume a session')
    expect(lastFrame()).toContain('first chat')
    stdin.write('second')
    await flush()
    expect(lastFrame()).not.toContain('first chat')
    stdin.write('\r')
    await flush()
    expect(state.picked).toEqual(['session-b'])
  })

  it('cancels on Escape without applying anything', async () => {
    const { state, controller } = rig(snap({ picker: PICKER }))
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('\u001B')
    await flush()
    expect(state.pickerCloses).toBe(1)
    expect(state.picked).toEqual([])
    expect(state.cancels).toBe(0)
  })

  it('closes the picker on the first Ctrl+C and quits on the second', async () => {
    const { state, controller } = rig(snap({ picker: PICKER }))
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('\u0003')
    await flush()
    expect(state.pickerCloses).toBe(1)
    expect(state.quits).toBe(0)
    stdin.write('\u0003')
    await flush()
    expect(state.quits).toBe(1)
  })
})
