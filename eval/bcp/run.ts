/**
 * BrowseComp-Plus (github.com/texttron/BrowseComp-Plus) through Claude Code + the MarkIndex MCP server.
 *
 *   npx tsx eval/bcp/run.ts --root eval/bcp/md --db eval/bcp/runs/lib.db --run-dir eval/bcp/runs/<name> \
 *     (--all | --sample <n> | --ids id1,id2) [--model haiku] [--judge-model sonnet] [--no-judge] \
 *     [--max-turns 60] [--timeout-sec 1500] [--concurrency 3] [--rerank jev|overlap] [--rerank-pool 50] \
 *     [--product-rerank jev]
 *
 * `--product-rerank jev` starts the built CLI with its own option, `markindex mcp --rerank jev`: the package's
 * optional reranking as a user gets it. The server is not told the question; the agent may pass `intent` to
 * search_documents, and the hits are judged against that (else against the keywords). How often it did is
 * recorded per question as `intent_calls`, next to `reranked_searches` (searches that came back scored).
 *
 * `--rerank <scorer>` serves the tools from rerank_server.ts instead of the built CLI: every search fetches
 * `--rerank-pool` nodes and returns the ones the scorer judges most relevant to the question (see rerank.ts for
 * the keys the scorer reads from the environment). Scores are cached in `<run-dir>.scores.jsonl` unless
 * `--rerank-cache` names another file; one line per search goes to `<run-dir>.searches.jsonl`.
 *
 * Writes one JSON file per query into --run-dir in the format of the benchmark's evaluation script
 * (query_id, tool_call_counts, status, retrieved_docids, result), plus `<run-dir>.report.json` with our own summary.
 * A re-run resumes: queries with a "completed" file are skipped.
 *
 * Scaffold ("Custom" on the leaderboard): one fresh `claude -p` session per query whose only tools are MarkIndex's
 * `search_documents`, `get_document_structure` and `get_node_content` over the corpus converted to Markdown, one
 * file per document. The prompt is the benchmark's QUERY_TEMPLATE with the tool sentence adapted.
 *
 * `retrieved_docids` is the union of the documents returned by any search and of the documents the agent read.
 * The judge here (a Claude model with the benchmark's grader prompt) is for our own reference only: leaderboard
 * submissions must be judged with Qwen3-32B by the benchmark's scripts_evaluation/evaluate_run.py.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { mcpConfigFor } from '../lib/claude-code.js'
import { runClaude } from '../financebench/run.js'

const HERE = import.meta.dirname
const log = (s: string) => process.stderr.write(`${s}\n`)
const REMOVED = ['browse_documents', 'get_document'].map((t) => `mcp__markindex__${t}`)

interface Query { query_id: string; query: string; answer: string; evidence_docids: string[] }

/** The benchmark's QUERY_TEMPLATE (search_agent/prompts.py); only the sentence about the tools is adapted. */
const QUERY_PROMPT = (question: string) => `You are a deep research agent. You need to answer the given question by interacting with a search engine over a fixed library of web documents, using the markindex MCP tools provided: search_documents to search, get_document_structure and get_node_content to read a document. Every document is one Markdown file whose name is its docid (for example "docs/42/12345.md" is docid 12345). Please perform reasoning and use the tools step by step, in an interleaved manner. You may use the tools multiple times.

Question: ${question}

Your response should be in the following format:
Explanation: {your explanation for your final answer. For this explanation section only, you should cite your evidence documents inline by enclosing their docids in square brackets [] at the end of sentences. For example, [20].}
Exact Answer: {your succinct, final answer}
Confidence: {your confidence score between 0% and 100% for your answer}`

/** The benchmark's GRADER_TEMPLATE (scripts_evaluation/evaluate_run.py), verbatim. */
const GRADER_PROMPT = (question: string, response: string, correct: string) => `Judge whether the following [response] to [question] is correct or not based on the precise and unambiguous [correct_answer] below.

[question]: ${question}

[response]: ${response}

[correct_answer]: ${correct}

Your judgement must be in the format and criteria specified below:

extracted_final_answer: The final exact answer extracted from the [response].

[correct_answer]: Repeat the [correct_answer] given above.

reasoning: Explain why the extracted_final_answer is correct or incorrect based on [correct_answer], in the context of this [question]. You should judge whether the extracted_final_answer is semantically equivalent to [correct_answer], allowing the extracted_final_answer to be string variations of [correct_answer]. You should also allow the extracted_final_answer to be more precise or verbose than [correct_answer], as long as its additional details are correct. Do not comment on any background to the problem, do not attempt to solve the problem, do not argue for any answer different than [correct_answer], focus only on whether the answers are semantically equivalent.

correct: Answer 'yes' if extracted_final_answer matches the [correct_answer] given above, or is within a small margin of error for numerical problems. Answer 'no' otherwise, i.e. if there if there is any inconsistency, ambiguity, non-equivalency, or if the extracted answer is incorrect.


confidence: The extracted confidence score between 0|\\%| and 100|\\%| from [response]. Put 100 if there is no confidence score available.`

