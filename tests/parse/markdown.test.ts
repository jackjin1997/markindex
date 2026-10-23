import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../../src/parse/markdown.js'

const titles = (src: string) => parseMarkdown(src).headings.map((h) => [h.level, h.title, h.line])

describe('parseMarkdown', () => {
  it('atx headings levels 1-6', () => {
    const src = ['# a', '## b', '### c', '#### d', '##### e', '###### f', '####### g'].join('\n')
    expect(titles(src)).toEqual([
      [1, 'a', 1], [2, 'b', 2], [3, 'c', 3], [4, 'd', 4], [5, 'e', 5], [6, 'f', 6],
    ])
  })

  it('setext headings', () => {
    const doc = parseMarkdown('Acme SDK\n========\n\nintro\n\n## Install\n')
    expect(doc.headings).toEqual([
      { title: 'Acme SDK', level: 1, line: 1, endLine: 2 },
      { title: 'Install', level: 2, line: 6, endLine: 6 },
    ])
    expect(parseMarkdown('Sub\n---\n').headings[0]).toMatchObject({ level: 2, line: 1, endLine: 2 })
  })

  it('ignores # inside fenced (``` and ~~~), indented code, blockquote, list, html', () => {
    const src = [
      '```', '# in backtick fence', '```',
      '~~~', '# in tilde fence', '~~~',
      '', '    # indented code', '',
      '> # in quote', '',
      '- # in list', '',
      '<div>', '# in html', '</div>', '',
      '# Real',
    ].join('\n')
    const doc = parseMarkdown(src)
    expect(doc.headings.map((h) => h.title)).toEqual(['Real'])
    expect(doc.headings[0]?.line).toBe(18)
  })

  it('yaml frontmatter parsed, not a heading', () => {
    const doc = parseMarkdown('---\ntitle: T\n---\n# A\n')
    expect(doc.frontmatter?.data.title).toBe('T')
    expect(doc.frontmatter?.startLine).toBe(1)
    expect(doc.frontmatter?.endLine).toBe(3)
    expect(doc.headings).toHaveLength(1)
    expect(doc.headings[0]?.line).toBe(4)
    expect(doc.firstContentLine).toBe(4)
  })

  it('toml frontmatter (+++)', () => {
    const doc = parseMarkdown('+++\ntitle = "T"\n+++\n# A\n')
    expect(doc.frontmatter?.endLine).toBe(3)
    expect(typeof doc.frontmatter?.data).toBe('object')
    expect(doc.headings[0]?.line).toBe(4)
  })

  it('invalid yaml frontmatter does not throw', () => {
    const doc = parseMarkdown('---\na: [unclosed\n---\n# A\n')
    expect(doc.frontmatter?.data).toBeTypeOf('object')
    expect(doc.headings[0]?.line).toBe(4)
  })

  it('no frontmatter: firstContentLine is 1', () => {
    expect(parseMarkdown('# A').firstContentLine).toBe(1)
    expect(parseMarkdown('').headings).toEqual([])
  })

  it('heading text strips inline formatting and closing #', () => {
    expect(parseMarkdown('## **Bold** [link](x) ##').headings[0]?.title).toBe('Bold link')
  })

  it('bold-only line is not a heading', () => {
    expect(parseMarkdown('**Not a heading**\n\ntext').headings).toEqual([])
  })

  it('handles BOM and CRLF line numbers', () => {
    const doc = parseMarkdown('﻿# A\r\nx\r\n# B')
    expect(doc.headings.map((h) => [h.title, h.line])).toEqual([['A', 1], ['B', 3]])
    expect(doc.lines).toEqual(['# A', 'x', '# B'])
  })

  it('lone CR and CR CR LF are line endings, matching mdast line numbers', () => {
    const crcrlf = parseMarkdown('para one\r\r\n# A\r\r\nbody of A\r\r\n# B\r\r\nbody of B')
    expect(crcrlf.headings.map((h) => [h.title, h.line])).toEqual([['A', 3], ['B', 7]])
    expect(crcrlf.lines[2]).toBe('# A')
    expect(crcrlf.lines[6]).toBe('# B')
    expect(crcrlf.lines).toHaveLength(9)
    const cr = parseMarkdown('# A\rx\r# B\ry')
    expect(cr.headings.map((h) => [h.title, h.line])).toEqual([['A', 1], ['B', 3]])
    expect(cr.lines).toEqual(['# A', 'x', '# B', 'y'])
  })

  it('exposes top-level non-heading blocks with line ranges', () => {
    const src = ['---', 'a: 1', '---', '# H', '', 'para', '', '```js', 'x', '```', '', '| a | b |', '| - | - |', '| 1 | 2 |'].join('\n')
    expect(parseMarkdown(src).blocks).toEqual([
      { type: 'paragraph', startLine: 6, endLine: 6 },
      { type: 'code', startLine: 8, endLine: 10 },
      { type: 'table', startLine: 12, endLine: 14 },
    ])
  })
})
