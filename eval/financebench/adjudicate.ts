/**
 * Final scoring of a FinanceBench run: a three-judge majority, plus Mafin2.5's own human-review labels for
 * benchmark errors. Writes a shareable report without the dataset's question / answer text (FinanceBench is
 * CC BY-NC 4.0; join on `id` with data/open.jsonl to read them).
 *
 *   npx tsx eval/financebench/adjudicate.ts --run runs/full150.json \
 *     --judges runs/full150.rejudge-opus-mafin.json,runs/full150.rejudge-opus-strict.json \
 *     --review review-<run>.json [--mafin data/mafin-result-gpt4o.json] --out results/full150.json
 *
 * 1. Majority: a question is correct when at least 2 of the 3 judges say so (the run's own judge plus the two
 *    re-judges).
 * 2. Adjudicated: a majority-wrong question still counts as correct when Mafin2.5's reviewers labeled it BE / MVA /
 *    SEDC (the gold answer is wrong or not the only valid one) and the run's review file records that our answer
 *    reaches the same conclusion as Mafin2.5's reviewed answer. Mafin2.5 counts these labels as correct for itself
 *    (98.7% = 148 / 150). A flagged, majority-wrong question without a review entry is an error (review it first),
 *    and so is an entry whose answer_sha1 does not match the run's answer (the review was for another answer).
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const HERE = import.meta.dirname

interface RunRow {
  id: string
  question_type: string
  answer: string | null
  evidence: unknown[]
  correct: boolean | null
  page_hit: boolean
  doc_hit: boolean
  turns: number
  cost_usd: number
}
interface Rejudge { summary: { judge_model: string; prompt: string }; results: { id: string; rejudged: boolean | null }[] }
interface Review { mafin_label: string; agrees_with_mafin: boolean; answer_sha1: string; note: string }

/** First 12 hex digits of the SHA-1 of an answer; ties a review entry to the answer it reviewed. */
export const answerHash = (answer: string | null) => createHash('sha1').update(answer ?? '').digest('hex').slice(0, 12)
const FLAGS = new Set(['BE', 'MVA', 'SEDC'])

const pct = (k: number, n: number) => Math.round((k / n) * 1000) / 10

function main() {
  const { values: v } = parseArgs({
    args: process.argv.slice(2),
    options: {
      run: { type: 'string' },
      judges: { type: 'string' },
      mafin: { type: 'string', default: join(HERE, 'data/mafin-result-gpt4o.json') },
      review: { type: 'string' },
      out: { type: 'string' },
    },
  })
  if (!v.run || !v.judges || !v.review || !v.out) throw new Error('--run, --judges, --review and --out are required')
  const run = JSON.parse(readFileSync(resolve(v.run), 'utf8')) as { model: string; judge_model: string; results: RunRow[] }
  const judges = v.judges.split(',').map((p) => JSON.parse(readFileSync(resolve(p), 'utf8')) as Rejudge)
  if (judges.length !== 2) throw new Error('pass exactly two re-judge reports (three judges in total)')
  const order = readFileSync(join(HERE, 'data/open.jsonl'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { financebench_id: string }).financebench_id)
  // Mafin2.5's results are listed in the dataset's order (checked on the question text when the file was adopted).
  const mafin = JSON.parse(readFileSync(resolve(v.mafin!), 'utf8')) as { label: string }[]
  if (mafin.length !== order.length) throw new Error(`mafin results have ${mafin.length} rows, dataset has ${order.length}`)
  const mafinLabel = new Map(order.map((id, i) => [id, mafin[i]!.label]))
  const review = JSON.parse(readFileSync(resolve(v.review!), 'utf8')) as Record<string, Review | string>

  const judgeNames = [`${run.judge_model}/mafin`, ...judges.map((j) => `${j.summary.judge_model}/${j.summary.prompt}`)]
  const votesOf = new Map<string, (boolean | null)[]>()
  for (const r of run.results) votesOf.set(r.id, [r.correct])
  for (const j of judges) for (const r of j.results) votesOf.get(r.id)?.push(r.rejudged)

  const missing: string[] = []
  const rows = run.results.map((r) => {
    const votes = votesOf.get(r.id)!
    if (votes.length !== 3) throw new Error(`${r.id}: ${votes.length} judge votes, expected 3`)
    const majority = votes.filter((x) => x === true).length >= 2
    const label = mafinLabel.get(r.id) ?? 'AL'
    let final = majority
    let reviewed: Review | undefined
    if (!majority && FLAGS.has(label)) {
      const rv = review[r.id]
      if (!rv || typeof rv === 'string') missing.push(`${r.id} (${label}, answer_sha1 ${answerHash(r.answer)})`)
      else if (rv.answer_sha1 !== answerHash(r.answer)) {
        throw new Error(`${r.id}: the review is for another answer (answer_sha1 ${rv.answer_sha1}, run has ${answerHash(r.answer)})`)
      } else {
        reviewed = rv
        final = rv.agrees_with_mafin
      }
    }
    return {
      id: r.id,
      question_type: r.question_type,
      votes: Object.fromEntries(judgeNames.map((n, i) => [n, votes[i]])),
      majority,
      mafin_label: label,
      ...(reviewed ? { review: reviewed.note } : {}),
      final,
      doc_hit: r.doc_hit,
      page_hit: r.page_hit,
      turns: r.turns,
      cost_usd: Math.round(r.cost_usd * 10_000) / 10_000,
      answer: r.answer,
      evidence: r.evidence,
    }
  })
  if (missing.length) throw new Error(`review these flagged, majority-wrong questions in ${v.review} first: ${missing.join(', ')}`)

  rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  const n = rows.length
  const count = (f: (r: (typeof rows)[number]) => boolean, rs = rows) => rs.filter(f).length
  const byType = Object.fromEntries(
    [...new Set(rows.map((r) => r.question_type))].sort().map((t) => {
      const rs = rows.filter((r) => r.question_type === t)
      return [t, { n: rs.length, majority: pct(count((r) => r.majority, rs), rs.length), adjudicated: pct(count((r) => r.final, rs), rs.length) }]
    }),
  )
  const summary = {
    n,
    agent_model: run.model,
    accuracy_pct: {
      ...Object.fromEntries(judgeNames.map((name, i) => [name, pct(count((r) => Object.values(r.votes)[i] === true), n)])),
      majority: pct(count((r) => r.majority), n),
      adjudicated: pct(count((r) => r.final), n),
    },
    correct: { majority: count((r) => r.majority), adjudicated: count((r) => r.final) },
    recovered_by_review: rows.filter((r) => !r.majority && r.final).map((r) => r.id),
    by_question_type: byType,
    doc_hit_pct: pct(count((r) => r.doc_hit), n),
    page_hit_pct: pct(count((r) => r.page_hit), n),
    mean_turns: Math.round((rows.reduce((s, r) => s + r.turns, 0) / n) * 10) / 10,
    cost_usd_agent_and_first_judge: Math.round(rows.reduce((s, r) => s + r.cost_usd, 0) * 100) / 100,
    wrong: rows.filter((r) => !r.final).map((r) => r.id),
  }
  writeFileSync(resolve(v.out), `${JSON.stringify({ summary, results: rows }, null, 2)}\n`)
  process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`)
}

try {
  main()
} catch (e) {
  process.stderr.write(`adjudicate: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
}
