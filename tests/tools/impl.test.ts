import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RESPONSE_CHAR_BUDGET } from '../../src/config.js'
import { indexLibrary } from '../../src/library/indexer.js'
import { openLibrary, type Library } from '../../src/library.js'
import { openStore } from '../../src/store/db.js'
import type { ToolName } from '../../src/tools/contract.js'
import type { DocumentRecord, TreeNode } from '../../src/types.js'

let root: string
let dbFile: string
let lib: Library | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'markindex-tools-'))
  dbFile = join(root, '.markindex', 'index.db')
})
afterEach(() => {
  lib?.close()
  lib = undefined
  rmSync(root, { recursive: true, force: true })
})

const PAD = 'filler '.repeat(300).trim()

function put(rel: string, content: string) {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

async function index(files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) put(rel, content)
  const store = openStore(dbFile)
  try {
    await indexLibrary({ root, store })
  } finally {
    store.close()
  }
}

/** Opens the library read-only (the default) once the index exists. */
async function library(files: Record<string, string>): Promise<Library> {
  await index(files)
  lib = openLibrary({ root })
  return lib
}

type Json = any
async function call(name: string, args: unknown): Promise<Json> {
  const out = await lib!.callTool(name as ToolName, args)
  expect(typeof out).toBe('string')
  expect(out.length).toBeLessThanOrEqual(RESPONSE_CHAR_BUDGET)
  return JSON.parse(out)
}

/** Writes a synthetic document straight into the store (bypasses parsing/optimization). */
function putSynthetic(path: string, tree: TreeNode[], lines: string[]) {
  const store = openStore(dbFile)
  const doc: DocumentRecord = {
    docId: '',
    path,
    title: path,
    metadata: {},
    contentHash: 'h',
    lineCount: lines.length,
    tokens: lines.length,
    indexedAt: '2026-10-23T00:00:00.000Z',
  }
  store.replaceDoc(doc, tree, lines)
  store.close()
}

function node(nodeId: string, title: string, start: number, end: number, children: TreeNode[] = []): TreeNode {
  return {
    nodeId,
    title,
    kind: 'section',
    level: 1,
    startLine: start,
    endLine: end,
    // own text = first line only: keeps the FTS body tiny (these tests exercise paging, not indexing)
    ownEndLine: start,
    tokens: end - start + 1,
    ownTokens: 1,
    children,
  }
}

const GUIDE = [
  '# Guide',
  '',
  'Intro.',
  '',
  '## Alpha',
  '',
  'Alpha body.',
  '',
  PAD,
  '',
  '### Alpha One',
  '',
  PAD,
  '',
  '### Alpha Two',
  '',
  PAD,
  '',
  '## Beta',
  '',
  'Beta body about ISO-27001.',
  '',
  PAD,
  '',
].join('\n')

const TOOLS: ToolName[] = [
  'browse_documents',
  'get_document',
  'get_document_structure',
  'get_node_content',
  'search_documents',
]

interface SNode {
  node_id: string
  title: string
  child_count?: number
  nodes?: SNode[]
}

