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
  /** Distinct document lines covered by the evidence (overlapping items counted once). */
  evidenceLines: number
  /** Approx tokens of those lines' text. */
  evidenceTokens: number
  /** Share of evidenceLines inside any gold line range; null when no gold has a line range or there is no evidence. */
  precision: number | null
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
  meanEvidenceLines: number
  medianEvidenceLines: number
  meanEvidenceTokens: number
  /** Mean over the questions whose precision is not null; null when none has one. */
  meanPrecision: number | null
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

/**
 * 1-based rank of the first evidence item matching any gold. With `maxEvidenceLines`, only items spanning at most
 * that many lines count (a whole-chapter "hit" does not).
 */
export function firstHitRank(evidence: EvidenceRef[], gold: Gold[], maxEvidenceLines?: number): number | null {
  const i = evidence.findIndex(
    (e) =>
      (maxEvidenceLines === undefined || e.endLine - e.startLine + 1 <= maxEvidenceLines) &&
      gold.some((g) => matchesGold(e, g)),
  )
  return i === -1 ? null : i + 1
}

export interface LineRange {
  docPath: string
  startLine: number
  endLine: number
}

/** Evidence as disjoint line ranges: sorted by document then line, overlapping or adjacent items merged. */
export function evidenceLineRanges(evidence: LineRange[]): LineRange[] {
  const sorted = evidence
    .map(({ docPath, startLine, endLine }) => ({ docPath, startLine, endLine }))
    .filter((r) => r.endLine >= r.startLine)
    .sort((a, b) => (a.docPath < b.docPath ? -1 : a.docPath > b.docPath ? 1 : a.startLine - b.startLine))
  const out: LineRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && last.docPath === r.docPath && r.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, r.endLine)
    else out.push(r)
  }
  return out
}

const lineCount = (ranges: LineRange[]) => ranges.reduce((n, r) => n + r.endLine - r.startLine + 1, 0)

/** Share of distinct evidence lines that fall inside any gold line range (gold without lines is ignored). */
export function evidencePrecision(evidence: EvidenceRef[], gold: Gold[]): number | null {
  const goldRanges = evidenceLineRanges(
    gold.flatMap((g) =>
      g.start_line !== undefined && g.end_line !== undefined
        ? [{ docPath: g.doc_path, startLine: g.start_line, endLine: g.end_line }]
        : [],
    ),
  )
  const ev = evidenceLineRanges(evidence)
  const total = lineCount(ev)
  if (goldRanges.length === 0 || total === 0) return null
  let inside = 0
  for (const e of ev) {
    for (const g of goldRanges) {
      if (g.docPath !== e.docPath) continue
      const lo = Math.max(e.startLine, g.startLine)
      const hi = Math.min(e.endLine, g.endLine)
      if (hi >= lo) inside += hi - lo + 1
    }
  }
  return round(inside / total)
}

function round(x: number): number {
  return Math.round(x * 10_000) / 10_000
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function summarize(rs: QuestionResult[]): Summary {
  const n = rs.length
  const avg = (f: (r: QuestionResult) => number) => (n === 0 ? 0 : round(rs.reduce((s, r) => s + f(r), 0) / n))
  const hits = rs.filter((r) => r.hit).length
  const precisions = rs.flatMap((r) => (r.precision === null ? [] : [r.precision]))
  return {
    questions: n,
    hits,
    hitRate: n === 0 ? 0 : round(hits / n),
    hitAt1: avg((r) => (r.rank === 1 ? 1 : 0)),
    mrr: avg((r) => (r.rank === null ? 0 : 1 / r.rank)),
    avgTokens: avg((r) => r.tokens),
    avgSteps: avg((r) => r.steps),
    errors: rs.filter((r) => r.error !== undefined).length,
    meanEvidenceLines: avg((r) => r.evidenceLines),
    medianEvidenceLines: median(rs.map((r) => r.evidenceLines)),
    meanEvidenceTokens: avg((r) => r.evidenceTokens),
    meanPrecision: precisions.length === 0 ? null : round(precisions.reduce((a, b) => a + b, 0) / precisions.length),
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
