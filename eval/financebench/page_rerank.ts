/**
 * Control for toc_eval.ts: the same decision model as a plain reranker of retrieved pages, with no section tree.
 *
 *   npx tsx eval/financebench/page_rerank.ts --db eval/financebench/runs/lib368.db \
 *     --pool eval/financebench/runs/baseline/retrieval-dense-top100.json --out eval/financebench/runs/rerank-dense.json \
 *     [--depth 100] [--limit 10 | --ids id1,id2] [--cache <answers.jsonl>] [--retrieval-out <pages.json>]
 *
 * toc_eval.ts finds evidence pages from section titles alone. To tell what the tree adds from what the model adds,
 * this script gives the model (TypeSafe Jev, ../lib/jev.ts) the pages a retriever returned (baseline_retrieve.py
 * search --top-k 100) and asks one yes/no question per page, about the page's full text, then sorts the pages by
 * the probability of yes. A question counts at k when one of its evidence pages is among the first k pages, as in
 * baseline_retrieve.py. The reranked order cannot find a page that is not in the pool (`pool_ceiling`).
 *
 * The output holds ids and numbers only; question and answer text stay in data/open.jsonl.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { openStore } from '../../src/store/db.js'
import { orderByScore } from '../bcp/rerank.js'
import { jevClient } from '../lib/jev.js'
import { loadDocs } from './toc_route.js'

const HERE = import.meta.dirname
const log = (s: string) => process.stderr.write(`${s}\n`)
const KS = [1, 3, 5, 10, 20] as const
const INSTRUCTIONS = 'Does `page`, a page of `filing`, contain the information needed to answer `question`?'

interface Question { financebench_id: string; question: string; evidence: { doc_name: string; evidence_page_num: number }[] }
interface Page { doc_path: string; page: number; start_line: number; end_line: number }
interface Row { id: string; pool: number; pool_hit: boolean; before: Record<string, boolean>; after: Record<string, boolean>; gold_rank_before: number; gold_rank_after: number; ms: number; calls: number; failed: number }

async function main() {
  const { values: v } = parseArgs({
    args: process.argv.slice(2),
    options: {
      db: { type: 'string' },
      pool: { type: 'string' },
      questions: { type: 'string', default: join(HERE, 'data', 'open.jsonl') },
      depth: { type: 'string', default: '100' },
      ids: { type: 'string' },
      limit: { type: 'string' },
      cache: { type: 'string' },
      'retrieval-out': { type: 'string' },
      out: { type: 'string' },
    },
  })
  if (!v.db || !v.pool || !v.out) throw new Error('--db, --pool and --out are required')
  const depth = Number(v.depth)
  let questions = readFileSync(resolve(v.questions!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Question)
  if (v.ids) {
    const want = new Set(v.ids.split(','))
    questions = questions.filter((q) => want.has(q.financebench_id))
  } else if (v.limit) {
    const n = Number(v.limit)
    questions = Array.from({ length: Math.min(n, questions.length) }, (_, i) => questions[Math.floor((i * questions.length) / n)]!)
  }
  const pool = JSON.parse(readFileSync(resolve(v.pool), 'utf8')) as { summary: { method: string; model: string | null }; results: Record<string, Page[]> }

  const store = openStore(resolve(v.db), { readonly: true })
  const jev = jevClient({ cacheFile: v.cache ? resolve(v.cache) : undefined })
  const { docs } = loadDocs(store)
  const labelOf = new Map(docs.map((d) => [d.path, d.label]))
  const pathOf = new Map(docs.map((d) => [d.path.split('/').pop()!.replace(/\.md$/, ''), d.path]))
  log(`${questions.length} questions, pool ${pool.summary.method} depth ${depth}, model ${jev.model}`)

  const rows: Row[] = []
  const reranked: Record<string, Page[]> = {}
  for (const [i, q] of questions.entries()) {
    const gold = new Set(q.evidence.map((e) => `${pathOf.get(e.doc_name)}#${Number(e.evidence_page_num)}`))
    const pages = (pool.results[q.financebench_id] ?? []).slice(0, depth)
    const before = jev.stats()
    const t0 = Date.now()
    const answers = await Promise.all(
      pages.map((p) =>
        jev.ask(
          { question: q.question, filing: labelOf.get(p.doc_path) ?? p.doc_path, page: store.getLines(p.doc_path, p.start_line, p.end_line).join('\n') },
          { type: 'noul', instructions: INSTRUCTIONS },
        ),
      ),
    )
    const ordered = orderByScore(pages, answers.map((a) => a?.noul ?? null))
    const after = jev.stats()
    const isGold = (p: Page) => gold.has(`${p.doc_path}#${p.page}`)
    const hits = (list: Page[]) => Object.fromEntries(KS.map((k) => [k, list.slice(0, k).some(isGold)]))
    const row: Row = {
      id: q.financebench_id,
      pool: pages.length,
      pool_hit: pages.some(isGold),
      before: hits(pages),
      after: hits(ordered),
      gold_rank_before: pages.findIndex(isGold) + 1, // 0 = not in the pool
      gold_rank_after: ordered.findIndex(isGold) + 1,
      ms: Date.now() - t0,
      calls: after.calls - before.calls,
      failed: after.failed - before.failed,
    }
    rows.push(row)
    reranked[q.financebench_id] = ordered.slice(0, 20)
    log(`[${i + 1}/${questions.length}] ${row.id} gold rank ${row.gold_rank_before || 'none'} -> ${row.gold_rank_after || 'none'} (${row.ms} ms, calls ${row.calls}${row.failed ? `, failed ${row.failed}` : ''})`)
  }
  store.close()

  const n = rows.length
  const rate = (f: (r: Row) => boolean | undefined) => Math.round((10000 * rows.filter((r) => f(r) === true).length) / n) / 100
  const recall = (get: (r: Row) => Record<string, boolean>) => Object.fromEntries(KS.map((k) => [`@${k}`, rate((r) => get(r)[k])]))
  const summary = {
    benchmark: 'FinanceBench open-source (150)',
    test: 'decision model as a reranker of retrieved pages (full page text, one yes/no question per page)',
    model: jev.stats().model ?? jev.model,
    pool: { method: pool.summary.method, model: pool.summary.model, depth },
    questions: n,
    evidence_page_recall_before: recall((r) => r.before),
    evidence_page_recall_after: recall((r) => r.after),
    pool_ceiling: rate((r) => r.pool_hit),
    mean_ms: Math.round(rows.reduce((s, r) => s + r.ms, 0) / n),
    jev: jev.stats(),
    results: rows,
  }
  writeFileSync(resolve(v.out), `${JSON.stringify(summary, null, 1)}\n`)
  if (v['retrieval-out']) {
    const frac = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([k, x]) => [k, Math.round(x * 100) / 10000]))
    const out = { summary: { method: `${pool.summary.method}-top${depth}-jev`, model: summary.model, subset: 'all', questions: n, evidence_page_recall: frac(summary.evidence_page_recall_after) }, results: reranked }
    writeFileSync(resolve(v['retrieval-out']), `${JSON.stringify(out, null, 1)}\n`)
  }
  const { results: _results, ...head } = summary
  log(JSON.stringify(head, null, 1))
}

await main()
