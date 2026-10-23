import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../../src/parse/markdown.js'
import { assertCoverage, buildTree, walk } from '../../src/tree/build.js'

const FIX = join(import.meta.dirname, '../fixtures/md')
const build = (src: string, fileTitle = 'doc') => {
  const doc = parseMarkdown(src)
  return { doc, roots: buildTree(doc, { fileTitle }) }
}
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8')

describe('buildTree', () => {
  it('preface node for text before first heading', () => {
    const { roots } = build('Intro text\n\n# A\n\nbody\n')
    expect(roots.map((n) => [n.kind, n.title, n.startLine, n.endLine])).toEqual([
      ['preface', 'Preface', 1, 2],
      ['section', 'A', 3, 6],
    ])
  })

  it('blank-only lines before first heading do not create a preface', () => {
    const { doc, roots } = build('\n\n# A\n\nbody\n')
    expect(roots).toHaveLength(1)
    expect(roots[0]).toMatchObject({ kind: 'section', startLine: 1 })
    assertCoverage(doc, roots)
  })

  it('headless doc becomes one root titled by file', () => {
    const { doc, roots } = build('just text', 'notes')
    expect(roots).toHaveLength(1)
    expect(roots[0]).toMatchObject({ title: 'notes', kind: 'section', level: 0, startLine: 1, endLine: 1, ownEndLine: 1 })
    assertCoverage(doc, roots)
  })

  it('frontmatter-only doc yields no nodes, empty doc yields one empty root', () => {
    const fm = build('---\ntitle: x\n---', 'm')
    expect(fm.roots).toEqual([])
    assertCoverage(fm.doc, fm.roots)
    const empty = build('', 'e')
    expect(empty.roots).toHaveLength(1)
    assertCoverage(empty.doc, empty.roots)
  })

  it('skipped levels attach to nearest shallower', () => {
    const { doc, roots } = build('# A\n### C\n## B\n')
    expect(roots).toHaveLength(1)
    expect(roots[0]!.children.map((c) => c.title)).toEqual(['C', 'B'])
    assertCoverage(doc, roots)
  })

  it('endLine covers subtree, ownEndLine stops before first child', () => {
    const { roots } = build('# A\nintro\n## B\nb\n### C\nc\n## D\nd\n# E\ne')
    const a = roots[0]!
    expect(a).toMatchObject({ startLine: 1, ownEndLine: 2, endLine: 8 })
    const [b, d] = a.children
    expect(b).toMatchObject({ startLine: 3, ownEndLine: 4, endLine: 6 })
    expect(b!.children[0]).toMatchObject({ startLine: 5, ownEndLine: 6, endLine: 6 })
    expect(d).toMatchObject({ startLine: 7, ownEndLine: 8, endLine: 8 })
    expect(roots[1]).toMatchObject({ startLine: 9, endLine: 10 })
  })

  it('uses original file line numbers with frontmatter', () => {
    const { doc, roots } = build('---\na: 1\n---\n# A\nx\n')
    expect(roots[0]!.startLine).toBe(4)
    assertCoverage(doc, roots)
  })

  it('computes tokens with the injected counter over own / subtree text', () => {
    const doc = parseMarkdown('# A\nxx\n## B\nyyyy')
    const roots = buildTree(doc, { fileTitle: 'd', countTokens: (t) => t.length })
    expect(roots[0]!.ownTokens).toBe('# A\nxx'.length)
    expect(roots[0]!.tokens).toBe('# A\nxx\n## B\nyyyy'.length)
    expect(roots[0]!.children[0]!.tokens).toBe(roots[0]!.children[0]!.ownTokens)
  })

  it('coverage invariant holds on all fixtures', () => {
    const files = readdirSync(FIX).filter((f) => f.endsWith('.md'))
    expect(files.length).toBeGreaterThanOrEqual(6)
    for (const f of files) {
      const doc = parseMarkdown(fixture(f))
      expect(() => assertCoverage(doc, buildTree(doc, { fileTitle: f }))).not.toThrow()
    }
  })

  it('assertCoverage detects gaps and overlaps', () => {
    const { doc, roots } = build('# A\nx\n## B\ny\n')
    roots[0]!.children[0]!.startLine += 1
    expect(() => assertCoverage(doc, roots)).toThrow(/coverage/)
  })

  it('fixtures: code-block hashes are not headings, duplicate titles kept', () => {
    const { roots } = build(fixture('en-guide.md'), 'g')
    const titles = [...walk(roots)].map((x) => x.titlePath.join('/'))
    expect(titles).toContain('Acme SDK/Install')
    expect(titles.filter((t) => t === 'Acme SDK/Notes')).toHaveLength(2)
    expect(titles.some((t) => t.includes('shell comment'))).toBe(false)
    expect(roots[0]!.kind).toBe('preface')
  })

  it('node ids stable under unrelated edits; same-title siblings differ', () => {
    const base = fixture('en-guide.md')
    const ids = (src: string) => new Map([...walk(build(src).roots)].map((x) => [x.titlePath.join('/') + '#' + x.node.startLine, x.node.nodeId]))
    const before = [...walk(build(base).roots)]
    const after = [...walk(build(base + '\n## Appendix\n\nmore\n').roots)]
    for (const b of before) expect(after.find((a) => a.node.nodeId === b.node.nodeId)?.titlePath).toEqual(b.titlePath)
    const notes = before.filter((x) => x.node.title === 'Notes').map((x) => x.node.nodeId)
    expect(notes).toHaveLength(2)
    expect(notes[0]).not.toBe(notes[1])
    const all = before.map((x) => x.node.nodeId)
    expect(new Set(all).size).toBe(all.length)
    expect(ids(base).size).toBeGreaterThan(0)
  })

  it('node ids survive edits to body text and earlier sibling insertion of different title', () => {
    const a = [...walk(build('# A\n## X\nx\n').roots)].find((n) => n.node.title === 'X')!
    const b = [...walk(build('# A\nnew body\n## Y\n## X\nx edited\n').roots)].find((n) => n.node.title === 'X')!
    expect(b.node.nodeId).toBe(a.node.nodeId)
  })

  it('deterministic', () => {
    const src = fixture('mixed-setext.md')
    expect(JSON.stringify(build(src).roots)).toBe(JSON.stringify(build(src).roots))
  })

  it('handles CRLF fixture', () => {
    const { doc, roots } = build(fixture('crlf.md'))
    expect(roots[0]!.children[0]!.title).toBe('Sub')
    assertCoverage(doc, roots)
  })
})
