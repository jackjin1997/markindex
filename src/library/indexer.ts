import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { parseMarkdown, type ParsedDoc } from '../parse/markdown.js'
import type { Store } from '../store/db.js'
import { approxTokens, type TokenCounter } from '../text/tokens.js'
import { buildTree } from '../tree/build.js'
import { optimizeTree } from '../tree/optimize.js'
import type { DocumentRecord } from '../types.js'
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
  onProgress?: (e: IndexEvent) => void
}

export interface IndexReport {
  added: string[]
  updated: string[]
  removed: string[]
  unchanged: string[]
  skipped: { path: string; reason: string }[]
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Incrementally indexes the Markdown files under `root` (spec §6): unchanged content hashes are skipped,
 * new / changed files are rebuilt one transaction per document, and documents missing on disk are deleted.
 * A file that cannot be read, decoded or indexed is reported in `skipped`; any previous version of it is
 * dropped so the index never serves content that no longer matches the disk.
 */
export async function indexLibrary(opts: IndexOptions): Promise<IndexReport> {
  const { store } = opts
  const countTokens = opts.countTokens ?? approxTokens
  const report: IndexReport = { added: [], updated: [], removed: [], unchanged: [], skipped: [] }
  const files = scanLibrary(opts.root)
  const total = files.length
  let done = 0
  const emit = (path: string, status: IndexStatus, reason?: string) =>
    opts.onProgress?.(reason === undefined ? { path, status, done, total } : { path, status, reason, done, total })

  for (const file of files) {
    done++
    const existing = store.getDoc(file.path)
    try {
      const bytes = readFileSync(file.abs)
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (existing?.contentHash === hash) {
        report.unchanged.push(file.path)
        emit(file.path, 'unchanged')
        continue
      }
      let src: string
      try {
        src = utf8.decode(bytes)
      } catch {
        throw new Error('not valid utf-8 text')
      }
      const doc = parseMarkdown(src)
      const title = docTitle(doc, file.path)
      const tree = optimizeTree(buildTree(doc, { fileTitle: title, countTokens }), doc, { countTokens })
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
      const status = existing ? 'updated' : 'added'
      report[status].push(file.path)
      emit(file.path, status)
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      if (existing) store.deleteDoc(file.path)
      report.skipped.push({ path: file.path, reason })
      emit(file.path, 'skipped', reason)
    }
  }

  const onDisk = new Set(files.map((f) => f.path))
  for (const path of store.allDocPaths()) {
    if (onDisk.has(path)) continue
    store.deleteDoc(path)
    report.removed.push(path)
    emit(path, 'removed')
  }
  return report
}

/** frontmatter `title` > first h1 > file name without extension. */
function docTitle(doc: ParsedDoc, path: string): string {
  const fm = doc.frontmatter?.data.title
  if (typeof fm === 'string' && fm.trim() !== '') return fm.trim()
  const h1 = doc.headings.find((h) => h.level === 1 && h.title !== '')
  if (h1) return h1.title
  return basename(path, extname(path))
}
