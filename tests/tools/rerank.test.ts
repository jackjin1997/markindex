import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAiSdkTools } from '../../src/adapters/ai-sdk.js'
import { createMcpServer } from '../../src/adapters/mcp.js'
import { indexLibrary } from '../../src/library/indexer.js'
import { openLibrary, type Library } from '../../src/library.js'
import type { Reranker } from '../../src/rerank/types.js'
import { openStore } from '../../src/store/db.js'
import { TOOL_CONTRACT } from '../../src/tools/contract.js'

const PAD = 'filler '.repeat(60).trim()
// Keyword order is Alpha, Beta, Gamma (fewer "widget" each); only Gamma holds what the reader is after.
const DOC = `# Widgets

## Alpha

widget widget widget widget alpha. ${PAD}

## Beta

widget widget beta. ${PAD}

## Gamma

widget gamma. The torque limit is 12 Nm. ${PAD}
`

let root: string
const open: Library[] = []
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'markindex-rerank-'))
  const file = join(root, 'docs', 'widgets.md')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, DOC)
  const store = openStore(join(root, '.markindex', 'index.db'))
  await indexLibrary({ root, store })
  store.close()
})
afterEach(() => {
  for (const l of open.splice(0)) l.close()
  rmSync(root, { recursive: true, force: true })
})

interface Seen { question: string; passages: string[] }
/** Scores a passage 0.9 when it mentions the torque limit, else 0.1, and records what it was asked. */
function fake(seen: Seen[] = []): Reranker {
  return {
    name: 'fake',
    async score(question, candidates) {
      seen.push({ question, passages: candidates.map((c) => c.passage) })
      return candidates.map((c) => (c.passage.includes('torque limit') ? 0.9 : 0.1))
    },
  }
}
const lib = (rerank?: Parameters<typeof openLibrary>[0]['rerank']) => {
  const l = openLibrary({ root, rerank })
  open.push(l)
  return l
}
type Json = any
const search = async (l: Library, args: unknown): Promise<Json> => JSON.parse(await l.callTool('search_documents', args))
const titles = (env: Json): string[] => env.data.results.map((r: Json) => r.title_path.at(-1))

