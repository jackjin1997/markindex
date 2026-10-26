import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildClaudeArgs,
  buildReport,
  mcpConfigFor,
  parseClaudeOutput,
  parseEvidenceAnswer,
  parseRunnerArgs,
  sampleQuestions,
  scoreAnswer,
  type ClaudeCodeResult,
} from '../../eval/lib/claude-code.js'
import { parseQuestions, type EvalQuestion } from '../../src/eval/questions.js'
import type { QuestionResult } from '../../src/eval/score.js'

const repo = join(import.meta.dirname, '..', '..')

const q = (id: string, lang: EvalQuestion['lang'], gold: EvalQuestion['gold'] = [{ doc_path: 'a.md', start_line: 10, end_line: 20 }]): EvalQuestion => ({
  id,
  question: `question ${id}`,
  lang,
  gold,
  line: 1,
})

describe('parseEvidenceAnswer', () => {
  it('reads a bare JSON object, best first, at most 5 items', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ doc_path: `d${i}.md`, start_line: i + 1, end_line: i + 2 }))
    const r = parseEvidenceAnswer(JSON.stringify({ evidence: items }))
    expect(r).toHaveLength(5)
    expect(r![0]).toEqual({ docPath: 'd0.md', titlePath: [], startLine: 1, endLine: 2 })
  })

  it('tolerates prose and code fences around the object', () => {
    const text = 'Here you go:\n```json\n{"evidence":[{"doc_path":"x/y.md","start_line":3,"end_line":9}]}\n```\nDone.'
    expect(parseEvidenceAnswer(text)).toEqual([{ docPath: 'x/y.md', titlePath: [], startLine: 3, endLine: 9 }])
  })

  it('drops malformed items and swaps reversed ranges', () => {
    const text = JSON.stringify({
      evidence: [
        { doc_path: 'a.md', start_line: 9, end_line: 3 },
        { doc_path: '', start_line: 1, end_line: 2 },
        { doc_path: 'b.md', start_line: '1', end_line: 2 },
        { doc_path: 'c.md', start_line: 0, end_line: 2 },
        { doc_path: 'd.md', start_line: 4 },
      ],
    })
    expect(parseEvidenceAnswer(text)).toEqual([
      { docPath: 'a.md', titlePath: [], startLine: 3, endLine: 9 },
      { docPath: 'd.md', titlePath: [], startLine: 4, endLine: 4 },
    ])
  })

  it('returns null when there is no parsable evidence object', () => {
    expect(parseEvidenceAnswer('')).toBeNull()
    expect(parseEvidenceAnswer('I could not find it.')).toBeNull()
    expect(parseEvidenceAnswer('{"evidence": [}')).toBeNull()
    expect(parseEvidenceAnswer('{"answer": "42"}')).toBeNull()
    expect(parseEvidenceAnswer('{"evidence": []}')).toEqual([])
  })
})

describe('parseClaudeOutput', () => {
  it('extracts result, turns, cost and token usage from `claude -p --output-format json`', () => {
    const out = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '{"evidence":[]}',
      num_turns: 5,
      total_cost_usd: 0.15,
      usage: { input_tokens: 8, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000, output_tokens: 300 },
    })
    expect(parseClaudeOutput(out)).toEqual({ ok: true, result: '{"evidence":[]}', turns: 5, costUsd: 0.15, tokens: 21308, isError: false })
  })

  it('reports unparsable output', () => {
    expect(parseClaudeOutput('Error: not logged in')).toEqual({ ok: false, raw: 'Error: not logged in' })
  })
})

