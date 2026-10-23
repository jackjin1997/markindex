import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { walk } from '../tree/build.js'
import { segmentForIndex } from '../text/segment.js'
import type { DocumentRecord, TreeNode } from '../types.js'

type DB = Database.Database

export interface Store {
  readonly db: DB
  getDoc(path: string): DocumentRecord | undefined
  /** Direct subfolders (full paths) and a page of the docs directly inside `folder` ('' = library root). */
  listDocs(folder: string, offset: number, limit: number): { folders: string[]; docs: DocumentRecord[]; total: number }
  allDocPaths(): string[]
  getTree(path: string): TreeNode[] | undefined
  /** 1-based inclusive range, clamped to the document. */
  getLines(path: string, start: number, end: number): string[]
  /** Replaces every row of `doc.path` (docs, nodes, lines, FTS) in a single transaction. */
  replaceDoc(doc: DocumentRecord, tree: TreeNode[], lines: string[]): void
  deleteDoc(path: string): void
  close(): void
}

export class StoreLockedError extends Error {
  constructor(
    readonly lockFile: string,
    readonly pid: number | undefined,
  ) {
    super(
      `index is locked by another writer (pid ${pid ?? 'unknown'}): ${lockFile}. ` +
        'Wait for it to finish, or open the store read-only.',
    )
    this.name = 'StoreLockedError'
  }
}

const SCHEMA_VERSION = 1
const LINE_CHUNK = 200

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE docs (
      path TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      metadata TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      line_count INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE nodes (
      doc_path TEXT NOT NULL,
      node_id TEXT NOT NULL,
      parent_id TEXT,
      ord INTEGER NOT NULL,
      json TEXT NOT NULL,
      fts_rowid INTEGER NOT NULL,
      PRIMARY KEY (doc_path, node_id)
    );
    CREATE TABLE lines (
      doc_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (doc_path, start_line)
    );
    CREATE TABLE summaries (
      content_hash TEXT PRIMARY KEY,
      summary TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE fts_words USING fts5(
      title, key_items, summary, body, doc_path UNINDEXED, node_id UNINDEXED,
      tokenize = "unicode61 tokenchars '+#.-_'"
    );
    CREATE VIRTUAL TABLE fts_tri USING fts5(
      title, body, doc_path UNINDEXED, node_id UNINDEXED,
      tokenize = 'trigram'
    );
  `,
}

/** Locks held by this process, released on exit. */
const heldLocks = new Set<string>()
let exitHookInstalled = false

function releaseLock(lockFile: string): void {
  if (!heldLocks.delete(lockFile)) return
  try {
    unlinkSync(lockFile)
  } catch {
    // already gone
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function acquireLock(lockFile: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx')
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
      heldLocks.add(lockFile)
      if (!exitHookInstalled) {
        exitHookInstalled = true
        process.on('exit', () => {
          for (const f of [...heldLocks]) releaseLock(f)
        })
      }
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    let pid: number | undefined
    try {
      const n = Number.parseInt(readFileSync(lockFile, 'utf8').trim(), 10)
      pid = Number.isInteger(n) && n > 0 ? n : undefined
    } catch {
      continue // removed between open and read: retry
    }
    if (pid !== undefined && pidAlive(pid)) throw new StoreLockedError(lockFile, pid)
    // stale (dead pid or unreadable content): take over
    try {
      unlinkSync(lockFile)
    } catch {
      // another process took it over first; the retry decides
    }
  }
  throw new StoreLockedError(lockFile, undefined)
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${v}`)
    })()
  }
}

/**
 * Opens (creating if needed) a store file. Write mode takes an exclusive `${file}.lock` (O_EXCL, holds the pid);
 * a lock whose pid is no longer alive is taken over. Read-only opens take no lock and never block on a writer (WAL).
 */
export function openStore(file: string, opts: { readonly?: boolean } = {}): Store {
  if (opts.readonly) {
    const db = new Database(file, { readonly: true, fileMustExist: true })
    return createStore(db, () => {})
  }
  mkdirSync(dirname(file), { recursive: true })
  const lockFile = `${file}.lock`
  acquireLock(lockFile)
  let db: DB
  try {
    db = new Database(file)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    migrate(db)
  } catch (e) {
    releaseLock(lockFile)
    throw e
  }
  return createStore(db, () => releaseLock(lockFile))
}

interface DocRow {
  path: string
  title: string
  description: string | null
  metadata: string
  content_hash: string
  line_count: number
  tokens: number
  indexed_at: string
}

/** Stable short id derived from the library-relative path. */
function docIdFor(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 12)
}

function toRecord(r: DocRow): DocumentRecord {
  const rec: DocumentRecord = {
    docId: docIdFor(r.path),
    path: r.path,
    title: r.title,
    metadata: JSON.parse(r.metadata) as Record<string, unknown>,
    contentHash: r.content_hash,
    lineCount: r.line_count,
    tokens: r.tokens,
    indexedAt: r.indexed_at,
  }
  if (r.description !== null) rec.description = r.description
  return rec
}

