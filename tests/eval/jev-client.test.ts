import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { jevClient } from '../../eval/lib/jev.js'

describe('jevClient', () => {
  it('answers one question or several per request and reuses cached answers of both kinds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'markindex-jevclient-'))
    const cacheFile = join(dir, 'answers.jsonl')
    const config = { url: 'http://jev.test/v1/systemone', key: 'secret-key', model: 'jev-test', via: 'custom' as const }
    const bodies: { questions: Record<string, unknown> }[] = []
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { questions: Record<string, unknown> }
      bodies.push(body)
      const names = Object.keys(body.questions)
      // the second request of the test gets an answer short of one name
      const answered = bodies.length === 2 ? names.slice(1) : names
      const answers = Object.fromEntries(answered.map((n, i) => [n, { type: 'noul', noul: (i + 1) / 10 }]))
      return new Response(JSON.stringify({ model: 'jev-test-1', answers, usage: { input_tokens: 5 } }))
    }) as typeof fetch
    const noul = { type: 'noul' as const, instructions: 'x?' }
    try {
      const first = jevClient({ config, cacheFile, fetchFn })
      expect(await first.ask({ a: 1 }, noul)).toMatchObject({ noul: 0.1 })
      expect(await first.askMany({ a: 1 }, { s1: noul, s2: noul })).toBeNull()
      expect(await first.askMany({ a: 2 }, { s1: noul, s2: noul })).toMatchObject({ s1: { noul: 0.1 }, s2: { noul: 0.2 } })
      expect(first.stats()).toMatchObject({ calls: 2, failed: 1, inputTokens: 10 })
      expect(Object.keys(bodies[2]!.questions)).toEqual(['s1', 's2'])
      expect(readFileSync(cacheFile, 'utf8')).not.toContain('secret-key')

      const second = jevClient({ config, cacheFile, fetchFn })
      expect(await second.ask({ a: 1 }, noul)).toMatchObject({ noul: 0.1 })
      expect(await second.askMany({ a: 2 }, { s1: noul, s2: noul })).toMatchObject({ s2: { noul: 0.2 } })
      expect(second.stats()).toMatchObject({ calls: 0, cached: 2 })
      expect(bodies).toHaveLength(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
