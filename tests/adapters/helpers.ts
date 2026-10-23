import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { indexLibrary } from '../../src/library/indexer.js'
import { openStore } from '../../src/store/db.js'

/** Copies the md fixtures to a temp root and indexes them (no LLM). */
export async function indexedFixtureRoot(): Promise<{ root: string; cleanup: () => void }> {
  const root = mkdtempSync(join(tmpdir(), 'markindex-adapter-'))
  cpSync(join(import.meta.dirname, '..', 'fixtures', 'md'), root, { recursive: true })
  const store = openStore(join(root, '.markindex', 'index.db'))
  await indexLibrary({ root, store })
  store.close()
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
