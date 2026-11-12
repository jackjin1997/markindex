/**
 * FinanceBench (open-source 150 questions) through Claude Code + the MarkIndex MCP server.
 *
 *   npm run build
 *   npx tsx eval/financebench/run.ts --root eval/financebench/md --out eval/financebench/runs/<name>.json \
 *     (--all | --sample <n> | --ids id1,id2) [--model sonnet] [--judge-model sonnet] [--concurrency 3] \
 *     [--max-turns 30] [--timeout-sec 600] [--db <index.db>] [--only-tools search_documents,get_node_content]
 *
 * Setup follows VectifyAI's Mafin2.5 FinanceBench protocol: every converted filing sits in ONE library (the agent is
 * not told which document to use), and answers are judged with Mafin2.5's own `check_answer_equivalence` prompt
 * (eval.py in github.com/VectifyAI/Mafin2.5-FinanceBench), here run by a Claude model instead of gpt-4o.
 * Each question runs in a fresh `claude -p` session whose only tools are the five MarkIndex MCP tools.
 *
 * Besides answer accuracy the report has evidence-page recall: whether any cited line range overlaps one of the
 * pages FinanceBench lists as evidence (converted with md-pages/<doc>.json).
 * The report is rewritten after every question and an existing report is resumed (finished ids are skipped).
 *
 * `--only-tools` is for ablations: the listed MarkIndex tools stay, the other ones are removed from the model's
 * context (`--disallowedTools`). Prompt, server and server instructions are unchanged.
 * `--flat-chunks <chunks.db>` is the agentic baseline: the same loop, prompt and judge, but the agent's tools come
 * from flat_server.ts (BM25 over the flat page chunks of baseline_retrieve.py, reading by page) instead of MarkIndex.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { mcpConfigFor, parseClaudeOutput, type ClaudeOutput } from '../lib/claude-code.js'
import { FLAT_TOOLS } from './flat_server.js'

const HERE = import.meta.dirname
const KILL_GRACE_MS = 10_000
const log = (s: string) => process.stderr.write(`${s}\n`)
const MARKINDEX_TOOLS = ['browse_documents', 'get_document', 'get_document_structure', 'get_node_content', 'search_documents']

interface FbEvidence { doc_name: string; evidence_page_num: number }
export interface FbQuestion {
  financebench_id: string
  company: string
  doc_name: string
  question_type: string
  question_reasoning: string | null
  question: string
  answer: string
  evidence: FbEvidence[]
}
interface DocInfo { doc_name: string; company: string }
interface Cited { doc_path: string; start_line: number; end_line: number }

export interface Result {
  id: string
  question_type: string
  question: string
  gold_answer: string
  answer: string | null
  evidence: Cited[]
  correct: boolean | null
  /** Any cited range overlaps a FinanceBench evidence page. */
  page_hit: boolean
  /** A cited range is in the right document. */
  doc_hit: boolean
  turns: number
  cost_usd: number
  judge_raw: string
  error?: string
}

const FILINGS_INTRO =
  'You are a financial analyst answering a question from a library of public-company filings (10-K, 10-Q, 8-K, earnings releases). The library is organized in one folder per company; every document starts with front matter (company, doc_type, period) and every page with an "<!-- page N -->" line.'

export const AGENT_PROMPT = (question: string, server = 'markindex', intro = FILINGS_INTRO) => `${intro}

Use ONLY the ${server} MCP tools to find the right document and the passages that answer the question, read them, and compute the answer when a calculation is needed. Base the answer only on what you read.

When done, reply with ONLY a JSON object (no prose, no code fence):
{"answer":"<concise final answer, with the numbers and a one-sentence justification>","evidence":[{"doc_path":"...","start_line":N,"end_line":N}]}
Cite at most 5 tight line ranges you actually read, most important first.

Question: ${question}`

