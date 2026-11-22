/**
 * Offline reranking test on BrowseComp-Plus: no agent, so the result is deterministic and cheap.
 *
 *   npx tsx eval/bcp/rerank_eval.ts --db eval/bcp/runs/lib.db --scorer jev --ids-from eval/bcp/runs/pilot50-haiku-fixed \
 *     --out eval/bcp/runs/rerank-jev-50.json [--pool 50] [--max-chars 8000] [--max-df 0.2] [--cache eval/bcp/runs/jev-cache.jsonl]
 *
 * For every question: MarkIndex's BM25 search with the question as the query returns `pool` section nodes; the
 * scorer reads one passage per node and reorders them. Documents are ranked by their best node. Reported against
 * the benchmark's evidence documents: recall@5/10/20 and nDCG@10 before and after, and recall@pool, which is the
 * ceiling a reranker of this pool can reach.
 *
 * The output holds ids and numbers only; question text never leaves data/queries.jsonl.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { openStore } from '../../src/store/db.js'
import { searchNodes, type SearchHit } from '../../src/store/search.js'
import { segmentQuery } from '../../src/text/segment.js'
import { bestWindow, makeScorer, ndcgAt, orderByScore, queryTerms, recallAt } from './rerank.js'

const HERE = import.meta.dirname
const log = (s: string) => process.stderr.write(`${s}\n`)
const docidOf = (docPath: string) => docPath.split('/').pop()!.replace(/\.md$/, '')
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const uniq = <T>(xs: T[]) => [...new Set(xs)]

interface Query { query_id: string; query: string; evidence_docids: string[] }
interface Metrics { r5: number; r10: number; r20: number; ndcg10: number }
interface Row {
  query_id: string
  query_terms: number
  hits: number
  docs: number
  evidence: number
  unscored: number
  ceiling: number
  before: Metrics
  after: Metrics
  search_ms: number
  rerank_ms: number
}

async function main() {
  const { values: v } = parseArgs({
    args: process.argv.slice(2),
    options: {
      db: { type: 'string' },
      queries: { type: 'string', default: join(HERE, 'data', 'queries.jsonl') },
      all: { type: 'boolean' },
      sample: { type: 'string' },
      ids: { type: 'string' },
      'ids-from': { type: 'string' },
      scorer: { type: 'string', default: 'jev' },
      pool: { type: 'string', default: '50' },
      'max-chars': { type: 'string', default: '8000' },
      'max-df': { type: 'string', default: '0.2' },
      cache: { type: 'string' },
      out: { type: 'string' },
    },
  })
  if (!v.db || !v.out) throw new Error('--db and --out are required')
  const pool = Number(v.pool)
  const maxChars = Number(v['max-chars'])
  const maxDf = Number(v['max-df'])
  const all = readFileSync(resolve(v.queries!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Query)
  let queries = all
  if (v['ids-from']) {
    const want = new Set(readdirSync(resolve(v['ids-from'])).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')))
    queries = all.filter((q) => want.has(q.query_id))
  } else if (v.ids) {
    const want = new Set(v.ids.split(','))
    queries = all.filter((q) => want.has(q.query_id))
  } else if (v.sample) {
    const n = Number(v.sample)
    queries = Array.from({ length: n }, (_, i) => all[Math.floor((i * all.length) / n)]!)
  } else if (!v.all) throw new Error('pass --all, --sample <n>, --ids or --ids-from <run dir>')

  const store = openStore(resolve(v.db), { readonly: true })
  const scorer = makeScorer(v.scorer!, v.cache ? resolve(v.cache) : undefined)
  log(`${queries.length} questions, pool ${pool}, passages of at most ${maxChars} chars, scorer ${scorer.name}`)

  // A whole question as an OR query matches most of the library through its common words and takes tens of
  // seconds to rank. Words that occur in more than `maxDf` of the nodes add almost nothing to a BM25 score, so
  // they are left out of the query (an agent's own queries are a few keywords and never need this).
  store.db.exec("CREATE VIRTUAL TABLE temp.vocab USING fts5vocab('main', 'fts_words', 'row')")
  const nodeCount = (store.db.prepare('SELECT count(*) AS n FROM nodes').get() as { n: number }).n
  const dfStmt = store.db.prepare('SELECT doc FROM temp.vocab WHERE term = ?')
  const selective = (query: string): string => {
    const tokens = [...new Set([...segmentQuery(query).matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replaceAll('""', '"').toLowerCase()))]
    const withDf = tokens.map((t) => ({ t, df: (dfStmt.get(t) as { doc: number } | undefined)?.doc ?? 0 })).filter((x) => x.df > 0)
    const rare = withDf.filter((x) => x.df <= maxDf * nodeCount)
    const kept = rare.length >= 3 ? rare : withDf.sort((a, b) => a.df - b.df).slice(0, 8)
    return kept.map((x) => x.t).join(' ')
  }

  const passageOf = (h: SearchHit, terms: string[]) => {
    const text = store.getLines(h.docPath, h.startLine, h.endLine).join('\n')
    return `${h.titlePath.join(' > ')}\n\n${bestWindow(text, terms, maxChars)}`
  }

  const rows: Row[] = []
  const started = Date.now()
  for (const [i, q] of queries.entries()) {
    const t0 = Date.now()
    const searchQuery = selective(q.query)
    const hits = searchNodes(store, searchQuery, { limit: pool })
    const searchMs = Date.now() - t0
    const terms = queryTerms(q.query)
    const t1 = Date.now()
    const scores = await scorer.score(q.query, hits.map((h) => ({ id: `${h.docPath}#${h.nodeId}`, passage: passageOf(h, terms) })))
    const rerankMs = Date.now() - t1
    const evidence = new Set(q.evidence_docids)
    const before = uniq(hits.map((h) => docidOf(h.docPath)))
    const after = uniq(orderByScore(hits, scores).map((h) => docidOf(h.docPath)))
    const m = (ranked: string[]): Metrics => ({
      r5: recallAt(ranked, evidence, 5),
      r10: recallAt(ranked, evidence, 10),
      r20: recallAt(ranked, evidence, 20),
      ndcg10: ndcgAt(ranked, evidence, 10),
    })
    const row: Row = {
      query_id: q.query_id,
      query_terms: searchQuery.split(' ').length,
      hits: hits.length,
      docs: before.length,
      evidence: evidence.size,
      unscored: scores.filter((s) => s === null).length,
      ceiling: recallAt(before, evidence, before.length),
      before: m(before),
      after: m(after),
      search_ms: searchMs,
      rerank_ms: rerankMs,
    }
    rows.push(row)
    log(`[${i + 1}/${queries.length}] ${q.query_id} docs=${row.docs} ceiling=${(100 * row.ceiling).toFixed(0)}% terms=${row.query_terms} search ${searchMs} ms r@10 ${(100 * row.before.r10).toFixed(0)}% -> ${(100 * row.after.r10).toFixed(0)}% rerank ${rerankMs} ms${row.unscored ? ` unscored=${row.unscored}` : ''}`)
  }
  store.close()

  const keys = ['r5', 'r10', 'r20', 'ndcg10'] as const
  const side = (which: 'before' | 'after') => Object.fromEntries(keys.map((k) => [k, mean(rows.map((r) => r[which][k]))]))
  const summary = {
    benchmark: 'BrowseComp-Plus',
    test: 'offline rerank: BM25 node search with the question as query, then one relevance judgement per node',
    scorer: scorer.name,
    pool,
    max_chars: maxChars,
    max_df: maxDf,
    questions: rows.length,
    ceiling_recall_at_pool: mean(rows.map((r) => r.ceiling)),
    before: side('before'),
    after: side('after'),
    paired: Object.fromEntries(
      keys.map((k) => [k, {
        better: rows.filter((r) => r.after[k] > r.before[k] + 1e-9).length,
        worse: rows.filter((r) => r.after[k] < r.before[k] - 1e-9).length,
        same: rows.filter((r) => Math.abs(r.after[k] - r.before[k]) <= 1e-9).length,
      }]),
    ),
    mean_search_ms: mean(rows.map((r) => r.search_ms)),
    mean_rerank_ms: mean(rows.map((r) => r.rerank_ms)),
    wall_s: (Date.now() - started) / 1000,
    scorer_stats: scorer.stats(),
    results: rows,
  }
  writeFileSync(resolve(v.out), `${JSON.stringify(summary, null, 1)}\n`)
  const { results: _results, ...head } = summary
  log(JSON.stringify(head, null, 1))
}

await main()
