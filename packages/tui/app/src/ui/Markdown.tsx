/**
 * Terminal markdown rendering for assistant text. Parsing is delegated to the
 * same micromark/mdast GFM pipeline the web client uses, and fenced-code
 * highlighting to the repo's shared shiki JS-engine setup; this module only
 * adapts the mdast tree and shiki tokens into Ink nodes — nothing here parses
 * markdown itself.
 * @module @deepseek-ai/dsh-tui-app/ui/markdown
 */

import React from 'react'
import { Text } from 'ink'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { createHighlighterCoreSync } from 'shiki/core'
import { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor } from 'shiki/engine/javascript'
import langTs from '@shikijs/langs/typescript'
import langBash from '@shikijs/langs/shellscript'
import langJson from '@shikijs/langs/json'
import themeGithubDark from '@shikijs/themes/github-dark'
import type { List, PhrasingContent, Root, RootContent, Table, TableCell } from 'mdast'

/** Parse GFM markdown through the maintained micromark/mdast stack. */
function parseMarkdown(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  })
}

/** The language tags the shiki instance can highlight, by fence alias. */
const LANG_ALIASES = new Map<string, string>([
  ['ts', 'typescript'], ['tsx', 'typescript'], ['js', 'typescript'], ['javascript', 'typescript'],
  ['bash', 'shellscript'], ['sh', 'shellscript'], ['shell', 'shellscript'],
  ['json', 'json'],
])

const highlighter = createHighlighterCoreSync({
  themes: [themeGithubDark],
  langs: [langTs, langBash, langJson],
  engine: createJavaScriptRegexEngine({
    forgiving: true,
    regexConstructor: defaultJavaScriptRegexConstructor,
  }),
})

/** Highlight one code fence via shiki; undefined when the tag is not registered. */
function codeTokens(code: string, langTag: string): { content: string; color?: string }[][] | undefined {
  const lang = LANG_ALIASES.get(langTag.toLowerCase())
  if (lang === undefined) return undefined
  try {
    return highlighter.codeToTokens(code, { lang, theme: 'github-dark', tokenizeTimeLimit: 0 }).tokens
  } catch {
    return undefined
  }
}

/** Terminal display width: CJK and wide glyphs count as two columns. */
function displayWidth(text: string): number {
  let width = 0
  // Han ideographs, kana, hangul, full-width forms, and emoji are 2 columns wide.
  const WIDE = /[\p{Script=Han}\u3040-\u30FF\uAC00-\uD7A3\uFF01-\uFF60\u{1F300}-\u{1FAFF}]/u
  for (const char of Array.from(text)) {
    width += WIDE.test(char) ? 2 : 1
  }
  return width
}

/** Pad one table cell to its column width; wider-than-column cells truncate. */
function padCell(text: string, width: number): string {
  const pad = width - displayWidth(text)
  return pad > 0 ? `${text}${' '.repeat(pad)}` : text.slice(0, width)
}

/** Render one aligned table row. */
function formatTableRow(cells: readonly string[], widths: readonly number[]): string {
  return `| ${cells.map((cell, index) => padCell(cell, widths[index] ?? 0)).join(' | ')} |`
}

/** Render one mdast table: bold header, dim separator, aligned data rows. */
function renderTable(table: Table, key: string, out: React.ReactNode[]): void {
  const cellText = (cell: TableCell): string => cell.children
    .map(child => (child.type === 'text' || child.type === 'inlineCode' ? child.value : ''))
    .join('')
  const rows = table.children.map(row => row.children.map(cellText))
  const header = rows[0] ?? []
  const widths = header.map((_, col) => Math.max(...rows.map(row => displayWidth(row[col] ?? ''))))
  out.push(<Text key={`${key}:h`} bold>{formatTableRow(header, widths)}</Text>)
  out.push(<Text key={`${key}:s`} dimColor>{formatTableRow(header.map(() => ''), widths).replaceAll(' ', '─')}</Text>)
  for (const [index, row] of rows.slice(1).entries()) {
    out.push(<Text key={`${key}:${index}`}>{formatTableRow(row, widths)}</Text>)
  }
}

