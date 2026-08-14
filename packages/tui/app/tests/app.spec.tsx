/** Ink frame rendering and key handling, driven through a scripted controller store. */

import { describe, expect, it } from 'vitest'
import { render } from 'ink-testing-library'
import type { ApprovalChoice, TuiController, TuiSnapshot } from '../src/controller.ts'
import { App } from '../src/ui/App.tsx'
import type { ChatRow } from '../src/types.ts'

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
    modelLabel: 'test-provider/test-model',
    pendingApproval: undefined,
    commands: [],
    picker: null,
    thinkingLabel: '',
    ...overrides,
  }
}

/** A controller stand-in recording every UI-initiated call. */
function rig(snapshot: TuiSnapshot) {
  const state = {
    submitted: [] as string[],
    cancels: 0,
    thinkingToggles: 0,
    quits: 0,
    picked: [] as string[],
    pickerCloses: 0,
  }
  const controller = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    submit: (text: string) => {
      state.submitted.push(text)
      return Promise.resolve()
    },
    cancelTurn: () => { state.cancels += 1 },
    cycleReasoningEffort: () => {
      state.thinkingToggles += 1
      return Promise.resolve()
    },
    quit: () => {
      state.quits += 1
      return Promise.resolve()
    },
    argumentItems: () => Promise.resolve([]),
    applyPickerSelection: (value: string) => {
      state.picked.push(value)
      return Promise.resolve()
    },
    closePicker: () => { state.pickerCloses += 1 },
  } as unknown as TuiController
  return { state, controller }
}

describe('App rendering', () => {
  it('renders transcript rows and the status bar', () => {
    const rows: ChatRow[] = [
      { kind: 'user', key: 'u:1', text: 'hello agent' },
      { kind: 'assistant', key: 'a:2', text: 'answer text', reasoning: '', model: 'test-provider/test-model' },
      { kind: 'tool', key: 't:c1', name: 'bash', argsSummary: 'ls', status: 'done', resultPreview: 'file.txt', isError: false },
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

  it('shows a running tool with its live marker', () => {
    const rows: ChatRow[] = [
      { kind: 'tool', key: 't:c2', name: 'fs_read', argsSummary: '/tmp/a', status: 'running' },
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

  it('quits on Ctrl+C', async () => {
    const { state, controller } = rig(snap())
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('\u0003')
    await flush()
    expect(state.quits).toBe(1)
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

  it('remembers the tool on a', async () => {
    const { controller, decided } = approvalRig()
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('a')
    await flush()
    expect(decided).toEqual(['always'])
  })

  it('keeps the prompt editable while the question is open', async () => {
    const { controller, decided } = approvalRig()
    const { stdin, lastFrame } = render(<App controller={controller} />)
    await flush()
    // Typing while the overlay is up echoes into the still-mounted prompt;
    // only the overlay-owned letters settle the question. ('wait' avoids
    // y/n/a, which the overlay claims even mid-typing.)
    stdin.write('wait')
    await flush()
    expect(lastFrame()).toContain('wait')
    expect(decided).toEqual([])
    stdin.write('y')
    await flush()
    expect(decided).toEqual(['allowed-once'])
    expect(lastFrame()).not.toContain('waity')
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

  it('keeps Ctrl+C quitting while a picker is open', async () => {
    const { state, controller } = rig(snap({ picker: PICKER }))
    const { stdin } = render(<App controller={controller} />)
    await flush()
    stdin.write('\u0003')
    await flush()
    expect(state.quits).toBe(1)
  })
})