/** Verbatim criteria of Mafin2.5's check_answer_equivalence (eval.py). */
export const JUDGE_PROMPT = (query: string, answer: string, gold: string) => `
    You are an expert evaluator for AI-generated responses to queries. Your task is to determine whether the AI-generated answer correctly answers the query based on the golden answer provided by a human expert.

    Numerical Accuracy:
    - Rounding differences should be **ignored** if they do not meaningfully change the conclusion.
    - You can allow some flexibility in accuracy. For example, 1.2 is considered similar to 1.23. Two numbers are considered similar if one can be rounded to the other.
    - Fractions, percentage, and numerics could be considered similar, for example: "11 of 14" is considered equivalent to "79%" and "0.79".

    Evaluation Criteria:
    - If the golden answer or any of its equivalence can be inferred or generated from the AI-generated answer, then the AI-generated answer is considered correct.
    - If any number, percentage, fraction, or figure in the golden answer is not present in the AI-generated answer, but can be inferred or generated from the AI-generated answer or implicitly exist in the AI-generated answer, then the AI-generated answer is considered correct.
    - The AI-generated answer is considered correct if it conveys the same or similar meaning, conclusion, or rationale as the golden answer.
    - If the AI-generated answer is a superset of the golden answer, it is also considered correct.
    - If the AI-generated answer provides a valid answer or reasonable interpretation compared to the golden answer, it is considered correct.
    - If the AI-generated answer contains subjective judgments or opinions, it is considered correct as long as they are reasonable and justifiable compared to the golden answer.

    - Otherwise, the AI-generated answer is incorrect.

    Inputs:
    - Query: ${query}
    - AI-Generated Answer: ${answer}
    - Golden Answer: ${gold}

    Your output should be ONLY a boolean value: \`True\` or \`False\`, nothing else.
    `

export function parseAgentAnswer(text: string): { answer: string; evidence: Cited[] } | null {
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s === -1 || e <= s) return null
  try {
    const j = JSON.parse(text.slice(s, e + 1)) as { answer?: unknown; evidence?: unknown }
    if (typeof j.answer !== 'string') return null
    const ev = Array.isArray(j.evidence) ? j.evidence : []
    const evidence = ev.flatMap((x): Cited[] => {
      const it = (x ?? {}) as Record<string, unknown>
      const a = Number(it.start_line)
      const b = it.end_line === undefined ? a : Number(it.end_line)
      if (typeof it.doc_path !== 'string' || !Number.isInteger(a) || !Number.isInteger(b)) return []
      return [{ doc_path: it.doc_path, start_line: Math.min(a, b), end_line: Math.max(a, b) }]
    })
    return { answer: j.answer, evidence: evidence.slice(0, 5) }
  } catch {
    return null
  }
}

export function parseJudge(text: string): boolean | null {
  const t = text.toLowerCase()
  if (t.includes('true')) return true // same order as eval.py
  if (t.includes('false')) return false
  return null
}

export function runClaude(args: string[], cwd: string, timeoutMs: number): Promise<ClaudeOutput> {
  return new Promise((done) => {
    const p = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d: Buffer) => (out += d))
    p.stderr.on('data', (d: Buffer) => (err += d))
    let killer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      p.kill('SIGTERM')
      killer = setTimeout(() => p.kill('SIGKILL'), KILL_GRACE_MS)
    }, timeoutMs)
    const stop = () => {
      clearTimeout(timer)
      clearTimeout(killer)
    }
    p.on('error', (e) => {
      stop()
      done({ ok: false, raw: `could not run claude: ${e.message}` })
    })
    p.on('close', () => {
      stop()
      const parsed = parseClaudeOutput(out)
      done(parsed.ok ? parsed : { ok: false, raw: `${parsed.raw}${err ? ` | stderr: ${err.slice(0, 300)}` : ''}` })
    })
  })
}

const folder = (company: string) => company.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

export function summarize(results: Result[]) {
  const by = (pred: (r: Result) => boolean) => {
    const rs = results.filter(pred)
    const judged = rs.filter((r) => r.correct !== null)
    return {
      n: rs.length,
      accuracy: judged.length ? judged.filter((r) => r.correct).length / rs.length : 0,
      correct: judged.filter((r) => r.correct).length,
      unjudged: rs.length - judged.length,
      doc_hit: rs.length ? rs.filter((r) => r.doc_hit).length / rs.length : 0,
      page_hit: rs.length ? rs.filter((r) => r.page_hit).length / rs.length : 0,
      mean_turns: rs.length ? rs.reduce((s, r) => s + r.turns, 0) / rs.length : 0,
      cost_usd: rs.reduce((s, r) => s + r.cost_usd, 0),
    }
  }
  const types = [...new Set(results.map((r) => r.question_type))].sort()
  return { overall: by(() => true), ...Object.fromEntries(types.map((t) => [t, by((r) => r.question_type === t)])) }
}

