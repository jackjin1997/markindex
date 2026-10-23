import type { LanguageModel } from 'ai'
import type { Library } from '../library.js'
import { retrieve, RETRIEVE_MAX_INPUT_TOKENS, RETRIEVE_MAX_STEPS } from '../retrieve.js'
import { searchNodes } from '../store/search.js'
import { approxTokens } from '../text/tokens.js'
import { walk } from '../tree/build.js'
import type { TreeNode } from '../types.js'
import type { EvalQuestion, QuestionIssue } from './questions.js'
import { aggregate, firstHitRank, type Aggregate, type EvidenceRef, type QuestionResult } from './score.js'

/**
 * - `bm25`: baseline — `searchNodes(question)` top-k, no LLM. Evidence = each hit node's own text range.
 * - `agent`: the built-in `retrieve()` loop (generateText + the five library tools + AGENT_INSTRUCTIONS +
 *   select_evidence). This is also what an external agent does in "tools" mode, so the two are one mode here.
 */
export type EvalMode = 'bm25' | 'agent'

export interface RunEvalOptions {
  mode: EvalMode
  /** bm25: hits per question (default 5). */
  topK?: number
  /** agent: the model driving retrieve(). */
  model?: LanguageModel
  /** agent: label recorded in the report (e.g. "anthropic:claude-sonnet-5-5"). */
  modelId?: string
  /** agent: retrieve() maxSteps (default RETRIEVE_MAX_STEPS). */
  maxSteps?: number
  /** agent: retrieve() maxInputTokens per question (default RETRIEVE_MAX_INPUT_TOKENS). */
  maxInputTokens?: number
  /** agent: questions run in parallel (default 1). */
  concurrency?: number
  /** agent: also run the bm25 baseline on the same questions (default true). */
  baseline?: boolean
  onProgress?: (done: number, total: number, result: QuestionResult) => void
}

export interface EvalReport {
  mode: EvalMode
  model?: string
  createdAt: string
  options: { topK?: number; maxSteps?: number; maxInputTokens?: number }
  summary: Aggregate
  /** agent mode: the bm25 top-k baseline on the same questions. */
  baseline?: { mode: 'bm25'; topK: number; summary: Aggregate }
  results: QuestionResult[]
}

const DEFAULT_TOP_K = 5

/**
 * Checks every gold location against the index: the document exists, the line range is inside the file and a
 * title_path names an existing node. Returns issues keyed by question-file line (empty = all good).
 */
export function checkGold(lib: Library, questions: EvalQuestion[]): QuestionIssue[] {
  const issues: QuestionIssue[] = []
  const titlePaths = new Map<string, Set<string>>()
  for (const q of questions) {
    for (const g of q.gold) {
      const doc = lib.store.getDoc(g.doc_path)
      if (!doc) {
        issues.push({ line: q.line, message: `question "${q.id}": gold doc_path "${g.doc_path}" is not in the index (use a library-relative path as printed by \`markindex search\`)` })
        continue
      }
      if (g.end_line !== undefined && g.end_line > doc.lineCount) {
        issues.push({ line: q.line, message: `question "${q.id}": gold lines ${g.start_line}-${g.end_line} exceed "${g.doc_path}" (${doc.lineCount} lines)` })
      }
      if (g.title_path && g.start_line === undefined) {
        let paths = titlePaths.get(g.doc_path)
        if (!paths) {
          paths = new Set([...walk(lib.store.getTree(g.doc_path) ?? [])].map((e) => e.titlePath.join('\0')))
          titlePaths.set(g.doc_path, paths)
        }
        if (!paths.has(g.title_path.join('\0'))) {
          issues.push({ line: q.line, message: `question "${q.id}": gold title_path ${JSON.stringify(g.title_path)} matches no node of "${g.doc_path}" (see \`markindex tree\`)` })
        }
      }
    }
  }
  return issues
}

function bm25Runner(lib: Library, topK: number) {
  const nodes = new Map<string, Map<string, TreeNode>>()
  const node = (docPath: string, nodeId: string) => {
    let m = nodes.get(docPath)
    if (!m) {
      m = new Map([...walk(lib.store.getTree(docPath) ?? [])].map((e) => [e.node.nodeId, e.node]))
      nodes.set(docPath, m)
    }
    return m.get(nodeId)
  }
  return (q: EvalQuestion): QuestionResult => {
    const hits = searchNodes(lib.store, q.question, { limit: topK })
    const evidence: EvidenceRef[] = hits.map((h) => ({
      docPath: h.docPath,
      titlePath: h.titlePath,
      startLine: h.startLine,
      // what BM25 scored is the node's own text, not its whole subtree
      endLine: node(h.docPath, h.nodeId)?.ownEndLine ?? h.endLine,
    }))
    const rank = firstHitRank(evidence, q.gold)
    return { id: q.id, lang: q.lang, hit: rank !== null, rank, tokens: approxTokens(JSON.stringify(hits)), steps: 1, evidence }
  }
}

async function agentResult(lib: Library, q: EvalQuestion, opts: RunEvalOptions): Promise<QuestionResult> {
  try {
    const r = await retrieve(lib, q.question, {
      model: opts.model!,
      ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
      ...(opts.maxInputTokens !== undefined ? { maxInputTokens: opts.maxInputTokens } : {}),
    })
    const evidence = r.evidence.map(({ docPath, titlePath, startLine, endLine }) => ({ docPath, titlePath, startLine, endLine }))
    const rank = firstHitRank(evidence, q.gold)
    return {
      id: q.id,
      lang: q.lang,
      hit: rank !== null,
      rank,
      tokens: r.usage.inputTokens + r.usage.outputTokens,
      steps: r.steps,
      evidence,
      stopReason: r.stopReason,
    }
  } catch (e) {
    return { id: q.id, lang: q.lang, hit: false, rank: null, tokens: 0, steps: 0, evidence: [], error: e instanceof Error ? e.message : String(e) }
  }
}

/** Runs every question in the given mode and aggregates the results (overall + by language). */
export async function runEval(lib: Library, questions: EvalQuestion[], opts: RunEvalOptions): Promise<EvalReport> {
  const topK = opts.topK ?? DEFAULT_TOP_K
  const total = questions.length
  const createdAt = new Date().toISOString()

  if (opts.mode === 'bm25') {
    const run = bm25Runner(lib, topK)
    const results = questions.map((q, i) => {
      const r = run(q)
      opts.onProgress?.(i + 1, total, r)
      return r
    })
    return { mode: 'bm25', createdAt, options: { topK }, summary: aggregate(results), results }
  }

  if (!opts.model) throw new Error('agent mode needs a model (e.g. --model anthropic:claude-sonnet-5-5)')
  const results: QuestionResult[] = new Array(total)
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < total) {
      const i = next++
      results[i] = await agentResult(lib, questions[i]!, opts)
      opts.onProgress?.(++done, total, results[i]!)
    }
  }
  const concurrency = Math.max(1, Math.min(total, Math.floor(opts.concurrency ?? 1)))
  await Promise.all(Array.from({ length: concurrency }, worker))

  const report: EvalReport = {
    mode: 'agent',
    ...(opts.modelId ? { model: opts.modelId } : {}),
    createdAt,
    options: { maxSteps: opts.maxSteps ?? RETRIEVE_MAX_STEPS, maxInputTokens: opts.maxInputTokens ?? RETRIEVE_MAX_INPUT_TOKENS },
    summary: aggregate(results),
    results,
  }
  if (opts.baseline ?? true) {
    const run = bm25Runner(lib, topK)
    report.baseline = { mode: 'bm25', topK, summary: aggregate(questions.map(run)) }
  }
  return report
}
