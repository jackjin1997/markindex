import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseMarkdown } from '../../src/parse/markdown.js'
import { openStore, StoreLockedError, type Store } from '../../src/store/db.js'
import { buildTree } from '../../src/tree/build.js'
import { optimizeTree } from '../../src/tree/optimize.js'
import type { DocumentRecord, TreeNode } from '../../src/types.js'

const FIX = join(import.meta.dirname, '../fixtures/md')

let dir: string
let stores: Store[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markindex-db-'))
  stores = []
})
afterEach(() => {
  for (const s of stores) s.close()
  rmSync(dir, { recursive: true, force: true })
})

const open = (file = join(dir, 'lib.db'), opts?: { readonly?: boolean }) => {
  const s = openStore(file, opts)
  stores.push(s)
  return s
}

function record(path: string, lineCount = 1): DocumentRecord {
  return {
    docId: '',
    path,
    title: path,
    metadata: { tags: ['a'] },
    contentHash: `hash-${path}`,
    lineCount,
    tokens: 1,
    indexedAt: '2026-10-23T00:00:00.000Z',
  }
}

function fixtureDoc(name: string) {
  const src = readFileSync(join(FIX, name), 'utf8')
  const doc = parseMarkdown(src)
  const tree = optimizeTree(buildTree(doc, { fileTitle: name }), doc, { maxNodeTokens: 200 })
  return { doc, tree }
}

