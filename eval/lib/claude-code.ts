/**
 * Pure parts of the Claude Code agent-mode runner (eval/claude-code-eval.ts): argument parsing, question sampling,
 * `claude -p` output and answer parsing, scoring with the shared helpers and report aggregation.
 * Nothing here spawns processes or touches the network, so it is unit-tested (tests/eval/claude-code.test.ts).
 */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { EvalQuestion, QuestionIssue } from '../../src/eval/questions.js'
import {
  aggregate,
  evidenceLineRanges,
  evidencePrecision,
  firstHitRank,
  type Aggregate,
  type EvidenceRef,
  type LineRange,
  type QuestionResult,
} from '../../src/eval/score.js'

/** At most this many evidence items of an answer are judged (best first). */
export const MAX_ANSWER_ITEMS = 5

export const PROMPT = (question: string) => `You are evaluating a retrieval tool. Use ONLY the markindex MCP tools to locate the passage(s) in the library that answer the question below. Do not answer the question itself.
When done, reply with ONLY a JSON object (no prose, no code fence): {"evidence":[{"doc_path":"...","start_line":N,"end_line":N}]} — at most ${MAX_ANSWER_ITEMS} items, best first, each a tight line range you actually read.

Question: ${question}`

export type Sample = { perLang: number } | 'all'

export interface RunnerArgs {
  root: string
  questions: string
  sample: Sample
  /** Claude Code model alias or id (`sonnet`, `opus`, `claude-sonnet-5-5`, …). */
  model: string
  concurrency: number
  maxTurns: number
  /** Per-question wall-clock limit for one `claude -p` process. */
  timeoutMs: number
  out: string
  /** A `markindex eval --mode bm25` report to compare on the same question ids. */
  bm25?: string
  /** Index database passed to `markindex mcp --db`. */
  db?: string
  /** Built CLI to serve over MCP (default `<repo>/dist/cli.js`). */
  cli?: string
  /** Validate the questions and print the sample and the `claude` command line without running anything. */
  dryRun: boolean
}

