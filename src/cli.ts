#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Command } from 'commander'
import { createMcpServer, packageVersion } from './adapters/mcp.js'
import { parseQuestions, QuestionFileError } from './eval/questions.js'
import { checkGold, runEval, type EvalMode, type EvalReport } from './eval/run.js'
import type { Aggregate, Summary } from './eval/score.js'
import { indexLibrary, type IndexReport } from './library/indexer.js'
import { defaultDbFile, openLibrary } from './library.js'
import { estimateSummaryCost } from './llm/summarize.js'
import { ProviderError, resolveSummaryModel } from './llm/provider.js'
import { RETRIEVE_MAX_INPUT_TOKENS, RETRIEVE_MAX_STEPS } from './retrieve.js'
import { searchNodes } from './store/search.js'
import { openStore, StoreLockedError } from './store/db.js'
import type { TreeNode } from './types.js'

const out = (s: string) => process.stdout.write(`${s}\n`)
const err = (s: string) => process.stderr.write(`${s}\n`)
const json = (v: unknown) => out(JSON.stringify(v, null, 2))

function printReport(r: IndexReport) {
  if (r.rebuilt) out(`full rebuild: ${r.rebuilt.reason}`)
  out(`added ${r.added.length}, updated ${r.updated.length}, removed ${r.removed.length}, unchanged ${r.unchanged.length}, skipped ${r.skipped.length}`)
  for (const s of r.skipped) out(`  skipped ${s.path}: ${s.reason}`)
  for (const s of r.summaryErrors) out(`  summary failed ${s.path}${s.nodeId ? ` [${s.nodeId}]` : ''}: ${s.message}`)
}

async function indexCommand(root: string, o: { db?: string; summaryModel?: string; estimate?: boolean; json?: boolean }) {
  root = resolve(root)
  const model = o.summaryModel && !o.estimate ? await resolveSummaryModel(o.summaryModel) : undefined
  const store = openStore(resolve(o.db ?? defaultDbFile(root)))
  try {
    const report = await indexLibrary({
      root,
      store,
      summary: model ? { model } : undefined,
      onProgress: o.json ? undefined : (e) => err(`[${e.done}/${e.total}] ${e.status} ${e.path}`),
    })
    if (o.estimate) {
      const est = estimateSummaryCost(store)
      if (o.json) json({ report, estimate: est })
      else {
        printReport(report)
        out(`Summary estimate: ${est.nodes} nodes to summarize, ${est.llmCalls} LLM calls, ~${est.inputTokens} input tokens (no LLM calls were made).`)
      }
      return
    }
    if (o.json) json(report)
    else printReport(report)
  } finally {
    store.close()
  }
}

function renderTree(nodes: TreeNode[], depth: number, level = 1, lines: string[] = []): string[] {
  for (const n of nodes) {
    const more = n.children.length > 0 && level >= depth ? ` (+${n.children.length} children)` : ''
    lines.push(`${'  '.repeat(level - 1)}${n.title}  [${n.nodeId}] L${n.startLine}-${n.endLine} ${n.tokens}t${more}`)
    if (level < depth) renderTree(n.children, depth, level + 1, lines)
  }
  return lines
}

function pruneDepth(nodes: TreeNode[], depth: number): TreeNode[] {
  return nodes.map((n) => ({ ...n, children: depth > 1 ? pruneDepth(n.children, depth - 1) : [] }))
}

function treeCommand(root: string, doc: string, o: { db?: string; depth: string; json?: boolean }) {
  const lib = openLibrary({ root, dbFile: o.db })
  try {
    const tree = lib.store.getTree(doc)
    if (!tree) throw new Error(`Document not found in index: ${doc}. Use \`markindex search\` or check the path (library-relative, case-sensitive).`)
    const depth = Math.max(1, Number.parseInt(o.depth, 10) || 1)
    if (o.json) json(pruneDepth(tree, depth))
    else out(renderTree(tree, depth).join('\n'))
  } finally {
    lib.close()
  }
}

function searchCommand(root: string, query: string, o: { db?: string; folder?: string; doc?: string; limit: string; json?: boolean }) {
  const lib = openLibrary({ root, dbFile: o.db })
  try {
    const hits = searchNodes(lib.store, query, { folder: o.folder, docPath: o.doc, limit: Number.parseInt(o.limit, 10) || 10 })
    if (o.json) {
      json(hits)
      return
    }
    if (hits.length === 0) {
      out('No matches.')
      return
    }
    for (const h of hits) {
      out(`${h.docPath} > ${h.titlePath.join(' > ')}  [${h.nodeId}] L${h.startLine}-${h.endLine}`)
      out(`  ${h.snippet.replace(/\s+/g, ' ')}`)
    }
  } finally {
    lib.close()
  }
}