const count = (s: Store, table: string, path: string) =>
  (s.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE doc_path = ?`).get(path) as { n: number }).n

describe('store', () => {
  it('roundtrips a document', () => {
    const s = open()
    const { doc, tree } = fixtureDoc('zh-manual.md')
    // more than one 200-line chunk
    const lines = [...doc.lines, ...Array.from({ length: 450 }, (_, i) => `extra ${i}\r`)]
    const rec = { ...record('dir/zh-manual.md', lines.length), description: 'desc' }
    s.replaceDoc(rec, tree, lines)

    expect(s.getTree('dir/zh-manual.md')).toEqual(tree)
    expect(s.getLines('dir/zh-manual.md', 1, lines.length)).toEqual(lines)
    expect(s.getLines('dir/zh-manual.md', 199, 402)).toEqual(lines.slice(198, 402))
    expect(s.getLines('dir/zh-manual.md', 0, 2)).toEqual(lines.slice(0, 2))
    expect(s.getLines('dir/zh-manual.md', lines.length, lines.length + 10)).toEqual(lines.slice(-1))
    const got = s.getDoc('dir/zh-manual.md')
    expect(got).toMatchObject({ ...rec, docId: expect.any(String) })
    expect(got!.docId).not.toBe('')
    expect(s.getDoc('missing.md')).toBeUndefined()
    expect(s.getTree('missing.md')).toBeUndefined()
    expect(s.getLines('missing.md', 1, 5)).toEqual([])
    expect(s.allDocPaths()).toEqual(['dir/zh-manual.md'])
  })

  it('replaceDoc writes one FTS row per node with own text only', () => {
    const s = open()
    const lines = ['# Parent', 'parent body C++', '## Child', 'child body ISO-27001']
    const doc = parseMarkdown(lines.join('\n'))
    const tree = buildTree(doc, { fileTitle: 'x' })
    s.replaceDoc(record('a.md', lines.length), tree, lines)

    const words = s.db
      .prepare('SELECT node_id, title, body, summary FROM fts_words WHERE doc_path = ? ORDER BY node_id')
      .all('a.md') as { node_id: string; title: string; body: string; summary: string }[]
    expect(words).toHaveLength(2)
    const parent = words.find((w) => w.node_id === tree[0]!.nodeId)!
    expect(parent.title).toBe('parent')
    expect(parent.body).toBe('parent parent body c++')
    expect(parent.summary).toBe('')
    expect(s.db.prepare(`SELECT node_id FROM fts_words WHERE fts_words MATCH '"iso-27001"'`).all()).toEqual([
      { node_id: tree[0]!.children[0]!.nodeId },
    ])
    expect(s.db.prepare(`SELECT node_id FROM fts_tri WHERE fts_tri MATCH '"O-270"'`).all()).toEqual([
      { node_id: tree[0]!.children[0]!.nodeId },
    ])
    s.deleteDoc('a.md')
    expect(count(s, 'fts_words', 'a.md') + count(s, 'fts_tri', 'a.md')).toBe(0)
  })

  it('replaceDoc replaces previous rows', () => {
    const s = open()
    const { doc, tree } = fixtureDoc('en-guide.md')
    s.replaceDoc(record('a.md', doc.lines.length), tree, doc.lines)
    const small = parseMarkdown('# Only\n\ntext\n')
    const smallTree = buildTree(small, { fileTitle: 'a' })
    s.replaceDoc(record('a.md', small.lines.length), smallTree, small.lines)
    expect(s.getTree('a.md')).toEqual(smallTree)
    expect(s.getLines('a.md', 1, 100)).toEqual(small.lines)
    expect(count(s, 'nodes', 'a.md')).toBe(1)
    expect(count(s, 'fts_words', 'a.md')).toBe(1)
    expect(count(s, 'fts_tri', 'a.md')).toBe(1)
  })

  it('listDocs returns direct subfolders and docs', () => {
    const s = open()
    for (const p of ['a.md', 'x/b.md', 'x/y/c.md', 'x/y/d.md', 'z/e.md']) s.replaceDoc(record(p), [], ['l'])
    const root = s.listDocs('', 0, 50)
    expect(root.folders).toEqual(['x', 'z'])
    expect(root.docs.map((d) => d.path)).toEqual(['a.md'])
    expect(root.total).toBe(1)
    const x = s.listDocs('x', 0, 50)
    expect(x.folders).toEqual(['x/y'])
    expect(x.docs.map((d) => d.path)).toEqual(['x/b.md'])
    const xy = s.listDocs('x/y/', 1, 50)
    expect(xy.docs.map((d) => d.path)).toEqual(['x/y/d.md'])
    expect(xy.total).toBe(2)
    expect(s.listDocs('nope', 0, 10)).toEqual({ folders: [], docs: [], total: 0 })
  })

  it('failed document leaves no partial rows', () => {
    const s = open()
    const { doc, tree } = fixtureDoc('en-guide.md')
    s.replaceDoc(record('a.md', doc.lines.length), tree, doc.lines)
    const before = s.getTree('a.md')

    // second node cannot be serialized -> throws after docs + first node rows were written
    const poisoned = structuredClone(tree)
    const second = [...poisoned.flatMap(function flat(n): TreeNode[] { return [n, ...n.children.flatMap(flat)] })][1]!
    ;(second as unknown as { bad: bigint }).bad = 1n
    expect(() => s.replaceDoc(record('b.md', doc.lines.length), poisoned, doc.lines)).toThrow()
    for (const t of ['nodes', 'lines', 'fts_words', 'fts_tri']) expect(count(s, t, 'b.md')).toBe(0)
    expect(s.getDoc('b.md')).toBeUndefined()

    // a failed replacement keeps the previous version intact
    expect(() => s.replaceDoc(record('a.md', doc.lines.length), poisoned, doc.lines)).toThrow()
    expect(s.getTree('a.md')).toEqual(before)
  })

  it('uses WAL and sets user_version', () => {
    const s = open()
    expect(s.db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(s.db.pragma('user_version', { simple: true })).toBeGreaterThan(0)
  })

  it('creates the parent directory', () => {
    const file = join(dir, 'nested', 'deeper', 'lib.db')
    open(file)
    expect(existsSync(file)).toBe(true)
  })
})

describe('store lock', () => {
  it('second writer fails fast with lock message', () => {
    const file = join(dir, 'lib.db')
    const w = open(file)
    w.replaceDoc(record('a.md'), [], ['hello'])
    expect(readFileSync(`${file}.lock`, 'utf8').trim()).toBe(String(process.pid))
    expect(() => openStore(file)).toThrow(StoreLockedError)
    expect(() => openStore(file)).toThrow(/locked.*pid \d+/i)
    const r = open(file, { readonly: true })
    expect(r.getLines('a.md', 1, 1)).toEqual(['hello'])
    expect(() => r.deleteDoc('a.md')).toThrow()
  })

  it('close() releases the lock', () => {
    const file = join(dir, 'lib.db')
    const w = openStore(file)
    w.close()
    w.close()
    expect(existsSync(`${file}.lock`)).toBe(false)
    open(file)
  })

  it('takes over a stale lock', () => {
    const file = join(dir, 'lib.db')
    writeFileSync(`${file}.lock`, '2147483646\n') // no such pid
    open(file)
    expect(readFileSync(`${file}.lock`, 'utf8').trim()).toBe(String(process.pid))
  })
})
