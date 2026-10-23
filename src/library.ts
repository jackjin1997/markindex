import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { indexLibrary, type IndexOptions, type IndexReport } from './library/indexer.js'
import { openStore, type Store } from './store/db.js'
import type { ToolName } from './tools/contract.js'
import { runTool } from './tools/impl.js'

export interface OpenLibraryOptions {
  /** Library root directory (the folder of Markdown files). */
  root: string
  /** Index database; defaults to `${root}/.markindex/index.db`. */
  dbFile?: string
  /** Defaults to true: agents only read, and a read-only store never waits on (or blocks) an indexer. */
  readonly?: boolean
}

export interface Library {
  readonly store: Store
  /** Absolute library root. */
  readonly root: string
  /** Runs an agent tool and returns its JSON envelope. Never rejects, whatever the name or arguments. */
  callTool(name: ToolName, args: unknown): Promise<string>
  /**
   * Incrementally (re)indexes the library into this library's database. A read-only library opens a separate
   * writable store for the duration of the call (throws StoreLockedError if another writer holds the index).
   */
  index(opts?: Omit<IndexOptions, 'root' | 'store'>): Promise<IndexReport>
  close(): void
}

export const defaultDbFile = (root: string) => join(root, '.markindex', 'index.db')

/**
 * Opens an existing library index for agent use. Does not index: run `markindex index` (or `indexLibrary`)
 * first. Throws if a read-only open finds no index.
 */
export function openLibrary(opts: OpenLibraryOptions): Library {
  const root = resolve(opts.root)
  const dbFile = resolve(opts.dbFile ?? defaultDbFile(root))
  const readonly = opts.readonly ?? true
  if (readonly && !existsSync(dbFile)) {
    throw new Error(`No MarkIndex index at ${dbFile}. Build it first with \`markindex index ${root}\`.`)
  }
  const store = openStore(dbFile, { readonly })
  return {
    store,
    root,
    async callTool(name, args) {
      return JSON.stringify(runTool(store, name, args))
    },
    async index(indexOpts = {}) {
      if (!readonly) return indexLibrary({ ...indexOpts, root, store })
      const writer = openStore(dbFile)
      try {
        return await indexLibrary({ ...indexOpts, root, store: writer })
      } finally {
        writer.close()
      }
    },
    close() {
      store.close()
    },
  }
}
