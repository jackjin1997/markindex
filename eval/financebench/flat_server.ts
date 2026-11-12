/**
 * Baseline MCP server for FinanceBench: plain keyword search over flat page chunks, no section tree.
 *
 *   npx tsx eval/financebench/flat_server.ts --db eval/financebench/runs/baseline/chunks.db \
 *     --root eval/financebench/md --pages eval/financebench/md-pages
 *
 * It gives an agent the same loop as the MarkIndex tools `search_documents` + `get_node_content`, but over the
 * chunks of baseline_retrieve.py (<= 1200 chars, page-bounded, header "company | DOC_TYPE | period N") and whole
 * pages instead of section nodes. Search is FTS5 BM25 with an OR query, like MarkIndex's; the response size cap and
 * the snippet length are the same as MarkIndex's. run.ts starts it with `--flat-chunks <chunks.db>`.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import Database from 'better-sqlite3'
import { z } from 'zod'

/** Same values as MarkIndex (src/config.ts RESPONSE_CHAR_BUDGET, src/store/search.ts SNIPPET_MAX). */
const RESPONSE_CHAR_BUDGET = 95_000
const SNIPPET_MAX = 300

export const FLAT_TOOLS = ['search_chunks', 'get_page_content']

const INSTRUCTIONS = `This server holds a library of long Markdown documents, split into small text chunks. Every chunk belongs to one page of one document and is addressed by line numbers in the original file.

FINDING AND READING:
- search_chunks() — keyword (BM25) search over all chunks. Returns matching chunks (doc_path, page, line range, snippet). Scope it with \`folder\` or \`doc_path\` once you know where to look.
- get_page_content() — read whole pages of one document, every line prefixed with its line number. Use the \`page\` numbers from search results; neighbouring pages (page - 1, page + 1) often hold the rest of a table or statement.

PERSISTENCE (before concluding the answer is not in the library):
Applies both when results are empty AND when returned results do not clearly match the question — treat a mismatch as "not found". Do NOT give up after a single attempt: search again with synonyms and with the terms a document would actually use, scope the search to the most plausible document, and read the pages around promising hits. Do NOT fall back to general knowledge.

GROUNDING AND CITATIONS:
- Answer only from content read with get_page_content(); never fill a gap from general knowledge. When the documents do not answer the question, say so.
- Cite what you use by doc_path and the line numbers shown in the content. Cite the narrowest range that supports the claim.

TOOL USAGE RULES:
- Copy doc_path and folder values verbatim from earlier tool results; never construct or guess them.
- If a tool returns an error, follow its message instead of retrying blindly.`

interface ChunkRow { id: number; doc_path: string; page: number; start_line: number; end_line: number; body: string; rank: number }

function ftsQuery(q: string): string {
  const seen = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
  return seen.map((t) => `"${t}"`).join(' OR ')
}

function snippet(body: string, needles: string[]): string {
  const lower = body.toLowerCase()
  let at = -1
  for (const n of needles) {
    const i = lower.indexOf(n)
    if (i !== -1 && (at === -1 || i < at)) at = i
  }
  const from = at === -1 ? 0 : Math.max(0, at - 60)
  return body.slice(from, from + SNIPPET_MAX).trim()
}

