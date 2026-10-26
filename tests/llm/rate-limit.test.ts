import { describe, expect, it } from 'vitest'
import { createRateLimiter, parseRateLimit, rateLimiterFor } from '../../src/llm/rate-limit.js'

/** Fake clock: `sleep` advances time instantly, so waits are deterministic. */
function fakeClock() {
  let t = 1_000_000
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    advance: (ms: number) => void (t += ms),
    sleeps,
  }
}

describe('createRateLimiter', () => {
  it('lets requests through immediately while under the limit', async () => {
    const c = fakeClock()
    const l = createRateLimiter({ requestsPerMinute: 3 }, c)
    await l.acquire(1)
    await l.acquire(1)
    await l.acquire(1)
    expect(c.sleeps).toEqual([])
  })

  it('respects requests per minute: the 3rd call in a 60 s window waits for the 1st to expire', async () => {
    const c = fakeClock()
    const l = createRateLimiter({ requestsPerMinute: 2 }, c)
    const stamps: number[] = []
    for (let i = 0; i < 5; i++) {
      await l.acquire(1)
      stamps.push(c.now())
    }
    const t0 = stamps[0]!
    expect(stamps.map((s) => s - t0)).toEqual([0, 0, 60_000, 60_000, 120_000])
  })

  it('never has more than rpm calls in any 60 s window', async () => {
    const c = fakeClock()
    const l = createRateLimiter({ requestsPerMinute: 3 }, c)
    const stamps: number[] = []
    for (let i = 0; i < 10; i++) {
      await l.acquire(1)
      stamps.push(c.now())
      c.advance(7_000)
    }
    for (let i = 3; i < stamps.length; i++) expect(stamps[i]! - stamps[i - 3]!).toBeGreaterThanOrEqual(60_000)
  })

  it('respects input tokens per minute', async () => {
    const c = fakeClock()
    const l = createRateLimiter({ inputTokensPerMinute: 1000 }, c)
    const stamps: number[] = []
    for (const tokens of [600, 300, 200, 500, 500]) {
      await l.acquire(tokens)
      stamps.push(c.now())
    }
    const t0 = stamps[0]!
    // 600+300 fit; +200 needs the first window to expire; +500 fits beside the 200; the last 500 needs the 200 to expire too.
    expect(stamps.map((s) => s - t0)).toEqual([0, 0, 60_000, 60_000, 120_000])
  })

  it('a single request larger than the TPM proceeds once the window is empty, and blocks followers for a window', async () => {
    const c = fakeClock()
    const l = createRateLimiter({ inputTokensPerMinute: 100 }, c)
    await l.acquire(50)
    const t0 = c.now()
    await l.acquire(10_000) // alone: waits for the 50 to expire, does not deadlock
    expect(c.now() - t0).toBe(60_000)
    const t1 = c.now()
    await l.acquire(10)
    expect(c.now() - t1).toBe(60_000)
  })

  it('an oversized request on an empty limiter goes straight through', async () => {
    const c = fakeClock()
    const l = createRateLimiter({ inputTokensPerMinute: 100 }, c)
    await l.acquire(10_000)
    expect(c.sleeps).toEqual([])
  })

  it('is FIFO-fair: a small later request does not overtake a large waiting one', async () => {
    const c = fakeClock()
    const l = createRateLimiter({ inputTokensPerMinute: 1000 }, c)
    await l.acquire(900)
    const order: string[] = []
    const big = l.acquire(800).then(() => order.push('big'))
    const small = l.acquire(50).then(() => order.push('small'))
    await Promise.all([big, small])
    expect(order).toEqual(['big', 'small'])
  })

  it('applies both limits together', async () => {
    const c = fakeClock()
    const l = createRateLimiter({ requestsPerMinute: 10, inputTokensPerMinute: 100 }, c)
    await l.acquire(60)
    await l.acquire(60)
    expect(c.now() - 1_000_000).toBe(60_000)
  })

  it('does nothing without limits', async () => {
    const c = fakeClock()
    const l = createRateLimiter({}, c)
    for (let i = 0; i < 100; i++) await l.acquire(1e9)
    expect(c.sleeps).toEqual([])
  })

  it('rejects non-positive limits', () => {
    expect(() => createRateLimiter({ requestsPerMinute: 0 })).toThrow(/requestsPerMinute/)
    expect(() => createRateLimiter({ inputTokensPerMinute: -1 })).toThrow(/inputTokensPerMinute/)
    expect(() => createRateLimiter({ requestsPerMinute: Number.NaN })).toThrow(/requestsPerMinute/)
  })
})

describe('rateLimiterFor', () => {
  it('returns undefined without limits and one shared limiter per options object', () => {
    expect(rateLimiterFor(undefined)).toBeUndefined()
    expect(rateLimiterFor({})).toBeUndefined()
    const opts = { requestsPerMinute: 5 }
    expect(rateLimiterFor(opts)).toBe(rateLimiterFor(opts))
    expect(rateLimiterFor({ requestsPerMinute: 5 })).not.toBe(rateLimiterFor(opts))
  })
})

describe('parseRateLimit', () => {
  it('returns undefined when neither flag is given', () => {
    expect(parseRateLimit({}, '--rpm', '--tpm')).toBeUndefined()
  })
  it('parses integers', () => {
    expect(parseRateLimit({ rpm: '50', tpm: '40000' }, '--rpm', '--tpm')).toEqual({ requestsPerMinute: 50, inputTokensPerMinute: 40000 })
    expect(parseRateLimit({ tpm: '10' }, '--rpm', '--tpm')).toEqual({ inputTokensPerMinute: 10 })
  })
  it('rejects bad values naming the flag', () => {
    expect(() => parseRateLimit({ rpm: '0' }, '--summary-rpm', '--summary-tpm')).toThrow(/--summary-rpm/)
    expect(() => parseRateLimit({ tpm: 'abc' }, '--summary-rpm', '--summary-tpm')).toThrow(/--summary-tpm/)
    expect(() => parseRateLimit({ rpm: '1.5' }, '--rpm', '--tpm')).toThrow(/--rpm/)
  })
})
