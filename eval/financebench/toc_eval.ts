/**
 * Offline test of table-of-contents navigation by a decision model on FinanceBench: no agent, no text search.
 *
 *   npx tsx eval/financebench/toc_eval.ts --db eval/financebench/runs/lib368.db --out eval/financebench/runs/toc-jev.json \
 *     [--limit 10 | --ids id1,id2] [--mode both|flat|beam] [--beam 3] [--preview 0] [--cache <answers.jsonl>] \\
 *     [--retrieval-out <pages.json>]
 *
 * The model (TypeSafe Jev, see ../lib/jev.ts) only ever sees the question and names: folder names, filing titles
 * and section titles from MarkIndex's tree. Three steps:
 *   1. filing: one choice among the company folders, then one among that folder's filings (repeated without the
 *      winner to get a ranking);
 *   2. sections, `beam`: at each level of the filing's tree a choice among the children, keeping `--beam` of them,
 *      down to the leaves (tens of calls);
 *   3. sections, `flat`: one yes/no question per section of the filing, ranked by the probability of yes
 *      (hundreds of calls).
 * Sections are scored twice: in the filing the model picked (end to end) and in the right filing (oracle), which
 * separates the two steps.
 *
 * Metrics follow eval/financebench/baseline_retrieve.py so they compare with results/retrieval-recall.json:
 * a question counts at k when one of its evidence pages is among the first k pages, where pages are taken in the
 * order of the ranked sections (a section's own lines, without its subsections). `node@k` counts the question
 * when an evidence page lies in one of the first k sections.
 *
 * `--retrieval-out` writes the end-to-end `flat` ranking as pages (20 per question) in the format of
 * runs/baseline/retrieval-*.json, so baseline.ts can answer from them in one prompt.
 *
 * The output holds ids and numbers only; question and answer text stay in data/open.jsonl.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { openStore } from '../../src/store/db.js'
import { jevClient } from '../lib/jev.js'
import { describeSection, loadDocs, loadTree, rankByChoice, routeFilings, scoreSections, type Doc, type Sec } from './toc_route.js'

const HERE = import.meta.dirname
const log = (s: string) => process.stderr.write(`${s}\n`)
const KS = [1, 3, 5, 10, 20] as const
const NODE_KS = [1, 3, 5, 10] as const
interface Question { financebench_id: string; question: string; doc_name: string; evidence: { doc_name: string; evidence_page_num: number }[] }
/** A ranked piece of a filing: a section's own lines. */
interface Pick { start: number; end: number }
interface Scored { page: Record<string, boolean>; node: Record<string, boolean>; ranked: number }
interface Ranked { oracle: Scored; e2e: Scored; ms: number }
interface Page { doc_path: string; page: number; start_line: number; end_line: number }
interface Row { id: string; filing_rank: number; route_ms: number; sections: number; beam?: Ranked; flat?: Ranked; calls: number; failed: number }