interface Trace { calls: Record<string, number>; docids: Set<string>; result: string; ok: boolean; isError: boolean; turns: number; cost: number; raw: string; intents: number; reranked: number }

const docidOf = (docPath: string) => docPath.split('/').pop()!.replace(/\.md$/, '')

/** One agent session with stream-json output: tool calls are counted and every doc_path in a tool result is kept. */
function runAgent(args: string[], cwd: string, timeoutMs: number): Promise<Trace> {
  return new Promise((done) => {
    const t: Trace = { calls: {}, docids: new Set(), result: '', ok: false, isError: false, turns: 0, cost: 0, raw: '', intents: 0, reranked: 0 }
    const p = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    let err = ''
    const onLine = (line: string) => {
      if (!line.trim()) return
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) {
          if (c.type === 'tool_use') {
            const name = String(c.name).replace('mcp__markindex__', '')
            t.calls[name] = (t.calls[name] ?? 0) + 1
            if (name === 'search_documents' && typeof c.input?.intent === 'string') t.intents++
            const dp = c.input?.doc_path
            if (typeof dp === 'string') t.docids.add(docidOf(dp))
          }
        }
      } else if (ev.type === 'user') {
        for (const c of ev.message?.content ?? []) {
          if (c.type !== 'tool_result') continue
          const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join('\n') : String(c.content ?? '')
          for (const m of text.matchAll(/"doc_path"\s*:\s*"([^"]+)"/g)) t.docids.add(docidOf(m[1]!))
          // the package's reranking reports itself in the search result: {"rerank":{"by":…,"candidates":…,"scored":N}}
          const scored = /"rerank"\s*:\s*\{[^}]*"scored"\s*:\s*(\d+)/.exec(text)
          if (scored && Number(scored[1]) > 0) t.reranked++
        }
      } else if (ev.type === 'result') {
        t.ok = true
        t.isError = Boolean(ev.is_error)
        t.result = typeof ev.result === 'string' ? ev.result : ''
        t.turns = Number(ev.num_turns ?? 0)
        t.cost = Number(ev.total_cost_usd ?? 0)
      }
    }
    p.stdout.on('data', (d: Buffer) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) !== -1) {
        onLine(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    })
    p.stderr.on('data', (d: Buffer) => (err += d))
    let killer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      p.kill('SIGTERM')
      killer = setTimeout(() => p.kill('SIGKILL'), 10_000)
    }, timeoutMs)
    const finish = () => {
      clearTimeout(timer)
      clearTimeout(killer)
      onLine(buf)
      if (!t.ok) t.raw = `no result event${err ? ` | stderr: ${err.slice(0, 300)}` : ''}`
      done(t)
    }
    p.on('error', (e) => {
      t.raw = `could not run claude: ${e.message}`
      finish()
    })
    p.on('close', finish)
  })
}