async function mcpCommand(root: string, o: { db?: string; reindexOnStart?: boolean }) {
  root = resolve(root)
  const dbFile = resolve(o.db ?? defaultDbFile(root))
  if (o.reindexOnStart) {
    const store = openStore(dbFile)
    try {
      await indexLibrary({ root, store })
    } finally {
      store.close()
    }
  } else if (!existsSync(dbFile)) {
    throw new Error(`No MarkIndex index at ${dbFile}. Run \`markindex index ${root}\` first (or pass --reindex-on-start).`)
  }
  const lib = openLibrary({ root, dbFile })
  const server = createMcpServer(lib)
  process.on('exit', () => lib.close())
  await server.connect(new StdioServerTransport())
  err(`markindex MCP server ready (stdio), library: ${root}`)
}

const EVAL_MODES: Record<string, EvalMode> = { bm25: 'bm25', agent: 'agent', tools: 'agent', retrieve: 'agent' }

const int = (v: string, name: string, min = 1) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${v}"`)
  return n
}

function printSummary(report: EvalReport) {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const row = (label: string, s: Summary | undefined) =>
    s &&
    out(
      `${label.padEnd(10)}${String(s.questions).padStart(5)}${String(s.hits).padStart(6)}${pct(s.hitRate).padStart(9)}` +
        `${pct(s.hitAt1).padStart(9)}${s.mrr.toFixed(3).padStart(8)}${String(Math.round(s.avgTokens)).padStart(11)}` +
        `${s.avgSteps.toFixed(1).padStart(7)}${String(s.errors).padStart(7)}` +
        `${s.meanEvidenceLines.toFixed(1).padStart(10)}${String(s.medianEvidenceLines).padStart(7)}` +
        `${(s.meanPrecision === null ? '-' : pct(s.meanPrecision)).padStart(8)}`,
    )
  const table = (title: string, a: Aggregate) => {
    out(title)
    out(`${'set'.padEnd(10)}${'n'.padStart(5)}${'hits'.padStart(6)}${'hit'.padStart(9)}${'hit@1'.padStart(9)}${'mrr'.padStart(8)}${'avg tok'.padStart(11)}${'steps'.padStart(7)}${'errors'.padStart(7)}${'ev lines'.padStart(10)}${'med'.padStart(7)}${'prec'.padStart(8)}`)
    row('overall', a.overall)
    for (const lang of ['zh', 'en', 'mixed'] as const) row(lang, a.byLang[lang])
  }
  const maxLines = report.options.maxEvidenceLines ? `, hits need evidence <= ${report.options.maxEvidenceLines} lines` : ''
  table(`mode ${report.mode}${report.model ? ` (${report.model})` : ''}${report.options.topK ? `, top-${report.options.topK}` : ''}${maxLines}`, report.summary)
  if (report.baseline) {
    out('')
    table(`baseline bm25 top-${report.baseline.topK}`, report.baseline.summary)
  }
}

async function evalCommand(
  root: string,
  o: {
    questions: string
    mode: string
    model?: string
    topK: string
    maxSteps: string
    maxInputTokens: string
    concurrency: string
    baseline: boolean
    maxEvidenceLines?: string
    db?: string
    out?: string
    json?: boolean
  },
) {
  const mode = EVAL_MODES[o.mode]
  if (!mode) throw new Error(`--mode must be bm25 or agent (aliases: tools, retrieve), got "${o.mode}"`)
  if (mode === 'agent' && !o.model) throw new Error('agent mode needs --model <provider:model>, e.g. --model anthropic:claude-sonnet-5-5')
  const maxEvidenceLines = o.maxEvidenceLines === undefined ? undefined : int(o.maxEvidenceLines, '--max-evidence-lines')
  const questions = parseQuestions(readFileSync(o.questions, 'utf8'), o.questions)
  const lib = openLibrary({ root, dbFile: o.db })
  try {
    const goldIssues = checkGold(lib, questions)
    if (goldIssues.length > 0) throw new QuestionFileError(goldIssues, o.questions)
    const model =
      mode === 'agent'
        ? await resolveSummaryModel(o.model!).catch((e: unknown) => {
            throw e instanceof ProviderError ? new ProviderError(e.message.replace('--summary-model', '--model')) : e
          })
        : undefined
    const report = await runEval(lib, questions, {
      mode,
      topK: int(o.topK, '--top-k'),
      maxSteps: int(o.maxSteps, '--max-steps'),
      maxInputTokens: int(o.maxInputTokens, '--max-input-tokens'),
      concurrency: int(o.concurrency, '--concurrency'),
      baseline: o.baseline,
      ...(maxEvidenceLines !== undefined ? { maxEvidenceLines } : {}),
      ...(model ? { model, modelId: o.model } : {}),
      onProgress: o.json
        ? undefined
        : (done, total, r) => err(`[${done}/${total}] ${r.id} ${r.hit ? 'HIT' : 'miss'}${r.error ? ` (error: ${r.error})` : ''}`),
    })
    if (o.out) writeFileSync(o.out, `${JSON.stringify(report, null, 2)}\n`)
    if (o.json) json(report)
    else {
      printSummary(report)
      if (o.out) out(`\nFull report: ${resolve(o.out)}`)
    }
  } finally {
    lib.close()
  }
}