describe('search_documents with a reranker', () => {
  it('returns the best-scored nodes first, cut to limit, with their relevance', async () => {
    const seen: Seen[] = []
    const plain = await search(lib(), { query: 'widget' })
    expect(titles(plain).slice(0, 3)).toEqual(['Alpha', 'Beta', 'Gamma'])

    const env = await search(lib({ reranker: fake(seen) }), { query: 'widget', limit: 1 })
    expect(env.success).toBe(true)
    expect(titles(env)).toEqual(['Gamma'])
    expect(env.data.results[0]).toMatchObject({ doc_path: 'docs/widgets.md', relevance: 0.9, via: 'bm25' })
    expect(env.data.rerank).toEqual({ by: 'fake', candidates: plain.data.results.length, scored: plain.data.results.length })
    expect(env.next_steps.summary).toBe('Found 1 matching node(s).')
    // the reranker saw more candidates than were asked for, each with its document, title path and text
    expect(seen[0]!.passages.length).toBeGreaterThan(1)
    expect(seen[0]!.passages.find((p) => p.includes('Gamma'))).toMatch(/^Document: docs\/widgets\.md\nSection: Widgets > Gamma\n\n## Gamma/)
  })

  it('judges the passages against `intent` when it is given, else against the query', async () => {
    const seen: Seen[] = []
    const l = lib({ reranker: fake(seen) })
    await search(l, { query: 'widget' })
    await search(l, { query: 'widget', intent: 'What is the torque limit of the widget?' })
    expect(seen.map((s) => s.question)).toEqual(['widget', 'What is the torque limit of the widget?'])
  })

  it('asks for at most `pool` candidates', async () => {
    const seen: Seen[] = []
    await search(lib({ reranker: fake(seen), pool: 2 }), { query: 'widget', limit: 1 })
    expect(seen[0]!.passages).toHaveLength(2)
  })

  it('keeps the keyword order when the reranker fails', async () => {
    const plain = await search(lib(), { query: 'widget', limit: 2 })
    const broken: Reranker = { name: 'broken', score: async () => { throw new Error('boom') } }
    const env = await search(lib({ reranker: broken }), { query: 'widget', limit: 2 })
    expect(env.success).toBe(true)
    expect(titles(env)).toEqual(titles(plain))
    expect(env.data.rerank).toMatchObject({ by: 'broken', scored: 0 })
    expect(env.data.results[0]).not.toHaveProperty('relevance')
  })

  it('keeps the keyword order when the reranker does not answer in time', async () => {
    const plain = await search(lib(), { query: 'widget', limit: 2 })
    const stuck: Reranker = { name: 'stuck', score: () => new Promise(() => {}) }
    const t0 = Date.now()
    const env = await search(lib({ reranker: stuck, timeoutMs: 50 }), { query: 'widget', limit: 2 })
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(titles(env)).toEqual(titles(plain))
    expect(env.data.rerank).toMatchObject({ scored: 0 })
  })

  it('puts unscored candidates after the scored ones', async () => {
    // only the Beta section itself is scored (the passage of the top node holds the text of all three)
    const partial: Reranker = { name: 'partial', score: async (_q, c) => c.map((x) => (x.passage.includes('\nSection: Widgets > Beta\n') ? 0.4 : null)) }
    const env = await search(lib({ reranker: partial }), { query: 'widget', limit: 3 })
    expect(titles(env)).toEqual(['Beta', 'Alpha', 'Gamma'])
    expect(env.data.rerank).toMatchObject({ scored: 1 })
  })

  it('does not call the reranker for invalid arguments, an unknown scope or no hits', async () => {
    const seen: Seen[] = []
    const l = lib({ reranker: fake(seen) })
    expect(await search(l, { query: '' })).toMatchObject({ success: false, code: 'INVALID_INPUT' })
    expect(await search(l, { query: 'widget', nope: 1 })).toMatchObject({ success: false, code: 'INVALID_INPUT' })
    expect(await search(l, { query: 'widget', doc_path: 'nope.md' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
    const none = await search(l, { query: 'zzzqqqxxx' })
    expect(none.data.results).toEqual([])
    expect(none.data).not.toHaveProperty('rerank')
    expect(seen).toEqual([])
  })

  it('leaves the other tools as they are', async () => {
    const a = await lib().callTool('browse_documents', {})
    const b = await lib({ reranker: fake() }).callTool('browse_documents', {})
    expect(b).toBe(a)
  })
})

describe('the `intent` argument', () => {
  it('exists only when a reranker is configured', async () => {
    const plain = lib()
    expect(plain.contract).toBe(TOOL_CONTRACT)
    expect(await search(plain, { query: 'widget', intent: 'x' })).toMatchObject({ success: false, code: 'INVALID_INPUT' })

    const reranked = lib({ reranker: fake() })
    expect(Object.keys(reranked.contract.search_documents.input.shape)).toContain('intent')
    expect(reranked.contract.search_documents.description).toMatch(/`intent`/)
    expect(reranked.contract.browse_documents).toBe(TOOL_CONTRACT.browse_documents)
  })

  it('is listed by the MCP server and the AI SDK tools of a reranked library', async () => {
    const l = lib({ reranker: fake() })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0' })
    await Promise.all([createMcpServer(l).connect(a), client.connect(b)])
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'search_documents')!
      expect(Object.keys((tool.inputSchema as { properties: object }).properties).sort()).toEqual(['doc_path', 'folder', 'intent', 'limit', 'query'])
      expect((tool.inputSchema as { required?: string[] }).required).toEqual(['query'])
      const res = await client.callTool({ name: 'search_documents', arguments: { query: 'widget', intent: 'torque limit?', limit: 1 } })
      expect(res.isError).toBe(false)
      expect(JSON.parse((res.content as { text: string }[])[0]!.text).data.results[0].title_path.at(-1)).toBe('Gamma')
    } finally {
      await client.close()
    }
    const sdk = createAiSdkTools(l)
    expect(sdk.search_documents.description).toMatch(/`intent`/)
  })
})
