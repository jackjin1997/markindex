import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMarkdown, type ParsedDoc } from '../../src/parse/markdown.js'
import { approxTokens } from '../../src/text/tokens.js'
import { assertCoverage, buildTree, walk } from '../../src/tree/build.js'
import { optimizeTree } from '../../src/tree/optimize.js'
import type { TreeNode } from '../../src/types.js'

const FIX = join(import.meta.dirname, '../fixtures/md')
const prepare = (src: string, fileTitle = 'doc') => {
  const doc = parseMarkdown(src)
  return { doc, roots: buildTree(doc, { fileTitle }) }
}
/** `n` approx tokens of ASCII prose (4 chars per token). */
const words = (n: number, seed = 'lorem') => `${seed} `.repeat(Math.ceil((n * 4) / (seed.length + 1))).slice(0, n * 4).trim()
const text = (doc: ParsedDoc, from: number, to: number) => doc.lines.slice(from - 1, to).join('\n')

/** Every node's token fields match its line ranges. */
function assertTokens(doc: ParsedDoc, roots: TreeNode[]): void {
  for (const { node } of walk(roots)) {
    expect(node.ownTokens).toBe(approxTokens(text(doc, node.startLine, node.ownEndLine)))
    expect(node.tokens).toBe(approxTokens(text(doc, node.startLine, node.endLine)))
  }
}

