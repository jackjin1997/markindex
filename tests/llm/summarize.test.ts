import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { APICallError } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { indexLibrary } from '../../src/library/indexer.js'
import { estimateSummaryCost, summarizeDocument } from '../../src/llm/summarize.js'
import { openStore, type Store } from '../../src/store/db.js'
import { searchNodes } from '../../src/store/search.js'
import type { TreeNode } from '../../src/types.js'

let root: string
let store: Store
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'markindex-sum-'))
  store = openStore(join(root, '.markindex', 'index.db'))
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const pad = (word: string) => `${word} `.repeat(300).trim()

function put(rel: string, content: string) {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

/** Parent `## Alpha` has its own long text plus long children; `## Beta` is a long leaf; `## Tiny` is short. */
function doc(opts: { beta?: string } = {}) {
  return [
    '# Doc',
    '',
    '## Alpha',
    '',
    `alphaintro ${pad('aaa')}`,
    '',
    '### Alpha One',
    '',
    `aone ${pad('bbb')}`,
    '',
    '### Alpha Two',
    '',
    `atwo ${pad('ccc')}`,
    '',
    '## Beta',
    '',
    `${opts.beta ?? 'betatext'} ${pad('ddd')}`,
    '',
    '## Tiny',
    '',
    'tiny body here.',
    '',
  ].join('\n')
}

interface Mock {
  model: MockLanguageModelV4
  prompts: string[]
  maxActive: () => number
}

/** Replies `SUM[<marker>]` for node prompts (marker = first word of the text) and `DESC` for description prompts. */
function mockModel(opts: { delayMs?: number; fail?: (prompt: string) => boolean } = {}): Mock {
  const prompts: string[] = []
  let active = 0
  let max = 0
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt)
      const text = (options.prompt as { content: { text: string }[] }[]).flatMap((m) => m.content.map((c) => c.text)).join('')
      prompts.push(text)
      active++
      max = Math.max(max, active)
      try {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
        if (opts.fail?.(prompt)) throw new APICallError({ message: 'boom', url: 'mock://', requestBodyValues: {}, isRetryable: true })
        const reply = text.includes('Document Structure') ? 'DESC one sentence' : `SUM[${/Partial Document Text: (?:#+ [^\n]*\n+)?(\S+)/.exec(text)?.[1]}]`
        return {
          content: [{ type: 'text' as const, text: reply }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
          warnings: [],
        }
      } finally {
        active--
      }
    },
  })
  return { model, prompts, maxActive: () => max }
}

const flat = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((n) => [n, ...flat(n.children)])
const byTitle = (path: string, title: string) => flat(store.getTree(path)!).find((n) => n.title === title)!

async function indexed(content = doc()) {
  put('a.md', content)
  await indexLibrary({ root, store })
}