describe('sampleQuestions', () => {
  const qs = [...Array.from({ length: 6 }, (_, i) => q(`en-${i}`, 'en')), ...Array.from({ length: 3 }, (_, i) => q(`zh-${i}`, 'zh'))]

  it('takes every k-th question per language, deterministically', () => {
    expect(sampleQuestions(qs, { perLang: 2 }).map((x) => x.id)).toEqual(['en-0', 'en-3', 'zh-0', 'zh-1'])
    expect(sampleQuestions(qs, { perLang: 5 }).map((x) => x.id)).toEqual(['en-0', 'en-1', 'en-2', 'en-3', 'en-4', 'zh-0', 'zh-1', 'zh-2'])
    expect(sampleQuestions(qs, 'all')).toEqual(qs)
  })

  it('reproduces the 30 question ids of the committed Claude Code run', () => {
    const all = parseQuestions(readFileSync(join(repo, 'eval/questions.jsonl'), 'utf8'))
    const committed = JSON.parse(readFileSync(join(repo, 'eval/results/agent-claude-code-sonnet-30.json'), 'utf8')) as { results: { id: string }[] }
    expect(sampleQuestions(all, { perLang: 10 }).map((x) => x.id).sort()).toEqual(committed.results.map((r) => r.id).sort())
  })
})

describe('scoreAnswer', () => {
  const readTokens = () => 7
  it('hit, rank, distinct evidence lines and precision via the shared score helpers', () => {
    const r = scoreAnswer(q('en-1', 'en'), { ok: true, result: '', turns: 4, costUsd: 0.1, tokens: 900, isError: false }, [
      { docPath: 'b.md', titlePath: [], startLine: 1, endLine: 5 },
      { docPath: 'a.md', titlePath: [], startLine: 15, endLine: 24 },
      { docPath: 'a.md', titlePath: [], startLine: 20, endLine: 24 },
    ], readTokens)
    expect(r).toMatchObject({
      id: 'en-1',
      lang: 'en',
      hit: true,
      rank: 2,
      evidenceLines: 15,
      evidenceTokens: 14,
      precision: 0.4,
      tokens: 900,
      steps: 4,
      turns: 4,
      costUsd: 0.1,
      parseOk: true,
    })
    expect(r.error).toBeUndefined()
  })

  it('an unparsable answer or CLI failure is a miss with an error', () => {
    const noAnswer = scoreAnswer(q('en-2', 'en'), { ok: true, result: 'sorry', turns: 3, costUsd: 0.2, tokens: 10, isError: false }, null, readTokens)
    expect(noAnswer).toMatchObject({ hit: false, rank: null, evidenceLines: 0, precision: null, parseOk: false, error: 'no evidence JSON in the answer' })
    const bad = scoreAnswer(q('en-3', 'en'), { ok: false, raw: 'boom' }, null, readTokens)
    expect(bad).toMatchObject({ hit: false, steps: 0, costUsd: 0, error: 'unparsable claude output: boom' })
    const errored = scoreAnswer(q('en-4', 'en'), { ok: true, result: 'max turns', turns: 20, costUsd: 1, tokens: 5, isError: true }, null, readTokens)
    expect(errored.error).toBe('claude reported an error: max turns')
  })
})