const positiveInt = (v: string | undefined, name: string, def: number) => {
  if (v === undefined) return def
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be an integer >= 1, got "${v}"`)
  return n
}

export function parseRunnerArgs(argv: string[]): RunnerArgs {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: {
      root: { type: 'string' },
      questions: { type: 'string' },
      'per-lang': { type: 'string' },
      all: { type: 'boolean' },
      model: { type: 'string' },
      concurrency: { type: 'string' },
      'max-turns': { type: 'string' },
      'timeout-sec': { type: 'string' },
      out: { type: 'string' },
      bm25: { type: 'string' },
      db: { type: 'string' },
      cli: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  })
  for (const name of ['root', 'questions', 'out'] as const) {
    if (!v[name]) throw new Error(`--${name} is required`)
  }
  if (v.all && v['per-lang'] !== undefined) throw new Error('pass --per-lang <n> or --all, not both')
  if (!v.all && v['per-lang'] === undefined) throw new Error('pass --per-lang <n> (stratified sample) or --all')
  return {
    root: resolve(v.root!),
    questions: resolve(v.questions!),
    sample: v.all ? 'all' : { perLang: positiveInt(v['per-lang'], '--per-lang', 1) },
    model: v.model ?? 'sonnet',
    concurrency: positiveInt(v.concurrency, '--concurrency', 3),
    maxTurns: positiveInt(v['max-turns'], '--max-turns', 20),
    timeoutMs: positiveInt(v['timeout-sec'], '--timeout-sec', 420) * 1000,
    out: resolve(v.out!),
    ...(v.bm25 ? { bm25: resolve(v.bm25) } : {}),
    ...(v.db ? { db: resolve(v.db) } : {}),
    ...(v.cli ? { cli: resolve(v.cli) } : {}),
    dryRun: v['dry-run'] === true,
  }
}

/**
 * Deterministic stratified sample: per language (in order of first appearance), every k-th question with
 * k = count / perLang; all of them when a language has fewer than `perLang`.
 */
export function sampleQuestions(questions: EvalQuestion[], sample: Sample): EvalQuestion[] {
  if (sample === 'all') return questions
  const byLang = new Map<string, EvalQuestion[]>()
  for (const q of questions) {
    const list = byLang.get(q.lang) ?? []
    list.push(q)
    byLang.set(q.lang, list)
  }
  return [...byLang.values()].flatMap((qs) => {
    if (qs.length <= sample.perLang) return qs
    const step = qs.length / sample.perLang
    return Array.from({ length: sample.perLang }, (_, i) => qs[Math.floor(i * step)]!)
  })
}

export function mcpConfigFor(cli: string, root: string, db?: string) {
  return {
    mcpServers: {
      markindex: { command: process.execPath, args: [cli, 'mcp', root, ...(db ? ['--db', db] : [])] },
    },
  }
}

/**
 * `claude -p` arguments. `--tools ""` removes every built-in tool (Read, Grep, Bash, WebFetch, …; MCP tools are not
 * affected) — `--allowedTools` alone only pre-approves tools and would leave the built-ins available.
 * `--setting-sources ""` ignores user / project / local settings (permission mode, hooks, extra MCP servers);
 * authentication still works without them. Only the markindex MCP server is loaded, and its tools are pre-approved.
 */
export function buildClaudeArgs(o: { question: string; mcpConfig: string; model: string; maxTurns: number }): string[] {
  return [
    '-p', PROMPT(o.question),
    '--tools', '',
    '--setting-sources', '',
    '--mcp-config', o.mcpConfig,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__markindex__*',
    '--output-format', 'json',
    '--max-turns', String(o.maxTurns),
    '--model', o.model,
  ]
}

/**
 * Answers carry line ranges only (no title path), so a gold with a title_path but no line range cannot be judged
 * (any range in the document would match). Returns one issue per such question; doc-level golds are fine.
 */
export function unsupportedGold(questions: EvalQuestion[]): QuestionIssue[] {
  const issues: QuestionIssue[] = []
  for (const q of questions) {
    const bad = q.gold.find((g) => g.title_path !== undefined && g.start_line === undefined)
    if (bad) {
      issues.push({
        line: q.line,
        message: `question "${q.id}": gold in "${bad.doc_path}" has a title_path but no line range; the Claude Code runner judges line ranges only (add start_line / end_line)`,
      })
    }
  }
  return issues
}

export type ClaudeOutput =
  | { ok: true; result: string; turns: number; costUsd: number; tokens: number; isError: boolean }
  | { ok: false; raw: string }

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)

/** Parses the single JSON object printed by `claude -p --output-format json`. */
export function parseClaudeOutput(stdout: string): ClaudeOutput {
  let j: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    j = parsed as Record<string, unknown>
  } catch {
    return { ok: false, raw: stdout.slice(0, 500) }
  }
  const u = (j.usage ?? {}) as Record<string, unknown>
  return {
    ok: true,
    result: typeof j.result === 'string' ? j.result : '',
    turns: num(j.num_turns),
    costUsd: num(j.total_cost_usd),
    tokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens),
    isError: j.is_error === true,
  }
}

const lineNo = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 1 ? x : undefined)

/**
 * Extracts `{"evidence":[{doc_path,start_line,end_line}]}` from the model's final answer (prose and code fences
 * around it are tolerated). Malformed items are dropped, a missing end_line means one line, reversed ranges are
 * swapped, and only the first MAX_ANSWER_ITEMS are kept. Returns null when no evidence object can be parsed.
 */
export function parseEvidenceAnswer(text: string): EvidenceRef[] | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const items = (parsed as { evidence?: unknown } | null)?.evidence
  if (!Array.isArray(items)) return null
  const out: EvidenceRef[] = []
  for (const item of items) {
    const it = (item ?? {}) as Record<string, unknown>
    const a = lineNo(it.start_line)
    const b = it.end_line === undefined ? a : lineNo(it.end_line)
    if (typeof it.doc_path !== 'string' || it.doc_path === '' || a === undefined || b === undefined) continue
    out.push({ docPath: it.doc_path, titlePath: [], startLine: Math.min(a, b), endLine: Math.max(a, b) })
  }
  return out.slice(0, MAX_ANSWER_ITEMS)
}

/** A scored question plus the Claude Code session facts. `tokens` = all input (incl. cache) + output tokens; `steps` = turns. */
export interface ClaudeCodeResult extends QuestionResult {
  turns: number
  costUsd: number
  /** The final answer contained a parsable evidence object. */
  parseOk: boolean
}

/** Scores one answer with the shared helpers (same hit rule, evidence size and precision as `markindex eval`). */
export function scoreAnswer(
  q: EvalQuestion,
  output: ClaudeOutput,
  evidence: EvidenceRef[] | null,
  readTokens: (range: LineRange) => number,
): ClaudeCodeResult {
  const ev = evidence ?? []
  const ranges = evidenceLineRanges(ev)
  const rank = firstHitRank(ev, q.gold)
  const base = {
    id: q.id,
    lang: q.lang,
    hit: rank !== null,
    rank,
    evidence: ev,
    evidenceLines: ranges.reduce((n, r) => n + r.endLine - r.startLine + 1, 0),
    evidenceTokens: ranges.reduce((n, r) => n + readTokens(r), 0),
    precision: evidencePrecision(ev, q.gold),
    parseOk: evidence !== null,
  }
  if (!output.ok) return { ...base, tokens: 0, steps: 0, turns: 0, costUsd: 0, error: `unparsable claude output: ${output.raw}` }
  const session = { tokens: output.tokens, steps: output.turns, turns: output.turns, costUsd: output.costUsd }
  if (output.isError) return { ...base, ...session, error: `claude reported an error: ${output.result.slice(0, 300)}` }
  if (evidence === null) return { ...base, ...session, error: 'no evidence JSON in the answer' }
  return { ...base, ...session }
}

export interface SessionSummary {
  meanTurns: number
  totalCostUsd: number
  /** Questions whose answer had no parsable evidence object (incl. CLI failures). */
  parseFailures: number
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000

function sessionSummary(rs: ClaudeCodeResult[]): SessionSummary {
  return {
    meanTurns: rs.length === 0 ? 0 : round4(rs.reduce((s, r) => s + r.turns, 0) / rs.length),
    totalCostUsd: round4(rs.reduce((s, r) => s + r.costUsd, 0)),
    parseFailures: rs.filter((r) => !r.parseOk).length,
  }
}

export interface ClaudeCodeReport {
  mode: 'agent'
  runner: 'claude-code'
  model: string
  createdAt: string
  options: Record<string, unknown>
  /** Same aggregate as `markindex eval` (hit rate, evidence size, precision; tokens = session tokens, steps = turns). */
  summary: Aggregate
  claudeCode: { overall: SessionSummary; byLang: Partial<Record<EvalQuestion['lang'], SessionSummary>> }
  /** The given bm25 report restricted to the sampled question ids. */
  baseline?: { mode: 'bm25'; topK: number | null; summary: Aggregate; missingIds: string[] }
  results: ClaudeCodeResult[]
}

export function buildReport(o: {
  model: string
  options: Record<string, unknown>
  results: ClaudeCodeResult[]
  bm25?: { options?: { topK?: number }; results: QuestionResult[] }
  createdAt: string
}): ClaudeCodeReport {
  const byLang: ClaudeCodeReport['claudeCode']['byLang'] = {}
  for (const lang of ['zh', 'en', 'mixed'] as const) {
    const rs = o.results.filter((r) => r.lang === lang)
    if (rs.length > 0) byLang[lang] = sessionSummary(rs)
  }
  const report: ClaudeCodeReport = {
    mode: 'agent',
    runner: 'claude-code',
    model: o.model,
    createdAt: o.createdAt,
    options: o.options,
    summary: aggregate(o.results),
    claudeCode: { overall: sessionSummary(o.results), byLang },
    results: o.results,
  }
  if (o.bm25) {
    const byId = new Map(o.bm25.results.map((r) => [r.id, r]))
    const same = o.results.flatMap((r) => byId.get(r.id) ?? [])
    report.baseline = {
      mode: 'bm25',
      topK: o.bm25.options?.topK ?? null,
      summary: aggregate(same),
      missingIds: o.results.filter((r) => !byId.has(r.id)).map((r) => r.id),
    }
  }
  return report
}
