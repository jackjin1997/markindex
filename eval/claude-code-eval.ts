/**
 * Agent-mode evaluation through Claude Code (headless `claude -p`) and the MarkIndex MCP server. Uses your Claude
 * Code login (subscription or whatever `claude` is configured with); no API key or AI SDK provider is needed.
 *
 *   npm run build
 *   npx tsx eval/claude-code-eval.ts --root eval/corpus --questions eval/questions.jsonl \
 *     (--per-lang 10 | --all) [--model sonnet] [--concurrency 3] [--max-turns 20] [--timeout-sec 420] \
 *     [--bm25 eval/results/bm25-top5.json] [--db <index.db>] [--cli dist/cli.js] [--dry-run] --out report.json
 *
 * Every question runs in a fresh `claude -p` session whose only tools are the markindex MCP tools (`--tools ""`
 * removes the built-in tools, `--strict-mcp-config` other MCP servers, `--setting-sources ""` user / project
 * settings; `--allowedTools mcp__markindex__*` pre-approves the rest), from an empty temporary working directory.
 * Golds must have line ranges or be document-level (title_path-only golds are rejected). The model must answer with a JSON
 * evidence object; it is scored with the same hit rule, evidence size and precision as `markindex eval`.
 * The report is rewritten after every question, so an interrupted run keeps what it has.
 *
 * This spends Claude usage: about $0.15 per question with sonnet on the development corpus. `--dry-run` checks
 * the questions against the index and prints the sample and command line without calling `claude`.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseQuestions, QuestionFileError, type EvalQuestion } from '../src/eval/questions.js'
import { checkGold } from '../src/eval/run.js'
import type { Aggregate, QuestionResult } from '../src/eval/score.js'
import { openLibrary } from '../src/library.js'
import { approxTokens } from '../src/text/tokens.js'
import {
  buildClaudeArgs,
  buildReport,
  mcpConfigFor,
  parseClaudeOutput,
  parseEvidenceAnswer,
  parseRunnerArgs,
  sampleQuestions,
  scoreAnswer,
  unsupportedGold,
  type ClaudeCodeReport,
  type ClaudeCodeResult,
  type ClaudeOutput,
  type SessionSummary,
} from './lib/claude-code.js'

/** After the per-question timeout, SIGTERM, then SIGKILL if the process is still alive after this grace period. */
const KILL_GRACE_MS = 10_000

