import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { indexLibrary } from '../../src/library/indexer.js'
import { openStore, type Store } from '../../src/store/db.js'
import { searchNodes } from '../../src/store/search.js'

let root: string
let store: Store
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'markindex-search-'))
  store = openStore(join(root, '.markindex', 'index.db'))
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** Sections get ~500 tokens of filler so optimizeTree keeps them as separate nodes. */
const PAD = 'filler '.repeat(300).trim()
/** Markdown doc: `# title`, optional intro, and `## heading` sections each followed by body + padding. */
function md(title: string, sections: [string, string][], intro = ''): string {
  return [`# ${title}`, intro, ...sections.map(([h, b]) => `## ${h}\n\n${b}\n\n${PAD}`)].filter(Boolean).join('\n\n') + '\n'
}

async function lib(files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  await indexLibrary({ root, store })
}

describe('searchNodes', () => {
  it('zh query hits zh node', async () => {
    await lib({
      'hr.md': md('人事制度', [['离职', '公司依法支付经济补偿金计算标准如下。'], ['考勤', '每日打卡。']]),
    })
    const hits = searchNodes(store, '经济补偿')
    expect(hits[0]).toMatchObject({ docPath: 'hr.md', titlePath: ['人事制度', '离职'], via: 'bm25' })
    expect(hits[0]!.snippet).toContain('经济补偿金')
  })

  it('mixed query', async () => {
    await lib({
      'law.md': md('Law', [['Privacy', '用户享有 GDPR 规定的被遗忘权。'], ['Other', 'nothing here']]),
    })
    const hits = searchNodes(store, 'GDPR 被遗忘权')
    expect(hits[0]!.titlePath).toEqual(['Law', 'Privacy'])
  })

  it('finds ISO-27001 and C++', async () => {
    await lib({ 'a.md': md('A', [['Sec', 'We are ISO-27001 certified.'], ['Lang', 'Written in C++ mostly.']]) })
    expect(searchNodes(store, 'ISO-27001')[0]!.titlePath).toEqual(['A', 'Sec'])
    expect(searchNodes(store, 'C++')[0]!.titlePath).toEqual(['A', 'Lang'])
  })

  it('title outranks body', async () => {
    await lib({
      'a.md': md('Doc', [['Kubernetes', 'Some text about clusters.'], ['Intro', 'We use kubernetes in prod.']]),
    })
    const hits = searchNodes(store, 'kubernetes')
    expect(hits.map((h) => h.titlePath.at(-1))).toEqual(['Kubernetes', 'Intro'])
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })

  it('parent and child not double-counted', async () => {
    await lib({ 'a.md': md('Top', [['Child', 'the zebra lives here'], ['Other', 'nothing']], 'intro') })
    const hits = searchNodes(store, 'zebra')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.titlePath).toEqual(['Top', 'Child'])
  })

  it('trigram fallback', async () => {
    await lib({ 'a.md': md('A', [['Leave', 'Our internationalization guide covers locales.'], ['Other', 'nothing']]) })
    const hits = searchNodes(store, 'nationaliza')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.via).toBe('trigram')
    expect(hits[0]!.titlePath).toEqual(['A', 'Leave'])
    expect(hits[0]!.snippet).toContain('internationalization')
  })

  it('trigram tops up bm25 results without duplicating them', async () => {
    await lib({
      'a.md': md('A', [
        ['One', 'the compensation rules'],
        ['Two', 'compensationmatrix appendix'],
      ]),
    })
    const hits = searchNodes(store, 'compensation')
    expect(hits.map((h) => [h.titlePath.at(-1), h.via])).toEqual([
      ['One', 'bm25'],
      ['Two', 'trigram'],
    ])
  })

  it('does not duplicate a node found by bm25 in the trigram pass', async () => {
    await lib({ 'a.md': '# A\n\n## S\n\nhello world foo\n' })
    const hits = searchNodes(store, 'hello')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.via).toBe('bm25')
  })

  it('scoped by folder and doc', async () => {
    await lib({
      'x/a.md': '# A\n\nplatypus\n',
      'x/y/b.md': '# B\n\nplatypus\n',
      'xx/c.md': '# C\n\nplatypus\n',
      'd.md': '# D\n\nplatypus\n',
    })
    const paths = (o: Parameters<typeof searchNodes>[2]) => searchNodes(store, 'platypus', o).map((h) => h.docPath).sort()
    expect(paths({})).toEqual(['d.md', 'x/a.md', 'x/y/b.md', 'xx/c.md'])
    expect(paths({ folder: '' })).toHaveLength(4)
    expect(paths({ folder: 'x' })).toEqual(['x/a.md', 'x/y/b.md'])
    expect(paths({ folder: 'x/' })).toEqual(['x/a.md', 'x/y/b.md'])
    expect(paths({ docPath: 'x/a.md' })).toEqual(['x/a.md'])
    expect(paths({ limit: 2 })).toHaveLength(2)
  })

  it('snippet length bounded and taken from original text', async () => {
    const long = `${'前缀文字'.repeat(200)} NEEDLE-term ${'后缀'.repeat(300)}`
    await lib({ 'a.md': md('A', [['S', long], ['T', 'x']]) })
    const hits = searchNodes(store, 'needle-term')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(300)
    expect(hits[0]!.snippet).toContain('NEEDLE-term')
  })

  it('empty, punctuation-only and malformed queries return [] / never throw', async () => {
    await lib({ 'a.md': '# A\n\nhello "quoted" world\n' })
    for (const q of ['', '   ', '!!!', '"', '""', '*', 'NEAR(', 'a OR', '(((', '- + ~', 'title:foo', '\\']) {
      expect(() => searchNodes(store, q)).not.toThrow()
    }
    expect(searchNodes(store, '')).toEqual([])
    expect(searchNodes(store, '!!!')).toEqual([])
    expect(searchNodes(store, '"quoted"')).toHaveLength(1)
  })
})