describe('tools', () => {
  it('never throws', async () => {
    await library({ 'guide.md': GUIDE })
    const bad: unknown[] = [
      null,
      {},
      42,
      'x',
      [],
      { doc_path: 7 },
      { folder: 3, offset: -1, limit: 500 },
      { doc_path: 'guide.md', node_ids: 'abc' },
      { doc_path: 'guide.md', node_ids: [] },
      { doc_path: 'guide.md', depth: 0, part: 0 },
      { query: '' },
      { query: 5 },
    ]
    for (const tool of TOOLS) {
      for (const args of bad) {
        const env = await call(tool, args)
        if (tool === 'browse_documents' && JSON.stringify(args) === '{}') {
          expect(env.success).toBe(true)
          continue
        }
        expect(env.success, `${tool} ${JSON.stringify(args)}`).toBe(false)
        expect(['INVALID_INPUT', 'NOT_FOUND']).toContain(env.code)
        expect(env.next_steps.options.length).toBeGreaterThan(0)
      }
    }
    const unknown = await call('delete_everything', {})
    expect(unknown).toMatchObject({ success: false, code: 'INVALID_INPUT' })
    expect(unknown.next_steps.options.join(' ')).toContain('browse_documents')

    lib!.close()
    const closed = await call('get_document', { doc_path: 'guide.md' })
    expect(closed).toMatchObject({ success: false, code: 'INTERNAL_ERROR' })
  })

  it('suggests similar doc names', async () => {
    await library({
      'report.md': '# Report\n',
      'reports/annual.md': '# Annual\n',
      'zzz/unrelated-notes.md': '# Z\n',
      'reporting.md': '# R\n',
      'repo.md': '# Repo\n',
      'xyz.md': '# X\n',
    })
    const env = await call('get_document', { doc_path: 'reprot.md' })
    expect(env).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(env.details.similar_paths[0]).toBe('report.md')
    expect(env.details.similar_paths.length).toBeLessThanOrEqual(3)
    expect(env.details.similar_paths).not.toContain('zzz/unrelated-notes.md')
    expect(env.next_steps.options.some((o: string) => o.includes('"report.md"'))).toBe(true)

    // basename match for a doc in a subfolder
    const env2 = await call('get_document_structure', { doc_path: 'annual.md' })
    expect(env2.details.similar_paths).toContain('reports/annual.md')
  })

  it('get_document reports size and read_structure_first', async () => {
    await library({ 'guide.md': GUIDE, 'small.md': '---\ntitle: Small One\n---\n\n# S\n\nhello\n' })
    const big = await call('get_document', { doc_path: 'guide.md' })
    expect(big.success).toBe(true)
    expect(big.data).toMatchObject({ doc_path: 'guide.md', title: 'Guide', read_structure_first: false })
    expect(big.data.tokens).toBeGreaterThan(0)
    expect(big.data.line_count).toBe(GUIDE.split('\n').length)
    const small = await call('get_document', { doc_path: 'small.md' })
    expect(small.data.metadata).toEqual({ title: 'Small One' })

    putSynthetic('huge.md', [node('h1', 'H', 1, 3)], ['a', 'b', 'c'])
    const store = openStore(dbFile)
    store.db.prepare('UPDATE docs SET tokens = 20000 WHERE path = ?').run('huge.md')
    store.close()
    const huge = await call('get_document', { doc_path: 'huge.md' })
    expect(huge.data.read_structure_first).toBe(true)
    expect(huge.next_steps.options[0]).toMatch(/get_document_structure/)
  })

  it('structure depth and node_id expansion', async () => {
    await library({ 'guide.md': GUIDE })
    const d1 = await call('get_document_structure', { doc_path: 'guide.md', depth: 1 })
    expect(d1.success).toBe(true)
    const s1: SNode[] = d1.data.structure
    expect(s1.map((n) => n.title)).toEqual(['Guide'])
    expect(s1[0]!.child_count).toBe(2)
    expect(s1[0]!.nodes).toBeUndefined()
    expect(d1.data.pagination).toEqual({ part: 1, total_parts: 1, has_more: false })
    expect(JSON.stringify(d1)).not.toContain('filler')

    const d2 = await call('get_document_structure', { doc_path: 'guide.md' })
    const top: SNode = d2.data.structure[0]
    expect(top.nodes!.map((n) => n.title)).toEqual(['Alpha', 'Beta'])
    const alpha = top.nodes![0]!
    expect(alpha.child_count).toBe(2)
    expect(alpha.nodes).toBeUndefined()
    expect(alpha).toMatchObject({ start_line: 5, end_line: 18 })

    const sub = await call('get_document_structure', { doc_path: 'guide.md', node_id: alpha.node_id })
    expect(sub.data.title_path).toEqual(['Guide', 'Alpha'])
    const a: SNode = sub.data.structure[0]
    expect(a.node_id).toBe(alpha.node_id)
    expect(a.nodes!.map((n) => n.title)).toEqual(['Alpha One', 'Alpha Two'])
  })

  it('structure pagination never exceeds budget', async () => {
    const lines = ['# Big']
    const children: TreeNode[] = []
    for (let i = 0; i < 5000; i++) {
      lines.push(`## Section ${i}`)
      children.push(node(`n${i}`, `Section ${i} ${'long title words '.repeat(4)}`, i + 2, i + 2))
    }
    putSynthetic('big.md', [node('root', 'Big', 1, lines.length, children)], lines)
    lib = openLibrary({ root })

    const first = await call('get_document_structure', { doc_path: 'big.md' })
    expect(first.success).toBe(true)
    const total = first.data.pagination.total_parts
    expect(total).toBeGreaterThan(1)
    expect(first.data.pagination.has_more).toBe(true)
    const seen = new Set<string>()
    let count = 0
    for (let part = 1; part <= total; part++) {
      const out = await lib.callTool('get_document_structure', { doc_path: 'big.md', part })
      expect(out.length).toBeLessThanOrEqual(RESPONSE_CHAR_BUDGET)
      const env = JSON.parse(out)
      expect(env.data.pagination).toEqual({ part, total_parts: total, has_more: part < total })
      for (const shell of env.data.structure as SNode[]) {
        expect(shell.node_id).toBe('root')
        seen.add(shell.node_id)
        for (const c of shell.nodes!) {
          seen.add(c.node_id)
          count++
        }
      }
    }
    expect(count).toBe(5000)
    expect(seen.size).toBe(5001)

    const past = await call('get_document_structure', { doc_path: 'big.md', part: total + 1 })
    expect(past).toMatchObject({ success: false, code: 'INVALID_INPUT' })
    expect(past.next_steps.options.join(' ')).toContain(`part: ${total}`)
  })

  it('get_node_content returns numbered lines of the full subtree range', async () => {
    await library({ 'guide.md': GUIDE })
    const s = await call('get_document_structure', { doc_path: 'guide.md' })
    const alpha: SNode = s.data.structure[0].nodes[0]
    const env = await call('get_node_content', { doc_path: 'guide.md', node_ids: [alpha.node_id] })
    expect(env.success).toBe(true)
    const [c] = env.data.content
    expect(c).toMatchObject({ node_id: alpha.node_id, title_path: ['Guide', 'Alpha'], start_line: 5, end_line: 18, complete: true })
    const textLines: string[] = c.text.split('\n')
    expect(textLines[0]).toBe('5│ ## Alpha')
    expect(textLines.at(-1)).toMatch(/^18│ /)
    expect(c.text).toContain('11│ ### Alpha One')
  })

  it('stale node id tells agent to refetch structure', async () => {
    await library({ 'guide.md': GUIDE })
    const s = await call('get_document_structure', { doc_path: 'guide.md' })
    const beta: SNode = s.data.structure[0].nodes[1]

    // the file changes on disk and is re-indexed while the read-only library stays open
    await index({ 'guide.md': GUIDE.replace('## Beta', '## Gamma') })
    const env = await call('get_node_content', { doc_path: 'guide.md', node_ids: [beta.node_id] })
    expect(env).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(env.details.unknown_node_ids).toEqual([beta.node_id])
    expect(env.next_steps.options[0]).toMatch(/get_document_structure/)

    const sub = await call('get_document_structure', { doc_path: 'guide.md', node_id: 'nope' })
    expect(sub).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(sub.next_steps.options[0]).toMatch(/get_document_structure/)
  })

  it('get_node_content pages an oversized node', async () => {
    const lines: string[] = []
    for (let i = 1; i <= 30_000; i++) lines.push(`line ${i} ${'é"\\'.repeat(5)} text`)
    const longLine = 'L'.repeat(250_000)
    lines.push(longLine)
    lines.push('tail')
    putSynthetic('huge.md', [node('only', 'Huge', 1, lines.length)], lines)
    lib = openLibrary({ root })

    const first = await call('get_node_content', { doc_path: 'huge.md', node_ids: ['only'] })
    const total = first.data.pagination.total_parts
    expect(total).toBeGreaterThan(3)
    const byLine = new Map<number, string>()
    let lastLine = 0
    for (let part = 1; part <= total; part++) {
      const out = await lib.callTool('get_node_content', { doc_path: 'huge.md', node_ids: ['only'], part })
      expect(out.length).toBeLessThanOrEqual(RESPONSE_CHAR_BUDGET)
      const env = JSON.parse(out)
      expect(env.data.pagination).toEqual({ part, total_parts: total, has_more: part < total })
      for (const c of env.data.content) {
        expect(c).toMatchObject({ node_id: 'only', start_line: 1, end_line: lines.length, complete: false })
        for (const l of (c.text as string).split('\n')) {
          const m = /^(\d+)│ (.*)$/s.exec(l)!
          const n = Number(m[1])
          expect(n).toBeGreaterThanOrEqual(lastLine)
          lastLine = n
          byLine.set(n, (byLine.get(n) ?? '') + m[2])
        }
      }
    }
    expect(byLine.size).toBe(lines.length)
    for (const [n, text] of byLine) expect(text).toBe(lines[n - 1])

    const past = await call('get_node_content', { doc_path: 'huge.md', node_ids: ['only'], part: total + 1 })
    expect(past).toMatchObject({ success: false, code: 'INVALID_INPUT' })
  })

  it('browse paginates and lists subfolders', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 12; i++) files[`d${String(i).padStart(2, '0')}.md`] = `# Doc ${i}\n\nbody\n`
    files['sub/a.md'] = '# A\n'
    files['sub/deep/b.md'] = '# B\n'
    files['other/c.md'] = '# C\n'
    await library(files)

    const p1 = await call('browse_documents', {})
    expect(p1.success).toBe(true)
    expect(p1.data.folders).toEqual(['other', 'sub'])
    expect(p1.data.docs).toHaveLength(10)
    expect(p1.data.docs[0]).toMatchObject({ path: 'd00.md', title: 'Doc 0' })
    expect(p1.data.docs[0].tokens).toBeGreaterThan(0)
    expect(p1.data).toMatchObject({ total: 12, next_offset: 10, has_more: true })

    const p2 = await call('browse_documents', { offset: p1.data.next_offset })
    expect(p2.data.docs.map((d: { path: string }) => d.path)).toEqual(['d10.md', 'd11.md'])
    expect(p2.data).toMatchObject({ next_offset: null, has_more: false })

    const sub = await call('browse_documents', { folder: 'sub' })
    expect(sub.data).toMatchObject({ folder: 'sub', folders: ['sub/deep'], total: 1 })
    expect(sub.data.docs.map((d: { path: string }) => d.path)).toEqual(['sub/a.md'])

    const missing = await call('browse_documents', { folder: 'sbu' })
    expect(missing).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(missing.details.similar_folders).toContain('sub')

    const past = await call('browse_documents', { offset: 50 })
    expect(past).toMatchObject({ success: false, code: 'INVALID_INPUT' })
  })

  it('search_documents returns hits and guides on empty results', async () => {
    await library({ 'guide.md': GUIDE, 'docs/other.md': `# Other\n\nnothing\n\n${PAD}\n` })
    const env = await call('search_documents', { query: 'ISO-27001' })
    expect(env.success).toBe(true)
    expect(env.data.results[0]).toMatchObject({ doc_path: 'guide.md', title_path: ['Guide', 'Beta'], via: 'bm25' })
    expect(env.data.results[0].start_line).toBe(19)

    const scoped = await call('search_documents', { query: 'ISO-27001', folder: 'docs' })
    expect(scoped.data.results).toEqual([])
    expect(scoped.next_steps.options.join(' ')).toMatch(/browse_documents/)

    const badDoc = await call('search_documents', { query: 'x', doc_path: 'gide.md' })
    expect(badDoc).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(badDoc.details.similar_paths).toContain('guide.md')
  })

  it('openLibrary fails clearly without an index', () => {
    expect(() => openLibrary({ root })).toThrow(/markindex index/)
  })

  it('index() builds the index from a read-only library', async () => {
    await library({ 'guide.md': GUIDE })
    put('new.md', '# New\n')
    const report = await lib!.index()
    expect(report.added).toEqual(['new.md'])
    expect((await call('get_document', { doc_path: 'new.md' })).success).toBe(true)
  })
})