function main() {
  const { values: v } = parseArgs({
    args: process.argv.slice(2),
    options: { db: { type: 'string' }, root: { type: 'string' }, pages: { type: 'string' } },
  })
  if (!v.db || !v.root || !v.pages) throw new Error('--db, --root and --pages are required')
  const root = resolve(v.root)
  const pagesDir = resolve(v.pages)
  const db = new Database(resolve(v.db), { readonly: true, fileMustExist: true })
  const hasDoc = db.prepare('select 1 from chunks where doc_path = ? limit 1')

  const lines = new Map<string, string[]>()
  const linesOf = (docPath: string) => {
    let l = lines.get(docPath)
    if (!l) {
      l = readFileSync(join(root, docPath), 'utf8').split('\n')
      lines.set(docPath, l)
    }
    return l
  }
  const pageRanges = new Map<string, Record<string, [number, number]>>()
  const rangesOf = (docPath: string) => {
    let r = pageRanges.get(docPath)
    if (!r) {
      const name = docPath.split('/').pop()!.replace(/\.md$/, '')
      r = JSON.parse(readFileSync(join(pagesDir, `${name}.json`), 'utf8')) as Record<string, [number, number]>
      pageRanges.set(docPath, r)
    }
    return r
  }

  const ok = (body: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...body }) }] })
  const fail = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }], isError: true })

  const server = new McpServer({ name: 'chunksearch', version: '0.0.0' }, { instructions: INSTRUCTIONS })

  server.registerTool(
    'search_chunks',
    {
      description:
        'Keyword (BM25) search over the text chunks of every document. Returns matching chunks (doc_path, page, ' +
        'line range, snippet), best match first. Scope it with `folder` or `doc_path`. Then read the pages of the ' +
        'hits with `get_page_content()`.',
      inputSchema: {
        query: z.string().min(1).max(1024).describe('Keywords to look for: distinctive terms, names or identifiers as they appear in the text. Not a natural-language question.'),
        folder: z.string().max(1024).optional().describe('Restrict the search to documents under this folder: the first path segment of a `doc_path` from an earlier result.'),
        doc_path: z.string().min(1).max(1024).optional().describe('Restrict the search to this document (takes precedence over `folder`). Copy it verbatim from an earlier result.'),
        limit: z.int().min(1).max(50).default(10).describe('Maximum number of matching chunks to return (1-50, default 10).'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, folder, doc_path, limit }) => {
      const match = ftsQuery(query)
      if (!match) return fail('The query has no searchable terms.')
      let scope = ''
      const params: (string | number)[] = [match]
      if (doc_path) {
        if (!hasDoc.get(doc_path)) return fail(`Unknown doc_path "${doc_path}". Copy it verbatim from a search_chunks() result.`)
        scope = 'and c.doc_path = ?'
        params.push(doc_path)
      } else if (folder?.replace(/^\/+|\/+$/g, '')) {
        const prefix = `${folder.replace(/^\/+|\/+$/g, '')}/`
        scope = 'and substr(c.doc_path, 1, length(?)) = ?'
        params.push(prefix, prefix)
      }
      const rows = db
        .prepare(
          `select c.id as id, c.doc_path as doc_path, c.page as page, c.start_line as start_line, c.end_line as end_line, c.body as body, bm25(fts) as rank
           from fts join chunks c on c.id = fts.rowid where fts match ? ${scope} order by rank limit ?`,
        )
        .all(...params, limit) as ChunkRow[]
      const needles = [...match.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
      return ok({
        query,
        results: rows.map((r) => ({
          doc_path: r.doc_path,
          page: r.page + 1,
          start_line: r.start_line,
          end_line: r.end_line,
          snippet: snippet(r.body, needles),
          score: -r.rank,
        })),
        next_steps: rows.length
          ? 'Read the most relevant hits with get_page_content() using doc_path and page copied verbatim.'
          : 'No matching chunks. Search again with other terms or a wider scope.',
      })
    },
  )

  server.registerTool(
    'get_page_content',
    {
      description:
        'Read whole pages of one document as original Markdown, every line prefixed with its line number in the ' +
        'file ("123│ "). `pages` are the page numbers shown in search_chunks() results (the same numbers as the ' +
        '"<!-- page N -->" lines); neighbouring pages can be read by adding or subtracting 1.',
      inputSchema: {
        doc_path: z.string().min(1).max(1024).describe('Library-relative path of the document, copied verbatim from a search_chunks() result.'),
        pages: z.array(z.int().min(1)).min(1).max(20).describe('Page numbers to read (1-20 pages).'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ doc_path, pages }) => {
      if (!hasDoc.get(doc_path)) return fail(`Unknown doc_path "${doc_path}". Copy it verbatim from a search_chunks() result.`)
      const ranges = rangesOf(doc_path)
      const last = Math.max(...Object.keys(ranges).map(Number)) + 1
      const all = linesOf(doc_path)
      const content: { page: number; start_line: number; end_line: number; text: string }[] = []
      const omitted: number[] = []
      const missing: number[] = []
      let size = 0
      for (const p of [...new Set(pages)].sort((a, b) => a - b)) {
        const r = ranges[String(p - 1)]
        if (!r) {
          missing.push(p)
          continue
        }
        const text = all.slice(r[0] - 1, r[1]).map((line, i) => `${r[0] + i}│ ${line}`).join('\n')
        if (content.length && size + text.length > RESPONSE_CHAR_BUDGET) {
          omitted.push(p)
          continue
        }
        content.push({ page: p, start_line: r[0], end_line: r[1], text })
        size += text.length
      }
      if (!content.length) return fail(`No such page in ${doc_path}: ${missing.join(', ')}. The document has pages 1-${last}.`)
      return ok({
        doc_path,
        content,
        ...(missing.length ? { missing_pages: missing, page_count: last } : {}),
        ...(omitted.length ? { omitted_pages: omitted, note: 'Response size limit reached: request the omitted pages in another call.' } : {}),
      })
    },
  )

  void server.connect(new StdioServerTransport())
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main()
