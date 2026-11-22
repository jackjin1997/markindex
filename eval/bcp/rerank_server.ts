/**
 * MarkIndex's MCP server with reranked search, for evaluation only.
 *
 *   node --import <tsx loader> eval/bcp/rerank_server.ts <root> --db <index.db> --scorer jev \
 *     [--pool 50] [--max-chars 8000] [--cache <scores.jsonl>] [--log <searches.jsonl>]
 *
 * Same tools, descriptions and instructions as `markindex mcp`. `search_documents` asks MarkIndex for `pool`
 * nodes, has the scorer judge one passage per node, and returns the `limit` best. What a passage is judged
 * against is the question in RERANK_QUESTION when the runner sets it (the agent's own search query is a list of
 * keywords, which says little about what is wanted), else the search query. If scoring fails the BM25 order is
 * returned unchanged. run.ts starts this server with `--rerank <scorer>`.
 */
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openLibrary } from '../../src/library.js'
import { AGENT_INSTRUCTIONS, TOOL_CONTRACT, type ToolName } from '../../src/tools/contract.js'
import { bestWindow, makeScorer, orderByScore, queryTerms } from './rerank.js'

interface Hit { doc_path: string; node_id: string; title_path: string[]; start_line: number; end_line: number; relevance?: number }

function main() {
  const { values: v, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      scorer: { type: 'string', default: 'jev' },
      pool: { type: 'string', default: '50' },
      'max-chars': { type: 'string', default: '8000' },
      cache: { type: 'string' },
      log: { type: 'string' },
    },
  })
  if (!positionals[0]) throw new Error('usage: rerank_server.ts <root> [--db <index.db>] [--scorer jev|overlap]')
  const lib = openLibrary({ root: positionals[0], dbFile: v.db ? resolve(v.db) : undefined })
  const scorer = makeScorer(v.scorer!, v.cache ? resolve(v.cache) : undefined)
  const pool = Math.min(50, Number(v.pool)) // 50 is the tool's own maximum
  const maxChars = Number(v['max-chars'])
  const question = process.env.RERANK_QUESTION?.trim() || undefined
  const logFile = v.log ? resolve(v.log) : undefined
  const note = (o: object) => {
    if (logFile) appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...o })}\n`)
  }
  // Names only, never values: shows in the log whether the runner's key references reached this process.
  const envSeen = ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'JEV_BASE_URL', 'JEV_API_KEY', 'JEV_MODEL'].filter((k) => process.env[k]?.trim())
  note({ event: 'start', scorer: scorer.name, pool, max_chars: maxChars, has_question: question !== undefined, env_seen: envSeen })

  const search = async (args: { query: string; limit?: number }): Promise<string> => {
    const want = args.limit ?? 10
    const t0 = Date.now()
    const text = await lib.callTool('search_documents', { ...args, limit: Math.max(want, pool) })
    const searchMs = Date.now() - t0
    let env: { success?: boolean; data?: { results?: Hit[] }; next_steps?: { summary?: string } }
    try {
      env = JSON.parse(text)
    } catch {
      return text
    }
    const hits = env.data?.results
    if (env.success !== true || !hits || hits.length === 0) return text
    const against = question ?? args.query
    const terms = queryTerms(against)
    const t1 = Date.now()
    let scores: (number | null)[]
    try {
      scores = await scorer.score(
        against,
        hits.map((h) => ({
          id: `${h.doc_path}#${h.node_id}`,
          passage: `${h.title_path.join(' > ')}\n\n${bestWindow(lib.store.getLines(h.doc_path, h.start_line, h.end_line).join('\n'), terms, maxChars)}`,
        })),
      )
    } catch {
      scores = hits.map(() => null)
    }
    const scored = hits.map((h, i) => (scores[i] === null || scores[i] === undefined ? h : { ...h, relevance: Number(scores[i]!.toFixed(4)) }))
    const kept = orderByScore(scored, scores).slice(0, want)
    note({ event: 'search', candidates: hits.length, returned: kept.length, unscored: scores.filter((s) => s === null).length, search_ms: searchMs, rerank_ms: Date.now() - t1, ...scorer.stats() })
    env.data!.results = kept
    if (env.next_steps?.summary) env.next_steps.summary = `Found ${kept.length} matching node(s).`
    return JSON.stringify(env)
  }

  const server = new McpServer({ name: 'markindex', version: '0.0.0-rerank' }, { instructions: AGENT_INSTRUCTIONS })
  for (const name of Object.keys(TOOL_CONTRACT) as ToolName[]) {
    const contract = TOOL_CONTRACT[name]
    server.registerTool(
      name,
      { description: contract.description, inputSchema: contract.input.shape, annotations: { readOnlyHint: true } },
      async (args: unknown) => {
        const text = name === 'search_documents' ? await search(args as { query: string; limit?: number }) : await lib.callTool(name, args)
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

main()