/** Render one fenced code block: shiki tokens when the tag is registered. */
function renderCodeBlock(code: string, langTag: string, key: string): React.JSX.Element {
  const tokensByLine = codeTokens(code, langTag)
  return (
    <React.Fragment key={key}>
      {code.replace(/\n$/u, '').split('\n').map((line, lineIndex) => {
        const tokens = tokensByLine?.[lineIndex]
        return (
          <Text key={lineIndex} dimColor>
            {tokens === undefined
              ? line
              : tokens.map((token, tokenIndex) => (
                <Text key={tokenIndex} {...token.color === undefined ? {} : { color: token.color }}>{token.content}</Text>
              ))}
          </Text>
        )
      })}
    </React.Fragment>
  )
}

/** Render one mdast list (nested lists keep their indent). */
function renderList(list: List, key: string, depth: number, out: React.ReactNode[]): void {
  const indent = '  '.repeat(depth)
  let number = list.start ?? 1
  for (const [index, item] of list.children.entries()) {
    for (const child of item.children) {
      if (child.type === 'paragraph') {
        const marker = list.ordered === true ? `${indent}${number}. ` : `${indent}• `
        out.push(<Text key={`${key}:${index}`}>{marker}{renderInline(child.children, `${key}:${index}`)}</Text>)
        number += 1
      } else if (child.type === 'list') {
        renderList(child, `${key}:${index}`, depth + 1, out)
      }
    }
  }
}

/** Render inline phrasing nodes as nested Ink text styles. */
function renderInline(nodes: readonly PhrasingContent[], keyPrefix: string): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}:${index}`
    switch (node.type) {
      case 'text': return node.value
      case 'strong': return <Text key={key} bold>{renderInline(node.children, key)}</Text>
      case 'emphasis': return <Text key={key} italic>{renderInline(node.children, key)}</Text>
      case 'inlineCode': return <Text key={key} dimColor>{node.value}</Text>
      case 'delete': return <Text key={key} strikethrough>{renderInline(node.children, key)}</Text>
      case 'link': return <React.Fragment key={key}>{renderInline(node.children, key)}</React.Fragment>
      case 'image': return <Text key={key} dimColor>{node.alt !== '' ? node.alt : '[image]'}</Text>
      case 'break': return '\n'
      default: return null
    }
  })
}

/** Render block nodes into a flat Ink node list. */
function renderBlocks(nodes: readonly RootContent[], keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  for (const [index, node] of nodes.entries()) {
    const key = `${keyPrefix}:${index}`
    switch (node.type) {
      case 'heading':
        out.push(<Text key={key} bold>{renderInline(node.children, key)}</Text>)
        break
      case 'paragraph':
        out.push(<Text key={key}>{renderInline(node.children, key)}</Text>)
        break
      case 'list':
        renderList(node, key, 0, out)
        break
      case 'blockquote':
        for (const [partIndex, child] of node.children.entries()) {
          if (child.type === 'paragraph') {
            out.push(<Text key={`${key}:${partIndex}`} dimColor>{'│ '}{renderInline(child.children, `${key}:${partIndex}`)}</Text>)
          }
        }
        break
      case 'code':
        out.push(renderCodeBlock(node.value, node.lang ?? '', key))
        break
      case 'table':
        renderTable(node, key, out)
        break
      case 'thematicBreak':
        out.push(<Text key={key} dimColor>{'─'.repeat(40)}</Text>)
        break
      default:
        break // html and other constructs do not render in the terminal.
    }
  }
  return out
}

/** Render assistant markdown as Ink nodes. */
export function MarkdownText({ text }: { text: string }): React.JSX.Element {
  return <React.Fragment>{renderBlocks(parseMarkdown(text).children, 'md')}</React.Fragment>
}
