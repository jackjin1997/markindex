/**
 * Re-judge the answers of a FinanceBench report with another judge model and/or a stricter prompt, to see how much
 * the accuracy depends on the judge. The agent answers are not re-run.
 *
 *   npx tsx eval/financebench/rejudge.ts --in runs/full150.json --judge-model opus [--prompt mafin|strict] \
 *     [--concurrency 6] --out runs/full150.rejudge-opus.json
 *
 * `mafin` is Mafin2.5's lenient check_answer_equivalence prompt (same as run.ts). `strict` only accepts an answer
 * whose final figure / conclusion matches the golden answer (rounding allowed); a "valid alternative
 * interpretation" or a reasonable but different conclusion is wrong.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { JUDGE_PROMPT, parseJudge, runClaude } from './run.js'

const STRICT_PROMPT = (query: string, answer: string, gold: string) => `You are grading an answer to a financial question against the golden answer written by a human expert.

Mark the answer CORRECT only if its final answer matches the golden answer:
- the same final figure(s), allowing only rounding differences (1.23 vs 1.2, 79% vs 0.79 vs "11 of 14"), and
- for yes/no or qualitative questions, the same conclusion.
Extra information is fine as long as it does not contradict the golden answer. A different conclusion, a different
figure, a "valid alternative interpretation" that does not reach the golden answer, or a refusal is INCORRECT.

Query: ${query}
Answer: ${answer}
Golden answer: ${gold}

Reply with ONLY \`True\` (correct) or \`False\` (incorrect).`

interface Row { id: string; question: string; gold_answer: string; answer: string | null; correct: boolean | null }

async function main() {
  const { values: v } = parseArgs({
    args: process.argv.slice(2),
    options: {
      in: { type: 'string' },
      out: { type: 'string' },
      'judge-model': { type: 'string', default: 'opus' },
      prompt: { type: 'string', default: 'mafin' },
      concurrency: { type: 'string', default: '6' },
    },
  })
  if (!v.in || !v.out) throw new Error('--in and --out are required')
  if (v.prompt !== 'mafin' && v.prompt !== 'strict') throw new Error('--prompt must be mafin or strict')
  const report = JSON.parse(readFileSync(resolve(v.in), 'utf8')) as { results: Row[] }
  const rows = report.results
  const prompt = v.prompt === 'strict' ? STRICT_PROMPT : JUDGE_PROMPT
  const work = mkdtempSync(join(tmpdir(), 'markindex-fb-judge-'))
  const out: { id: string; original: boolean | null; rejudged: boolean | null; raw: string }[] = []
  let next = 0
  const worker = async () => {
    while (next < rows.length) {
      const r = rows[next++]!
      if (r.answer === null) {
        out.push({ id: r.id, original: r.correct, rejudged: false, raw: 'no answer' })
        continue
      }
      const j = await runClaude(
        ['-p', prompt(r.question, r.answer, r.gold_answer), '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--output-format', 'json', '--max-turns', '1', '--model', v['judge-model']!],
        work,
        120_000,
      )
      const raw = j.ok ? j.result : j.raw
      out.push({ id: r.id, original: r.correct, rejudged: j.ok ? parseJudge(raw) : null, raw: raw.slice(0, 200) })
      process.stderr.write(`[${out.length}/${rows.length}] ${r.id} ${String(out.at(-1)!.rejudged)}\n`)
    }
  }
  try {
    await Promise.all(Array.from({ length: Number(v.concurrency) }, worker))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  const n = rows.length
  const acc = (k: 'original' | 'rejudged') => out.filter((x) => x[k] === true).length
  const agree = out.filter((x) => x.original === x.rejudged).length
  const summary = {
    n,
    judge_model: v['judge-model'],
    prompt: v.prompt,
    original_correct: acc('original'),
    rejudged_correct: acc('rejudged'),
    rejudged_accuracy: acc('rejudged') / n,
    agreement: agree / n,
    unjudged: out.filter((x) => x.rejudged === null).length,
    flipped_to_wrong: out.filter((x) => x.original === true && x.rejudged !== true).map((x) => x.id),
    flipped_to_correct: out.filter((x) => x.original !== true && x.rejudged === true).map((x) => x.id),
  }
  writeFileSync(resolve(v.out), `${JSON.stringify({ summary, results: out }, null, 2)}\n`)
  process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`)
}

main().catch((e: unknown) => {
  process.stderr.write(`rejudge: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
})
