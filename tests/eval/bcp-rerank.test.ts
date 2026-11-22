import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bestWindow,
  buildJevBody,
  jevConfigFromEnv,
  jevScorer,
  ndcgAt,
  orderByScore,
  overlapScorer,
  parseJevAnswer,
  queryTerms,
  recallAt,
} from '../../eval/bcp/rerank.js'

describe('passages', () => {
  it('queryTerms keeps distinct words of four or more characters', () => {
    expect(queryTerms('The film, the FILM of 1987 and its director')).toEqual(['film', '1987', 'director'])
  })

  it('bestWindow returns short text whole and otherwise the stretch with the most terms', () => {
    expect(bestWindow('short text', ['text'], 100)).toBe('short text')
    const text = `${'x'.repeat(400)} alpha ${'y'.repeat(400)} alpha beta gamma ${'z'.repeat(400)}`
    const win = bestWindow(text, ['alpha', 'beta', 'gamma'], 200)
    expect(win.length).toBeLessThanOrEqual(200)
    expect(win).toContain('beta')
    expect(win).toContain('gamma')
  })
})

describe('ranking and metrics', () => {
  it('orderByScore sorts best first, keeps ties and unscored items in their original order', () => {
    expect(orderByScore(['a', 'b', 'c', 'd', 'e'], [0.2, null, 0.9, 0.2, null])).toEqual(['c', 'a', 'd', 'b', 'e'])
  })

  it('recallAt and ndcgAt', () => {
    const relevant = new Set(['r1', 'r2'])
    expect(recallAt(['x', 'r1', 'y', 'r2'], relevant, 2)).toBe(0.5)
    expect(recallAt(['x', 'r1', 'y', 'r2'], relevant, 10)).toBe(1)
    expect(recallAt(['x'], new Set(), 10)).toBe(0)
    expect(ndcgAt(['r1', 'r2', 'x'], relevant, 10)).toBeCloseTo(1)
    expect(ndcgAt(['x', 'r1'], relevant, 10)).toBeCloseTo((1 / Math.log2(3)) / (1 + 1 / Math.log2(3)))
  })
})

describe('jev', () => {
  it('reads the endpoint from the environment, most specific first', () => {
    expect(jevConfigFromEnv({ TYPESAFE_API_KEY: 'k1' })).toMatchObject({ via: 'typesafe', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' })
    expect(jevConfigFromEnv({ OPENROUTER_API_KEY: 'k2' })).toMatchObject({ via: 'openrouter', url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.14' })
    expect(jevConfigFromEnv({ TYPESAFE_API_KEY: 'k1', JEV_BASE_URL: 'http://x/y', JEV_API_KEY: 'k3', JEV_MODEL: 'm' })).toMatchObject({ via: 'custom', key: 'k3', model: 'm' })
    expect(() => jevConfigFromEnv({ TYPESAFE_API_KEY: '  ' })).toThrow(/TYPESAFE_API_KEY/)
  })

  it('builds the documented request and reads the documented answer', () => {
    expect(buildJevBody('jev-latest', 'q?', 'p')).toEqual({
      model: 'jev-latest',
      state: { question: 'q?', passage: 'p' },
      questions: { relevant: { type: 'noul', instructions: expect.stringContaining('`passage`') } },
    })
    expect(parseJevAnswer({ model: 'jev-1.14.0', answers: { relevant: { type: 'noul', noul: 0.98 } }, usage: { input_tokens: 120 } })).toBe(0.98)
    expect(parseJevAnswer({ answers: { relevant: { type: 'choice', choice: 'x' } } })).toBeNull()
    expect(parseJevAnswer({ detail: 'bad request' })).toBeNull()
    expect(parseJevAnswer(null)).toBeNull()
  })

  it('scores every candidate, retries a 429, gives null on a 400 and reuses cached scores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'markindex-jev-'))
    const cacheFile = join(dir, 'scores.jsonl')
    const config = { url: 'http://jev.test/v1/systemone', key: 'secret-key', model: 'jev-test', via: 'custom' as const }
    const seen: { auth: string | null; passage: string }[] = []
    let limited = false
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { state: { passage: string } }
      seen.push({ auth: new Headers(init!.headers).get('authorization'), passage: body.state.passage })
      if (body.state.passage === 'bad') return new Response(JSON.stringify({ detail: 'nope' }), { status: 400 })
      if (body.state.passage === 'busy' && !limited) {
        limited = true
        return new Response('', { status: 429, headers: { 'retry-after': '0.01' } })
      }
      const noul = body.state.passage === 'good' ? 0.9 : 0.1
      return new Response(JSON.stringify({ model: 'jev-test-1', answers: { relevant: { type: 'noul', noul } }, usage: { input_tokens: 7 } }))
    }) as typeof fetch
    try {
      const cands = ['good', 'bad', 'busy'].map((p) => ({ id: p, passage: p }))
      const first = jevScorer({ config, cacheFile, fetchFn, concurrency: 1 })
      expect(await first.score('q?', cands)).toEqual([0.9, null, 0.1])
      expect(first.stats()).toMatchObject({ calls: 2, failed: 1, inputTokens: 14, model: 'jev-test-1' })
      expect(seen.every((s) => s.auth === 'Bearer secret-key')).toBe(true)
      expect(seen.filter((s) => s.passage === 'busy')).toHaveLength(2)
      expect(readFileSync(cacheFile, 'utf8')).not.toContain('secret-key')

      const calls = seen.length
      const second = jevScorer({ config, cacheFile, fetchFn, concurrency: 1 })
      expect(await second.score('q?', cands.filter((c) => c.id !== 'bad'))).toEqual([0.9, 0.1])
      expect(second.stats()).toMatchObject({ calls: 0, cached: 2 })
      expect(seen).toHaveLength(calls)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('overlapScorer', () => {
  it('scores by the share of question terms in the passage', async () => {
    expect(await overlapScorer().score('alpha beta gamma delta', [{ id: 'a', passage: 'Alpha and beta' }, { id: 'b', passage: 'none' }])).toEqual([0.5, 0])
  })
})
