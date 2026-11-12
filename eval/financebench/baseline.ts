/**
 * Retrieve-then-read baselines for FinanceBench with the same model, answer format and judge as run.ts.
 *
 *   .venv/bin/python -I eval/financebench/baseline_retrieve.py search --method dense|bm25|hybrid   # ranked pages
 *   npx tsx eval/financebench/baseline.ts --retrieval eval/financebench/runs/baseline/retrieval-dense.json \
 *     --out eval/financebench/runs/baseline-dense.json (--all | --sample <n> | --ids id1,id2) \
 *     [--top-k 10] [--model sonnet] [--judge-model sonnet] [--concurrency 3] [--dry-run]
 *
 * The model gets the top-k retrieved pages in ONE prompt (no tools, one turn) and answers in the same JSON format as
 * the MarkIndex agent, so the report has the same shape and rejudge.ts / adjudicate.ts work on it unchanged.
 * `--dry-run` builds every prompt and prints context sizes without calling the model.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { JUDGE_PROMPT, parseAgentAnswer, parseJudge, runClaude, summarize, type FbQuestion, type Result } from './run.js'

const HERE = import.meta.dirname
/** Upper bound on the passages in one prompt; pages past it are dropped, lowest rank first. */
const MAX_CONTEXT_CHARS = 300_000
const log = (s: string) => process.stderr.write(`${s}\n`)

interface Page { doc_path: string; page: number; start_line: number; end_line: number }
interface Retrieval { summary: { method: string; model: string | null; subset: string }; results: Record<string, Page[]> }

/** Per-benchmark wording, read from <base>/prompt.json when the benchmark is not FinanceBench. */
export interface PromptConfig { benchmark?: string; agent_intro?: string; single_intro?: string; single_pages?: string }
export function loadPromptConfig(base: string): PromptConfig {
  const f = join(base, 'prompt.json')
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as PromptConfig) : {}
}

export const BASELINE_PROMPT = (question: string, passages: string, cfg: PromptConfig = {}) => `${cfg.single_intro ?? 'You are a financial analyst answering a question from a library of public-company filings (10-K, 10-Q, 8-K, earnings releases).'}

Below are the pages a search over the whole library returned for the question, best match first. Each page is labeled with its document path and line range, and every line starts with its line number. ${cfg.single_pages ?? 'The pages may come from different companies, years or document types; use the ones that answer the question, and compute the answer when a calculation is needed.'} Base the answer only on these pages.

Reply with ONLY a JSON object (no prose, no code fence):
{"answer":"<concise final answer, with the numbers and a one-sentence justification>","evidence":[{"doc_path":"...","start_line":N,"end_line":N}]}
Cite at most 5 tight line ranges from the pages, most important first. If the pages do not contain the answer, say so in "answer" and cite nothing.

Question: ${question}

${passages}`

const fileLines = new Map<string, string[]>()
function linesOf(root: string, docPath: string): string[] {
  let l = fileLines.get(docPath)
  if (!l) {
    l = readFileSync(join(root, docPath), 'utf8').split('\n')
    fileLines.set(docPath, l)
  }
  return l
}

export function renderPassages(root: string, pages: Page[]): { text: string; used: number } {
  const parts: string[] = []
  let size = 0
  for (const p of pages) {
    const body = linesOf(root, p.doc_path)
      .slice(p.start_line - 1, p.end_line)
      .map((line, i) => `${p.start_line + i}│ ${line}`)
      .join('\n')
    const part = `=== ${p.doc_path} · page ${p.page + 1} · L${p.start_line}-${p.end_line} ===\n${body}`
    if (parts.length && size + part.length > MAX_CONTEXT_CHARS) break
    parts.push(part)
    size += part.length
  }
  return { text: parts.join('\n\n'), used: parts.length }
}

