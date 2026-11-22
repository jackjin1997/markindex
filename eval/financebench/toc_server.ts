/**
 * MarkIndex's MCP server plus one tool, `locate_sections`, for evaluation only.
 *
 *   node --import <tsx loader> eval/financebench/toc_server.ts <root> --db <index.db> \
 *     [--cache <answers.jsonl>] [--log <calls.jsonl>]
 *
 * `locate_sections(question)` runs the steps of toc_route.ts: a decision model (TypeSafe Jev) picks the filing
 * from folder and filing names, then judges every section title of it, and the tool returns the sections most
 * likely to hold the answer in the shape of search_documents() hits. The agent supplies the question itself; the
 * server is not told what is being asked. The five MarkIndex tools are served unchanged. run.ts starts this
 * server with `--toc`.
 */
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { openLibrary } from '../../src/library.js'
import { AGENT_INSTRUCTIONS, TOOL_CONTRACT, type ToolName } from '../../src/tools/contract.js'
import { jevClient } from '../lib/jev.js'
import { loadDocs, loadTree, routeFilings, scoreSections, type Doc } from './toc_route.js'

export const TOC_TOOL = 'locate_sections'

const LOCATOR = `\
SECTION LOCATOR (fastest path, try it first):
- locate_sections() — give it the full question. It picks the document from folder and document names and returns the sections whose titles best match what the question needs, most likely first. Read them with get_node_content().
- It judges titles only, so check what you read: if the returned sections do not hold the answer, or the document is the wrong one, continue with the discovery steps below (browse_documents(), get_document_structure(), search_documents()).`

function main() {
  const { values: v, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { db: { type: 'string' }, cache: { type: 'string' }, log: { type: 'string' } },
  })
  if (!positionals[0]) throw new Error('usage: toc_server.ts <root> [--db <index.db>] [--cache <answers.jsonl>] [--log <calls.jsonl>]')
  const lib = openLibrary({ root: positionals[0], dbFile: v.db ? resolve(v.db) : undefined })
  const jev = jevClient({ cacheFile: v.cache ? resolve(v.cache) : undefined })
  const { docs, folders } = loadDocs(lib.store)
  const logFile = v.log ? resolve(v.log) : undefined
  const note = (o: object) => {
    if (logFile) appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...o })}\n`)
  }
  note({ event: 'start', model: jev.model, docs: docs.length, folders: folders.length })

  const envelope = (body: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: (body as { success?: boolean }).success !== true })
  const fallback = [
    'Find the document with browse_documents() and read its outline with get_document_structure()',
    'Search for the key terms with search_documents()',
  ]

  const locate = async (args: { question: string; doc_path?: string; limit: number }) => {
    const t0 = Date.now()
    const before = jev.stats()
    let chosen: Doc[]
    if (args.doc_path !== undefined) {
      const d = docs.find((x) => x.path === args.doc_path)
      if (!d) {
        return envelope({ success: false, code: 'NOT_FOUND', error: `Unknown doc_path "${args.doc_path}".`, next_steps: { summary: 'Copy doc_path verbatim from an earlier result, or omit it.', options: fallback } })
      }
      chosen = [d]
    } else {
      chosen = (await routeFilings(jev, args.question, docs, folders)).slice(0, 2)
    }
    if (chosen.length === 0) {
      note({ event: 'locate', documents: 0, ms: Date.now() - t0 })
      return envelope({ success: false, code: 'NOT_FOUND', error: 'No document could be chosen for this question.', next_steps: { summary: 'Use the other tools.', options: fallback } })
    }
    // The first document gets the full `limit`, a second candidate half of it.
    const perDoc = await Promise.all(chosen.map((d) => scoreSections(jev, lib.store, args.question, d, loadTree(lib.store, d.path).all)))
    const results = perDoc.flatMap((ranked, i) =>
      ranked
        .filter((x) => x.p >= 0)
        .slice(0, i === 0 ? args.limit : Math.ceil(args.limit / 2))
        .map((x) => ({ doc_path: chosen[i]!.path, node_id: x.sec.id, title_path: x.sec.path, start_line: x.sec.start, end_line: x.sec.end, relevance: Number(x.p.toFixed(2)) })),
    )
    const after = jev.stats()
    note({ event: 'locate', documents: chosen.length, sections: perDoc.reduce((n, r) => n + r.length, 0), returned: results.length, ms: Date.now() - t0, calls: after.calls - before.calls, cached: after.cached - before.cached, failed: after.failed - before.failed, input_tokens: after.inputTokens - before.inputTokens, scoped: args.doc_path !== undefined })
    if (results.length === 0) {
      return envelope({ success: false, code: 'INTERNAL_ERROR', error: 'The sections could not be judged.', next_steps: { summary: 'Use the other tools.', options: fallback } })
    }
    return envelope({
      success: true,
      data: { question: args.question, documents: chosen.map((d) => ({ doc_path: d.path, title: d.title })), results },
      next_steps: {
        summary: `Found ${results.length} candidate section(s) in ${chosen.length} document(s), most likely first.`,
        options: [
          'Read the most likely sections with get_node_content() using doc_path and node_id copied verbatim',
          'If they do not hold the answer, use get_document_structure() on the document or search_documents()',
        ],
      },
    })
  }

  const server = new McpServer({ name: 'markindex', version: '0.0.0-toc' }, { instructions: `${LOCATOR}\n\n${AGENT_INSTRUCTIONS}` })
  server.registerTool(
    TOC_TOOL,
    {
      description:
        'Finds where a question is answered from names alone: chooses the document from folder and document names, ' +
        'then ranks that document\'s sections by their titles. Returns candidate sections (doc_path, node_id, ' +
        'title_path, line range, relevance), most likely first, to read with `get_node_content()`. Use it first ' +
        'for a question about what a document reports; it does not read or search the text.',
      inputSchema: {
        question: z.string().min(1).max(2000).describe('The full question in natural language, with every name, period and quantity it mentions. Not keywords.'),
        doc_path: z.string().min(1).max(1024).optional().describe('Rank the sections of this document only (skips choosing the document). Copy it verbatim from an earlier result.'),
        limit: z.int().min(1).max(20).default(8).describe('Maximum number of sections to return for the chosen document (1-20, default 8).'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => locate(args),
  )
  for (const name of Object.keys(TOOL_CONTRACT) as ToolName[]) {
    const contract = TOOL_CONTRACT[name]
    server.registerTool(
      name,
      { description: contract.description, inputSchema: contract.input.shape, annotations: { readOnlyHint: true } },
      async (args: unknown) => {
        const text = await lib.callTool(name, args)
        let ok = false
        try {
          ok = (JSON.parse(text) as { success?: unknown }).success === true
        } catch {
          // not JSON: report it as an error
        }
        return { content: [{ type: 'text' as const, text }], isError: !ok }
      },
    )
  }
  void server.connect(new StdioServerTransport())
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main()
