/**
 * Reranking of MarkIndex search hits with a decision model, for evaluation only (nothing here ships in the package).
 *
 * The scorer asks one yes/no question per candidate passage and sorts by the probability of "yes". The model is
 * TypeSafe's Jev: a non-generative model that returns typed answers with probabilities (docs.typesafe.ai/api).
 * `overlap` is a term-overlap scorer with no network access, used to test the plumbing.
 *
 * Keys are read from the environment and are never written anywhere:
 *   TYPESAFE_API_KEY                  → https://api.typesafe.ai/v1/systemone
 *   OPENROUTER_API_KEY                → https://openrouter.ai/api/alpha/decisions
 *   JEV_BASE_URL + JEV_API_KEY        → any compatible endpoint
 *   JEV_MODEL, JEV_CONCURRENCY        → optional overrides
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { JEV_INSTRUCTIONS, buildJevBody, jevConfigFromEnv, parseJevAnswer, type JevConfig } from '../../src/rerank/jev.js'
import { queryTerms } from '../../src/rerank/passages.js'

export interface Candidate {
  id: string
  passage: string
}

export interface ScorerStats {
  calls: number
  cached: number
  failed: number
  inputTokens: number
  /** Sum of the wall-clock time of the network calls, in ms (calls overlap, so this is not elapsed time). */
  callMs: number
  model?: string
}

export interface Scorer {
  readonly name: string
  /** One score per candidate in [0, 1], or null when the candidate could not be scored. */
  score(question: string, candidates: Candidate[]): Promise<(number | null)[]>
  stats(): ScorerStats
}

// ── passages and ordering (shared with the package's optional reranking of search results) ──

export { bestWindow, orderByScore, queryTerms } from '../../src/rerank/passages.js'

// ── metrics ──

export function recallAt(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0
  return ranked.slice(0, k).filter((d) => relevant.has(d)).length / relevant.size
}

/** nDCG@k with binary gains. */
export function ndcgAt(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0
  const dcg = ranked.slice(0, k).reduce((s, d, i) => s + (relevant.has(d) ? 1 / Math.log2(i + 2) : 0), 0)
  let ideal = 0
  for (let i = 0; i < Math.min(k, relevant.size); i++) ideal += 1 / Math.log2(i + 2)
  return dcg / ideal
}

// ── Jev ──

export { JEV_INSTRUCTIONS, buildJevBody, jevConfigFromEnv, parseJevAnswer, type JevConfig } from '../../src/rerank/jev.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Runs `fn` over `items` with at most `limit` in flight; results keep the order of `items`. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

interface CacheLine { k: string; s: number; m?: string; t?: number }

/**
 * Jev over HTTP, one request per candidate (each question then sees one passage and nothing else). Scores are kept
 * in an append-only JSONL file keyed by a hash of model, instructions, question and passage, so a re-run costs
 * nothing and several processes can share the file.
 */
export function jevScorer(opts: { config?: JevConfig; cacheFile?: string; concurrency?: number; fetchFn?: typeof fetch } = {}): Scorer {
  const cfg = opts.config ?? jevConfigFromEnv()
  const doFetch = opts.fetchFn ?? fetch
  const concurrency = opts.concurrency ?? (Number(process.env.JEV_CONCURRENCY) || 12)
  const cache = new Map<string, number>()
  if (opts.cacheFile && existsSync(opts.cacheFile)) {
    for (const line of readFileSync(opts.cacheFile, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const c = JSON.parse(line) as CacheLine
        cache.set(c.k, c.s)
      } catch {
        // a line cut short by a concurrent writer: ignore it
      }
    }
  }
  const st: ScorerStats = { calls: 0, cached: 0, failed: 0, inputTokens: 0, callMs: 0 }
  const keyOf = (question: string, passage: string) =>
    createHash('sha256').update([cfg.model, JEV_INSTRUCTIONS, question, passage].join('\0')).digest('hex')

  const one = async (question: string, c: Candidate): Promise<number | null> => {
    const k = keyOf(question, c.passage)
    const hit = cache.get(k)
    if (hit !== undefined) {
      st.cached++
      return hit
    }
    const body = JSON.stringify(buildJevBody(cfg.model, question, c.passage))
    for (let attempt = 0; attempt < 5; attempt++) {
      const t0 = Date.now()
      try {
        const res = await doFetch(cfg.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(30_000),
        })
        st.callMs += Date.now() - t0
        if (res.status === 429 || res.status >= 500) {
          const wait = Number(res.headers.get('retry-after')) * 1000 || 500 * 2 ** attempt
          await sleep(Math.min(wait, 20_000))
          continue
        }
        if (!res.ok) break // a 4xx will not get better on retry
        const json = (await res.json()) as { model?: string; usage?: { input_tokens?: number } }
        const s = parseJevAnswer(json)
        if (s === null) break
        st.calls++
        st.inputTokens += json.usage?.input_tokens ?? 0
        st.model = json.model ?? st.model
        cache.set(k, s)
        if (opts.cacheFile) appendFileSync(opts.cacheFile, `${JSON.stringify({ k, s, m: json.model, t: json.usage?.input_tokens } satisfies CacheLine)}\n`)
        return s
      } catch {
        st.callMs += Date.now() - t0
        await sleep(500 * 2 ** attempt)
      }
    }
    st.failed++
    return null
  }

  return {
    name: `jev:${cfg.via}:${cfg.model}`,
    score: (question, candidates) => mapLimit(candidates, concurrency, (c) => one(question, c)),
    stats: () => ({ ...st }),
  }
}

/** Share of the question's terms that occur in the passage. No model, no network: for testing the plumbing. */
export function overlapScorer(): Scorer {
  const st: ScorerStats = { calls: 0, cached: 0, failed: 0, inputTokens: 0, callMs: 0 }
  return {
    name: 'overlap',
    async score(question, candidates) {
      const terms = queryTerms(question)
      st.calls += candidates.length
      return candidates.map((c) => {
        if (terms.length === 0) return 0
        const lower = c.passage.toLowerCase()
        return terms.filter((t) => lower.includes(t)).length / terms.length
      })
    },
    stats: () => ({ ...st }),
  }
}

export function makeScorer(name: string, cacheFile?: string): Scorer {
  if (name === 'overlap') return overlapScorer()
  if (name === 'jev') return jevScorer({ cacheFile })
  throw new Error(`unknown scorer "${name}" (jev | overlap)`)
}