const log = (s: string) => process.stderr.write(`${s}\n`)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`

function printTable(label: string, a: Aggregate, session?: ClaudeCodeReport['claudeCode']) {
  log(`\n${label}`)
  const sets: [string, Aggregate['overall'] | undefined, SessionSummary | undefined][] = [
    ['overall', a.overall, session?.overall],
    ...(['zh', 'en', 'mixed'] as const).map((l) => [l, a.byLang[l], session?.byLang[l]] as [string, Aggregate['overall'] | undefined, SessionSummary | undefined]),
  ]
  for (const [set, s, cc] of sets) {
    if (!s) continue
    const prec = s.meanPrecision === null ? '-' : pct(s.meanPrecision)
    const extra = cc ? ` turns=${cc.meanTurns.toFixed(1)} cost=$${cc.totalCostUsd.toFixed(2)} unparsed=${cc.parseFailures}` : ''
    log(`  ${set.padEnd(8)} n=${s.questions} hit=${pct(s.hitRate)} lines mean=${s.meanEvidenceLines.toFixed(1)} med=${s.medianEvidenceLines} prec=${prec}${extra}`)
  }
}

async function main() {
  const args = parseRunnerArgs(process.argv.slice(2))
  const cli = args.cli ?? join(import.meta.dirname, '..', 'dist', 'cli.js')
  if (!existsSync(cli)) throw new Error(`${cli} not found: run \`npm run build\` first (or pass --cli)`)

  const questions = sampleQuestions(parseQuestions(readFileSync(args.questions, 'utf8'), args.questions), args.sample)
  const lib = openLibrary({ root: args.root, dbFile: args.db })
  const work = mkdtempSync(join(tmpdir(), 'markindex-cc-eval-'))
  try {
    const goldIssues = [...unsupportedGold(questions), ...checkGold(lib, questions)]
    if (goldIssues.length > 0) throw new QuestionFileError(goldIssues, args.questions)
    const bm25 = args.bm25 ? (JSON.parse(readFileSync(args.bm25, 'utf8')) as { options?: { topK?: number }; results: QuestionResult[] }) : undefined
    const mcpConfig = join(work, 'mcp.json')
    writeFileSync(mcpConfig, JSON.stringify(mcpConfigFor(cli, lib.root, args.db)))
    const claudeArgs = (q: EvalQuestion) => buildClaudeArgs({ question: q.question, mcpConfig, model: args.model, maxTurns: args.maxTurns })

    if (args.dryRun) {
      log(`${questions.length} question(s): ${questions.map((q) => q.id).join(' ')}`)
      log(`mcp config: ${JSON.stringify(mcpConfigFor(cli, lib.root, args.db))}`)
      log(`command (first question): claude ${claudeArgs(questions[0]!).map((a) => JSON.stringify(a)).join(' ')}`)
      return
    }

    const ask = (q: EvalQuestion) =>
      new Promise<ClaudeOutput>((done) => {
        const p = spawn('claude', claudeArgs(q), { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let errOut = ''
        p.stdout.on('data', (d: Buffer) => (out += d))
        p.stderr.on('data', (d: Buffer) => (errOut += d))
        let killer: NodeJS.Timeout | undefined
        const timer = setTimeout(() => {
          p.kill('SIGTERM')
          killer = setTimeout(() => p.kill('SIGKILL'), KILL_GRACE_MS) // claude ignored SIGTERM
        }, args.timeoutMs)
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
          done(parsed.ok ? parsed : { ok: false, raw: `${parsed.raw}${errOut ? ` | stderr: ${errOut.slice(0, 300)}` : ''}` })
        })
      })
    const readTokens = (r: { docPath: string; startLine: number; endLine: number }) =>
      approxTokens(lib.store.getLines(r.docPath, r.startLine, r.endLine).join('\n'))

    const options = {
      ...(args.sample === 'all' ? { all: true } : { perLang: args.sample.perLang }),
      maxTurns: args.maxTurns,
      concurrency: args.concurrency,
    }
    const createdAt = new Date().toISOString()
    const order = new Map(questions.map((q, i) => [q.id, i]))
    const results: ClaudeCodeResult[] = []
    const report = () => {
      const sorted = [...results].sort((a, b) => order.get(a.id)! - order.get(b.id)!)
      return buildReport({ model: args.model, options, results: sorted, bm25, createdAt })
    }
    const save = () => writeFileSync(args.out, `${JSON.stringify(report(), null, 2)}\n`)

    let next = 0
    const worker = async () => {
      while (next < questions.length) {
        const q = questions[next++]!
        const output = await ask(q)
        const r = scoreAnswer(q, output, output.ok ? parseEvidenceAnswer(output.result) : null, readTokens)
        results.push(r)
        log(`[${results.length}/${questions.length}] ${r.id} ${r.hit ? 'HIT' : 'miss'} turns=${r.turns} lines=${r.evidenceLines} $${r.costUsd.toFixed(3)}${r.error ? ` (${r.error})` : ''}`)
        save()
      }
    }
    await Promise.all(Array.from({ length: Math.min(args.concurrency, questions.length) }, worker))
    const final = report()
    save()
    printTable(`claude-code ${args.model}`, final.summary, final.claudeCode)
    if (final.baseline) printTable(`bm25 top-${final.baseline.topK ?? '?'} on the same ids (missing: ${final.baseline.missingIds.length})`, final.baseline.summary)
    log(`\nreport: ${args.out}`)
  } finally {
    lib.close()
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch((e: unknown) => {
  log(`claude-code-eval: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
