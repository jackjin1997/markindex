#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Command } from 'commander'
import { createMcpServer, packageVersion } from './adapters/mcp.js'
import { indexLibrary, type IndexReport } from './library/indexer.js'
import { defaultDbFile, openLibrary } from './library.js'
import { estimateSummaryCost } from './llm/summarize.js'
import { ProviderError, resolveSummaryModel } from './llm/provider.js'
import { searchNodes } from './store/search.js'
import { openStore, StoreLockedError } from './store/db.js'
import type { TreeNode } from './types.js'

const out = (s: string) => process.stdout.write(`${s}\n`)
const err = (s: string) => process.stderr.write(`${s}\n`)
const json = (v: unknown) => out(JSON.stringify(v, null, 2))

function printReport(r: IndexReport) {
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
    .command('eval [args...]')
    .description('Evaluate retrieval on a question file (not implemented yet)')
    .allowUnknownOption()
    .action(() => {
      out('eval: not implemented yet')
    })
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