async function main() {
  const { values: v } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: 'string' },
      db: { type: 'string' },
      'run-dir': { type: 'string' },
      queries: { type: 'string', default: join(HERE, 'data', 'queries.jsonl') },
      all: { type: 'boolean' },
      sample: { type: 'string' },
      ids: { type: 'string' },
      model: { type: 'string', default: 'haiku' },
      'judge-model': { type: 'string', default: 'sonnet' },
      'no-judge': { type: 'boolean' },
      'max-turns': { type: 'string', default: '60' },
      'timeout-sec': { type: 'string', default: '1500' },
      concurrency: { type: 'string', default: '3' },
      cli: { type: 'string' },
      rerank: { type: 'string' },
      'rerank-pool': { type: 'string', default: '50' },
      'rerank-max-chars': { type: 'string', default: '8000' },
      'rerank-cache': { type: 'string' },
      'product-rerank': { type: 'string' },
    },
  })
  if (!v.root || !v.db || !v['run-dir']) throw new Error('--root, --db and --run-dir are required')
  const root = resolve(v.root)
  const runDir = resolve(v['run-dir'])
  const cli = v.cli ? resolve(v.cli) : join(HERE, '..', '..', 'dist', 'cli.js')
  if (!existsSync(cli)) throw new Error(`${cli} not found: run npm run build`)
  if (v.rerank && v['product-rerank']) throw new Error('--rerank and --product-rerank cannot be combined')
  mkdirSync(runDir, { recursive: true })

  const all = readFileSync(resolve(v.queries!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Query)
  let queries = all
  if (v.ids) {
    const want = new Set(v.ids.split(','))
    queries = all.filter((q) => want.has(q.query_id))
  } else if (v.sample) {
    const n = Number(v.sample)
    const step = all.length / n
    queries = Array.from({ length: n }, (_, i) => all[Math.floor(i * step)]!)
  } else if (!v.all) throw new Error('pass --all, --sample <n> or --ids')

  const fileOf = (id: string) => join(runDir, `${id}.json`)
  const isDone = (id: string) => existsSync(fileOf(id)) && (JSON.parse(readFileSync(fileOf(id), 'utf8')) as { status: string }).status === 'completed'
  const todo = queries.filter((q) => !isDone(q.query_id))
  log(`${queries.length} queries, ${queries.length - todo.length} resumed, ${todo.length} to run`)

  const work = mkdtempSync(join(tmpdir(), 'markindex-bcp-'))
  const mcpConfig = join(work, 'mcp.json')
  const plain = mcpConfigFor(cli, root, resolve(v.db))
  const KEY_VARS = ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'JEV_BASE_URL', 'JEV_API_KEY', 'JEV_MODEL']
  // The keys are passed by reference (`${NAME:-}` is expanded by Claude Code), so they are never written.
  const product = { mcpServers: { markindex: { ...plain.mcpServers.markindex, args: [...plain.mcpServers.markindex.args, '--rerank', v['product-rerank'] ?? '', '--rerank-pool', v['rerank-pool']!], env: Object.fromEntries(KEY_VARS.map((k) => [k, `\${${k}:-}`])) } } }
  writeFileSync(mcpConfig, JSON.stringify(v['product-rerank'] ? product : plain))
  // With --rerank every question gets its own server process and config, because the server is told the question.
  // The scorer's keys are passed by reference (`${NAME:-}` is expanded by Claude Code), so they are never written.
  const repo = join(HERE, '..', '..')
  const rerankConfigFor = (q: Query) => {
    const file = join(work, `mcp-${q.query_id}.json`)
    const passed = ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'JEV_BASE_URL', 'JEV_API_KEY', 'JEV_MODEL', 'JEV_CONCURRENCY']
    writeFileSync(file, JSON.stringify({
      mcpServers: {
        markindex: {
          command: process.execPath,
          args: [
            '--import', pathToFileURL(join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
            join(HERE, 'rerank_server.ts'), root, '--db', resolve(v.db!),
            '--scorer', v.rerank!, '--pool', v['rerank-pool']!, '--max-chars', v['rerank-max-chars']!,
            '--cache', resolve(v['rerank-cache'] ?? `${runDir}.scores.jsonl`), '--log', `${runDir}.searches.jsonl`,
          ],
          env: { RERANK_QUESTION: q.query, ...Object.fromEntries(passed.map((k) => [k, `\${${k}:-}`])) },
        },
      },
    }))
    return file
  }
  const timeoutMs = Number(v['timeout-sec']) * 1000

  const one = async (q: Query) => {
    const t = await runAgent(
      [
        '-p', QUERY_PROMPT(q.query),
        '--tools', '',
        '--setting-sources', '',
        '--mcp-config', v.rerank ? rerankConfigFor(q) : mcpConfig,
        '--strict-mcp-config',
        '--allowedTools', 'mcp__markindex__*',
        '--disallowedTools', REMOVED.join(','),
        '--output-format', 'stream-json',
        '--verbose',
        '--max-turns', String(v['max-turns']),
        '--model', v.model!,
      ],
      work,
      timeoutMs,
    )
    const completed = t.ok && !t.isError && /Exact Answer:/i.test(t.result)
    const retrieved = [...t.docids].sort()
    const evidence = new Set(q.evidence_docids)
    const recall = evidence.size ? retrieved.filter((d) => evidence.has(d)).length / evidence.size : 0
    let correct: boolean | null = null
    let judgeRaw = ''
    let judgeCost = 0
    if (completed && !v['no-judge']) {
      const j = await runClaude(
        ['-p', GRADER_PROMPT(q.query, t.result, q.answer), '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--output-format', 'json', '--max-turns', '1', '--model', v['judge-model']!],
        work,
        180_000,
      )
      judgeRaw = j.ok ? j.result : j.raw
      judgeCost = j.ok ? j.costUsd : 0
      const m = /\*{0,2}correct:?\*{0,2}:?\s*(yes|no)/i.exec(judgeRaw)
      correct = m ? m[1]!.toLowerCase() === 'yes' : null
    }
    const record = {
      query_id: q.query_id,
      tool_call_counts: t.calls,
      status: completed ? 'completed' : t.ok ? (t.isError ? 'error' : 'no_exact_answer') : 'failed',
      retrieved_docids: retrieved,
      result: [{ type: 'output_text', output: t.result }],
      // our own bookkeeping; the benchmark's script ignores extra fields
      markindex: { model: v.model, turns: t.turns, cost_usd: t.cost + judgeCost, agent_cost_usd: t.cost, recall, ...(v['product-rerank'] ? { intent_calls: t.intents, reranked_searches: t.reranked } : {}), reference_judge: v['no-judge'] ? null : v['judge-model'], reference_correct: correct, judge_raw: judgeRaw, error: t.ok ? undefined : t.raw },
    }
    writeFileSync(fileOf(q.query_id), `${JSON.stringify(record, null, 1)}\n`)
    return record
  }

  let next = 0
  let n = queries.length - todo.length
  const worker = async () => {
    while (next < todo.length) {
      const q = todo[next++]!
      const r = await one(q)
      n++
      const m = r.markindex
      log(`[${n}/${queries.length}] ${r.query_id} ${r.status} ${m.reference_correct === true ? 'CORRECT' : m.reference_correct === false ? 'wrong' : '-'} recall=${(100 * m.recall).toFixed(0)}% search=${r.tool_call_counts.search_documents ?? 0} read=${r.tool_call_counts.get_node_content ?? 0} turns=${m.turns} $${m.cost_usd.toFixed(3)}`)
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(Number(v.concurrency), todo.length) }, worker))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  const records = queries.filter((q) => existsSync(fileOf(q.query_id))).map((q) => JSON.parse(readFileSync(fileOf(q.query_id), 'utf8')) as Awaited<ReturnType<typeof one>>)
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const summary = {
    benchmark: 'BrowseComp-Plus',
    scaffold: `Claude Code headless + MarkIndex MCP (search_documents, get_document_structure, get_node_content)${v.rerank ? `; search reranked by ${v.rerank} over a pool of ${v['rerank-pool']} nodes, judged against the question` : ''}${v['product-rerank'] ? `; markindex mcp --rerank ${v['product-rerank']} over a pool of ${v['rerank-pool']} nodes, judged against the agent's intent or query` : ''}`,
    model: v.model,
    reference_judge: v['no-judge'] ? null : v['judge-model'],
    queries: records.length,
    completed: records.filter((r) => r.status === 'completed').length,
    reference_accuracy: mean(records.map((r) => (r.markindex.reference_correct === true ? 1 : 0))),
    recall: mean(records.map((r) => r.markindex.recall)),
    search_calls: mean(records.map((r) => r.tool_call_counts.search_documents ?? 0)),
    read_calls: mean(records.map((r) => r.tool_call_counts.get_node_content ?? 0)),
    ...(v['product-rerank'] ? { intent_calls: mean(records.map((r) => (r.markindex as { intent_calls?: number }).intent_calls ?? 0)), reranked_searches: mean(records.map((r) => (r.markindex as { reranked_searches?: number }).reranked_searches ?? 0)) } : {}),
    mean_turns: mean(records.map((r) => r.markindex.turns)),
    cost_usd: records.reduce((s, r) => s + r.markindex.cost_usd, 0),
    agent_cost_usd: records.reduce((s, r) => s + r.markindex.agent_cost_usd, 0),
  }
  writeFileSync(`${runDir}.report.json`, `${JSON.stringify(summary, null, 2)}\n`) // next to the run folder, which holds query files only
  log(JSON.stringify(summary, null, 2))
}

main().catch((e: unknown) => {
  log(`bcp: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
