import { describe, expect, it } from 'vitest'
import { aggregate, evidenceLineRanges, evidencePrecision, firstHitRank, matchesGold, type QuestionResult } from '../../src/eval/score.js'

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

  it('maxEvidenceLines: a matching item longer than n lines is not a hit', () => {
    const gold = [{ doc_path: 'a.md', start_line: 10, end_line: 20 }]
    const evidence = [ev('a.md', 1, 200), ev('a.md', 12, 15)]
    expect(firstHitRank(evidence, gold)).toBe(1)
    expect(firstHitRank(evidence, gold, 4)).toBe(2)
    expect(firstHitRank(evidence, gold, 3)).toBeNull()
    expect(firstHitRank([ev('a.md', 10, 10)], gold, 1)).toBe(1)
  })
})

describe('evidence size and precision', () => {
  it('evidenceLineRanges merges overlapping / adjacent items per document', () => {
    expect(evidenceLineRanges([ev('a.md', 10, 20), ev('b.md', 1, 1), ev('a.md', 15, 30), ev('a.md', 31, 32), ev('a.md', 40, 41)])).toEqual([
      { docPath: 'a.md', startLine: 10, endLine: 32 },
      { docPath: 'a.md', startLine: 40, endLine: 41 },
      { docPath: 'b.md', startLine: 1, endLine: 1 },
    ])
    expect(evidenceLineRanges([])).toEqual([])
  })

  it('precision = share of distinct evidence lines inside any gold line range', () => {
    const gold = [
      { doc_path: 'a.md', start_line: 10, end_line: 19 },
      { doc_path: 'a.md', start_line: 15, end_line: 24 },
    ]
    // 30 distinct lines (1-30), 15 inside gold (10-24)
    expect(evidencePrecision([ev('a.md', 1, 20), ev('a.md', 11, 30)], gold)).toBe(0.5)
    expect(evidencePrecision([ev('a.md', 12, 13)], gold)).toBe(1)
    expect(evidencePrecision([ev('b.md', 12, 13)], gold)).toBe(0)
  })

  it('precision is null without line-range gold or without evidence', () => {
    expect(evidencePrecision([ev('a.md', 1, 2)], [{ doc_path: 'a.md', title_path: ['A'] }])).toBeNull()
    expect(evidencePrecision([], [{ doc_path: 'a.md', start_line: 1, end_line: 2 }])).toBeNull()
  })
})

describe('aggregate', () => {
  const r = (
    id: string,
    lang: QuestionResult['lang'],
    rank: number | null,
    tokens: number,
    steps: number,
    error?: string,
    size: { lines: number; tok: number; precision: number | null } = { lines: 0, tok: 0, precision: null },
  ): QuestionResult => ({
    id,
    lang,
    hit: rank !== null,
    rank,
    tokens,
    steps,
    evidence: [],
    evidenceLines: size.lines,
    evidenceTokens: size.tok,
    precision: size.precision,
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
      meanEvidenceLines: 0,
      medianEvidenceLines: 0,
      meanEvidenceTokens: 0,
      meanPrecision: null,
    })
    expect(s.byLang.zh).toMatchObject({ questions: 2, hits: 1, hitRate: 0.5, hitAt1: 0.5, avgTokens: 200 })
    expect(s.byLang.en).toMatchObject({ questions: 1, hits: 1, hitRate: 1, hitAt1: 0, mrr: 0.5 })
    expect(s.byLang.mixed).toMatchObject({ questions: 1, hits: 0, errors: 1 })
  })

  it('evidence size: mean / median lines, mean tokens, mean precision over questions that have one', () => {
    const s = aggregate([
      r('1', 'zh', 1, 0, 1, undefined, { lines: 10, tok: 100, precision: 1 }),
      r('2', 'zh', null, 0, 1, undefined, { lines: 30, tok: 300, precision: 0.5 }),
      r('3', 'en', 1, 0, 1, undefined, { lines: 200, tok: 2000, precision: null }),
      r('4', 'en', 1, 0, 1, undefined, { lines: 40, tok: 400, precision: 0 }),
    ])
    expect(s.overall).toMatchObject({ meanEvidenceLines: 70, medianEvidenceLines: 35, meanEvidenceTokens: 700, meanPrecision: 0.5 })
    expect(s.byLang.zh).toMatchObject({ meanEvidenceLines: 20, medianEvidenceLines: 20, meanPrecision: 0.75 })
    expect(s.byLang.en).toMatchObject({ meanEvidenceLines: 120, medianEvidenceLines: 120, meanPrecision: 0 })
    expect(aggregate([r('5', 'en', 1, 0, 1, undefined, { lines: 3, tok: 1, precision: null })]).overall).toMatchObject({
      medianEvidenceLines: 3,
      meanPrecision: null,
    })
  })

  it('omits languages without questions and handles an empty run', () => {
    const s = aggregate([r('1', 'en', 1, 10, 1)])
    expect(Object.keys(s.byLang)).toEqual(['en'])
    expect(aggregate([]).overall).toMatchObject({ questions: 0, hitRate: 0, avgTokens: 0 })
  })
})