async function main() {
  const { values: v } = parseArgs({
    args: process.argv.slice(2),
    options: {
      retrieval: { type: 'string' },
      base: { type: 'string', default: HERE },
      root: { type: 'string' },
      out: { type: 'string' },
      all: { type: 'boolean' },
      sample: { type: 'string' },
      ids: { type: 'string' },
      'top-k': { type: 'string', default: '10' },
      model: { type: 'string', default: 'sonnet' },
      'judge-model': { type: 'string', default: 'sonnet' },
      concurrency: { type: 'string', default: '3' },
      'timeout-sec': { type: 'string', default: '600' },
      'dry-run': { type: 'boolean' },
    },
  })
  if (!v.retrieval || !v.out) throw new Error('--retrieval and --out are required')
  const base = resolve(v.base!)
  const cfg = loadPromptConfig(base)
  const root = resolve(v.root ?? join(base, 'md'))
  const out = resolve(v.out)
  const topK = Number(v['top-k'])
  const retrieval = JSON.parse(readFileSync(resolve(v.retrieval), 'utf8')) as Retrieval

  const all = readFileSync(join(base, 'data/open.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as FbQuestion)
  let questions = all
  if (v.ids) {
    const want = new Set(v.ids.split(','))
    questions = all.filter((q) => want.has(q.financebench_id))
  } else if (v.sample) {
    const n = Number(v.sample)
    const step = all.length / n
    questions = Array.from({ length: n }, (_, i) => all[Math.floor(i * step)]!)
  } else if (!v.all) throw new Error('pass --all, --sample <n> or --ids')

  // gold: line ranges of every evidence page; documents are matched by file name
  const goldOf = (q: FbQuestion) =>
    q.evidence.flatMap((e) => {
      const pages = JSON.parse(readFileSync(join(base, 'md-pages', `${e.doc_name}.json`), 'utf8')) as Record<string, [number, number]>
      const r = pages[String(e.evidence_page_num)]
      if (!r) throw new Error(`${q.financebench_id}: page ${e.evidence_page_num} missing in ${e.doc_name}`)
      return [{ doc_name: e.doc_name, start: r[0], end: r[1] }]
    })
  const docName = (docPath: string) => docPath.split('/').pop()!.replace(/\.md$/, '')

  const prompts = new Map<string, { prompt: string; used: number }>()
  for (const q of questions) {
    const pages = (retrieval.results[q.financebench_id] ?? []).slice(0, topK)
    const { text, used } = renderPassages(root, pages)
    prompts.set(q.financebench_id, { prompt: BASELINE_PROMPT(q.question, text, cfg), used })
  }
  const sizes = [...prompts.values()].map((p) => p.prompt.length).sort((a, b) => a - b)
  const pct = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))]!
  log(`${questions.length} questions, top-${topK} pages of ${retrieval.summary.method} (${retrieval.summary.subset}); prompt chars: median ${pct(0.5)}, p90 ${pct(0.9)}, max ${pct(1)}; pages dropped by the size cap in ${[...prompts.values()].filter((p) => p.used < topK).length} prompts`)
  if (v['dry-run']) return

  const prev = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { results: Result[] }).results : []
  const results: Result[] = prev.filter((r) => !r.error && questions.some((q) => q.financebench_id === r.id))
  const done = new Set(results.map((r) => r.id))
  const todo = questions.filter((q) => !done.has(q.financebench_id))
  log(`${done.size} resumed, ${todo.length} to run`)

  const work = mkdtempSync(join(tmpdir(), 'markindex-fb-base-'))
  const order = new Map(all.map((q, i) => [q.financebench_id, i]))
  const save = () => {
    results.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    const report = {
      benchmark: cfg.benchmark ?? 'FinanceBench open-source (150)',
      protocol: `retrieve-then-read baseline: top-${topK} pages of ${retrieval.summary.method} retrieval in one prompt, no tools; judge prompt from VectifyAI/Mafin2.5-FinanceBench eval.py`,
      retrieval: retrieval.summary,
      top_k: topK,
      model: v.model,
      judge_model: v['judge-model'],
      created_at: new Date().toISOString(),
      summary: summarize(results),
      results,
    }
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  }

  const common = ['--tools', '', '--setting-sources', '', '--strict-mcp-config', '--output-format', 'json', '--max-turns', '1']
  const one = async (q: FbQuestion): Promise<Result> => {
    const o = await runClaude(['-p', prompts.get(q.financebench_id)!.prompt, ...common, '--model', v.model!], work, Number(v['timeout-sec']) * 1000)
    const base = { id: q.financebench_id, question_type: q.question_type, question: q.question, gold_answer: q.answer, turns: o.ok ? o.turns : 0, cost_usd: o.ok ? o.costUsd : 0 }
    // A reply that is not valid JSON (e.g. an unescaped quote inside "answer") is still judged, as text without
    // citations, so that the baseline does not lose a question to formatting.
    const parsed = o.ok && !o.isError ? (parseAgentAnswer(o.result) ?? (o.result.trim() ? { answer: o.result.trim(), evidence: [] } : null)) : null
    if (!parsed) {
      const error = !o.ok ? o.raw : o.isError ? `claude error: ${o.result.slice(0, 300)}` : `no answer JSON: ${o.result.slice(0, 300)}`
      return { ...base, answer: o.ok ? o.result : null, evidence: [], correct: null, page_hit: false, doc_hit: false, judge_raw: '', error }
    }
    const g = goldOf(q)
    const doc_hit = parsed.evidence.some((e) => g.some((x) => x.doc_name === docName(e.doc_path)))
    const page_hit = parsed.evidence.some((e) => g.some((x) => x.doc_name === docName(e.doc_path) && e.start_line <= x.end && e.end_line >= x.start))
    const j = await runClaude(['-p', JUDGE_PROMPT(q.question, parsed.answer, q.answer), ...common, '--model', v['judge-model']!], work, 120_000)
    const judge_raw = j.ok ? j.result : j.raw
    const correct = j.ok ? parseJudge(j.result) : null
    return {
      ...base,
      answer: parsed.answer,
      evidence: parsed.evidence,
      correct,
      page_hit,
      doc_hit,
      judge_raw,
      cost_usd: base.cost_usd + (j.ok ? j.costUsd : 0),
      ...(correct === null ? { error: `judge failed: ${judge_raw.slice(0, 200)}` } : {}),
    }
  }

  let next = 0
  let n = done.size
  const worker = async () => {
    while (next < todo.length) {
      const q = todo[next++]!
      const r = await one(q)
      results.push(r)
      n++
      log(`[${n}/${questions.length}] ${r.id} ${r.correct === true ? 'CORRECT' : r.correct === false ? 'wrong' : 'ERROR'} page=${r.page_hit ? 'Y' : 'n'} doc=${r.doc_hit ? 'Y' : 'n'} $${r.cost_usd.toFixed(3)}${r.error ? ` (${r.error.slice(0, 160)})` : ''}`)
      save()
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(Number(v.concurrency), todo.length) }, worker))
  } finally {
    save()
    rmSync(work, { recursive: true, force: true })
  }
  log(JSON.stringify(summarize(results), null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e: unknown) => {
    log(`financebench baseline: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  })
}
