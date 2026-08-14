/** History file persistence: load, append round-trip, dedupe, cap, and line normalization. */

import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendHistory, loadHistory } from '../src/history.ts'

const tmpPaths: string[] = []

/** Reserve a unique temp file path and remember it for cleanup. */
function tempPath(): string {
  const path = join(tmpdir(), `dsh-history-${randomUUID()}.txt`)
  tmpPaths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(tmpPaths.splice(0).map(path => rm(path, { force: true })))
})

describe('loadHistory', () => {
  it('returns [] when the file does not exist', () => {
    expect(loadHistory(tempPath())).toEqual([])
  })

  it('returns [] for an empty file', async () => {
    const path = tempPath()
    await writeFile(path, '')
    expect(loadHistory(path)).toEqual([])
  })
})

describe('appendHistory', () => {
  it('round-trips appended records in order', async () => {
    const path = tempPath()
    await appendHistory(path, 'first')
    await appendHistory(path, 'second')
    expect(loadHistory(path)).toEqual(['first', 'second'])
  })

  it('folds consecutive duplicates but keeps a repeat after a different record', async () => {
    const path = tempPath()
    await appendHistory(path, 'same')
    await appendHistory(path, 'same')
    await appendHistory(path, 'other')
    await appendHistory(path, 'same')
    expect(loadHistory(path)).toEqual(['same', 'other', 'same'])
  })

  it('keeps only the newest `limit` records', async () => {
    const path = tempPath()
    for (const value of ['one', 'two', 'three', 'four', 'five']) {
      await appendHistory(path, value, 3)
    }
    expect(loadHistory(path)).toEqual(['three', 'four', 'five'])
  })

  it('collapses embedded newlines into a single line', async () => {
    const path = tempPath()
    await appendHistory(path, 'line1\nline2\rline3\r\nline4')
    expect(loadHistory(path)).toEqual(['line1 line2 line3 line4'])
  })
})
