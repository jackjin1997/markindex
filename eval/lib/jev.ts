/**
 * Minimal client for TypeSafe's Jev decision model (docs.typesafe.ai/api), for evaluation scripts.
 *
 * One request carries a `state` and one question; the answer comes back typed (`noul`: probability of yes,
 * `choice`: a probability per option). Answers are cached in an append-only JSONL file keyed by a hash of model,
 * state and question, so a re-run is free. The key is read from the environment (see ../bcp/rerank.ts) and is
 * never written anywhere.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { jevConfigFromEnv, type JevConfig } from '../bcp/rerank.js'

export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }

export interface JevAnswer {
  type: string
  noul?: number
  choice?: string
  confidence?: number
  probabilities?: Record<string, number>
}

export interface JevStats { calls: number; cached: number; failed: number; inputTokens: number; callMs: number; model?: string }

export interface JevClient {
  readonly model: string
  /** The typed answer, or null when the request failed after retries. */
  ask(state: unknown, question: JevQuestion): Promise<JevAnswer | null>
  stats(): JevStats
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function jevClient(opts: { config?: JevConfig; cacheFile?: string; concurrency?: number; fetchFn?: typeof fetch } = {}): JevClient {
  const cfg = opts.config ?? jevConfigFromEnv()
  const doFetch = opts.fetchFn ?? fetch
  const limit = opts.concurrency ?? (Number(process.env.JEV_CONCURRENCY) || 12)
  const cache = new Map<string, JevAnswer>()
  if (opts.cacheFile && existsSync(opts.cacheFile)) {
    for (const line of readFileSync(opts.cacheFile, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const c = JSON.parse(line) as { k: string; a: JevAnswer }
        cache.set(c.k, c.a)
      } catch {
        // a line cut short by a concurrent writer: ignore it
      }
    }
  }
  const st: JevStats = { calls: 0, cached: 0, failed: 0, inputTokens: 0, callMs: 0 }
  // Identical questions asked at the same moment share one request: Jev's probabilities vary a little from call
  // to call, and two answers for one key would make a re-run from the cache differ from the first run.
  const inflight = new Map<string, Promise<JevAnswer | null>>()

  // At most `limit` requests in flight, whoever calls ask().
  let active = 0
  const waiting: (() => void)[] = []
  const acquire = async () => {
    if (active >= limit) await new Promise<void>((r) => waiting.push(r))
    active++
  }
  const release = () => {
    active--
    waiting.shift()?.()
  }

  const request = async (body: string): Promise<JevAnswer | null> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const t0 = Date.now()
      try {
        const res = await doFetch(cfg.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(45_000),
        })
        st.callMs += Date.now() - t0
        if (res.status === 429 || res.status >= 500) {
          await sleep(Math.min(Number(res.headers.get('retry-after')) * 1000 || 500 * 2 ** attempt, 20_000))
          continue
        }
        if (!res.ok) return null // a 4xx will not get better on retry
        const json = (await res.json()) as { model?: string; answers?: { q?: JevAnswer }; usage?: { input_tokens?: number } }
        const a = json.answers?.q
        if (!a || typeof a.type !== 'string') return null
        st.calls++
        st.inputTokens += json.usage?.input_tokens ?? 0
        st.model = json.model ?? st.model
        return a
      } catch {
        st.callMs += Date.now() - t0
        await sleep(500 * 2 ** attempt)
      }
    }
    return null
  }

  return {
    model: cfg.model,
    async ask(state, question) {
      const k = createHash('sha256').update(JSON.stringify([cfg.model, state, question])).digest('hex')
      const hit = cache.get(k)
      if (hit) {
        st.cached++
        return hit
      }
      const pending = inflight.get(k)
      if (pending) return pending
      const run = (async () => {
        await acquire()
        try {
          const a = await request(JSON.stringify({ model: cfg.model, state, questions: { q: question } }))
          if (a === null) {
            st.failed++
            return null
          }
          cache.set(k, a)
          if (opts.cacheFile) appendFileSync(opts.cacheFile, `${JSON.stringify({ k, a })}\n`)
          return a
        } finally {
          release()
          inflight.delete(k)
        }
      })()
      inflight.set(k, run)
      return run
    },
    stats: () => ({ ...st }),
  }
}