function createStore(db: DB, unlock: () => void): Store {
  let closed = false
  // Prepared on first use, so a read-only store never prepares write statements.
  const cache = new Map<string, Database.Statement>()
  const stmt = (sql: string) => {
    let s = cache.get(sql)
    if (!s) {
      s = db.prepare(sql)
      cache.set(sql, s)
    }
    return s
  }

  const deleteRows = (path: string) => {
    stmt('DELETE FROM fts_words WHERE rowid IN (SELECT fts_rowid FROM nodes WHERE doc_path = ?)').run(path)
    stmt('DELETE FROM fts_tri WHERE rowid IN (SELECT fts_rowid FROM nodes WHERE doc_path = ?)').run(path)
    stmt('DELETE FROM nodes WHERE doc_path = ?').run(path)
    stmt('DELETE FROM lines WHERE doc_path = ?').run(path)
    stmt('DELETE FROM docs WHERE path = ?').run(path)
  }

  const replaceTx = db.transaction((doc: DocumentRecord, tree: TreeNode[], lines: string[]) => {
    const path = doc.path
    deleteRows(path)
    stmt(
      `INSERT INTO docs (path, title, description, metadata, content_hash, line_count, tokens, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      path,
      doc.title,
      doc.description ?? null,
      JSON.stringify(doc.metadata),
      doc.contentHash,
      doc.lineCount,
      doc.tokens,
      doc.indexedAt,
    )
    for (let i = 0; i < lines.length; i += LINE_CHUNK) {
      stmt('INSERT INTO lines (doc_path, start_line, text) VALUES (?, ?, ?)').run(
        path,
        i + 1,
        lines.slice(i, i + LINE_CHUNK).join('\n'),
      )
    }
    const insertNodes = (nodes: TreeNode[], parentId: string | null) => {
      nodes.forEach((node, ord) => {
        const { children, ...own } = node
        const json = JSON.stringify(own)
        const body = lines.slice(node.startLine - 1, node.ownEndLine).join('\n')
        const keyItems = (node.keyItems ?? []).join('\n')
        const info = stmt(
          'INSERT INTO fts_words (title, key_items, summary, body, doc_path, node_id) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(segmentForIndex(node.title), segmentForIndex(keyItems), '', segmentForIndex(body), path, node.nodeId)
        stmt('INSERT INTO fts_tri (rowid, title, body, doc_path, node_id) VALUES (?, ?, ?, ?, ?)').run(
          info.lastInsertRowid,
          node.title,
          body,
          path,
          node.nodeId,
        )
        stmt('INSERT INTO nodes (doc_path, node_id, parent_id, ord, json, fts_rowid) VALUES (?, ?, ?, ?, ?, ?)').run(
          path,
          node.nodeId,
          parentId,
          ord,
          json,
          info.lastInsertRowid,
        )
        insertNodes(children, node.nodeId)
      })
    }
    insertNodes(tree, null)
  })

  const deleteTx = db.transaction((path: string) => deleteRows(path))

  const getDoc = (path: string) => {
    const row = stmt('SELECT * FROM docs WHERE path = ?').get(path) as DocRow | undefined
    return row && toRecord(row)
  }

  return {
    db,
    getDoc,

    listDocs(folder, offset, limit) {
      const prefix = folder.replace(/^\/+|\/+$/g, '')
      const p = prefix === '' ? '' : `${prefix}/`
      const paths = (
        stmt('SELECT path FROM docs WHERE substr(path, 1, length(?)) = ? ORDER BY path').all(p, p) as {
          path: string
        }[]
      ).map((r) => r.path)
      const folders = new Set<string>()
      const direct: string[] = []
      for (const path of paths) {
        const rest = path.slice(p.length)
        const slash = rest.indexOf('/')
        if (slash === -1) direct.push(path)
        else folders.add(p + rest.slice(0, slash))
      }
      const page = direct.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit))
      const docs = page.map((path) => getDoc(path)!)
      return { folders: [...folders].sort(), docs, total: direct.length }
    },

    allDocPaths() {
      return (stmt('SELECT path FROM docs ORDER BY path').all() as { path: string }[]).map((r) => r.path)
    },

    getTree(path) {
      if (!stmt('SELECT 1 FROM docs WHERE path = ?').get(path)) return undefined
      const rows = stmt('SELECT node_id, parent_id, ord, json FROM nodes WHERE doc_path = ? ORDER BY ord').all(
        path,
      ) as { node_id: string; parent_id: string | null; ord: number; json: string }[]
      const byId = new Map<string, TreeNode>()
      for (const r of rows) byId.set(r.node_id, { ...(JSON.parse(r.json) as TreeNode), children: [] })
      const roots: TreeNode[] = []
      for (const r of rows) {
        const node = byId.get(r.node_id)!
        const parent = r.parent_id === null ? undefined : byId.get(r.parent_id)
        if (parent) parent.children.push(node)
        else roots.push(node)
      }
      return roots
    },

    getLines(path, start, end) {
      const from = Math.max(1, Math.floor(start))
      const to = Math.floor(end)
      if (to < from) return []
      const firstChunk = Math.floor((from - 1) / LINE_CHUNK) * LINE_CHUNK + 1
      const rows = stmt(
        'SELECT start_line, text FROM lines WHERE doc_path = ? AND start_line >= ? AND start_line <= ? ORDER BY start_line',
      ).all(path, firstChunk, to) as { start_line: number; text: string }[]
      const out: string[] = []
      for (const r of rows) {
        r.text.split('\n').forEach((line, i) => {
          const n = r.start_line + i
          if (n >= from && n <= to) out.push(line)
        })
      }
      return out
    },

    replaceDoc(doc, tree, lines) {
      replaceTx(doc, tree, lines)
    },

    deleteDoc(path) {
      deleteTx(path)
    },

    close() {
      if (closed) return
      closed = true
      try {
        db.close()
      } finally {
        unlock()
      }
    },
  }
}