export function buildProgram(): Command {
  const program = new Command('markindex').description('Section-tree index of Markdown libraries for agent retrieval').version(packageVersion())
  program
    .command('index <root>')
    .description('Build or update the index of a Markdown folder')
    .option('--db <file>', 'index database file (default <root>/.markindex/index.db)')
    .option('--summary-model <provider:model>', 'summarize with an LLM, e.g. anthropic:claude-sonnet-5-5 (needs @ai-sdk/<provider> installed)')
    .option('--estimate', 'index, then print the summarization cost estimate and exit without LLM calls')
    .option('--json', 'machine-readable output')
    .action(indexCommand)
  program
    .command('tree <root> <doc>')
    .description('Print the section tree of one document (library-relative path)')
    .option('--db <file>', 'index database file')
    .option('--depth <n>', 'outline levels to show', '3')
    .option('--json', 'machine-readable output')
    .action(treeCommand)
  program
    .command('search <root> <query>')
    .description('Keyword search over the index')
    .option('--db <file>', 'index database file')
    .option('--folder <folder>', 'restrict to a library-relative folder')
    .option('--doc <path>', 'restrict to one document')
    .option('--limit <n>', 'maximum hits', '10')
    .option('--json', 'machine-readable output')
    .action(searchCommand)
  program
    .command('mcp <root>')
    .description('Serve the library to agents as an MCP server over stdio (read-only)')
    .option('--db <file>', 'index database file')
    .option('--reindex-on-start', 'update the index before serving')
    .action(mcpCommand)
  program
    .command('eval <root>')
    .description('Measure retrieval quality on a JSONL question file (see eval/README.md for the format)')
    .requiredOption('--questions <file>', 'JSONL question file: {"id","question","lang":"zh|en|mixed","gold":[{"doc_path","start_line"?,"end_line"?,"title_path"?}]}')
    .option('--mode <mode>', 'bm25 (keyword baseline, no LLM) or agent (built-in retrieve() loop over the agent tools; "tools" and "retrieve" are aliases)', 'bm25')
    .option('--model <provider:model>', 'agent mode: model, e.g. anthropic:claude-sonnet-5-5 (needs @ai-sdk/<provider> installed)')
    .option('--top-k <n>', 'bm25: hits per question', '5')
    .option('--max-steps <n>', 'agent: model steps per question', String(RETRIEVE_MAX_STEPS))
    .option('--max-input-tokens <n>', 'agent: input-token budget per question', String(RETRIEVE_MAX_INPUT_TOKENS))
    .option('--concurrency <n>', 'agent: questions run in parallel', '1')
    .option('--no-baseline', 'agent: skip the bm25 baseline')
    .option('--max-evidence-lines <n>', 'count a hit only if the matching evidence item spans at most n lines')
    .option('--db <file>', 'index database file')
    .option('--out <file>', 'write the full JSON report (per-question results) to this file')
    .option('--json', 'print the full JSON report instead of the summary table')
    .action(evalCommand)
  return program
}

try {
  await buildProgram().parseAsync(process.argv)
} catch (e) {
  err(
    e instanceof StoreLockedError || e instanceof ProviderError || e instanceof Error
      ? `markindex: ${e.message}`
      : `markindex: ${String(e)}`,
  )
  process.exitCode = 1
}
