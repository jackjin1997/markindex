import { createHash, randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
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
  /**
   * Writes summaries into the stored node JSON and the `summary` FTS column (segmented; fts_tri is untouched),
   * in one transaction. Throws (and changes nothing) if a node id does not exist in `docPath`.
   */
  updateNodeSummaries(docPath: string, updates: { nodeId: string; summary?: string; prefixSummary?: string }[]): void
  setDocDescription(docPath: string, description: string): void
  /** Summary cache keyed by sha256 of a node's own text. */
  getCachedSummary(contentHash: string): string | undefined
  putCachedSummary(contentHash: string, summary: string): void
  /** Index-wide key/value settings (e.g. `index_format`). Undefined when unset or the store predates the table. */
  getMeta(key: string): string | undefined
  setMeta(key: string, value: string): void
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

const SCHEMA_VERSION = 2
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
  2: `
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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

/** An empty / unparsable lock younger than this is assumed to be held (its writer may be mid-takeover). */
const UNREADABLE_LOCK_GRACE_MS = 10_000
const MAX_LOCK_ATTEMPTS = 5

const uniqueSuffix = () => `${process.pid}.${randomBytes(6).toString('hex')}`

function parsePid(content: string): number | undefined {
  const t = content.trim()
  if (!/^\d+$/.test(t)) return undefined
  const n = Number(t)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** Atomically creates `lockFile` with our pid: the lock never exists without its content. */
function tryLink(lockFile: string): boolean {
  const tmp = `${lockFile}.${uniqueSuffix()}.tmp`
  writeFileSync(tmp, `${process.pid}\n`)
  try {
    linkSync(tmp, lockFile)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  } finally {
    rmSync(tmp, { force: true })
  }
}

function holdLock(lockFile: string): void {
  heldLocks.add(lockFile)
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.on('exit', () => {
      for (const f of [...heldLocks]) releaseLock(f)
    })
  }
}

function acquireLock(lockFile: string): void {
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    if (tryLink(lockFile)) {
      holdLock(lockFile)
      return
    }
    let content: string
    let mtimeMs: number
    try {
      content = readFileSync(lockFile, 'utf8')
      mtimeMs = statSync(lockFile).mtimeMs
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue // released meanwhile: retry
      throw e
    }
    const pid = parsePid(content)
    if (pid === undefined) {
      if (Date.now() - mtimeMs < UNREADABLE_LOCK_GRACE_MS) throw new StoreLockedError(lockFile, undefined)
    } else if (pidAlive(pid)) {
      throw new StoreLockedError(lockFile, pid)
    }
    // Stale: move it aside atomically, then confirm we moved the lock we judged (not a fresh one).
    const aside = `${lockFile}.stale.${uniqueSuffix()}`
    try {
      renameSync(lockFile, aside)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue // someone else took it over
      throw e
    }
    let movedContent: string | undefined
    try {
      movedContent = readFileSync(aside, 'utf8')
    } catch {
      movedContent = undefined
    }
    if (movedContent !== content) {
      // We displaced a lock created after our read: put it back (unless a newer one exists) and back off.
      try {
        linkSync(aside, lockFile)
      } catch {
        // a newer lock is already in place
      }
      rmSync(aside, { force: true })
      throw new StoreLockedError(lockFile, movedContent === undefined ? undefined : parsePid(movedContent))
    }
    rmSync(aside, { force: true })
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
 * Opens (creating if needed) a store file. Write mode takes an exclusive `${file}.lock` holding the pid, created
 * atomically (temp file + link). A lock whose pid is dead, or an empty / unparsable lock older than 10 s, is taken over. Read-only opens take no lock and never block on a writer (WAL).
 */
export function openStore(file: string, opts: { readonly?: boolean } = {}): Store {
  if (opts.readonly) {
    const db = new Database(file, { readonly: true, fileMustExist: true })
    return createStore(db, () => {})
  }
  mkdirSync(dirname(file), { recursive: true })
  const lockFile = `${file}.lock`
  acquireLock(lockFile)
  let db: DB | undefined
  try {
    db = new Database(file)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    migrate(db)
  } catch (e) {
    try {
      db?.close()
    } finally {
      releaseLock(lockFile)
    }
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

  const updateSummariesTx = db.transaction(
    (docPath: string, updates: { nodeId: string; summary?: string; prefixSummary?: string }[]) => {
      for (const u of updates) {
        const row = stmt('SELECT json, fts_rowid FROM nodes WHERE doc_path = ? AND node_id = ?').get(
          docPath,
          u.nodeId,
        ) as { json: string; fts_rowid: number } | undefined
        if (!row) throw new Error(`node ${u.nodeId} not found in ${docPath}`)
        const node = JSON.parse(row.json) as Omit<TreeNode, 'children'>
        if (u.summary !== undefined) node.summary = u.summary
        if (u.prefixSummary !== undefined) node.prefixSummary = u.prefixSummary
        stmt('UPDATE nodes SET json = ? WHERE doc_path = ? AND node_id = ?').run(
          JSON.stringify(node),
          docPath,
          u.nodeId,
        )
        stmt('UPDATE fts_words SET summary = ? WHERE rowid = ?').run(
          segmentForIndex(node.summary ?? node.prefixSummary ?? ''),
          row.fts_rowid,
        )
      }
    },
  )

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

    updateNodeSummaries(docPath, updates) {
      updateSummariesTx(docPath, updates)
    },

    setDocDescription(docPath, description) {
      stmt('UPDATE docs SET description = ? WHERE path = ?').run(description, docPath)
    },

    getCachedSummary(contentHash) {
      return (stmt('SELECT summary FROM summaries WHERE content_hash = ?').get(contentHash) as
        | { summary: string }
        | undefined)?.summary
    },

    putCachedSummary(contentHash, summary) {
      stmt('INSERT OR REPLACE INTO summaries (content_hash, summary) VALUES (?, ?)').run(contentHash, summary)
    },

    getMeta(key) {
      // a read-only store opened on an index written before schema v2 has no meta table
      if (!stmt("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) return undefined
      return (stmt('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
    },

    setMeta(key, value) {
      stmt('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
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
