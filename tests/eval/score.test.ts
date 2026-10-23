import { describe, expect, it } from 'vitest'
import { aggregate, firstHitRank, matchesGold, type QuestionResult } from '../../src/eval/score.js'

const ev = (docPath: string, startLine: number, endLine: number, titlePath: string[] = []) => ({ docPath, startLine, endLine, titlePath })

describe('matchesGold', () => {
  it('needs the same document', () => {
    expect(matchesGold(ev('a.md', 1, 100), { doc_path: 'b.md', start_line: 1, end_line: 100 })).toBe(false)
  })

  it('hits when line ranges overlap (inclusive bounds)', () => {
    const g = { doc_path: 'a.md', start_line: 10, end_line: 20 }
    expect(matchesGold(ev('a.md', 20, 30), g)).toBe(true)
    expect(matchesGold(ev('a.md', 1, 10), g)).toBe(true)
    expect(matchesGold(ev('a.md', 12, 13), g)).toBe(true)
    expect(matchesGold(ev('a.md', 1, 200), g)).toBe(true)
    expect(matchesGold(ev('a.md', 21, 30), g)).toBe(false)
    expect(matchesGold(ev('a.md', 1, 9), g)).toBe(false)
  })

  it('line range wins over title_path when both are given', () => {
    const g = { doc_path: 'a.md', title_path: ['A', 'B'], start_line: 10, end_line: 20 }
    expect(matchesGold(ev('a.md', 30, 40, ['A', 'B']), g)).toBe(false)
  })

  it('without lines, matches when one title path is a prefix of the other', () => {
    const g = { doc_path: 'a.md', title_path: ['手册', '安装'] }
    expect(matchesGold(ev('a.md', 1, 2, ['手册', '安装']), g)).toBe(true)
    expect(matchesGold(ev('a.md', 1, 2, ['手册', '安装', '系统要求']), g)).toBe(true)
    expect(matchesGold(ev('a.md', 1, 2, ['手册']), g)).toBe(true)
    expect(matchesGold(ev('a.md', 1, 2, ['手册', '配置']), g)).toBe(false)
    expect(matchesGold(ev('a.md', 1, 2, ['手册', '安装说明']), g)).toBe(false)
  })

  it('doc-level gold matches any evidence from that document', () => {
    expect(matchesGold(ev('a.md', 5, 6), { doc_path: 'a.md' })).toBe(true)
  })
})

describe('firstHitRank', () => {
  it('returns the 1-based rank of the first evidence matching any gold, or null', () => {
    const gold = [
      { doc_path: 'a.md', start_line: 10, end_line: 20 },
      { doc_path: 'b.md', start_line: 1, end_line: 2 },
    ]
    expect(firstHitRank([ev('c.md', 1, 9), ev('b.md', 2, 3), ev('a.md', 10, 10)], gold)).toBe(2)
    expect(firstHitRank([ev('c.md', 1, 9)], gold)).toBeNull()
    expect(firstHitRank([], gold)).toBeNull()
  })
})

describe('aggregate', () => {
  const r = (id: string, lang: QuestionResult['lang'], rank: number | null, tokens: number, steps: number, error?: string): QuestionResult => ({
    id,
    lang,
    hit: rank !== null,
    rank,
    tokens,
    steps,
    evidence: [],
    ...(error ? { error } : {}),
  })

  it('summarizes overall and by language', () => {
    const s = aggregate([r('1', 'zh', 1, 100, 1), r('2', 'zh', null, 300, 3), r('3', 'en', 2, 200, 2), r('4', 'mixed', null, 0, 0, 'boom')])
    expect(s.overall).toEqual({
      questions: 4,
      hits: 2,
      hitRate: 0.5,
      hitAt1: 0.25,
      mrr: 0.375,
      avgTokens: 150,
      avgSteps: 1.5,
      errors: 1,
    })
    expect(s.byLang.zh).toMatchObject({ questions: 2, hits: 1, hitRate: 0.5, hitAt1: 0.5, avgTokens: 200 })
    expect(s.byLang.en).toMatchObject({ questions: 1, hits: 1, hitRate: 1, hitAt1: 0, mrr: 0.5 })
    expect(s.byLang.mixed).toMatchObject({ questions: 1, hits: 0, errors: 1 })
  })

  it('omits languages without questions and handles an empty run', () => {
    const s = aggregate([r('1', 'en', 1, 10, 1)])
    expect(Object.keys(s.byLang)).toEqual(['en'])
    expect(aggregate([]).overall).toMatchObject({ questions: 0, hitRate: 0, avgTokens: 0 })
  })
})