async function main() {
  const { values: v } = parseArgs({
    args: process.argv.slice(2),
    options: {
      db: { type: 'string' },
      questions: { type: 'string', default: join(HERE, 'data', 'open.jsonl') },
      pages: { type: 'string', default: join(HERE, 'md-pages') },
      ids: { type: 'string' },
      limit: { type: 'string' },
      mode: { type: 'string', default: 'both' },
      beam: { type: 'string', default: '3' },
      preview: { type: 'string', default: '0' },
      cache: { type: 'string' },
      'retrieval-out': { type: 'string' },
      out: { type: 'string' },
    },
  })
  if (!v.db || !v.out) throw new Error('--db and --out are required')
  const beam = Number(v.beam)
  const previewChars = Number(v.preview)
  const doFlat = v.mode !== 'beam'
  const doBeam = v.mode !== 'flat'
  let questions = readFileSync(resolve(v.questions!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Question)
  if (v.ids) {
    const want = new Set(v.ids.split(','))
    questions = questions.filter((q) => want.has(q.financebench_id))
  } else if (v.limit) {
    const n = Number(v.limit)
    questions = Array.from({ length: Math.min(n, questions.length) }, (_, i) => questions[Math.floor((i * questions.length) / n)]!)
  }

  const store = openStore(resolve(v.db), { readonly: true })
  const jev = jevClient({ cacheFile: v.cache ? resolve(v.cache) : undefined })
  const { docs, folders } = loadDocs(store)
  const pathOf = new Map(docs.map((d) => [d.path.split('/').pop()!.replace(/\.md$/, ''), d.path]))
  log(`${questions.length} questions, ${docs.length} filings in ${folders.length} folders, model ${jev.model}, mode ${v.mode}, beam ${beam}, preview ${previewChars}`)

  const trees = new Map<string, ReturnType<typeof loadTree>>()
  const treeOf = (docPath: string) => {
    let t = trees.get(docPath)
    if (!t) trees.set(docPath, (t = loadTree(store, docPath)))
    return t
  }
  const pageCache = new Map<string, [number, number, number][]>()
  const pagesOf = (docPath: string) => {
    let p = pageCache.get(docPath)
    if (!p) {
      const name = docPath.split('/').pop()!.replace(/\.md$/, '')
      const raw = JSON.parse(readFileSync(join(resolve(v.pages!), `${name}.json`), 'utf8')) as Record<string, [number, number]>
      p = Object.entries(raw).map(([n, r]): [number, number, number] => [Number(n), r[0], r[1]]).sort((a, b) => a[0] - b[0])
      pageCache.set(docPath, p)
    }
    return p
  }
  const pagesIn = (docPath: string, pick: Pick) => pagesOf(docPath).filter(([, s, e]) => s <= pick.end && e >= pick.start).map(([n]) => n)
  const describe = (docPath: string, s: Sec) => describeSection(store, docPath, s, previewChars)

  const flatRank = async (q: Question, doc: Doc): Promise<Pick[]> =>
    (await scoreSections(jev, store, q.question, doc, treeOf(doc.path).all, previewChars)).map((x) => ({ start: x.sec.start, end: x.sec.ownEnd }))

  const beamRank = async (q: Question, doc: Doc): Promise<Pick[]> => {
    const { roots } = treeOf(doc.path)
    const instructions = `Which section of the filing "${doc.label}" contains the information needed to answer \`question\`?`
    const out: Pick[] = []
    const visit = async (level: Sec[]) => {
      const picked = await rankByChoice(jev, { question: q.question }, instructions, level, (s) => describe(doc.path, s), beam)
      for (const s of picked) {
        if (s.children.length === 0) {
          out.push({ start: s.start, end: s.ownEnd })
          continue
        }
        // A section with subsections may also hold text of its own before the first of them.
        const own: Sec = { ...s, children: [], title: `${s.title} (opening text)`, path: [...s.path, '(opening text of this section)'] }
        await visit(s.ownTokens > 20 ? [own, ...s.children] : s.children)
      }
    }
    await visit(roots)
    return out
  }

  const rows: Row[] = []
  const retrieved: Record<string, Page[]> = {}
  for (const [i, q] of questions.entries()) {
    const goldPath = pathOf.get(q.doc_name)
    const gold = new Set(q.evidence.filter((e) => pathOf.get(e.doc_name) === goldPath).map((e) => Number(e.evidence_page_num)))
    if (!goldPath) throw new Error(`no filing for ${q.doc_name}`)
    const before = jev.stats()
    const t0 = Date.now()

    const rankedDocs = await routeFilings(jev, q.question, docs, folders)
    const filingRank = rankedDocs.findIndex((d) => d.path === goldPath) + 1 // 0 = not ranked
    const routeMs = Date.now() - t0
    const goldDoc = docs.find((d) => d.path === goldPath)!
    const picked = rankedDocs[0]

    const score = (docPath: string, picks: Pick[]): Scored => {
      const pages: number[] = []
      for (const p of picks) for (const n of pagesIn(docPath, p)) if (!pages.includes(n)) pages.push(n)
      const hitAt = (k: number) => docPath === goldPath && pages.slice(0, k).some((n) => gold.has(n))
      const nodeAt = (k: number) => docPath === goldPath && picks.slice(0, k).some((p) => pagesIn(docPath, p).some((n) => gold.has(n)))
      return { page: Object.fromEntries(KS.map((k) => [k, hitAt(k)])), node: Object.fromEntries(NODE_KS.map((k) => [k, nodeAt(k)])), ranked: picks.length }
    }
    const run = async (rank: (q: Question, d: Doc) => Promise<Pick[]>): Promise<Ranked & { e2ePicks: Pick[] }> => {
      const t = Date.now()
      const oracle = score(goldDoc.path, await rank(q, goldDoc))
      const oracleMs = Date.now() - t
      const goldPicks = await rank(q, goldDoc)
      const e2ePicks = picked ? (picked.path === goldDoc.path ? goldPicks : await rank(q, picked)) : []
      const e2e = picked ? (picked.path === goldDoc.path ? oracle : score(picked.path, e2ePicks)) : score(goldDoc.path, [])
      return { oracle, e2e, ms: oracleMs, e2ePicks }
    }
    const strip = (r: (Ranked & { e2ePicks: Pick[] }) | undefined): Ranked | undefined => (r ? { oracle: r.oracle, e2e: r.e2e, ms: r.ms } : undefined)
    const beamFull = doBeam ? await run(beamRank) : undefined
    const flatFull = doFlat ? await run(flatRank) : undefined
    const beamRes = strip(beamFull)
    const flatRes = strip(flatFull)
    if (flatFull && picked) {
      const pages: Page[] = []
      for (const pick of flatFull.e2ePicks) {
        for (const [n, start, end] of pagesOf(picked.path)) {
          if (start <= pick.end && end >= pick.start && !pages.some((x) => x.page === n)) pages.push({ doc_path: picked.path, page: n, start_line: start, end_line: end })
        }
        if (pages.length >= 20) break
      }
      retrieved[q.financebench_id] = pages.slice(0, 20)
    } else retrieved[q.financebench_id] = []
    const after = jev.stats()
    const row: Row = { id: q.financebench_id, filing_rank: filingRank, route_ms: routeMs, sections: treeOf(goldDoc.path).all.length, beam: beamRes, flat: flatRes, calls: after.calls - before.calls, failed: after.failed - before.failed }
    rows.push(row)
    const show = (r?: Ranked) => (r ? `page@5 ${r.oracle.page[5] ? 'hit' : 'miss'} node@3 ${r.oracle.node[3] ? 'hit' : 'miss'}` : '-')
    log(`[${i + 1}/${questions.length}] ${row.id} filing rank ${filingRank || 'none'} | beam ${show(beamRes)} (${beamRes?.ms ?? 0} ms) | flat ${show(flatRes)} (${flatRes?.ms ?? 0} ms) | calls ${row.calls}${row.failed ? ` failed ${row.failed}` : ''}`)
  }
  store.close()

  const n = rows.length
  const rate = (f: (r: Row) => boolean | undefined) => Math.round((10000 * rows.filter((r) => f(r) === true).length) / n) / 100
  const block = (get: (r: Row) => Scored | undefined) => ({
    evidence_page_recall: Object.fromEntries(KS.map((k) => [`@${k}`, rate((r) => get(r)?.page[k])])),
    evidence_in_top_sections: Object.fromEntries(NODE_KS.map((k) => [`@${k}`, rate((r) => get(r)?.node[k])])),
  })
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0)
  const summary = {
    benchmark: 'FinanceBench open-source (150)',
    test: 'table-of-contents navigation by a decision model: folder -> filing -> sections, titles only',
    model: jev.stats().model ?? jev.model,
    questions: n,
    beam,
    preview_chars: previewChars,
    right_filing: { '@1': rate((r) => r.filing_rank === 1), '@3': rate((r) => r.filing_rank >= 1 && r.filing_rank <= 3), ranked: rate((r) => r.filing_rank >= 1) },
    mean_route_ms: mean(rows.map((r) => r.route_ms)),
    ...(doBeam ? { beam_oracle_filing: block((r) => r.beam?.oracle), beam_end_to_end: block((r) => r.beam?.e2e), beam_mean_ms: mean(rows.map((r) => r.beam?.ms ?? 0)) } : {}),
    ...(doFlat ? { flat_oracle_filing: block((r) => r.flat?.oracle), flat_end_to_end: block((r) => r.flat?.e2e), flat_mean_ms: mean(rows.map((r) => r.flat?.ms ?? 0)) } : {}),
    mean_sections_per_filing: mean(rows.map((r) => r.sections)),
    jev: jev.stats(),
    results: rows,
  }
  writeFileSync(resolve(v.out), `${JSON.stringify(summary, null, 1)}\n`)
  if (v['retrieval-out'] && doFlat) {
    const recall = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([k, x]) => [k, Math.round(x * 100) / 10000]))
    const out = {
      summary: {
        method: 'toc-jev',
        model: summary.model,
        subset: 'all',
        questions: n,
        evidence_page_recall: recall(block((r) => r.flat?.e2e).evidence_page_recall),
        right_filing_recall: { '@1': summary.right_filing['@1'] / 100 },
      },
      results: retrieved,
    }
    writeFileSync(resolve(v['retrieval-out']), `${JSON.stringify(out, null, 1)}\n`)
  }
  const { results: _results, ...head } = summary
  log(JSON.stringify(head, null, 1))
}

await main()
