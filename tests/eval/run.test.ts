import { createRateLimiter } from '../../src/llm/rate-limit.js'
import { MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkGold, runEval } from '../../src/eval/run.js'
import type { EvalQuestion } from '../../src/eval/questions.js'
import { openLibrary, type Library } from '../../src/library.js'
import { walk } from '../../src/tree/build.js'
import { indexedFixtureRoot } from '../adapters/helpers.js'

let lib: Library
let cleanup: () => void
beforeAll(async () => {
  const f = await indexedFixtureRoot()
  cleanup = f.cleanup
  lib = openLibrary({ root: f.root })
})
afterAll(() => {
  lib.close()
  cleanup()
})

const questions: EvalQuestion[] = [
  { id: 'en1', lang: 'en', question: 'npm install acme', gold: [{ doc_path: 'en-guide.md', start_line: 12, end_line: 16 }], line: 1 },
  { id: 'zh1', lang: 'zh', question: '系统要求 Node.js 版本', gold: [{ doc_path: 'zh-manual.md', title_path: ['产品手册'] }], line: 2 },
  { id: 'mx1', lang: 'mixed', question: 'npm install acme', gold: [{ doc_path: 'crlf.md', start_line: 1, end_line: 7 }], line: 3 },
]

const usage = (n: number) => ({
  inputTokens: { total: n, noCache: n, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
})

describe('checkGold', () => {
  it('accepts golds that exist in the index', () => {
    expect(checkGold(lib, questions)).toEqual([])
  })
  it('reports unknown documents, out-of-range lines and unknown title paths with question line numbers', () => {
    const bad: EvalQuestion[] = [
      { id: 'a', lang: 'en', question: 'x', gold: [{ doc_path: 'nope.md' }], line: 4 },
      { id: 'b', lang: 'en', question: 'x', gold: [{ doc_path: 'en-guide.md', start_line: 30, end_line: 99 }], line: 5 },
      { id: 'c', lang: 'en', question: 'x', gold: [{ doc_path: 'en-guide.md', title_path: ['Nope'] }], line: 6 },
    ]
    const issues = checkGold(lib, bad)
    expect(issues.map((i) => i.line)).toEqual([4, 5, 6])
    expect(issues[0]!.message).toMatch(/nope\.md.*not in the index/)
    expect(issues[1]!.message).toMatch(/38 lines/)
    expect(issues[2]!.message).toMatch(/title_path/)
  })
})

describe('runEval bm25', () => {
  it('runs searchNodes top-k per question and judges hits', async () => {
    const report = await runEval(lib, questions, { mode: 'bm25', topK: 5 })
    expect(report.mode).toBe('bm25')
    expect(report.results.map((r) => [r.id, r.hit])).toEqual([
      ['en1', true],
      ['zh1', true],
      ['mx1', false],
    ])
    const en1 = report.results[0]!
    expect(en1.rank).toBe(1)
    expect(en1.steps).toBe(1)
    expect(en1.tokens).toBeGreaterThan(0)
    expect(en1.evidence.length).toBeGreaterThan(0)
    expect(en1.evidence.length).toBeLessThanOrEqual(5)
    expect(report.summary.overall).toMatchObject({ questions: 3, hits: 2 })
    expect(report.summary.byLang.mixed).toMatchObject({ questions: 1, hits: 0 })
    expect(report.baseline).toBeUndefined()
  })

  it('records evidence size and precision per question and in the summary', async () => {
    const report = await runEval(lib, questions, { mode: 'bm25', topK: 5 })
    for (const r of report.results) {
      expect(r.evidenceLines).toBeGreaterThan(0)
      expect(r.evidenceLines).toBeLessThanOrEqual(r.evidence.reduce((n, e) => n + e.endLine - e.startLine + 1, 0))
      expect(r.evidenceTokens).toBeGreaterThan(0)
    }
    const en1 = report.results[0]!
    expect(en1.precision).toBeGreaterThan(0)
    expect(en1.precision).toBeLessThanOrEqual(1)
    expect(report.results[1]!.precision).toBeNull() // title_path gold
    expect(report.summary.overall.meanEvidenceLines).toBeGreaterThan(0)
    expect(report.summary.overall.meanPrecision).not.toBeNull()
  })

  it('--max-evidence-lines: only short enough matching items count as hits', async () => {
    const base = await runEval(lib, [questions[0]!], { mode: 'bm25', topK: 5 })
    const e = base.results[0]!.evidence[base.results[0]!.rank! - 1]!
    const span = e.endLine - e.startLine + 1
    expect(span).toBeGreaterThan(1)
    const ok = await runEval(lib, [questions[0]!], { mode: 'bm25', topK: 5, maxEvidenceLines: span })
    expect(ok.results[0]!.hit).toBe(true)
    expect(ok.options.maxEvidenceLines).toBe(span)
    const strict = await runEval(lib, [questions[0]!], { mode: 'bm25', topK: 1, maxEvidenceLines: span - 1 })
    expect(strict.results[0]!.hit).toBe(false)
  })

  it('bm25 evidence is the matched node own text range', async () => {
    const report = await runEval(lib, [questions[0]!], { mode: 'bm25', topK: 1 })
    const e = report.results[0]!.evidence[0]!
    const node = [...walk(lib.store.getTree(e.docPath)!)].find((x) => x.titlePath.join('/') === e.titlePath.join('/'))!.node
    expect([e.startLine, e.endLine]).toEqual([node.startLine, node.ownEndLine])
  })
})

describe('runEval agent', () => {
  const acme = () => [...walk(lib.store.getTree('en-guide.md')!)].find((e) => e.node.title === 'Acme SDK')!.node

  it('runs retrieve() with the model and judges its evidence, with a bm25 baseline', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 's',
            toolName: 'select_evidence',
            input: JSON.stringify({ items: [{ doc_path: 'en-guide.md', node_id: acme().nodeId }] }),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: usage(100),
        warnings: [],
      }),
    })
    const progress: string[] = []
    const report = await runEval(lib, questions, {
      mode: 'agent',
      model,
      modelId: 'mock:model',
      concurrency: 2,
      onProgress: (done, total, r) => progress.push(`${done}/${total} ${r.id}`),
    })
    expect(report.mode).toBe('agent')
    expect(report.model).toBe('mock:model')
    expect(report.results.map((r) => r.id)).toEqual(['en1', 'zh1', 'mx1'])
    expect(report.results.map((r) => r.hit)).toEqual([true, false, false])
    expect(report.results[0]).toMatchObject({ tokens: 105, steps: 1, stopReason: 'done' })
    expect(report.results[0]!.evidence[0]).toMatchObject({ docPath: 'en-guide.md', startLine: 8, endLine: 38 })
    expect(report.summary.overall).toMatchObject({ questions: 3, hits: 1, avgTokens: 105, avgSteps: 1 })
    expect(report.baseline?.summary.overall).toMatchObject({ questions: 3, hits: 2 })
    expect(progress).toHaveLength(3)
  })

  it('all questions draw from one shared rate limiter', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'tool-call' as const, toolCallId: 's', toolName: 'select_evidence', input: JSON.stringify({ items: [] }) }],
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: usage(10),
        warnings: [],
      }),
    })
    let t = 0
    const inner = createRateLimiter({ requestsPerMinute: 1 }, { now: () => t, sleep: async (ms) => void (t += ms) })
    const stamps: number[] = []
    const rateLimiter = {
      acquire: async (n: number) => {
        await inner.acquire(n)
        stamps.push(t)
      },
    }
    await runEval(lib, questions, { mode: 'agent', model, concurrency: 3, baseline: false, rateLimiter })
    expect(stamps).toEqual([0, 60_000, 120_000])
  })

  it('records a failing question as an error miss and keeps going', async () => {
    let n = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        n++
        throw new Error('provider exploded')
      },
    })
    const report = await runEval(lib, questions.slice(0, 2), { mode: 'agent', model, baseline: false })
    expect(n).toBeGreaterThanOrEqual(2)
    expect(report.results.every((r) => r.error?.includes('provider exploded') && !r.hit)).toBe(true)
    expect(report.summary.overall.errors).toBe(2)
    expect(report.baseline).toBeUndefined()
  })

  it('agent mode without a model is rejected', async () => {
    await expect(runEval(lib, questions, { mode: 'agent' })).rejects.toThrow(/model/)
  })
})
