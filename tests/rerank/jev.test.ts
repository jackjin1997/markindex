import { describe, expect, it } from 'vitest'
import { jevConfigFromEnv, jevReranker } from '../../src/rerank/jev.js'

const config = { url: 'http://jev.test/v1/systemone', key: 'secret-key', model: 'jev-test', via: 'custom' as const }
const cands = (...passages: string[]) => passages.map((p) => ({ id: p, passage: p }))

describe('jevReranker', () => {
  it('asks one yes/no question per candidate and returns the probability of yes', async () => {
    const seen: { url: string; auth: string | null; body: { model: string; state: { question: string; passage: string }; questions: Record<string, { type: string }> } }[] = []
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body))
      seen.push({ url: String(url), auth: new Headers(init!.headers).get('authorization'), body })
      return new Response(JSON.stringify({ answers: { relevant: { type: 'noul', noul: body.state.passage === 'good' ? 0.9 : 0.2 } } }))
    }) as typeof fetch
    const rr = jevReranker({ config, fetchFn })
    expect(rr.name).toBe('jev:custom:jev-test')
    expect(await rr.score('what is asked?', cands('good', 'other'))).toEqual([0.9, 0.2])
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ url: config.url, auth: 'Bearer secret-key', body: { model: 'jev-test', state: { question: 'what is asked?', passage: 'good' } } })
    expect(seen[0]!.body.questions.relevant!.type).toBe('noul')
  })

  it('retries a rate-limited request and gives null for a refused one, without rejecting', async () => {
    let busy = 0
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const { state } = JSON.parse(String(init!.body)) as { state: { passage: string } }
      if (state.passage === 'refused') return new Response('{"detail":"no"}', { status: 400 })
      if (state.passage === 'down') throw new Error('network down')
      if (state.passage === 'busy' && busy++ === 0) return new Response('', { status: 429, headers: { 'retry-after': '0.01' } })
      return new Response(JSON.stringify({ answers: { relevant: { type: 'noul', noul: 0.5 } } }))
    }) as typeof fetch
    const rr = jevReranker({ config, fetchFn, retries: 1 })
    expect(await rr.score('q?', cands('busy', 'refused', 'down', 'fine'))).toEqual([0.5, null, null, 0.5])
    expect(busy).toBe(2)
  })

  it('stops sending requests once the signal is aborted', async () => {
    let calls = 0
    const ac = new AbortController()
    const fetchFn = (async () => {
      calls++
      ac.abort()
      return new Response(JSON.stringify({ answers: { relevant: { type: 'noul', noul: 0.7 } } }))
    }) as typeof fetch
    const rr = jevReranker({ config, fetchFn, concurrency: 1 })
    expect(await rr.score('q?', cands('a', 'b', 'c'), { signal: ac.signal })).toEqual([0.7, null, null])
    expect(calls).toBe(1)
  })
})

describe('jevConfigFromEnv', () => {
  it('reads the endpoint from the environment and names the variables when none is set', () => {
    expect(jevConfigFromEnv({ TYPESAFE_API_KEY: 'k' })).toMatchObject({ via: 'typesafe', url: 'https://api.typesafe.ai/v1/systemone' })
    expect(() => jevConfigFromEnv({})).toThrow(/TYPESAFE_API_KEY/)
  })
})
