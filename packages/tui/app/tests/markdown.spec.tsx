/** Markdown module: GFM parsing through mdast, rendered into Ink. */

import { describe, expect, it } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { MarkdownText } from '../src/ui/Markdown.tsx'

describe('MarkdownText', () => {
  it('renders headings and lists without the markdown markers', () => {
    const { lastFrame } = render(<MarkdownText text={'# Title\n\n- one\n- two\n\nplain'} />)
    const frame = lastFrame()
    expect(frame).toContain('Title')
    expect(frame).not.toContain('# Title')
    expect(frame).toContain('• one')
    expect(frame).toContain('• two')
    expect(frame).toContain('plain')
  })

  it('renders quotes with a bar prefix', () => {
    const { lastFrame } = render(<MarkdownText text={'> quoted'} />)
    expect(lastFrame()).toContain('│ quoted')
  })

  it('renders a table with an aligned header, separator, and rows', () => {
    const { lastFrame } = render(<MarkdownText text={'| a | bb |\n| --- | --- |\n| x | y |'} />)
    const frame = lastFrame()
    expect(frame).toContain('| a | bb |')
    expect(frame).toContain('| x | y  |')
    expect(frame).not.toContain('---')
  })

  it('renders fenced code without fence lines and keeps code content', () => {
    const { lastFrame } = render(<MarkdownText text={'before\n```bash\necho hi\n```\nafter'} />)
    const frame = lastFrame()
    expect(frame).toContain('echo hi')
    expect(frame).toContain('before')
    expect(frame).toContain('after')
    expect(frame).not.toContain('```')
  })

  it('renders inline styles, links, and strikethrough without markers', () => {
    const { lastFrame } = render(<MarkdownText text={'**bold** *em* `code` [link](https://x) ~~gone~~'} />)
    const frame = lastFrame()
    expect(frame).toContain('bold')
    expect(frame).toContain('em')
    expect(frame).toContain('code')
    expect(frame).toContain('link')
    expect(frame).not.toContain('https://x')
    expect(frame).toContain('gone')
    expect(frame).not.toContain('**')
    expect(frame).not.toContain('~~')
  })

  it('renders ordered lists and thematic breaks', () => {
    const { lastFrame } = render(<MarkdownText text={'1. first\n2. second\n\n---\n\nafter'} />)
    const frame = lastFrame()
    expect(frame).toContain('1. first')
    expect(frame).toContain('2. second')
    expect(frame).toContain('after')
    expect(frame).not.toContain('---')
  })
})
