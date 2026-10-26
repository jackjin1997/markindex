import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INDEX_FORMAT_VERSION, MAX_NODE_TOKENS, ROUTING_COST_TOKENS } from '../../src/config.js'
import { indexFormat, indexLibrary, type IndexEvent } from '../../src/library/indexer.js'
import { approxTokens } from '../../src/text/tokens.js'
import { scanLibrary } from '../../src/library/scan.js'
import { openStore, type Store } from '../../src/store/db.js'
import { searchNodes } from '../../src/store/search.js'

const FIX = join(import.meta.dirname, '../fixtures/md')

let root: string
let store: Store
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'markindex-lib-'))
  store = openStore(join(root, '.markindex', 'index.db'))
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function put(rel: string, content: string | Buffer) {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

describe('scanLibrary', () => {
  it('respects .gitignore, skips .mdx and symlinks', () => {
    put('a.md', '# A\n')
    put('b.markdown', '# B\n')
    put('c.mdx', '# C\n')
    put('notes.txt', 'x')
    put('ignored/x.md', '# X\n')
    put('sub/keep.md', '# K\n')
    put('sub/secret.md', '# S\n')
    put('sub/.gitignore', 'secret.md\n')
    put('draft-1.md', '# D\n')
    put('.git/HEAD.md', '# G\n')
    put('.obsidian/w.md', '# O\n')
    put('.gitignore', 'ignored/\ndraft-*.md\n')
    symlinkSync(join(root, 'a.md'), join(root, 'link.md'))
    symlinkSync(join(root, 'sub'), join(root, 'linkdir'))

    expect(scanLibrary(root)).toEqual([
      { path: 'a.md', abs: join(root, 'a.md') },
      { path: 'b.markdown', abs: join(root, 'b.markdown') },
      { path: 'sub/keep.md', abs: join(root, 'sub', 'keep.md') },
    ])
  })

  it('applies ignore patterns and a root .markindexignore on top of .gitignore', () => {
    put('a.md', '# A\n')
    put('drafts/d.md', '# D\n')
    put('sub/drafts/e.md', '# E\n')
    put('archive/old.md', '# O\n')
    put('sub/notes.md', '# N\n')
    put('sub/keep.md', '# K\n')
    put('.gitignore', 'archive/\n')
    expect(scanLibrary(root, { ignore: ['drafts/', 'sub/notes.md'] }).map((f) => f.path)).toEqual(['a.md', 'sub/keep.md'])
    put('.markindexignore', '# comment\n/drafts/\n*.md\n!keep.md\n')
    expect(scanLibrary(root).map((f) => f.path)).toEqual(['sub/keep.md'])
    expect(scanLibrary(root, { ignore: ['keep.md'] }).map((f) => f.path)).toEqual([])
    put('.markindexignore', '!archive/\n!archive/old.md\n')
    expect(scanLibrary(root).map((f) => f.path)).not.toContain('archive/old.md') // cannot re-include .gitignore'd paths
  })

  it('ignore patterns: a leading ./ is stripped, absolute filesystem paths and ../ are rejected', () => {
    put('a.md', '# A\n')
    put('drafts/d.md', '# D\n')
    put('sub/x.md', '# X\n')
    expect(scanLibrary(root, { ignore: ['./drafts/', '!./sub/x.md', './sub/'] }).map((f) => f.path)).toEqual(['a.md'])
    expect(scanLibrary(root, { ignore: ['/drafts/'] }).map((f) => f.path)).toEqual(['a.md', 'sub/x.md']) // gitignore anchor
    expect(() => scanLibrary(root, { ignore: [join(root, 'drafts')] })).toThrow(/ignore pattern ".*drafts" is an absolute path.*"drafts"/)
    expect(() => scanLibrary(root, { ignore: ['C:\\docs\\drafts'] })).toThrow(/absolute path/)
    expect(() => scanLibrary(root, { ignore: ['../other/'] })).toThrow(/outside the library root/)
  })

  it('the ignore-file name and setext threshold are part of the public API', async () => {
    const api = await import('../../src/index.js')
    expect(api.IGNORE_FILE).toBe('.markindexignore')
    expect(api.SUSPECT_SETEXT_CHARS).toBe(120)
    expect(typeof api.normalizeIgnorePatterns).toBe('function')
  })

  it('.markindexignore is only read at the root', () => {
    put('a.md', '# A\n')
    put('sub/b.md', '# B\n')
    put('sub/.markindexignore', 'b.md\n')
    expect(scanLibrary(root).map((f) => f.path)).toEqual(['a.md', 'sub/b.md'])
  })

  it('ignores the .markindex directory', () => {
    put('.markindex/notes.md', '# N\n')
    put('a.md', '# A\n')
    expect(scanLibrary(root).map((f) => f.path)).toEqual(['a.md'])
  })
})

const isRoot = process.getuid?.() === 0

describe('indexLibrary', () => {
  it.skipIf(isRoot)('skips an unreadable subdirectory, reports it, and keeps its old documents', async () => {
    put('a.md', '# A\n')
    put('locked/b.md', '# B\n')
    await indexLibrary({ root, store })
    const locked = join(root, 'locked')
    chmodSync(locked, 0o000)
    try {
      put('c.md', '# C\n')
      const r = await indexLibrary({ root, store })
      expect(r.added).toEqual(['c.md'])
      expect(r.removed).toEqual([])
      expect(r.skipped).toHaveLength(1)
      expect(r.skipped[0]!.path).toBe('locked/')
      expect(r.skipped[0]!.reason).toMatch(/not readable.*EACCES/)
      expect(store.getDoc('locked/b.md')).toBeDefined()
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('a failing deleteDoc is reported in skipped instead of rejecting', async () => {
    put('a.md', '# A\n')
    put('gone.md', '# G\n')
    await indexLibrary({ root, store })
    put('a.md', Buffer.from([0xff, 0xfe]))
    unlinkSync(join(root, 'gone.md'))
    vi.spyOn(store, 'deleteDoc').mockImplementation(() => {
      throw new Error('disk I/O error')
    })
    const r = await indexLibrary({ root, store })
    expect(r.removed).toEqual([])
    expect(r.skipped).toEqual([
      { path: 'a.md', reason: expect.stringMatching(/utf-8.*previous version could not be removed: disk I\/O error/) },
      { path: 'gone.md', reason: expect.stringContaining('disk I/O error') },
    ])
  })

  const seed = () => {
    copyFileSync(join(FIX, 'en-guide.md'), join(root, 'en-guide.md'))
    mkdirSync(join(root, 'zh'))
    copyFileSync(join(FIX, 'zh-manual.md'), join(root, 'zh', 'manual.md'))
    copyFileSync(join(FIX, 'headless.md'), join(root, 'zh', 'headless.md'))
  }

  it('indexes a single ~200k-word line and keeps it searchable', async () => {
    put('huge-line.md', `# Huge\n\n${'alpha '.repeat(200_000)}needle-word\n`)
    const report = await indexLibrary({ root, store })
    expect(report.added).toEqual(['huge-line.md'])
    expect(report.skipped).toEqual([])
    const hits = searchNodes(store, 'needle-word')
    expect(hits.map((h) => h.docPath)).toContain('huge-line.md')
  })

  it('indexes a library and records documents', async () => {
    seed()
    const events: IndexEvent[] = []
    const r = await indexLibrary({ root, store, onProgress: (e) => events.push(e) })
    expect(r.added).toEqual(['en-guide.md', 'zh/headless.md', 'zh/manual.md'])
    expect(r).toMatchObject({ updated: [], removed: [], unchanged: [], skipped: [] })
    expect(events.map((e) => [e.path, e.status, e.done, e.total])).toEqual([
      ['en-guide.md', 'added', 1, 3],
      ['zh/headless.md', 'added', 2, 3],
      ['zh/manual.md', 'added', 3, 3],
    ])
    const doc = store.getDoc('zh/manual.md')!
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(doc.lineCount).toBeGreaterThan(0)
    expect(doc.tokens).toBe(store.getTree('zh/manual.md')!.reduce((s, n) => s + n.tokens, 0))
    expect(store.getTree('zh/manual.md')!.length).toBeGreaterThan(0)
    expect(store.listDocs('zh', 0, 10).docs.map((d) => d.path)).toEqual(['zh/headless.md', 'zh/manual.md'])
  })

  it('document title: frontmatter title > first h1 > filename', async () => {
    put('fm.md', '---\ntitle: From FM\nauthor: me\n---\n\n# Heading\n')
    put('h1.md', 'intro\n\n## Two\n\n# First H1\n')
    put('dir/plain-name.md', 'no headings here\n')
    await indexLibrary({ root, store })
    expect(store.getDoc('fm.md')).toMatchObject({ title: 'From FM', metadata: { title: 'From FM', author: 'me' } })
    expect(store.getDoc('h1.md')!.title).toBe('First H1')
    expect(store.getDoc('dir/plain-name.md')!.title).toBe('plain-name')
    expect(store.getTree('dir/plain-name.md')![0]!.title).toBe('plain-name')
  })

  it('incremental: unchanged files are skipped', async () => {
    seed()
    await indexLibrary({ root, store })
    const before = store.getDoc('en-guide.md')!
    const spy = vi.spyOn(store, 'replaceDoc')
    const r = await indexLibrary({ root, store })
    expect(r).toEqual({
      added: [],
      updated: [],
      removed: [],
      unchanged: ['en-guide.md', 'zh/headless.md', 'zh/manual.md'],
      skipped: [],
      summaryErrors: [],
      warnings: [],
    })
    expect(spy).not.toHaveBeenCalled()
    expect(store.getDoc('en-guide.md')).toEqual(before)
  })

  describe('index format fingerprint', () => {
    const all = ['en-guide.md', 'zh/headless.md', 'zh/manual.md']

    it('stores the fingerprint; same parameters stay incremental', async () => {
      seed()
      const first = await indexLibrary({ root, store })
      expect(first.rebuilt).toBeUndefined()
      expect(store.getMeta('index_format')).toBe(indexFormat({}))
      const again = await indexLibrary({ root, store, maxNodeTokens: MAX_NODE_TOKENS })
      expect(again.rebuilt).toBeUndefined()
      expect(again.unchanged).toEqual(all)
    })

    it.each([
      ['maxNodeTokens', { maxNodeTokens: 500 }],
      ['routingCost', { routingCost: 10 }],
      ['a custom token counter', { countTokens: (t: string) => t.length }],
      ['a named token counter', { countTokens: (t: string) => t.length, tokenCounterId: 'chars' }],
    ])('changing %s re-indexes every document', async (_label, opts) => {
      seed()
      await indexLibrary({ root, store })
      const spy = vi.spyOn(store, 'replaceDoc')
      const r = await indexLibrary({ root, store, ...opts })
      expect(r.rebuilt?.reason).toMatch(/index format changed/)
      expect(r.updated).toEqual(all)
      expect(r.unchanged).toEqual([])
      expect(spy).toHaveBeenCalledTimes(3)
      expect(store.getMeta('index_format')).toBe(indexFormat(opts))
      const next = await indexLibrary({ root, store, ...opts })
      expect(next.rebuilt).toBeUndefined()
      expect(next.unchanged).toEqual(all)
    })

    it('turning setext off re-indexes every document and changes the parse', async () => {
      seed()
      put('pages.md', 'Page one line one\npage one line two\n---\nPage two\n')
      await indexLibrary({ root, store })
      expect(store.getTree('pages.md')![0]!.title).toBe('Page one line one\npage one line two')
      const r = await indexLibrary({ root, store, setext: false })
      expect(r.rebuilt?.reason).toMatch(/index format changed/)
      expect(r.updated).toEqual([...all.slice(0, 1), 'pages.md', ...all.slice(1)])
      expect(store.getTree('pages.md')!.map((n) => n.title)).toEqual(['pages'])
      expect(JSON.parse(indexFormat({ setext: false })).setext).toBe(false)
      expect((await indexLibrary({ root, store, setext: false })).rebuilt).toBeUndefined()
    })

    it('setext is persisted: omitted inherits the stored value, only an explicit value changes it', async () => {
      seed()
      put('pages.md', 'Page one line one\npage one line two\n---\nPage two\n')
      await indexLibrary({ root, store, setext: false })
      const plain = await indexLibrary({ root, store })
      expect(plain.rebuilt).toBeUndefined()
      expect(plain.unchanged).toHaveLength(4)
      expect(JSON.parse(store.getMeta('index_format')!).setext).toBe(false)
      put('new.md', 'para line\nsecond line\n---\n')
      const added = await indexLibrary({ root, store })
      expect(added.added).toEqual(['new.md'])
      expect(added.warnings).toEqual([]) // inherited off: no setext, no page-break warnings
      expect(store.getTree('new.md')!.map((n) => n.title)).toEqual(['new'])
      const on = await indexLibrary({ root, store, setext: true })
      expect(on.rebuilt?.reason).toMatch(/index format changed/)
      expect(on.updated).toHaveLength(5)
      expect(store.getTree('pages.md')![0]!.title).toBe('Page one line one\npage one line two')
      expect(store.getMeta('index_format')).toBe(indexFormat({}))
      expect((await indexLibrary({ root, store })).rebuilt).toBeUndefined()
    })

    it('a stale or missing stored format (older code) triggers a full rebuild', async () => {
      seed()
      await indexLibrary({ root, store })
      store.setMeta('index_format', JSON.stringify({ version: 0 }))
      expect((await indexLibrary({ root, store })).updated).toEqual(all)
      store.db.prepare('DELETE FROM meta').run()
      const r = await indexLibrary({ root, store })
      expect(r.rebuilt?.reason).toMatch(/index format changed/)
      expect(r.updated).toEqual(all)
    })

    it('the fingerprint includes INDEX_FORMAT_VERSION and the tree parameters', () => {
      expect(JSON.parse(indexFormat({}))).toEqual({
        version: INDEX_FORMAT_VERSION,
        maxNodeTokens: MAX_NODE_TOKENS,
        routingCost: ROUTING_COST_TOKENS,
        tokens: 'approx',
      })
      expect(indexFormat({ countTokens: approxTokens })).toBe(indexFormat({}))
      expect(indexFormat({ countTokens: (t) => t.length })).not.toBe(indexFormat({}))
    })
  })

  it('incremental: modify / delete / rename', async () => {
    seed()
    await indexLibrary({ root, store })
    put('en-guide.md', '# Rewritten\n\nnew body\n')
    unlinkSync(join(root, 'zh', 'headless.md'))
    renameSync(join(root, 'zh', 'manual.md'), join(root, 'zh', 'manual-v2.md'))
    put('new.md', '# New\n')

    const r = await indexLibrary({ root, store })
    expect(r).toEqual({
      added: ['new.md', 'zh/manual-v2.md'],
      updated: ['en-guide.md'],
      removed: ['zh/headless.md', 'zh/manual.md'],
      unchanged: [],
      skipped: [],
      summaryErrors: [],
      warnings: [],
    })
    expect(store.allDocPaths()).toEqual(['en-guide.md', 'new.md', 'zh/manual-v2.md'])
    expect(store.getDoc('en-guide.md')!.title).toBe('Rewritten')
    expect(store.getLines('en-guide.md', 1, 10)).toEqual(['# Rewritten', '', 'new body', ''])
    expect(store.getTree('zh/headless.md')).toBeUndefined()
  })

  describe('page-break setext warning', () => {
    const longLine = 'word '.repeat(30).trim() // 149 chars
    it('warns about setext h2 headings that are long or span several lines, only while setext is on', async () => {
      put('pdf.md', `# Report\n\nFirst page line\nstill first page\n---\n${longLine}\n---\nshort\n---\n`)
      put('clean.md', '# Title\n\nSub\n---\n\nTop\n===\n')
      const r = await indexLibrary({ root, store })
      expect(r.warnings).toEqual([
        { path: 'pdf.md', message: expect.stringMatching(/^2 setext h2 heading\(s\) .*page break.*line 3/) },
      ])
      unlinkSync(join(root, 'pdf.md'))
      put('pdf2.md', `${longLine}\n---\n`)
      const off = await indexLibrary({ root, store, setext: false })
      expect(off.warnings).toEqual([])
    })

    it('an incremental run without parsed files has no warnings', async () => {
      put('a.md', '# A\n')
      await indexLibrary({ root, store })
      expect((await indexLibrary({ root, store })).warnings).toEqual([])
    })
  })

  it('ignore option: a newly ignored file is removed from the index on the next run', async () => {
    put('a.md', '# A\n')
    put('drafts/b.md', '# B\n')
    put('c.md', '# C\n')
    await indexLibrary({ root, store })
    const r = await indexLibrary({ root, store, ignore: ['drafts/'] })
    expect(r.removed).toEqual(['drafts/b.md'])
    expect(r.unchanged).toEqual(['a.md', 'c.md'])
    put('.markindexignore', 'c.md\n')
    const r2 = await indexLibrary({ root, store, ignore: ['drafts/'] })
    expect(r2.removed).toEqual(['c.md'])
    expect(store.allDocPaths()).toEqual(['a.md'])
  })

  it('reports non-utf8 files and continues', async () => {
    put('gbk.md', Buffer.from([0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0a])) // "# 中文" in GBK
    put('ok.md', '# OK\n')
    const r = await indexLibrary({ root, store })
    expect(r.added).toEqual(['ok.md'])
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0]!.path).toBe('gbk.md')
    expect(r.skipped[0]!.reason).toContain('utf-8')
    expect(store.getDoc('gbk.md')).toBeUndefined()
  })

  it('a previously indexed file that becomes unreadable is dropped and reported as skipped', async () => {
    put('a.md', '# A\n')
    await indexLibrary({ root, store })
    put('a.md', Buffer.from([0xff, 0xfe, 0x00, 0xd8]))
    const r = await indexLibrary({ root, store })
    expect(r.skipped.map((s) => s.path)).toEqual(['a.md'])
    expect(r.removed).toEqual([])
    expect(store.getDoc('a.md')).toBeUndefined()
  })

  it('failed document leaves no partial rows and indexing continues', async () => {
    put('a.md', '# A\n\nbody\n')
    put('b.md', '# B\n\nbody\n')
    const real = store.replaceDoc.bind(store)
    vi.spyOn(store, 'replaceDoc').mockImplementation((doc, tree, lines) => {
      if (doc.path === 'a.md') {
        const bad = structuredClone(tree)
        ;(bad[0] as unknown as { x: bigint }).x = 1n // fails mid-transaction
        return real(doc, bad, lines)
      }
      return real(doc, tree, lines)
    })
    const r = await indexLibrary({ root, store })
    expect(r.added).toEqual(['b.md'])
    expect(r.skipped.map((s) => s.path)).toEqual(['a.md'])
    expect(store.getDoc('a.md')).toBeUndefined()
    for (const t of ['nodes', 'lines', 'fts_words', 'fts_tri']) {
      expect(store.db.prepare(`SELECT count(*) AS n FROM ${t} WHERE doc_path = 'a.md'`).get()).toEqual({ n: 0 })
    }
  })

  it('passes the same countTokens to build and optimize', async () => {
    put('a.md', '# A\n\nhello world\n')
    const countTokens = vi.fn((s: string) => s.length)
    await indexLibrary({ root, store, countTokens })
    expect(countTokens).toHaveBeenCalled()
    const tree = store.getTree('a.md')!
    expect(tree[0]!.tokens).toBe('# A\n\nhello world\n'.length)
  })

  it('rebuilding the same input yields identical trees', async () => {
    seed()
    await indexLibrary({ root, store })
    const t1 = store.getTree('zh/manual.md')
    store.deleteDoc('zh/manual.md')
    await indexLibrary({ root, store })
    expect(JSON.stringify(store.getTree('zh/manual.md'))).toBe(JSON.stringify(t1))
  })
})