describe('buildReport', () => {
  const res = (id: string, lang: EvalQuestion['lang'], hit: boolean, extra: Partial<ClaudeCodeResult> = {}): ClaudeCodeResult => ({
    id,
    lang,
    hit,
    rank: hit ? 1 : null,
    tokens: 100,
    steps: 4,
    evidence: [],
    evidenceLines: 10,
    evidenceTokens: 30,
    precision: hit ? 1 : 0,
    turns: 4,
    costUsd: 0.25,
    parseOk: true,
    ...extra,
  })
  const bm = (id: string, lang: EvalQuestion['lang'], hit: boolean): QuestionResult => ({
    id, lang, hit, rank: hit ? 3 : null, tokens: 1, steps: 1, evidence: [], evidenceLines: 200, evidenceTokens: 900, precision: 0.1,
  })

  it('aggregates by language with turns and cost, and compares bm25 on the same ids', () => {
    const results = [res('en-1', 'en', true), res('en-2', 'en', false, { turns: 6, costUsd: 0.5 }), res('zh-1', 'zh', true)]
    const bm25 = { mode: 'bm25', options: { topK: 5 }, results: [bm('en-1', 'en', true), bm('en-2', 'en', false), bm('zh-1', 'zh', false), bm('zh-9', 'zh', true)] }
    const r = buildReport({ model: 'sonnet', options: { perLang: 2, maxTurns: 20, concurrency: 3 }, results, bm25, createdAt: 'T' })
    expect(r.runner).toBe('claude-code')
    expect(r.summary.overall).toMatchObject({ questions: 3, hits: 2, meanEvidenceLines: 10 })
    expect(r.claudeCode.overall).toEqual({ meanTurns: 4.6667, totalCostUsd: 1, parseFailures: 0 })
    expect(r.claudeCode.byLang.en).toEqual({ meanTurns: 5, totalCostUsd: 0.75, parseFailures: 0 })
    expect(r.baseline).toMatchObject({ mode: 'bm25', topK: 5, missingIds: [] })
    expect(r.baseline!.summary.overall).toMatchObject({ questions: 3, hits: 1, meanEvidenceLines: 200 })
    expect(r.baseline!.summary.byLang.zh).toMatchObject({ questions: 1, hits: 0 })
  })

  it('lists sampled ids missing from the bm25 report; no baseline without one', () => {
    const r = buildReport({ model: 'sonnet', options: { all: true }, results: [res('en-1', 'en', true), res('mx-1', 'mixed', true)], bm25: { results: [bm('en-1', 'en', true)] }, createdAt: 'T' })
    expect(r.baseline!.missingIds).toEqual(['mx-1'])
    expect(r.baseline!.topK).toBeNull()
    expect(buildReport({ model: 'sonnet', options: {}, results: [], createdAt: 'T' }).baseline).toBeUndefined()
  })
})

describe('runner plumbing', () => {
  it('mcp config points at `node <cli> mcp <root>`, with --db when given', () => {
    expect(mcpConfigFor('/r/dist/cli.js', '/lib')).toEqual({ mcpServers: { markindex: { command: process.execPath, args: ['/r/dist/cli.js', 'mcp', '/lib'] } } })
    expect(mcpConfigFor('/c.js', '/lib', '/x.db').mcpServers.markindex.args).toEqual(['/c.js', 'mcp', '/lib', '--db', '/x.db'])
  })

  it('claude args restrict the session to the markindex MCP tools', () => {
    const args = buildClaudeArgs({ question: 'Q?', mcpConfig: '/t/mcp.json', model: 'sonnet', maxTurns: 20 })
    expect(args[0]).toBe('-p')
    expect(args[1]).toContain('Question: Q?')
    expect(args.slice(2)).toEqual([
      '--mcp-config', '/t/mcp.json', '--strict-mcp-config', '--allowedTools', 'mcp__markindex__*',
      '--output-format', 'json', '--max-turns', '20', '--model', 'sonnet',
    ])
  })

  it('parses runner arguments', () => {
    const a = parseRunnerArgs(['--root', 'lib', '--questions', 'q.jsonl', '--per-lang', '10', '--model', 'opus', '--concurrency', '2', '--out', 'o.json', '--bm25', 'b.json'])
    expect(a).toMatchObject({ sample: { perLang: 10 }, model: 'opus', concurrency: 2, bm25: expect.stringMatching(/b\.json$/), dryRun: false })
    expect(parseRunnerArgs(['--root', 'l', '--questions', 'q', '--all', '--out', 'o', '--dry-run']).dryRun).toBe(true)
    expect(parseRunnerArgs(['--root', 'lib', '--questions', 'q.jsonl', '--all', '--out', 'o.json'])).toMatchObject({ sample: 'all', model: 'sonnet', concurrency: 3, maxTurns: 20 })
    expect(() => parseRunnerArgs(['--root', 'lib', '--questions', 'q.jsonl', '--out', 'o.json'])).toThrow(/--per-lang.*--all/)
    expect(() => parseRunnerArgs(['--root', 'lib', '--questions', 'q.jsonl', '--all', '--per-lang', '3', '--out', 'o'])).toThrow(/not both/)
    expect(() => parseRunnerArgs(['--root', 'lib', '--questions', 'q.jsonl', '--per-lang', '0', '--out', 'o'])).toThrow(/--per-lang/)
    expect(() => parseRunnerArgs(['--questions', 'q.jsonl', '--all', '--out', 'o'])).toThrow(/--root/)
  })
})
