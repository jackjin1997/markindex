import { approxTokens } from '../text/tokens.js'

export interface RateLimitOptions {
  /** Max LLM requests started in any 60 s window. */
  requestsPerMinute?: number
  /** Max estimated input tokens sent in any 60 s window (estimated with `approxTokens`). */
  inputTokensPerMinute?: number
}

export interface RateLimiter {
  /**
   * Resolves once a request of `inputTokens` estimated tokens may start, and reserves its slot. Callers are served
   * strictly in arrival order. A single request larger than `inputTokensPerMinute` is let through when no other
   * tokens are in the window (it then occupies the whole window), so it can never deadlock.
   */
  acquire(inputTokens: number): Promise<void>
}

/** Injectable for tests. */
export interface RateLimiterClock {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const WINDOW_MS = 60_000

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function checkLimit(name: string, value: number | undefined) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`${name} must be an integer >= 1, got ${value}`)
}

/** Sliding-window limiter (requests and estimated input tokens over the last 60 s) with a FIFO queue. No dependencies. */
export function createRateLimiter(opts: RateLimitOptions, clock: RateLimiterClock = {}): RateLimiter {
  checkLimit('requestsPerMinute', opts.requestsPerMinute)
  checkLimit('inputTokensPerMinute', opts.inputTokensPerMinute)
  const rpm = opts.requestsPerMinute
  const tpm = opts.inputTokensPerMinute
  const now = clock.now ?? (() => performance.now())
  const sleep = clock.sleep ?? defaultSleep
  let log: { t: number; tokens: number }[] = []
  let tail: Promise<void> = Promise.resolve()

  const fits = (at: number, tokens: number): boolean => {
    let requests = 0
    let used = 0
    for (const r of log) {
      if (r.t + WINDOW_MS > at) {
        requests++
        used += r.tokens
      }
    }
    if (rpm !== undefined && requests + 1 > rpm) return false
    if (tpm !== undefined && used > 0 && used + tokens > tpm) return false
    return true
  }

  /** Earliest time at which the request fits: now, or the moment an entry leaves the window. */
  const waitMs = (tokens: number): number => {
    const t = now()
    if (fits(t, tokens)) return 0
    for (const r of log) {
      const at = r.t + WINDOW_MS
      if (at > t && fits(at, tokens)) return at - t
    }
    throw new Error('rate limiter: no admissible time found (internal error)') // unreachable: the window empties after 60 s
  }

  const take = async (tokens: number) => {
    for (;;) {
      const wait = waitMs(tokens)
      if (wait <= 0) break
      await sleep(wait)
    }
    const t = now()
    log = log.filter((r) => r.t + WINDOW_MS > t)
    log.push({ t, tokens })
  }

  return {
    acquire(inputTokens) {
      if (rpm === undefined && tpm === undefined) return Promise.resolve()
      const run = tail.then(() => take(Math.max(0, inputTokens)))
      tail = run.catch(() => undefined)
      return run
    },
  }
}

const shared = new WeakMap<RateLimitOptions, RateLimiter | undefined>()

/**
 * One limiter per options object, so every call that receives the same `rateLimit` object (all documents of an index
 * run, all questions of an eval run) draws from the same budget. Undefined when no limit is set.
 */
export function rateLimiterFor(opts: RateLimitOptions | undefined): RateLimiter | undefined {
  if (!opts) return undefined
  if (!shared.has(opts)) {
    shared.set(opts, opts.requestsPerMinute === undefined && opts.inputTokensPerMinute === undefined ? undefined : createRateLimiter(opts))
  }
  return shared.get(opts)
}

/** Estimated input tokens of anything that will be sent to the model (strings as-is, other values as JSON). */
export const estimateInputTokens = (value: unknown): number => approxTokens(typeof value === 'string' ? value : JSON.stringify(value) ?? '')

function parsePositiveInt(v: string, flag: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be an integer >= 1, got "${v}"`)
  return n
}

/** CLI helper: `{ rpm, tpm }` strings from the option flags -> `RateLimitOptions` (undefined when neither is set). */
export function parseRateLimit(o: { rpm?: string; tpm?: string }, rpmFlag: string, tpmFlag: string): RateLimitOptions | undefined {
  if (o.rpm === undefined && o.tpm === undefined) return undefined
  return {
    ...(o.rpm !== undefined ? { requestsPerMinute: parsePositiveInt(o.rpm, rpmFlag) } : {}),
    ...(o.tpm !== undefined ? { inputTokensPerMinute: parsePositiveInt(o.tpm, tpmFlag) } : {}),
  }
}