describe('optimizeTree', () => {
  it('merges tiny subtree into parent', () => {
    const src = `# P\n\n${words(50)}\n\n## C1\n\n${words(20)}\n\n## C2\n\n${words(20)}\n`
    const { doc, roots } = prepare(src)
    const out = optimizeTree(roots, doc, { routingCost: 150 })
    expect(out).toHaveLength(1)
    const p = out[0]!
    expect(p.children).toEqual([])
    expect(p.keyItems).toEqual(['C1', 'C2'])
    expect(p.ownEndLine).toBe(p.endLine)
    expect(p.nodeId).toBe(roots[0]!.nodeId)
    assertCoverage(doc, out)
    assertTokens(doc, out)
  })

  it('merged descendants keep pre-order titles including nested ones', () => {
    const src = `# P\nx\n## A\na\n### A1\na1\n## B\nb\n`
    const { doc, roots } = prepare(src)
    const out = optimizeTree(roots, doc)
    expect(out[0]!.keyItems).toEqual(['A', 'A1', 'B'])
    assertCoverage(doc, out)
  })

  it('keeps large children', () => {
    const src = `# P\n\nshort intro\n\n## C1\n\n${words(5000)}\n\n## C2\n\n${words(5000)}\n`
    const { doc, roots } = prepare(src)
    const out = optimizeTree(roots, doc)
    expect(out[0]!.children.map((c) => c.title)).toEqual(['C1', 'C2'])
    expect(out[0]!.keyItems).toBeUndefined()
    expect(out[0]!.children.map((c) => c.nodeId)).toEqual(roots[0]!.children.map((c) => c.nodeId))
    assertCoverage(doc, out)
  })

  it('merges small siblings while keeping large ones (bottom-up per subtree)', () => {
    const src = `# P\nintro\n## Big\n${words(5000)}\n## Small\ns\n### Tiny\nt\n## Big2\n${words(5000)}\n`
    const { doc, roots } = prepare(src)
    const out = optimizeTree(roots, doc)
    const [big, small, big2] = out[0]!.children
    expect([big!.title, big2!.title]).toEqual(['Big', 'Big2'])
    expect(small).toMatchObject({ title: 'Small', keyItems: ['Tiny'], children: [] })
    assertCoverage(doc, out)
    assertTokens(doc, out)
  })

  it('keeps children when S <= maxNodeTokens but S > tree_cost (cost clause alone)', () => {
    const src = `# P\n\nshort intro\n\n## C1\n\n${words(3000)}\n\n## C2\n\n${words(3000)}\n`
    const { doc, roots } = prepare(src)
    const s = roots[0]!.tokens
    expect(s).toBeLessThanOrEqual(8000)
    expect(s).toBeGreaterThan(150 + 3000)
    const out = optimizeTree(roots, doc)
    expect(out[0]!.children.map((c) => c.title)).toEqual(['C1', 'C2'])
    expect(out[0]!.keyItems).toBeUndefined()
    assertCoverage(doc, out)
  })

  it('never merges into a node larger than maxNodeTokens', () => {
    // S = ~8050 <= tree_cost = 150 + 8000, but merging would create an oversized node.
    const src = `# P\n${words(40)}\n## C\n${words(7990)}\n`
    const { doc, roots } = prepare(src)
    const out = optimizeTree(roots, doc)
    expect(out[0]!.children.map((c) => c.title)).toEqual(['C'])
  })

  it('expands a 100k-token headless section into chunks', () => {
    const paras = Array.from({ length: 1000 }, (_, i) => `Paragraph ${i} ${words(100)}`)
    const { doc, roots } = prepare(paras.join('\n\n') + '\n', 'big')
    expect(roots[0]!.tokens).toBeGreaterThan(100_000)
    const out = optimizeTree(roots, doc)
    const root = out[0]!
    expect(root.children.length).toBeGreaterThan(12)
    expect(root.ownTokens).toBeLessThanOrEqual(8000)
    root.children.forEach((c, i) => {
      expect(c.kind).toBe('chunk')
      expect(c.tokens).toBeLessThanOrEqual(8000)
      expect(c.nodeId).toBe(`${root.nodeId}-c${i + 1}`)
      expect(c.level).toBe(root.level + 1)
      expect(c.title).toMatch(/^Paragraph \d+ lorem/)
      expect([...c.title].length).toBeLessThanOrEqual(60)
    })
    expect(root.tokens).toBe(roots[0]!.tokens)
    assertCoverage(doc, out)
    assertTokens(doc, out)
  })

  it('chunk boundaries fall on block starts', () => {
    const paras = Array.from({ length: 40 }, (_, i) => `- item ${i}\n- more ${words(30)}`)
    const { doc, roots } = prepare(`# L\n\n${paras.join('\n\nPara.\n\n')}\n`)
    const out = optimizeTree(roots, doc, { maxNodeTokens: 200 })
    const starts = new Set(doc.blocks.map((b) => b.startLine))
    expect(out[0]!.children.length).toBeGreaterThan(1)
    for (const c of out[0]!.children) expect(starts.has(c.startLine)).toBe(true)
    assertCoverage(doc, out)
  })

  it('never splits inside a fenced code block', () => {
    const code = (i: number) => ['```ts', ...Array.from({ length: 8 }, (_, j) => `const v${i}_${j} = ${j} // ${words(3)}`), '```'].join('\n')
    const parts = Array.from({ length: 12 }, (_, i) => `${words(40)}\n\n${code(i)}`)
    const { doc, roots } = prepare(`# Code\n\n${parts.join('\n\n')}\n`)
    const out = optimizeTree(roots, doc, { maxNodeTokens: 120 })
    const fences = doc.blocks.filter((b) => b.type === 'code')
    expect(fences.length).toBe(12)
    const chunks = out[0]!.children
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) {
      for (const f of fences) expect(c.startLine > f.startLine && c.startLine <= f.endLine).toBe(false)
      expect(c.tokens).toBeLessThanOrEqual(120)
    }
    assertCoverage(doc, out)
  })

  it('does not split inside a fence nested in an oversized list', () => {
    const fence = ['   ```', ...Array.from({ length: 6 }, (_, j) => `   line ${j} ${words(4)}`), '   ```'].join('\n')
    const items = Array.from({ length: 10 }, (_, i) => `1. step ${i} ${words(40)}\n\n${fence}`).join('\n\n')
    const { doc, roots } = prepare(`# Steps\n\n${items}\n`)
    expect(doc.blocks).toHaveLength(1) // one top-level list, larger than the limit
    const out = optimizeTree(roots, doc, { maxNodeTokens: 50 })
    // lines after an opening fence up to and including its closing fence
    const inside = new Set<number>()
    let open = false
    doc.lines.forEach((l, i) => {
      const isFence = /^\s*```/.test(l)
      if (open) inside.add(i + 1)
      if (isFence) open = !open
    })
    const chunks = out[0]!.children
    expect(chunks.length).toBeGreaterThan(2)
    for (const c of chunks) expect(inside.has(c.startLine)).toBe(false)
    assertCoverage(doc, out)
  })

  it('splits a single code block by lines only when it alone exceeds the limit', () => {
    const big = ['```', ...Array.from({ length: 200 }, (_, j) => `x${j} = ${words(5)}`), '```'].join('\n')
    const { doc, roots } = prepare(`# Huge\n\n${big}\n`)
    const out = optimizeTree(roots, doc, { maxNodeTokens: 100 })
    expect(out[0]!.children.length).toBeGreaterThan(5)
    for (const c of out[0]!.children) expect(c.tokens).toBeLessThanOrEqual(100)
    assertCoverage(doc, out)
    assertTokens(doc, out)
  })

  it('expands the oversized own text of a non-leaf before its existing children', () => {
    const intro = Array.from({ length: 50 }, (_, i) => `Intro ${i} ${words(60)}`).join('\n\n')
    const src = `# Guide\n\n${intro}\n\n## Setup\n\n${words(3000)}\n\n## Usage\n\n${words(3000)}\n`
    const { doc, roots } = prepare(src)
    const out = optimizeTree(roots, doc, { maxNodeTokens: 1000 })
    const g = out[0]!
    expect(g.ownTokens).toBeLessThanOrEqual(1000)
    const kinds = g.children.map((c) => c.kind)
    const firstSection = kinds.indexOf('section')
    expect(firstSection).toBeGreaterThan(1)
    expect(kinds.slice(0, firstSection).every((k) => k === 'chunk')).toBe(true)
    const sections = g.children.slice(firstSection)
    expect(sections.map((c) => [c.title, c.nodeId])).toEqual(roots[0]!.children.map((c) => [c.title, c.nodeId]))
    // the sections themselves were leaves above the limit and got chunked too
    expect(sections.every((s) => s.children.length > 0 && s.children.every((c) => c.kind === 'chunk'))).toBe(true)
    g.children.slice(0, firstSection).forEach((c, i) => expect(c.nodeId).toBe(`${g.nodeId}-c${i + 1}`))
    assertCoverage(doc, out)
    assertTokens(doc, out)
  })

  it('chunk titles strip markdown and truncate to 60 chars', () => {
    const paras = Array.from({ length: 6 }, (_, i) => `> **Note ${i}**: see [the docs](http://x.y) and \`code\` ${words(60)}`)
    const { doc, roots } = prepare(`# T\n\n${paras.join('\n\n')}\n`)
    const out = optimizeTree(roots, doc, { maxNodeTokens: 100 })
    const c = out[0]!.children[0]!
    expect(c.title.startsWith('Note 1: see the docs and code lorem')).toBe(true)
    expect([...c.title].length).toBeLessThanOrEqual(60)
  })

  it('does not mutate its input', () => {
    const src = `# P\nx\n## A\na\n\n${Array.from({ length: 30 }, () => words(40)).join('\n\n')}\n`
    const { doc, roots } = prepare(src)
    const before = structuredClone(roots)
    optimizeTree(roots, doc, { maxNodeTokens: 100 })
    expect(roots).toEqual(before)
  })

  it('deterministic', () => {
    const src = readFileSync(join(FIX, 'en-guide.md'), 'utf8') + `\n${Array.from({ length: 50 }, () => words(50)).join('\n\n')}\n`
    const { doc, roots } = prepare(src)
    const a = JSON.stringify(optimizeTree(roots, doc, { maxNodeTokens: 300 }))
    const b = JSON.stringify(optimizeTree(prepare(src).roots, parseMarkdown(src), { maxNodeTokens: 300 }))
    expect(a).toBe(b)
  })

  it('coverage holds and retained node ids are unchanged on all fixtures', () => {
    const files = readdirSync(FIX).filter((f) => f.endsWith('.md'))
    for (const f of files) {
      for (const opts of [{}, { maxNodeTokens: 10, routingCost: 2 }, { maxNodeTokens: 3, routingCost: 0 }]) {
        const { doc, roots } = prepare(readFileSync(join(FIX, f), 'utf8'), f)
        const out = optimizeTree(roots, doc, opts)
        expect(() => assertCoverage(doc, out), `${f} ${JSON.stringify(opts)}`).not.toThrow()
        assertTokens(doc, out)
        const original = new Map([...walk(roots)].map(({ node }) => [node.nodeId, node.title]))
        for (const { node } of walk(out)) {
          if (node.kind === 'chunk') expect(node.nodeId).toMatch(/-c\d+$/)
          else expect(original.get(node.nodeId)).toBe(node.title)
        }
      }
    }
  })
})