async function main() {
  const { values: v } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: 'string' },
      out: { type: 'string' },
      all: { type: 'boolean' },
      sample: { type: 'string' },
      ids: { type: 'string' },
      model: { type: 'string', default: 'sonnet' },
      'judge-model': { type: 'string', default: 'sonnet' },
      concurrency: { type: 'string', default: '3' },
      'max-turns': { type: 'string', default: '30' },
      'timeout-sec': { type: 'string', default: '600' },
      db: { type: 'string' },
      cli: { type: 'string' },
      'only-tools': { type: 'string' },
      'flat-chunks': { type: 'string' },
      base: { type: 'string', default: HERE },
    },
  })
  if (!v.root || !v.out) throw new Error('--root and --out are required')
  const root = resolve(v.root)
  const out = resolve(v.out)
  // benchmark folder with data/open.jsonl, data/docs.jsonl, md-pages/ and, for other benchmarks, prompt.json
  const base = resolve(v.base!)
  const promptFile = join(base, 'prompt.json')
  const cfg = existsSync(promptFile) ? (JSON.parse(readFileSync(promptFile, 'utf8')) as { benchmark?: string; agent_intro?: string }) : {}
  const cli = v.cli ? resolve(v.cli) : join(HERE, '..', '..', 'dist', 'cli.js')
  const flat = v['flat-chunks'] ? resolve(v['flat-chunks']) : undefined
  if (flat && (v['only-tools'] || v.db)) throw new Error('--flat-chunks cannot be combined with --only-tools or --db')
  if (flat ? !existsSync(flat) : !existsSync(cli)) throw new Error(flat ? `${flat} not found: run baseline_retrieve.py chunk` : `${cli} not found: run npm run build`)
  const serverName = flat ? 'chunksearch' : 'markindex'
  const tools = flat ? FLAT_TOOLS : v['only-tools'] ? v['only-tools'].split(',').map((t) => t.trim()) : MARKINDEX_TOOLS
  const unknown = flat ? [] : tools.filter((t) => !MARKINDEX_TOOLS.includes(t))
  if (unknown.length || !tools.length) throw new Error(`--only-tools: unknown tool ${unknown.join(', ')}; known: ${MARKINDEX_TOOLS.join(', ')}`)
  const removed = flat ? [] : MARKINDEX_TOOLS.filter((t) => !tools.includes(t)).map((t) => `mcp__markindex__${t}`)

  const all = readFileSync(join(base, 'data/open.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as FbQuestion)
  const docs = new Map(
    readFileSync(join(base, 'data/docs.jsonl'), 'utf8').trim().split('\n').map((l) => {
      const d = JSON.parse(l) as DocInfo
      return [d.doc_name, d]
    }),
  )
  let questions = all
  if (v.ids) {
    const want = new Set(v.ids.split(','))
    questions = all.filter((q) => want.has(q.financebench_id))
  } else if (v.sample) {
    const n = Number(v.sample)
    const step = all.length / n
    questions = Array.from({ length: n }, (_, i) => all[Math.floor(i * step)]!)
  } else if (!v.all) throw new Error('pass --all, --sample <n> or --ids')

  // gold: doc path + line ranges of every evidence page
  const gold = new Map<string, { doc_path: string; start: number; end: number }[]>()
  for (const q of questions) {
    gold.set(
      q.financebench_id,
      q.evidence.map((e) => {
        const company = docs.get(e.doc_name)?.company ?? q.company
        const pages = JSON.parse(readFileSync(join(base, 'md-pages', `${e.doc_name}.json`), 'utf8')) as Record<string, [number, number]>
        const r = pages[String(e.evidence_page_num)]
        if (!r) throw new Error(`${q.financebench_id}: page ${e.evidence_page_num} missing in ${e.doc_name}`)
        return { doc_path: `${folder(company)}/${e.doc_name}.md`, start: r[0], end: r[1] }
      }),
    )
  }

  const prev = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { results: Result[] }).results : []
  const results: Result[] = prev.filter((r) => !r.error && questions.some((q) => q.financebench_id === r.id))
  const done = new Set(results.map((r) => r.id))
  const todo = questions.filter((q) => !done.has(q.financebench_id))
  log(`${questions.length} questions, ${done.size} resumed, ${todo.length} to run`)

  const work = mkdtempSync(join(tmpdir(), 'markindex-fb-'))
  const mcpConfig = join(work, 'mcp.json')
  const flatConfig = () => ({
    mcpServers: {
      chunksearch: {
        command: join(HERE, '..', '..', 'node_modules', '.bin', 'tsx'),
        args: [join(HERE, 'flat_server.ts'), '--db', flat!, '--root', root, '--pages', join(base, 'md-pages')],
      },
    },
  })
  writeFileSync(mcpConfig, JSON.stringify(flat ? flatConfig() : mcpConfigFor(cli, root, v.db ? resolve(v.db) : undefined)))
  const timeoutMs = Number(v['timeout-sec']) * 1000
  const order = new Map(all.map((q, i) => [q.financebench_id, i]))
  const save = () => {
    results.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    const report = {
      benchmark: cfg.benchmark ?? 'FinanceBench open-source (150)',
      protocol: 'Mafin2.5: single library, judge prompt from VectifyAI/Mafin2.5-FinanceBench eval.py',
      model: v.model,
      judge_model: v['judge-model'],
      server: serverName,
      tools,
      created_at: new Date().toISOString(),
      summary: summarize(results),
      results,
    }
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  }

  const one = async (q: FbQuestion): Promise<Result> => {
    const agentArgs = [
      '-p', AGENT_PROMPT(q.question, serverName, cfg.agent_intro),
      '--tools', '',
      '--setting-sources', '',
      '--mcp-config', mcpConfig,
      '--strict-mcp-config',
      '--allowedTools', `mcp__${serverName}__*`,
      ...(removed.length ? ['--disallowedTools', removed.join(',')] : []),
      '--output-format', 'json',
      '--max-turns', String(v['max-turns']),
      '--model', v.model!,
    ]
    const o = await runClaude(agentArgs, work, timeoutMs)
    const base = {
      id: q.financebench_id,
      question_type: q.question_type,
      question: q.question,
      gold_answer: q.answer,
      turns: o.ok ? o.turns : 0,
      cost_usd: o.ok ? o.costUsd : 0,
    }
    const parsed = o.ok && !o.isError ? parseAgentAnswer(o.result) : null
    if (!parsed) {
      const error = !o.ok ? o.raw : o.isError ? `claude error: ${o.result.slice(0, 300)}` : `no answer JSON: ${o.result.slice(0, 300)}`
      return { ...base, answer: o.ok ? o.result : null, evidence: [], correct: null, page_hit: false, doc_hit: false, judge_raw: '', error }
    }
    const g = gold.get(q.financebench_id)!
    const doc_hit = parsed.evidence.some((e) => g.some((x) => x.doc_path === e.doc_path))
    const page_hit = parsed.evidence.some((e) => g.some((x) => x.doc_path === e.doc_path && e.start_line <= x.end && e.end_line >= x.start))
    const j = await runClaude(
      ['-p', JUDGE_PROMPT(q.question, parsed.answer, q.answer), '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--output-format', 'json', '--max-turns', '1', '--model', v['judge-model']!],
      work,
      120_000,
    )
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
      log(`[${n}/${questions.length}] ${r.id} ${r.correct === true ? 'CORRECT' : r.correct === false ? 'wrong' : 'ERROR'} page=${r.page_hit ? 'Y' : 'n'} doc=${r.doc_hit ? 'Y' : 'n'} turns=${r.turns} $${r.cost_usd.toFixed(3)}${r.error ? ` (${r.error.slice(0, 160)})` : ''}`)
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
    log(`financebench: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  })
}
