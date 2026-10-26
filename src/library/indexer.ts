import { createHash } from 'node:crypto'
import { INDEX_FORMAT_VERSION, MAX_NODE_TOKENS, ROUTING_COST_TOKENS } from '../config.js'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { parseMarkdown, type ParsedDoc } from '../parse/markdown.js'
import type { Store } from '../store/db.js'
import { approxTokens, type TokenCounter } from '../text/tokens.js'
import { buildTree } from '../tree/build.js'
import { optimizeTree } from '../tree/optimize.js'
import type { DocumentRecord } from '../types.js'
import { summarizeDocument, type SummaryOptions } from '../llm/summarize.js'
import { scanLibrary } from './scan.js'

export type IndexStatus = 'added' | 'updated' | 'unchanged' | 'removed' | 'skipped'

export interface IndexEvent {
  path: string
  status: IndexStatus
  reason?: string
  /** Files processed so far (1-based); removals do not count. */
  done: number
  /** Files found by the scan. */
  total: number
}

export interface IndexOptions {
  root: string
  store: Store
  /** Used for both buildTree and optimizeTree. Defaults to approxTokens. */
  countTokens?: TokenCounter
  /**
   * Names a custom `countTokens` in the index format fingerprint, so swapping one custom counter for another
   * also triggers a rebuild. Without it every custom counter is recorded as `custom`.
   */
  tokenCounterId?: string
  /** optimizeTree `maxNodeTokens` (default MAX_NODE_TOKENS). */
  maxNodeTokens?: number
  /** optimizeTree `routingCost` (default ROUTING_COST_TOKENS). */
  routingCost?: number
  /**
   * parseMarkdown `setext` (default true). Set false for converter output whose bare `---` lines are page breaks.
   * Part of the index format fingerprint: changing it re-indexes every document.
   */
  setext?: boolean
  onProgress?: (e: IndexEvent) => void
  /** When set, every document (including unchanged ones, so earlier failures are retried) is summarized; omitted = no LLM calls at all. */
  summary?: SummaryOptions
}

export interface IndexReport {
  added: string[]
  updated: string[]
  removed: string[]
  unchanged: string[]
  skipped: { path: string; reason: string }[]
  /**
   * Only with `summary`: documents whose summarization failed (in whole or in part). The document itself stays
   * indexed and searchable; whatever succeeded was saved, the rest is retried (cache-assisted) on the next
   * `summarizeDocument` call.
   */
  summaryErrors: { path: string; nodeId: string | null; message: string }[]
  /** Present when the stored index format differed from this run's, so every document was re-indexed. */
  rebuilt?: { reason: string }
  /**
   * Non-fatal findings about documents parsed in this run (unchanged documents are not re-checked). Currently:
   * setext h2 headings that look like page breaks (see `SUSPECT_SETEXT_CHARS`), reported only while `setext` is on.
   */
  warnings: { path: string; message: string }[]
}

export type IndexFormatOptions = Pick<IndexOptions, 'countTokens' | 'tokenCounterId' | 'maxNodeTokens' | 'routingCost' | 'setext'>

const FORMAT_KEY = 'index_format'

/** Fingerprint of everything besides file content that shapes the stored trees (INDEX_FORMAT_VERSION + build parameters). */
export function indexFormat(opts: IndexFormatOptions): string {
  const custom = opts.countTokens !== undefined && opts.countTokens !== approxTokens
  return JSON.stringify({
    version: INDEX_FORMAT_VERSION,
    maxNodeTokens: opts.maxNodeTokens ?? MAX_NODE_TOKENS,
    routingCost: opts.routingCost ?? ROUTING_COST_TOKENS,
    tokens: custom ? `custom${opts.tokenCounterId === undefined ? '' : `:${opts.tokenCounterId}`}` : 'approx',
    // only recorded when off, so indexes built before the option existed (setext always on) are not rebuilt
    ...(opts.setext === false ? { setext: false } : {}),
  })
}

/** A setext h2 whose heading text is longer than this many code points (or spans several lines) looks like a page. */
export const SUSPECT_SETEXT_CHARS = 120

/**
 * Setext h2 headings that are probably a converter's page break (`---` right under a paragraph) rather than a real
 * heading: heading text over SUSPECT_SETEXT_CHARS code points or spread over more than one source line.
 */
