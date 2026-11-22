import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertLibraryRoot } from './library/scan.js'
import { indexLibrary, type IndexOptions, type IndexReport } from './library/indexer.js'
import { openStore, type Store } from './store/db.js'
import type { RerankOptions } from './rerank/types.js'
import { TOOL_CONTRACT, TOOL_CONTRACT_RERANKED, type ToolContract, type ToolName } from './tools/contract.js'
import { runTool, runToolReranked } from './tools/impl.js'

export interface OpenLibraryOptions {
  /** Library root directory (the folder of Markdown files). */
  root: string
  /** Index database; defaults to `${root}/.markindex/index.db`. */
  dbFile?: string
  /** Defaults to true: agents only read, and a read-only store never waits on (or blocks) an indexer. */
  readonly?: boolean
  /**
   * Off by default. With a reranker, `search_documents` has it score the keyword hits and returns the best, and
   * the tool takes an optional `intent` (see `Library.contract`). The reranker decides where the text goes:
   * `jevReranker()` sends the question and the candidate sections to a hosted model.
   */
  rerank?: RerankOptions
}

export interface Library {
  readonly store: Store
  /** Absolute library root. */
  readonly root: string
  /** Descriptions and input schemas of the tools as this library serves them: `TOOL_CONTRACT`, or `TOOL_CONTRACT_RERANKED` with a reranker. */
  readonly contract: ToolContract
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
  assertLibraryRoot(root)
  const dbFile = resolve(opts.dbFile ?? defaultDbFile(root))
  const readonly = opts.readonly ?? true
  if (readonly && !existsSync(dbFile)) {
    throw new Error(`No MarkIndex index at ${dbFile}. Build it first with \`markindex index ${root}\`.`)
  }
  const store = openStore(dbFile, { readonly })
  const { rerank } = opts
  return {
    store,
    root,
    contract: rerank ? TOOL_CONTRACT_RERANKED : TOOL_CONTRACT,
    async callTool(name, args) {
      return rerank ? runToolReranked(store, name, args, rerank) : runTool(store, name, args)
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
