import type { EvalQuestion, Gold } from './questions.js'

/** Where a returned piece of evidence points (lines 1-based, inclusive). */
export interface EvidenceRef {
  docPath: string
  titlePath: string[]
  startLine: number
  endLine: number
}

export interface QuestionResult {
  id: string
  lang: EvalQuestion['lang']
  hit: boolean
  /** 1-based position of the first evidence item matching a gold location; null when none does. */
  rank: number | null
  /** bm25: approx tokens of the search response; agent: model input + output tokens. */
  tokens: number
  /** bm25: 1 (one search call); agent: model steps. */
  steps: number
  evidence: EvidenceRef[]
  stopReason?: string
  /** Set when the question could not be run (e.g. a provider error); counts as a miss. */
  error?: string
}

export interface Summary {
  questions: number
  hits: number
  /** hits / questions */
  hitRate: number
  /** Share of questions whose FIRST evidence item is a hit (meaningful for ranked bm25 output). */
  hitAt1: number
  /** Mean reciprocal rank of the first hit (0 for misses). */
  mrr: number
  avgTokens: number
  avgSteps: number
  errors: number
}

export interface Aggregate {
  overall: Summary
  byLang: Partial<Record<EvalQuestion['lang'], Summary>>
}

const prefixOf = (a: string[], b: string[]) => a.length <= b.length && a.every((t, i) => t === b[i])

/**
 * Hit judgement: same document, and
 * - gold has a line range → the evidence range overlaps it (inclusive);
 * - else gold has title_path → one title path is a prefix of the other (evidence inside, or containing, the gold section);
 * - else (doc-level gold) → any evidence from the document.
 */
export function matchesGold(e: EvidenceRef, g: Gold): boolean {
  if (e.docPath !== g.doc_path) return false
  if (g.start_line !== undefined && g.end_line !== undefined) return e.startLine <= g.end_line && g.start_line <= e.endLine
  if (g.title_path) return prefixOf(g.title_path, e.titlePath) || prefixOf(e.titlePath, g.title_path)
  return true
}

export function firstHitRank(evidence: EvidenceRef[], gold: Gold[]): number | null {
  const i = evidence.findIndex((e) => gold.some((g) => matchesGold(e, g)))
  return i === -1 ? null : i + 1
}

const round = (x: number) => Math.round(x * 10_000) / 10_000

function summarize(rs: QuestionResult[]): Summary {
  const n = rs.length
  const avg = (f: (r: QuestionResult) => number) => (n === 0 ? 0 : round(rs.reduce((s, r) => s + f(r), 0) / n))
  const hits = rs.filter((r) => r.hit).length
  return {
    questions: n,
    hits,
    hitRate: n === 0 ? 0 : round(hits / n),
    hitAt1: avg((r) => (r.rank === 1 ? 1 : 0)),
    mrr: avg((r) => (r.rank === null ? 0 : 1 / r.rank)),
    avgTokens: avg((r) => r.tokens),
    avgSteps: avg((r) => r.steps),
    errors: rs.filter((r) => r.error !== undefined).length,
  }
}

/** Overall and per-language summaries; averages run over all questions (errors count as misses with their partial cost). */
export function aggregate(results: QuestionResult[]): Aggregate {
  const byLang: Aggregate['byLang'] = {}
  for (const lang of ['zh', 'en', 'mixed'] as const) {
    const rs = results.filter((r) => r.lang === lang)
    if (rs.length > 0) byLang[lang] = summarize(rs)
  }
  return { overall: summarize(results), byLang }
}
