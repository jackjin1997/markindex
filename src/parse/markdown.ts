import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { frontmatter } from 'micromark-extension-frontmatter'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import { toString } from 'mdast-util-to-string'
import { parse as parseYaml } from 'yaml'

export interface Heading {
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
  /** BOM stripped, split on /\r?\n/ */
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

export function parseMarkdown(src: string): ParsedDoc {
  const text = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src
  const lines = text.split(/\r?\n/)
  const root = fromMarkdown(text, {
    extensions: [gfm(), frontmatter(FM)],
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
      doc.headings.push({ title: toString(node).trim(), level: node.depth, line: startLine, endLine })
    } else {
      doc.blocks.push({ type: node.type, startLine, endLine })
    }
  }
  return doc
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