function suspectSetextHeadings(doc: ParsedDoc): number[] {
  const out: number[] = []
  for (const h of doc.headings) {
    if (h.level !== 2 || h.endLine === h.line) continue // ATX headings are one line; setext ones span text + underline
    const textLines = h.endLine - h.line
    const raw = doc.lines.slice(h.line - 1, h.endLine - 1).join('\n').trim()
    if (textLines > 1 || Array.from(raw).length > SUSPECT_SETEXT_CHARS) out.push(h.line)
  }
  return out
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Incrementally indexes the Markdown files under `root` (spec §6): unchanged content hashes are skipped,
 * new / changed files are rebuilt one transaction per document, and documents missing on disk are deleted.
 * A file that cannot be read, decoded or indexed is reported in `skipped`; any previous version of it is
 * dropped so the index never serves content that no longer matches the disk. An unreadable subdirectory is
 * reported in `skipped` (path with trailing `/`) and the documents previously indexed under it are kept.
 * When the stored index format (see `indexFormat`) differs from this run's, every document is re-indexed
 * (summaries are reused through the content-hash cache) and the report carries `rebuilt`.
 */
export async function indexLibrary(opts: IndexOptions): Promise<IndexReport> {
  const { store } = opts
  const countTokens = opts.countTokens ?? approxTokens
  const report: IndexReport = { added: [], updated: [], removed: [], unchanged: [], skipped: [], summaryErrors: [], warnings: [] }
  const format = indexFormat(opts)
  const storedFormat = store.getMeta(FORMAT_KEY)
  const rebuild = storedFormat !== format && store.allDocPaths().length > 0
  if (rebuild) {
    report.rebuilt = {
      reason: `index format changed (stored ${storedFormat ?? 'none'}, now ${format}): re-indexing every document`,
    }
  }
  const unreadableDirs: string[] = []
  const files = scanLibrary(opts.root, {
    onError: (dir, error) => {
      unreadableDirs.push(dir)
      report.skipped.push({ path: dir, reason: `directory not readable: ${error.message}` })
    },
  })
  const total = files.length
  let done = 0
  const emit = (path: string, status: IndexStatus, reason?: string) =>
    opts.onProgress?.(reason === undefined ? { path, status, done, total } : { path, status, reason, done, total })

  const summarize = async (path: string) => {
    if (!opts.summary) return
    try {
      const res = await summarizeDocument(store, path, opts.summary)
      for (const f of res.failures) report.summaryErrors.push({ path, ...f })
    } catch (e) {
      report.summaryErrors.push({ path, nodeId: null, message: errorMessage(e) })
    }
  }

  for (const file of files) {
    done++
    const existing = store.getDoc(file.path)
    try {
      const bytes = readFileSync(file.abs)
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (!rebuild && existing?.contentHash === hash) {
        report.unchanged.push(file.path)
        emit(file.path, 'unchanged')
        await summarize(file.path) // enables summaries on an existing index and retries earlier failures (cache-assisted)
        continue
      }
      let src: string
      try {
        src = utf8.decode(bytes)
      } catch {
        throw new Error('not valid utf-8 text')
      }
      const doc = parseMarkdown(src, { setext: opts.setext })
      const suspects = opts.setext === false ? [] : suspectSetextHeadings(doc)
      const title = docTitle(doc, file.path)
      const tree = optimizeTree(buildTree(doc, { fileTitle: title, countTokens }), doc, {
        countTokens,
        maxNodeTokens: opts.maxNodeTokens,
        routingCost: opts.routingCost,
      })
      const record: DocumentRecord = {
        docId: '',
        path: file.path,
        title,
        metadata: doc.frontmatter?.data ?? {},
        contentHash: hash,
        lineCount: doc.lines.length,
        tokens: tree.reduce((sum, n) => sum + n.tokens, 0),
        indexedAt: new Date().toISOString(),
      }
      store.replaceDoc(record, tree, doc.lines)
      if (suspects.length > 0) {
        report.warnings.push({
          path: file.path,
          message:
            `${suspects.length} setext h2 heading(s) look like page breaks (a \`---\` line under a paragraph that spans ` +
            `several lines or exceeds ${SUSPECT_SETEXT_CHARS} characters), first at line ${suspects[0]}; if \`---\` ` +
            'marks page breaks in this file, index with setext headings off',
        })
      }
      const status = existing ? 'updated' : 'added'
      report[status].push(file.path)
      emit(file.path, status)
      await summarize(file.path)
    } catch (e) {
      let reason = errorMessage(e)
      if (existing) {
        try {
          store.deleteDoc(file.path)
        } catch (e2) {
          reason += `; previous version could not be removed: ${errorMessage(e2)}`
        }
      }
      report.skipped.push({ path: file.path, reason })
      emit(file.path, 'skipped', reason)
    }
  }

  const onDisk = new Set(files.map((f) => f.path))
  for (const path of store.allDocPaths()) {
    if (onDisk.has(path)) continue
    // Contents of an unreadable directory are unknown: keep their previous versions.
    if (unreadableDirs.some((dir) => path.startsWith(dir))) continue
    try {
      store.deleteDoc(path)
    } catch (e) {
      const reason = `could not remove deleted document: ${errorMessage(e)}`
      report.skipped.push({ path, reason })
      emit(path, 'skipped', reason)
      continue
    }
    report.removed.push(path)
    emit(path, 'removed')
  }
  // Written last: an interrupted rebuild keeps the old fingerprint and is redone in full next time.
  if (storedFormat !== format) store.setMeta(FORMAT_KEY, format)
  return report
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** frontmatter `title` > first h1 > file name without extension. */
function docTitle(doc: ParsedDoc, path: string): string {
  const fm = doc.frontmatter?.data.title
  if (typeof fm === 'string' && fm.trim() !== '') return fm.trim()
  const h1 = doc.headings.find((h) => h.level === 1 && h.title !== '')
  if (h1) return h1.title
  return basename(path, extname(path))
}
