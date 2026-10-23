import { segmentQuery } from '../text/segment.js'
import type { TreeNode } from '../types.js'
import type { Store } from './db.js'

export interface SearchHit {
  docPath: string
  nodeId: string
  /** Ancestor titles from the top-level section down to the hit node. */
  titlePath: string[]
  startLine: number
  endLine: number
  /** <= 300 chars of the node's own original text around the first match. */
  snippet: string
  /** Higher is better (negated FTS5 bm25). Only comparable within the same `via`. */
  score: number
  via: 'bm25' | 'trigram'
}

export interface SearchOptions {
  /** Restrict to documents under this folder ('' or omitted = whole library). */
  folder?: string
  /** Restrict to exactly this document; takes precedence over `folder`. */
  docPath?: string
  limit?: number
}

const SNIPPET_MAX = 300
const DEFAULT_LIMIT = 10
/** Own text beyond this many chars is never scanned for the snippet window. */
const SNIPPET_SCAN_MAX = 20_000

interface Row {
  doc_path: string
  node_id: string
  json: string
  rank: number
}

function scopeClause(opts: SearchOptions): { sql: string; params: string[] } {
  if (opts.docPath !== undefined && opts.docPath !== '') return { sql: 'AND f.doc_path = ?', params: [opts.docPath] }
  const folder = (opts.folder ?? '').replace(/^\/+|\/+$/g, '')
  if (folder === '') return { sql: '', params: [] }
  const prefix = `${folder}/`
  return { sql: 'AND substr(f.doc_path, 1, length(?)) = ?', params: [prefix, prefix] }
}

/** Quoted tokens of a segmentQuery() expression, un-escaped. */
function queryTokens(expr: string): string[] {
  return [...expr.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replaceAll('""', '"'))
}

/**
 * Snippet from the ORIGINAL own text of the node: a window of <= 300 chars starting a little before the first
 * occurrence of any needle (case-insensitive); falls back to the start of the text, then to the title.
 */
function makeSnippet(text: string, needles: string[], title: string): string {
  const body = text.slice(0, SNIPPET_SCAN_MAX)
  if (body.trim() === '') return title.slice(0, SNIPPET_MAX)
  const lower = body.toLowerCase()
  let at = -1
  for (const n of needles) {
    const i = n === '' ? -1 : lower.indexOf(n.toLowerCase())
    if (i !== -1 && (at === -1 || i < at)) at = i
  }
  const from = at === -1 ? 0 : Math.max(0, at - 60)
  return body.slice(from, from + SNIPPET_MAX).trim()
}

/**
 * BM25 node search with trigram fallback (spec §7). Ranks `fts_words` by bm25(title 10, key_items 5, summary 2,
 * body 1); if that yields fewer than `limit` nodes and the whitespace-stripped query has >= 3 chars, the
 * `fts_tri` substring index tops the list up (deduplicated by doc+node). Never throws on malformed input.
 */
export function searchNodes(store: Store, query: string, opts: SearchOptions = {}): SearchHit[] {
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIMIT))
  if (limit === 0) return []
  const scope = scopeClause(opts)
  const { db } = store
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  const titleCache = new Map<string, { title: string; parent: string | null }>()
  const nodeStmt = db.prepare(
    "SELECT json_extract(json, '$.title') AS t, parent_id AS p FROM nodes WHERE doc_path = ? AND node_id = ?",
  )

  const titlePath = (docPath: string, nodeId: string): string[] => {
    const out: string[] = []
    let cur: string | null = nodeId
    while (cur !== null) {
      const key = `${docPath}\0${cur}`
      let e = titleCache.get(key)
      if (!e) {
        const r = nodeStmt.get(docPath, cur) as { t: string; p: string | null } | undefined
        if (!r) break
        e = { title: r.t, parent: r.p }
        titleCache.set(key, e)
      }
      out.push(e.title)
      cur = e.parent
    }
    return out.reverse()
  }

  const push = (r: Row, needles: string[], via: SearchHit['via']) => {
    const key = `${r.doc_path}\0${r.node_id}`
    if (seen.has(key) || hits.length >= limit) return
    seen.add(key)
    const node = JSON.parse(r.json) as TreeNode
    const own = store.getLines(r.doc_path, node.startLine, node.ownEndLine).join('\n')
    hits.push({
      docPath: r.doc_path,
      nodeId: r.node_id,
      titlePath: titlePath(r.doc_path, r.node_id),
      startLine: node.startLine,
      endLine: node.endLine,
      snippet: makeSnippet(own, needles, node.title),
      score: -r.rank,
      via,
    })
  }

  const run = (table: 'fts_words' | 'fts_tri', match: string, rankExpr: string): Row[] => {
    try {
      return db
        .prepare(
          `SELECT f.doc_path AS doc_path, f.node_id AS node_id, n.json AS json, ${rankExpr} AS rank
           FROM ${table} f JOIN nodes n ON n.doc_path = f.doc_path AND n.node_id = f.node_id
           WHERE ${table} MATCH ? ${scope.sql}
           ORDER BY rank LIMIT ?`,
        )
        .all(match, ...scope.params, limit) as Row[]
    } catch {
      return [] // a MATCH expression FTS5 refuses is treated as "no results"
    }
  }

  const words = segmentQuery(query)
  if (words !== '') {
    const needles = queryTokens(words)
    for (const r of run('fts_words', words, 'bm25(fts_words, 10.0, 5.0, 2.0, 1.0, 0.0, 0.0)')) push(r, needles, 'bm25')
  }

  if (hits.length < limit) {
    const compact = query.replace(/\s+/g, '')
    if ([...compact].length >= 3) {
      const phrase = `"${compact.replaceAll('"', '""')}"`
      for (const r of run('fts_tri', phrase, 'bm25(fts_tri, 10.0, 1.0, 0.0, 0.0)')) push(r, [compact], 'trigram')
    }
  }
  return hits
}
