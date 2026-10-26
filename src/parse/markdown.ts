import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { frontmatter } from 'micromark-extension-frontmatter'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import { toString } from 'mdast-util-to-string'
import { parse as parseYaml } from 'yaml'
import { MAX_TITLE_CHARS } from '../config.js'

export interface Heading {
  /** plain heading text, capped at MAX_TITLE_CHARS code points */
  title: string
  level: number
  /** 1-based, original file line */
  line: number
  /** last line of the heading (setext headings span two lines) */
  endLine: number
}

export interface Block {
  type: string
  startLine: number
  endLine: number
}

export interface ParsedDoc {
  /** BOM stripped, split on \r\n, \r or \n (the same line endings mdast counts) */
  lines: string[]
  frontmatter?: { startLine: number; endLine: number; data: Record<string, unknown> }
  /** direct children of the mdast root only */
  headings: Heading[]
  /** top-level non-heading, non-frontmatter nodes */
  blocks: Block[]
  /** first line after frontmatter (1 when there is none) */
  firstContentLine: number
}

const FM: ('yaml' | 'toml')[] = ['yaml', 'toml']

export interface ParseOptions {
  /**
   * Recognize setext headings (`Title` underlined with `===` / `---`), as CommonMark does. Default true.
   * Set false for converter output (PDF/HTML → Markdown) that marks page breaks with a bare `---` line right after
   * a paragraph: `---` then parses as a thematic break and `===` lines as paragraph text.
   */
  setext?: boolean
}

const NO_SETEXT = { disable: { null: ['setextUnderline'] } }

export function parseMarkdown(src: string, opts: ParseOptions = {}): ParsedDoc {
  const text = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src
  const lines = text.split(/\r\n|\r|\n/)
  const root = fromMarkdown(text, {
    extensions: opts.setext === false ? [gfm(), frontmatter(FM), NO_SETEXT] : [gfm(), frontmatter(FM)],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(FM)],
  })

  const doc: ParsedDoc = { lines, headings: [], blocks: [], firstContentLine: 1 }
  for (const node of root.children) {
    const pos = node.position
    if (!pos) continue
    const startLine = pos.start.line
    const endLine = pos.end.line
    const type: string = node.type // 'toml' is absent from mdast's static types
    if (type === 'yaml' || type === 'toml') {
      if (!doc.frontmatter) {
        const value = (node as { value: string }).value
        doc.frontmatter = { startLine, endLine, data: parseFrontmatter(type, value) }
        doc.firstContentLine = endLine + 1
      }
    } else if (node.type === 'heading') {
      doc.headings.push({ title: capTitle(toString(node).trim()), level: node.depth, line: startLine, endLine })
    } else {
      doc.blocks.push({ type: node.type, startLine, endLine })
    }
  }
  return doc
}

function capTitle(title: string): string {
  const cps = Array.from(title)
  return cps.length <= MAX_TITLE_CHARS ? title : cps.slice(0, MAX_TITLE_CHARS - 1).join('') + '…'
}

function parseFrontmatter(kind: 'yaml' | 'toml', value: string): Record<string, unknown> {
  if (kind === 'toml') return { raw: value }
  try {
    const data: unknown = parseYaml(value)
    return data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