describe('summarizeDocument', () => {
  it('short nodes use own text, no LLM call', async () => {
    await indexed()
    const m = mockModel()
    await summarizeDocument(store, 'a.md', { model: m.model, describe: false })
    const tiny = byTitle('a.md', 'Tiny')
    expect(tiny.summary ?? tiny.prefixSummary).toContain('tiny body here.')
    expect(m.prompts.some((p) => p.includes('tiny body here.'))).toBe(false)
  })

  it('long leaf gets summary, long parent gets prefixSummary', async () => {
    await indexed()
    const m = mockModel()
    const res = await summarizeDocument(store, 'a.md', { model: m.model })
    const alpha = byTitle('a.md', 'Alpha')
    expect(alpha.children.length).toBeGreaterThan(0)
    expect(alpha.prefixSummary).toBe('SUM[alphaintro]')
    expect(alpha.summary).toBeUndefined()
    const beta = byTitle('a.md', 'Beta')
    expect(beta.summary).toBe('SUM[betatext]')
    expect(beta.prefixSummary).toBeUndefined()
    // parent prompt covers own text only
    const parentPrompt = m.prompts.find((p) => p.includes('alphaintro'))!
    expect(parentPrompt).not.toContain('aone')
    expect(store.getDoc('a.md')!.description).toBe('DESC one sentence')
    expect(res.failures).toEqual([])
    expect(res.usage).toEqual({ inputTokens: 10 * res.llmCalls, outputTokens: 5 * res.llmCalls })
  })

  it('prompts ask for same-language, concise output', async () => {
    await indexed()
    const m = mockModel()
    await summarizeDocument(store, 'a.md', { model: m.model })
    for (const p of m.prompts) expect(p).toContain('same language')
    expect(m.prompts.find((p) => p.includes('betatext'))).toContain('150 words')
  })

  it('cache hit after unrelated edit', async () => {
    await indexed()
    const first = mockModel()
    const r1 = await summarizeDocument(store, 'a.md', { model: first.model, describe: false })
    expect(r1.cached).toBe(0)
    put('a.md', doc({ beta: 'betachanged' }))
    await indexLibrary({ root, store })
    const second = mockModel()
    const r2 = await summarizeDocument(store, 'a.md', { model: second.model, describe: false })
    expect(r2.llmCalls).toBe(1)
    expect(r2.cached).toBe(r1.llmCalls - 1)
    expect(second.prompts).toHaveLength(1)
    expect(second.prompts[0]).toContain('betachanged')
    expect(byTitle('a.md', 'Beta').summary).toBe('SUM[betachanged]')
    expect(byTitle('a.md', 'Alpha').prefixSummary).toBe('SUM[alphaintro]')
  })

  it('concurrency limit respected', async () => {
    await indexed()
    const m = mockModel({ delayMs: 15 })
    const r = await summarizeDocument(store, 'a.md', { model: m.model, concurrency: 2, describe: false })
    expect(r.llmCalls).toBeGreaterThan(2)
    expect(m.maxActive()).toBe(2)
  })

  it('retries then reports failure without corrupting store', async () => {
    await indexed()
    const before = JSON.stringify(store.getTree('a.md'))
    const m = mockModel({ fail: (p) => p.includes('betatext') })
    const r = await summarizeDocument(store, 'a.md', { model: m.model, maxRetries: 1 })
    const betaCalls = m.prompts.filter((p) => p.includes('betatext')).length
    expect(betaCalls).toBe(2) // 1 + 1 retry (SDK backoff makes this test ~2s)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]!.nodeId).toBe(byTitle('a.md', 'Beta').nodeId)
    expect(byTitle('a.md', 'Beta').summary).toBeUndefined()
    expect(byTitle('a.md', 'Alpha').prefixSummary).toBe('SUM[alphaintro]')
    // structure intact apart from the successful summaries
    const strip = (t: TreeNode[]): unknown[] => t.map(({ summary, prefixSummary, children, ...r }) => ({ ...r, c: strip(children) }))
    expect(strip(store.getTree('a.md')!)).toEqual(strip(JSON.parse(before) as TreeNode[]))
    expect(store.getDoc('a.md')!.description).toBe('DESC one sentence')
  }, 15_000)

  it('summary text is searchable via FTS', async () => {
    await indexed()
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: 'zebrafish handling protocol' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      },
    })
    expect(searchNodes(store, 'zebrafish')).toEqual([])
    await summarizeDocument(store, 'a.md', { model, describe: false })
    const hits = searchNodes(store, 'zebrafish')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.via === 'bm25')).toBe(true)
  })

  it('description outline is bounded', async () => {
    const sections = Array.from({ length: 600 }, (_, i) => `## Section number ${i}\n\n${i} ${pad(`w${i}`)}\n`)
    await indexed(['# Big', '', ...sections].join('\n'))
    const m = mockModel()
    await summarizeDocument(store, 'a.md', { model: m.model, threshold: 100000 })
    const p = m.prompts.find((x) => x.includes('Document Structure'))!
    expect(p.length).toBeLessThan(14_000)
    expect(p).toContain('outline truncated')
  })
})

describe('estimateSummaryCost', () => {
  it('matches actual llmCalls', async () => {
    await indexed()
    put('b.md', doc({ beta: 'otherbeta' }))
    await indexLibrary({ root, store })
    const est = estimateSummaryCost(store, {})
    expect(est.nodes).toBeGreaterThan(0)
    expect(est.inputTokens).toBeGreaterThan(0)
    const m = mockModel()
    let calls = 0
    for (const p of store.allDocPaths()) calls += (await summarizeDocument(store, p, { model: m.model })).llmCalls
    expect(est.llmCalls).toBe(calls)
    expect(m.prompts).toHaveLength(calls)
    expect(estimateSummaryCost(store, {}).llmCalls).toBe(0)
  })
})

describe('indexLibrary summary option', () => {
  it('summarizes (re)indexed docs only when summary is set, and reports failures', async () => {
    put('a.md', doc())
    await indexLibrary({ root, store })
    expect(store.getDoc('a.md')!.description).toBeUndefined()

    put('a.md', doc({ beta: 'betaedit' }))
    const m = mockModel({ fail: (p) => p.includes('betaedit') })
    const report = await indexLibrary({ root, store, summary: { model: m.model, maxRetries: 0 } })
    expect(report.updated).toEqual(['a.md'])
    expect(report.summaryErrors).toHaveLength(1)
    expect(report.summaryErrors[0]).toMatchObject({ path: 'a.md', message: expect.stringContaining('boom') })
    expect(store.getDoc('a.md')).toBeDefined()
    expect(byTitle('a.md', 'Alpha').prefixSummary).toBe('SUM[alphaintro]')

    const calls = m.prompts.length
    await indexLibrary({ root, store, summary: { model: m.model } }) // unchanged -> no new LLM calls
    expect(m.prompts.length).toBe(calls)
  })
})
