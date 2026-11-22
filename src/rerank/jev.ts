/**
 * Reranker backed by TypeSafe's Jev, a hosted decision model that answers a yes/no question with a probability
 * and generates no text (docs.typesafe.ai/api). One request per candidate. Using it sends the search question
 * and the text of the candidate sections to the endpoint in `JevConfig.url`.
 */
import type { RerankCandidate, Reranker } from './types.js'

export const JEV_INSTRUCTIONS =
  'Does `passage` contain information that helps answer `question`, or that confirms one of the facts `question` describes?'

export interface JevConfig {
  url: string
  key: string
  model: string
  via: 'typesafe' | 'openrouter' | 'custom'
}

/**
 * Endpoint and key from the environment, most specific first:
 *   JEV_BASE_URL + JEV_API_KEY   any compatible endpoint
 *   TYPESAFE_API_KEY             https://api.typesafe.ai/v1/systemone
 *   OPENROUTER_API_KEY           https://openrouter.ai/api/alpha/decisions
 * JEV_MODEL overrides the model name.
 */
export function jevConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JevConfig {
  const model = env.JEV_MODEL?.trim()
  if (env.JEV_BASE_URL?.trim() && env.JEV_API_KEY?.trim()) {
    return { url: env.JEV_BASE_URL.trim(), key: env.JEV_API_KEY.trim(), model: model || 'jev-latest', via: 'custom' }
  }
  if (env.TYPESAFE_API_KEY?.trim()) {
    return { url: 'https://api.typesafe.ai/v1/systemone', key: env.TYPESAFE_API_KEY.trim(), model: model || 'jev-latest', via: 'typesafe' }
  }
  if (env.OPENROUTER_API_KEY?.trim()) {
    return { url: 'https://openrouter.ai/api/alpha/decisions', key: env.OPENROUTER_API_KEY.trim(), model: model || 'typesafe/jev-1.14', via: 'openrouter' }
  }
  throw new Error('No key for the Jev scorer: set TYPESAFE_API_KEY, or OPENROUTER_API_KEY, or JEV_BASE_URL with JEV_API_KEY')
}

export function buildJevBody(model: string, question: string, passage: string) {
  return {
    model,
    state: { question, passage },
    questions: { relevant: { type: 'noul', instructions: JEV_INSTRUCTIONS } },
  }
}

/** P(yes) of the `relevant` question, or null when the response has another shape. */
export function parseJevAnswer(body: unknown): number | null {
  const noul = (body as { answers?: { relevant?: { noul?: unknown } } } | null)?.answers?.relevant?.noul
  return typeof noul === 'number' && noul >= 0 && noul <= 1 ? noul : null
}

export interface JevRerankerOptions {
  /** Defaults to `jevConfigFromEnv()`. */
  config?: JevConfig
  /** Requests in flight at once (default 12). */
  concurrency?: number
  /** Extra attempts after a 429, a 5xx or a network error (default 2). */
  retries?: number
  /** Time allowed for one request, in ms (default 10000). */
  requestTimeoutMs?: number
  fetchFn?: typeof fetch
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })

/** Never rejects: a candidate whose request fails, or that is not reached before `signal` aborts, scores null. */
export function jevReranker(opts: JevRerankerOptions = {}): Reranker {
  const cfg = opts.config ?? jevConfigFromEnv()
  const doFetch = opts.fetchFn ?? fetch
  const concurrency = Math.max(1, opts.concurrency ?? 12)
  const retries = Math.max(0, opts.retries ?? 2)
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000

  const one = async (question: string, c: RerankCandidate, signal?: AbortSignal): Promise<number | null> => {
    const body = JSON.stringify(buildJevBody(cfg.model, question, c.passage))
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal?.aborted) return null
      const timeout = AbortSignal.timeout(requestTimeoutMs)
      try {
        const res = await doFetch(cfg.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
          body,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
        if (res.status === 429 || res.status >= 500) {
          await sleep(Math.min(Number(res.headers.get('retry-after')) * 1000 || 300 * 2 ** attempt, 5_000), signal)
          continue
        }
        if (!res.ok) return null // a 4xx will not get better on retry
        return parseJevAnswer(await res.json())
      } catch {
        await sleep(300 * 2 ** attempt, signal)
      }
    }
    return null
  }

  return {
    name: `jev:${cfg.via}:${cfg.model}`,
    async score(question, candidates, o) {
      const out = new Array<number | null>(candidates.length).fill(null)
      let next = 0
      const worker = async () => {
        while (next < candidates.length && !o?.signal?.aborted) {
          const i = next++
          out[i] = await one(question, candidates[i]!, o?.signal)
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker))
      return out
    },
  }
}
