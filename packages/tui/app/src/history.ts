/**
 * Readline-style input history persisted as one record per line, with
 * consecutive-duplicate folding and a size cap. The file path is injected by
 * the caller, so the module depends on no dsh service.
 * @module @deepseek-ai/dsh-tui-app/history
 */

import { readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Collapse one record to a single line: CRLF/CR endings fold to LF, then any
 * remaining LF becomes a space so a record never spans two file lines.
 * @param entry - the raw record text.
 * @returns the single-line form.
 */
function normalizeEntry(entry: string): string {
  return entry.replaceAll(/\r\n?/gu, '\n').split('\n').join(' ')
}

/**
 * Split raw file content into non-empty records, keeping file order.
 * @param content - the raw file text.
 * @returns the non-empty lines.
 */
function splitLines(content: string): string[] {
  return content.split('\n').filter(line => line !== '')
}

/**
 * True when an error carries the given Node filesystem errno code.
 * @param error - the caught value.
 * @param code - the errno code to match.
 * @returns whether the error carries that code.
 */
function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

/**
 * Load records from a history file: one per line, empty lines skipped, order
 * preserved. A missing or unreadable file yields no records — history is
 * best-effort and never throws.
 * @param path - the history file to read.
 * @param limit - maximum records to return, keeping the newest when exceeded.
 * @returns the records in file order (oldest first), capped to `limit`.
 */
export function loadHistory(path: string, limit = 200): string[] {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const lines = splitLines(content)
  return lines.length > limit ? lines.slice(-limit) : lines
}

/**
 * Append one record, skipping it when it equals the last stored record, then
 * truncate the file to the newest `limit` records. Creates the parent
 * directory when missing.
 * @param path - the history file to append to.
 * @param entry - the record to append; embedded line breaks collapse to a space.
 * @param limit - maximum records to keep, dropping the oldest when exceeded.
 */
export async function appendHistory(path: string, entry: string, limit = 200): Promise<void> {
  const line = normalizeEntry(entry)
  if (line === '') return
  await mkdir(dirname(path), { recursive: true })
  let existing = ''
  try {
    existing = await readFile(path, 'utf8')
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw new Error(`cannot read history file '${path}'`, { cause: error })
  }
  const lines = splitLines(existing)
  if (lines.at(-1) === line) return
  if (existing === '') {
    await writeFile(path, line)
  } else {
    await appendFile(path, `\n${line}`)
  }
  const full = await readFile(path, 'utf8')
  const records = splitLines(full)
  if (records.length > limit) await writeFile(path, records.slice(-limit).join('\n'))
}
